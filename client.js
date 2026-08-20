'use strict'

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { loadEnvironment, getClientConfig } = require('./config')

if (require.main === module) loadEnvironment(process.argv[2])

const { PROTOCOL_VERSION, CONNECTION_KINDS, TYPES } = require('./protocol')
const { tryParseJSON, log, writeMessage, createFirstMessageDecoder } = require('./utils')
const { enableSocketKeepAlive, stopListening, destroySockets, waitForSockets, runCli } = require('./lifecycle')
const { createTcpByteChannel, bridgeByteChannels } = require('./byte-channel')
const { createPeerSession } = require('./peer-session')

function createClient(config = getClientConfig()) {
  const events = new EventEmitter()
  const localConnections = new Set()
  const dataConnections = new Set()
  const pendingLocalConnections = new Map()

  let localServer
  let serviceUuid
  let started = false
  let stopping = false
  let closePromise
  let ready = false
  const controlSession = createPeerSession({
    config,
    type: TYPES.CLIENT,
    name: config.name,
    getUuid: () => serviceUuid,
    onConnected() {
      ready = false
      log.info('Connection to server established, waiting for agent.')
    },
    onDisconnected() {
      if (!stopping) log.info('Connection to server lost')
      ready = false
      closePendingLocalConnections()
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
    if (!ready || stopping) return localSocket.destroy()

    enableSocketKeepAlive(localSocket)
    localConnections.add(localSocket)
    const requestId = randomUUID()
    const timer = setTimeout(() => localSocket.destroy(), config.handshakeTimeout)
    pendingLocalConnections.set(requestId, { socket: localSocket, timer })

    localSocket.on('error', error => log.err('LOCAL_SOCKET', error.name || error.code, error.message))
    localSocket.on('close', () => {
      localConnections.delete(localSocket)
      const pending = pendingLocalConnections.get(requestId)
      if (!pending || pending.socket !== localSocket) return
      clearTimeout(pending.timer)
      pendingLocalConnections.delete(requestId)
    })

    if (!controlSession.send({ openTunnel: { requestId } })) localSocket.destroy()
  }

  function openDataConnection(requestId, ticket) {
    const pending = pendingLocalConnections.get(requestId)
    if (!pending) return controlSession.send({ cancelTunnel: { ticket } })
    pendingLocalConnections.delete(requestId)
    clearTimeout(pending.timer)

    const localSocket = pending.socket
    if (localSocket.destroyed || stopping) {
      controlSession.send({ cancelTunnel: { ticket } })
      return localSocket.destroy()
    }

    const dataClient = new net.Socket({ allowHalfOpen: true })
    let bridge
    dataConnections.add(dataClient)
    dataClient.setTimeout(config.handshakeTimeout, () => dataClient.destroy())
    dataClient.on('connect', () => {
      enableSocketKeepAlive(dataClient)
      writeMessage(
        dataClient,
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          kind: CONNECTION_KINDS.DATA,
          type: TYPES.CLIENT,
          ticket
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
      if (hadError) log.err('closed dataClient')
      if (!bridge && !localSocket.destroyed) {
        if (hadError) localSocket.destroy()
        else if (!localSocket.writableEnded) localSocket.end()
      }
    })

    localSocket.on('close', hadError => {
      if (!bridge && !dataClient.destroyed) {
        if (hadError) dataClient.destroy()
        else if (!dataClient.writableEnded) dataClient.end()
      }
    })

    dataClient.connect(config.serverPort, config.serverHost)
  }

  function onMessage(message, controls) {
    if (message.error) return controls.fail(message.error)
    if (message.agentDied) {
      ready = false
      return
    }
    if (message.registration) {
      serviceUuid = message.registration.uuid
      ready = Boolean(message.registration.ready)
      if (ready) log.info('Agent found, ready!')
      return
    }
    if (message.openTunnel) {
      return openDataConnection(message.openTunnel.requestId, message.openTunnel.ticket)
    }
    if (message.tunnelError) {
      const pending = pendingLocalConnections.get(message.tunnelError.requestId)
      if (pending) pending.socket.destroy()
      return
    }
    log.debug('ignored service message', message)
  }

  function closePendingLocalConnections() {
    for (const pending of pendingLocalConnections.values()) {
      clearTimeout(pending.timer)
      pending.socket.destroy()
    }
    pendingLocalConnections.clear()
  }

  function close({ force = false } = {}) {
    if (closePromise) return closePromise
    stopping = true
    stopListening(localServer)
    closePendingLocalConnections()

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
      pendingLocalConnections: pendingLocalConnections.size,
      dataConnections: dataConnections.size,
      connected: controlSession.getState().connected,
      ready
    }
  }

  return Object.assign(events, { start, close, getState })
}

module.exports = { createClient }

if (require.main === module) runCli(createClient)
