'use strict'

const { createDiagnostics } = require('./diagnostics')
const { connectToRelay } = require('./relay-connection')
const { PROTOCOL_VERSION, CONNECTION_KINDS } = require('./protocol')
const { tryParseJSON } = require('./utils')
const { enableSocketKeepAlive, startSocketDeadline, createBackoff, destroySockets } = require('./lifecycle')

function createPeerSession({
  config,
  messaging,
  type,
  name,
  onConnected,
  onDisconnected,
  onMessage,
  onFatal,
  errorLabel = 'CONTROL_SOCKET'
}) {
  const { log, sendJson, createMessageDecoder } = messaging
  const { debug, traceSocket } = createDiagnostics(log)
  const backoff = createBackoff({
    baseDelay: config.reconnectDelay,
    maxDelay: config.reconnectMaxDelay,
    jitterPercent: config.reconnectJitterPercent
  })

  let socket
  let uuid
  let reconnectTimer
  let pinger
  let pongDeadline
  let stopping = false
  let fatalError = false
  let connected = false

  function start() {
    if (!stopping && !fatalError && !socket) connect()
  }

  function connect() {
    if (stopping || fatalError) return

    let trace
    const nextSocket = connectToRelay(config, {}, () => {
      enableSocketKeepAlive(nextSocket)
      const message = {
        kind: CONNECTION_KINDS.CONTROL,
        type,
        name
      }
      if (uuid) message.uuid = uuid
      sendJson(nextSocket, message)
    })
    trace = traceSocket?.(nextSocket, `${type}-control`)
    const clearReadinessDeadline = startSocketDeadline(
      nextSocket,
      config.handshakeTimeout,
      trace &&
        (() => {
          trace('registration-timeout', { timeoutMs: config.handshakeTimeout })
        })
    )

    const decodeMessage = createMessageDecoder(
      data => handleMessage(nextSocket, data, clearReadinessDeadline, trace),
      () => {
        trace?.('invalid-control-frame')
        nextSocket.destroy()
      }
    )
    socket = nextSocket

    nextSocket.on('data', decodeMessage)
    nextSocket.on('error', error => log.err(errorLabel, error.name || error.code, error.message))
    nextSocket.on('close', () => {
      clearReadinessDeadline()
      nextSocket.removeListener('data', decodeMessage)
      if (nextSocket !== socket) return

      const wasConnected = connected
      socket = undefined
      connected = false
      clearPinger()
      if (wasConnected) onDisconnected()
      if (!stopping && !fatalError) connectWithDelay(backoff.next())
    })
  }

  function handleMessage(messageSocket, data, clearReadinessDeadline, trace) {
    if (messageSocket !== socket) return
    const message = tryParseJSON(data)
    if (!message || typeof message !== 'object') return messageSocket.destroy()
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      return fail(
        `protocol version mismatch: ${type}=${PROTOCOL_VERSION}, relay=${message.protocolVersion ?? 'unknown'}`
      )
    }

    const registration = isRegistration(message)
    if (registration) uuid = message.registration.uuid
    if (!connected && registration) {
      clearReadinessDeadline()
      trace?.('relay-registered')
      connected = true
      backoff.reset()
      startPinger(messageSocket)
      onConnected()
    } else if (!connected && !message.error) {
      return messageSocket.destroy()
    }

    if (message.pong) {
      clearTimeout(pongDeadline)
      pongDeadline = undefined
      return
    }
    onMessage(message, {
      disconnect() {
        messageSocket.destroy()
      },
      fail
    })
  }

  function connectWithDelay(delay) {
    if (stopping || fatalError) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    debug?.(`${errorLabel} reconnect-scheduled`, { delayMs: delay })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
  }

  function startPinger(activeSocket) {
    clearPinger()
    pinger = setInterval(() => {
      if (pongDeadline) return
      pongDeadline = setTimeout(() => {
        log.info(`${errorLabel}: relay pong timed out; reconnecting`)
        activeSocket.destroy()
      }, config.heartbeatTimeout ?? 7_000)
      sendJson(activeSocket, { ping: true })
    }, config.heartbeatInterval ?? 2_000)
  }

  function clearPinger() {
    clearTimeout(pongDeadline)
    pongDeadline = undefined
    if (pinger) clearInterval(pinger)
    pinger = undefined
  }

  function fail(error) {
    if (fatalError) return
    fatalError = true
    const fatal = error instanceof Error ? error : new Error(error)
    log.info(fatal.message)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    clearPinger()
    if (socket && !socket.destroyed) socket.destroy()
    onFatal(fatal)
  }

  function send(message) {
    return sendJson(socket, message)
  }

  async function close() {
    stopping = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    clearPinger()
    await destroySockets(socket ? [socket] : [])
  }

  function getState() {
    return { connected, stopping, fatal: fatalError }
  }

  return { start, close, send, fail, getState }
}

function isRegistration(message) {
  return (
    message.registration &&
    typeof message.registration.uuid === 'string' &&
    message.registration.uuid.length > 0 &&
    typeof message.registration.ready === 'boolean'
  )
}

module.exports = { createPeerSession }
