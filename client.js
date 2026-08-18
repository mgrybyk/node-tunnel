'use strict'

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { loadEnvironment, getClientConfig } = require('./config')

if (require.main === module) loadEnvironment(process.argv[2])

const { PROTOCOL_VERSION, ERRORS } = require('./protocol')
const { tryParseJSON, log, writeMessage, createMessageDecoder, createFirstMessageDecoder } = require('./utils')
const { createBackoff, stopListening, destroySockets, waitForSockets, runCli } = require('./lifecycle')

function createClient(config = getClientConfig()) {
  const events = new EventEmitter()
  const localConnections = new Set()
  const dataConnections = new Set()
  const backoff = createBackoff({
    baseDelay: config.reconnectDelay,
    maxDelay: config.reconnectMaxDelay,
    jitterPercent: config.reconnectJitterPercent
  })

  let localServer
  let serviceClient
  let reconnectTimer
  let pinger
  let dataJson
  let started = false
  let stopping = false
  let closePromise
  let fatalError = false
  let isDataClient = false
  let connectionToServerLost = false

  function start() {
    if (started) return Promise.resolve()
    if (stopping) return Promise.reject(new Error('client is closing'))

    localServer = net.createServer({ pauseOnConnect: true, allowHalfOpen: true }, handleLocalSocket)

    return new Promise((resolve, reject) => {
      const onStartupError = error => {
        localServer.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        localServer.off('error', onStartupError)
        localServer.on('error', onRuntimeError)
        started = true
        log.info(`Client listening on port ${config.localPort}. Connecting to server...`)
        connect()
        resolve()
      }

      localServer.once('error', onStartupError)
      localServer.once('listening', onListening)
      localServer.listen(config.localPort)
    })
  }

  function onRuntimeError(error) {
    log.info('Something went wrong with client server. Stopping...\n', error.name || error.code, error.message)
    stopFatal(error.message)
  }

  function handleLocalSocket(localSocket) {
    if (!isDataClient || !dataJson || stopping) return localSocket.destroy()

    localConnections.add(localSocket)
    const dataClient = new net.Socket({ allowHalfOpen: true })
    let isPiped = false

    dataClient.uuid = `client-${randomUUID()}`
    dataConnections.add(dataClient)
    dataClient.setTimeout(config.handshakeTimeout, () => dataClient.destroy())
    dataClient.on('connect', () => {
      writeMessage(
        dataClient,
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          type: 'client',
          uuid: dataClient.uuid
        })
      )
    })

    const decodeReady = createFirstMessageDecoder(
      (message, remainder) => {
        const readyMessage = tryParseJSON(message)
        if (!readyMessage || readyMessage.protocolVersion !== PROTOCOL_VERSION || !readyMessage.ready) {
          return dataClient.destroy()
        }

        dataClient.removeListener('data', decodeReady)
        dataClient.setTimeout(0)
        dataClient.pipe(localSocket).pipe(dataClient)
        isPiped = true
        if (remainder.length > 0) localSocket.write(remainder)
        localSocket.resume()
      },
      () => dataClient.destroy()
    )

    dataClient.on('data', decodeReady)
    dataClient.on('error', error => log.err('DATA_CLIENT', error.name || error.code, error.message))
    dataClient.on('close', hadError => {
      dataClient.removeListener('data', decodeReady)
      dataConnections.delete(dataClient)
      if (hadError) log.err(`closed dataClient (${dataClient.uuid})`)
      if (!localSocket.destroyed) {
        if (hadError) localSocket.destroy()
        else if (!localSocket.writableEnded) localSocket.end()
      }
    })

    localSocket.on('error', error => log.err('LOCAL_SOCKET', error.name || error.code, error.message))
    localSocket.on('close', hadError => {
      localConnections.delete(localSocket)
      const wasPiped = isPiped
      if (wasPiped) {
        dataClient.unpipe(localSocket)
        localSocket.unpipe(dataClient)
        isPiped = false
      }
      if (!dataClient.destroyed) {
        if (hadError || !wasPiped) dataClient.destroy()
        else if (!dataClient.writableEnded) dataClient.end()
      }
    })

    dataClient.connect(dataJson.port, config.serverHost)
  }

  function onServiceMessage(socket, data) {
    const message = tryParseJSON(data)
    if (!message || typeof message !== 'object') return socket.destroy()
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      return stopFatal(
        `${ERRORS.VERSION_MISMATCH}: client=${PROTOCOL_VERSION}, server=${message.protocolVersion ?? 'unknown'}`
      )
    }
    if (message.error) return stopFatal(message.error)

    backoff.reset()
    if (message.pong) return
    if (message.agentDied || !message.port) {
      dataJson = null
      isDataClient = false
      return
    }

    dataJson = message
    log.debug(dataJson)
    isDataClient = true
    log.info('Agent found, ready!')
  }

  function connect() {
    if (stopping || fatalError) return

    const socket = new net.Socket()
    const decodeServiceMessage = createMessageDecoder(
      data => onServiceMessage(socket, data),
      () => socket.destroy()
    )
    serviceClient = socket

    socket.on('data', decodeServiceMessage)
    socket.on('connect', () => {
      connectionToServerLost = false
      log.info('Connection to server established, waiting for agent.')
      const message = { protocolVersion: PROTOCOL_VERSION, type: 'client', name: config.name }
      if (dataJson?.uuid) message.uuid = dataJson.uuid
      writeMessage(socket, JSON.stringify(message))
      startPinger(socket)
      if (dataJson) isDataClient = true
    })
    socket.on('error', error => log.err('SERVICE_SOCKET', error.name || error.code, error.message))
    socket.on('close', () => {
      socket.removeListener('data', decodeServiceMessage)
      if (socket !== serviceClient) return

      if (!connectionToServerLost && !stopping) {
        connectionToServerLost = true
        log.info('Connection to server lost')
      }
      clearPinger()
      isDataClient = false
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
    if (serviceClient && !serviceClient.destroyed) serviceClient.destroy()
    events.emit('fatal', new Error(message))
  }

  function close({ force = false } = {}) {
    if (closePromise) return closePromise
    stopping = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    clearPinger()
    stopListening(localServer)

    closePromise = (async () => {
      if (!force) await waitForSockets(dataConnections, config.shutdownTimeout)
      await Promise.all([destroySockets(localConnections), destroySockets(dataConnections)])
      await destroySockets(serviceClient ? [serviceClient] : [])
      if (localServer?.closeAllConnections) localServer.closeAllConnections()
      await new Promise(resolve => setImmediate(resolve))
      started = false
      log.info(`Client stopped. Local connections: ${localConnections.size}, data connections: ${dataConnections.size}`)
    })()

    return closePromise
  }

  function getState() {
    return {
      started,
      stopping,
      localConnections: localConnections.size,
      dataConnections: dataConnections.size,
      connected: Boolean(serviceClient && !serviceClient.destroyed),
      ready: isDataClient
    }
  }

  return Object.assign(events, { start, close, getState })
}

module.exports = { createClient }

if (require.main === module) runCli(createClient)
