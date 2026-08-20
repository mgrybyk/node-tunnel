'use strict'

const net = require('node:net')
const { PROTOCOL_VERSION, CONNECTION_KINDS } = require('./protocol')
const { tryParseJSON, log, writeMessage, createMessageDecoder } = require('./utils')
const { enableSocketKeepAlive, createBackoff, destroySockets } = require('./lifecycle')

function createPeerSession({
  config,
  type,
  name,
  getUuid,
  onConnected,
  onDisconnected,
  onMessage,
  onFatal,
  errorLabel = 'CONTROL_SOCKET'
}) {
  const backoff = createBackoff({
    baseDelay: config.reconnectDelay,
    maxDelay: config.reconnectMaxDelay,
    jitterPercent: config.reconnectJitterPercent
  })

  let socket
  let reconnectTimer
  let pinger
  let stopping = false
  let fatalError = false
  let connected = false
  let connectionLossReported = false

  function start() {
    if (!stopping && !fatalError && !socket) connect()
  }

  function connect() {
    if (stopping || fatalError) return

    const nextSocket = new net.Socket()
    const decodeMessage = createMessageDecoder(
      data => handleMessage(nextSocket, data),
      () => nextSocket.destroy()
    )
    socket = nextSocket

    nextSocket.on('data', decodeMessage)
    nextSocket.on('connect', () => {
      enableSocketKeepAlive(nextSocket)
      connected = true
      connectionLossReported = false
      const message = { protocolVersion: PROTOCOL_VERSION, kind: CONNECTION_KINDS.CONTROL, type, name }
      const uuid = getUuid()
      if (uuid) message.uuid = uuid
      writeMessage(nextSocket, JSON.stringify(message))
      startPinger(nextSocket)
      onConnected()
    })
    nextSocket.on('error', error => log.err(errorLabel, error.name || error.code, error.message))
    nextSocket.on('close', () => {
      nextSocket.removeListener('data', decodeMessage)
      if (nextSocket !== socket) return

      socket = undefined
      connected = false
      clearPinger()
      if (!connectionLossReported) {
        connectionLossReported = true
        onDisconnected()
      }
      if (!stopping && !fatalError) connectWithDelay(backoff.next())
    })
    nextSocket.connect(config.serverPort, config.serverHost)
  }

  function handleMessage(messageSocket, data) {
    const message = tryParseJSON(data)
    if (!message || typeof message !== 'object') return messageSocket.destroy()
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      return fail(
        `protocol version mismatch: ${type}=${PROTOCOL_VERSION}, server=${message.protocolVersion ?? 'unknown'}`
      )
    }

    backoff.reset()
    if (message.pong) return
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
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
  }

  function startPinger(activeSocket) {
    clearPinger()
    pinger = setInterval(() => {
      writeMessage(activeSocket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ping: Math.random() }))
    }, 15_000)
  }

  function clearPinger() {
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
    return writeMessage(socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message }))
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

module.exports = { createPeerSession }
