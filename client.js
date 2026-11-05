'use strict'

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { connectToRelay } = require('./relay-connection')
const { randomUUID } = require('node:crypto')
const { loadEnvironment, getClientConfig } = require('./config')

if (require.main === module) loadEnvironment(process.argv[2])

const { createDiagnostics } = require('./diagnostics')
const { CONNECTION_KINDS, TYPES } = require('./protocol')
const { createMessaging } = require('./utils')
const { enableSocketKeepAlive, stopListening, destroySockets, waitForSockets, runCli } = require('./lifecycle')
const { bridgeWhenReady } = require('./data-readiness')
const { createPeerSession } = require('./peer-session')

function createClient(config = getClientConfig()) {
  const messaging = createMessaging(config)
  const { log, sendJson } = messaging
  const { traceSocket } = createDiagnostics(log)
  const events = new EventEmitter()
  const localConnections = new Set()
  const dataConnections = new Set()
  const pendingLocalConnections = new Map()

  /** @type {net.Server} */
  let localServer
  let serviceUuid
  let started = false
  let stopping = false
  let startPromise
  let closePromise
  let ready = false
  const controlSession = createPeerSession({
    config,
    messaging,
    type: TYPES.CLIENT,
    name: config.name,
    getUuid: () => serviceUuid,
    onConnected() {
      ready = false
      log.info('Connection to relay established, waiting for agent.')
    },
    onDisconnected() {
      if (!stopping) log.info('Connection to relay lost')
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
    if (stopping) return Promise.reject(new Error('client is closing'))
    if (startPromise) return startPromise

    localServer = net.createServer({ pauseOnConnect: true, allowHalfOpen: true }, handleLocalSocket)

    startPromise = new Promise((resolve, reject) => {
      const onStartupError = error => {
        localServer.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        localServer.off('error', onStartupError)
        localServer.on('error', onRuntimeError)
        started = true
        log.info(`Client listening on ${config.localHost}:${config.localPort}. Connecting to relay...`)
        controlSession.start()
        resolve()
      }

      localServer.once('error', onStartupError)
      localServer.once('listening', onListening)
      localServer.listen(config.localPort, config.localHost)
    }).catch(error => {
      startPromise = undefined
      throw error
    })
    return startPromise
  }

  function onRuntimeError(error) {
    log.info('Something went wrong with client relay. Stopping...\n', error.name || error.code, error.message)
    controlSession.fail(error)
  }

  /**
   * @param {net.Socket} localSocket
   * @returns {net.Socket|undefined}
   */
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

    const dataClient = connectToRelay(config, { allowHalfOpen: true }, () => {
      enableSocketKeepAlive(dataClient)
      sendJson(dataClient, {
        kind: CONNECTION_KINDS.DATA,
        type: TYPES.CLIENT,
        ticket
      })
    })
    const trace = traceSocket?.(dataClient, 'client-data', { ticket, requestId })
    dataConnections.add(dataClient)
    bridgeWhenReady(dataClient, localSocket, {
      messaging,
      timeout: config.handshakeTimeout,
      trace,
      onSetupFailed: () => controlSession.send({ cancelTunnel: { ticket } })
    })

    dataClient.on('error', error => log.err('DATA_CLIENT', error.name || error.code, error.message))
    dataClient.on('close', () => {
      dataConnections.delete(dataClient)
    })
  }

  function onMessage(message, controls) {
    if (message.error) return controls.fail(message.error)
    if (message.registration) {
      serviceUuid = message.registration.uuid
      ready = Boolean(message.registration.ready)
      if (!ready) closePendingLocalConnections()
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
    closePendingLocalConnections()

    closePromise = (async () => {
      await startPromise?.catch(() => {})
      const listenerClosed = stopListening(localServer)
      if (!force) await waitForSockets(dataConnections, config.shutdownTimeout)
      await Promise.all([destroySockets(localConnections), destroySockets(dataConnections)])
      await controlSession.close()
      await listenerClosed
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
