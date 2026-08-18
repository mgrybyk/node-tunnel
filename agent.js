'use strict'

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { loadEnvironment, getAgentConfig } = require('./config')

if (require.main === module) loadEnvironment(process.argv[2])

const { PROTOCOL_VERSION, ERRORS } = require('./protocol')
const { tryParseJSON, log, writeMessage, createMessageDecoder } = require('./utils')
const { createBackoff, destroySockets, waitForSockets, runCli } = require('./lifecycle')

function createAgent(config = getAgentConfig()) {
  const events = new EventEmitter()
  const localConnections = new Set()
  const dataConnections = new Set()
  const backoff = createBackoff({
    baseDelay: config.reconnectDelay,
    maxDelay: config.reconnectMaxDelay,
    jitterPercent: config.reconnectJitterPercent
  })

  let started = false
  let stopping = false
  let closePromise
  let fatalError = false
  let sameNameRetries = 3
  let serviceUuid
  let dataPort
  let serviceAgent
  let reconnectTimer
  let pinger
  let connectionToServerLost = false

  function start() {
    if (started) return Promise.resolve()
    if (stopping) return Promise.reject(new Error('agent is closing'))
    started = true
    connect()
    return Promise.resolve()
  }

  function onServiceMessage(socket, data) {
    const dataJson = tryParseJSON(data)
    if (!dataJson || typeof dataJson !== 'object') return socket.destroy()

    if (dataJson.protocolVersion !== PROTOCOL_VERSION) {
      return stopFatal(
        `${ERRORS.VERSION_MISMATCH}: agent=${PROTOCOL_VERSION}, server=${dataJson.protocolVersion ?? 'unknown'}`
      )
    }

    if (dataJson.error) {
      log.info(dataJson.error)
      if (sameNameRetries > 0 && dataJson.error === ERRORS.DUPLICATE_AGENT) {
        log.info('attempting to reconnect, retries left:', sameNameRetries)
        sameNameRetries--
        return socket.destroy()
      }
      return stopFatal(dataJson.error)
    }

    backoff.reset()
    sameNameRetries = 3
    if (dataJson.pong) return
    if (dataJson.uuid && dataJson.port) {
      serviceUuid = dataJson.uuid
      dataPort = dataJson.port
      return log.debug('setting port and uuid:', dataJson.port, dataJson.uuid)
    }
    if (!dataJson.data || !dataPort || stopping) return log.debug('ignored service message', dataJson)

    openDataConnection()
  }

  function openDataConnection() {
    const dataAgent = new net.Socket({ allowHalfOpen: true })
    let localSocket
    let isPiped = false

    dataConnections.add(dataAgent)
    dataAgent.uuid = `agent-${randomUUID()}`
    dataAgent.setTimeout(config.handshakeTimeout, () => dataAgent.destroy())
    dataAgent.on('error', error => log.err('DATA_AGENT', error.name || error.code, error.message))
    dataAgent.on('close', hadError => {
      dataConnections.delete(dataAgent)
      if (hadError) log.debug(`closed dataAgent '${dataAgent.uuid}'`)
      if (localSocket && !localSocket.destroyed) {
        if (hadError) localSocket.destroy()
        else if (!localSocket.writableEnded) localSocket.end()
      }
    })
    dataAgent.on('connect', () => {
      if (stopping) return dataAgent.destroy()

      localSocket = new net.Socket({ allowHalfOpen: true })
      localConnections.add(localSocket)
      localSocket.setTimeout(config.handshakeTimeout, () => localSocket.destroy())
      localSocket.on('error', error => log.err('LOCAL_SOCKET', error.name || error.code, error.message))
      localSocket.on('connect', () => {
        if (dataAgent.destroyed || stopping) return localSocket.destroy()

        dataAgent.setTimeout(0)
        localSocket.setTimeout(0)
        writeMessage(
          dataAgent,
          JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            type: 'agent',
            uuid: dataAgent.uuid
          })
        )
        dataAgent.pipe(localSocket).pipe(dataAgent)
        isPiped = true
      })
      localSocket.on('close', hadError => {
        localConnections.delete(localSocket)
        if (isPiped) {
          dataAgent.unpipe(localSocket)
          localSocket.unpipe(dataAgent)
          isPiped = false
        }
        if (!dataAgent.destroyed) {
          if (hadError) dataAgent.destroy()
          else if (!dataAgent.writableEnded) dataAgent.end()
        }
      })
      localSocket.connect(config.targetPort, config.targetHost)
    })
    dataAgent.connect(dataPort, config.serverHost)
  }

  function connect() {
    if (stopping || fatalError) return

    const socket = new net.Socket()
    const decodeServiceMessage = createMessageDecoder(
      data => onServiceMessage(socket, data),
      () => socket.destroy()
    )
    serviceAgent = socket

    socket.on('data', decodeServiceMessage)
    socket.on('connect', () => {
      connectionToServerLost = false
      log.info('Connection to server established.')
      const message = { protocolVersion: PROTOCOL_VERSION, type: 'agent', name: config.name }
      if (serviceUuid) message.uuid = serviceUuid
      writeMessage(socket, JSON.stringify(message))
      startPinger(socket)
    })
    socket.on('error', error => log.err('SERVICE_AGENT', error.name || error.code, error.message))
    socket.on('close', () => {
      socket.removeListener('data', decodeServiceMessage)
      if (socket !== serviceAgent) return

      if (!connectionToServerLost && !stopping) {
        connectionToServerLost = true
        log.info('Connection to server lost')
      }
      clearPinger()
      dataPort = undefined
      if (!stopping && !fatalError) connectWithDelay(backoff.next())
    })
    socket.connect(config.serverPort, config.serverHost)
  }

  function connectWithDelay(delay) {
    if (stopping || fatalError) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
  }

  function startPinger(socket) {
    clearPinger()
    pinger = setInterval(() => {
      writeMessage(socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ping: Math.random() }))
    }, 15_000)
  }

  function clearPinger() {
    if (pinger) clearInterval(pinger)
    pinger = undefined
  }

  function stopFatal(message) {
    if (fatalError) return
    fatalError = true
    log.info(message)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    clearPinger()
    if (serviceAgent && !serviceAgent.destroyed) serviceAgent.destroy()
    events.emit('fatal', new Error(message))
  }

  function close({ force = false } = {}) {
    if (closePromise) return closePromise
    stopping = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    clearPinger()

    closePromise = (async () => {
      if (!force) await waitForSockets(dataConnections, config.shutdownTimeout)
      destroySockets(localConnections)
      destroySockets(dataConnections)
      if (serviceAgent) serviceAgent.destroy()
      await new Promise(resolve => setImmediate(resolve))
      started = false
      log.info(`Agent stopped. Local connections: ${localConnections.size}, data connections: ${dataConnections.size}`)
    })()

    return closePromise
  }

  function getState() {
    return {
      started,
      stopping,
      localConnections: localConnections.size,
      dataConnections: dataConnections.size,
      connected: Boolean(serviceAgent && !serviceAgent.destroyed),
      dataPort
    }
  }

  return Object.assign(events, { start, close, getState })
}

module.exports = { createAgent }

if (require.main === module) runCli(createAgent)
