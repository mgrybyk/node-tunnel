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
  portCount = 1,
  protocol = createJsonPeerProtocol({ messaging, type, name, portCount }),
  log = messaging.log,
  onConnected,
  onDisconnected,
  onMessage,
  onFatal,
  errorLabel = 'CONTROL_SOCKET'
}) {
  const { debug, traceSocket } = createDiagnostics(log)
  const backoff = createBackoff({
    baseDelay: config.reconnectDelay,
    maxDelay: config.reconnectMaxDelay,
    jitterPercent: config.reconnectJitterPercent
  })

  let socket
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
      protocol.register(nextSocket)
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

    const decodeMessage = protocol.createDecoder(
      event => handleMessage(nextSocket, event, clearReadinessDeadline, trace),
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
      protocol.disconnect?.()
      clearPinger()
      if (wasConnected) onDisconnected()
      if (!stopping && !fatalError) connectWithDelay(backoff.next())
    })
  }

  function handleMessage(messageSocket, { message, registration, pong, fatal }, clearReadinessDeadline, trace) {
    if (messageSocket !== socket) return
    if (fatal) return fail(fatal)
    if (!message) return messageSocket.destroy()
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

    if (pong) {
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
      protocol.ping(activeSocket)
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
    return protocol.send(socket, message)
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

function createJsonPeerProtocol({ messaging, type, name, portCount }) {
  const { sendJson, createMessageDecoder } = messaging
  let uuid
  return {
    register(socket) {
      const message = { kind: CONNECTION_KINDS.CONTROL, type, name, portCount }
      if (uuid) message.uuid = uuid
      sendJson(socket, message)
    },
    ping: socket => sendJson(socket, { ping: true }),
    send: sendJson,
    createDecoder(onEvent, onInvalid) {
      return createMessageDecoder(data => {
        const message = tryParseJSON(data)
        if (!message || typeof message !== 'object') return onEvent({})
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          return onEvent({
            fatal: `protocol version mismatch: ${type}=${PROTOCOL_VERSION}, relay=${message.protocolVersion ?? 'unknown'}`
          })
        }
        const registration = isRegistration(message)
        if (registration) uuid = message.registration.uuid
        onEvent({ message, registration, pong: message.pong })
      }, onInvalid)
    }
  }
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
