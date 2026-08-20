'use strict'

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { loadEnvironment, getClientConfig } = require('./config')

if (require.main === module) loadEnvironment(process.argv[2])

const { PROTOCOL_VERSION, TYPES } = require('./protocol')
const { tryParseJSON, log, writeMessage, createFirstMessageDecoder } = require('./utils')
const { enableSocketKeepAlive, stopListening, destroySockets, waitForSockets, runCli } = require('./lifecycle')
const { createTcpByteChannel, bridgeByteChannels } = require('./byte-channel')
const { createPeerSession } = require('./peer-session')

function createClient(config = getClientConfig()) {
  const events = new EventEmitter()
  const localConnections = new Set()
  const dataConnections = new Set()

  let localServer
  let dataJson
  let started = false
  let stopping = false
  let closePromise
  let isDataClient = false
  const controlSession = createPeerSession({
    config,
    type: TYPES.CLIENT,
    name: config.name,
    getUuid: () => dataJson?.uuid,
    onConnected() {
      log.info('Connection to server established, waiting for agent.')
      if (dataJson) isDataClient = true
    },
    onDisconnected() {
      if (!stopping) log.info('Connection to server lost')
      isDataClient = false
    },
    onMessage,
    onFatal(error) {
      events.emit('fatal', error)
    },
    errorLabel: 'SERVICE_SOCKET'
  })

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
        controlSession.start()
        resolve()
      }

      localServer.once('error', onStartupError)
      localServer.once('listening', onListening)
      localServer.listen(config.localPort)
    })
  }

  function onRuntimeError(error) {
    log.info('Something went wrong with client server. Stopping...\n', error.name || error.code, error.message)
    controlSession.fail(error)
  }

  function handleLocalSocket(localSocket) {
    if (!isDataClient || !dataJson || stopping) return localSocket.destroy()

    enableSocketKeepAlive(localSocket)
    localConnections.add(localSocket)
    const dataClient = new net.Socket({ allowHalfOpen: true })
    let bridge

    dataClient.uuid = `client-${randomUUID()}`
    dataConnections.add(dataClient)
    dataClient.setTimeout(config.handshakeTimeout, () => dataClient.destroy())
    dataClient.on('connect', () => {
      enableSocketKeepAlive(dataClient)
      writeMessage(
        dataClient,
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          type: TYPES.CLIENT,
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
        bridge = bridgeByteChannels(
          createTcpByteChannel(dataClient, { initialData: remainder }),
          createTcpByteChannel(localSocket)
        )
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
      if (!bridge && !localSocket.destroyed) {
        if (hadError) localSocket.destroy()
        else if (!localSocket.writableEnded) localSocket.end()
      }
    })

    localSocket.on('error', error => log.err('LOCAL_SOCKET', error.name || error.code, error.message))
    localSocket.on('close', hadError => {
      localConnections.delete(localSocket)
      if (!bridge && !dataClient.destroyed) {
        if (hadError) dataClient.destroy()
        else if (!dataClient.writableEnded) dataClient.end()
      }
    })

    dataClient.connect(dataJson.port, config.serverHost)
  }

  function onMessage(message, controls) {
    if (message.error) return controls.fail(message.error)
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

  function close({ force = false } = {}) {
    if (closePromise) return closePromise
    stopping = true
    stopListening(localServer)

    closePromise = (async () => {
      if (!force) await waitForSockets(dataConnections, config.shutdownTimeout)
      await Promise.all([destroySockets(localConnections), destroySockets(dataConnections)])
      await controlSession.close()
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
      connected: controlSession.getState().connected,
      ready: isDataClient
    }
  }

  return Object.assign(events, { start, close, getState })
}

module.exports = { createClient }

if (require.main === module) runCli(createClient)
