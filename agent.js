'use strict'

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { connectToRelay } = require('./relay-connection')
const { loadEnvironment, getAgentConfig } = require('./config')

if (require.main === module) loadEnvironment(process.argv[2])

const { createDiagnostics } = require('./diagnostics')
const { CONNECTION_KINDS, TYPES, ERRORS } = require('./protocol')
const { createMessaging } = require('./utils')
const { enableSocketKeepAlive, destroySockets, waitForSockets, runCli } = require('./lifecycle')
const { bridgeWhenReady } = require('./data-readiness')
const { createPeerSession } = require('./peer-session')

function createAgent(config = getAgentConfig()) {
  const messaging = createMessaging(config)
  const { log, sendJson } = messaging
  const { debug, traceSocket } = createDiagnostics(log)
  const events = new EventEmitter()
  const localConnections = new Set()
  const dataConnections = new Set()

  let started = false
  let stopping = false
  let closePromise
  let sameNameRetries = 3
  let serviceUuid
  let ready = false
  const controlSession = createPeerSession({
    config,
    messaging,
    type: TYPES.AGENT,
    name: config.name,
    getUuid: () => serviceUuid,
    onConnected() {
      ready = false
      log.info('Connection to relay established.')
    },
    onDisconnected() {
      if (!stopping) log.info('Connection to relay lost')
      ready = false
    },
    onMessage,
    onFatal(error) {
      events.emit('fatal', error)
    },
    errorLabel: 'SERVICE_AGENT'
  })

  function start() {
    if (stopping) return Promise.reject(new Error('agent is closing'))
    if (started) return Promise.resolve()
    started = true
    debug?.('agent-start', {
      relayHost: config.relayHost,
      relayPort: config.relayPort,
      useTLS: config.useTLS,
      targetHost: config.targetHost,
      targetPort: config.targetPort,
      handshakeTimeoutMs: config.handshakeTimeout
    })
    controlSession.start()
    return Promise.resolve()
  }

  function onMessage(message, controls) {
    if (message.error) {
      log.info(message.error)
      if (sameNameRetries > 0 && message.error === ERRORS.DUPLICATE_AGENT) {
        log.info('attempting to reconnect, retries left:', sameNameRetries)
        sameNameRetries--
        return controls.disconnect()
      }
      return controls.fail(message.error)
    }

    sameNameRetries = 3
    if (message.registration) {
      serviceUuid = message.registration.uuid
      ready = Boolean(message.registration.ready)
      return
    }
    if (!message.openTunnel?.ticket || !ready || stopping) return

    openDataConnection(message.openTunnel.ticket)
  }

  function openDataConnection(ticket) {
    const localSocket = new net.Socket({ allowHalfOpen: true })
    localConnections.add(localSocket)
    localSocket.on('error', error => log.err('LOCAL_SOCKET', error.name || error.code, error.message))
    localSocket.once('close', () => localConnections.delete(localSocket))
    let trace
    const dataAgent = connectToRelay(config, { allowHalfOpen: true }, () => {
      if (stopping) return dataAgent.destroy()
      enableSocketKeepAlive(dataAgent)

      trace?.('target-connecting', { host: config.targetHost, port: config.targetPort })
      traceSocket?.(localSocket, 'agent-target', { ticket })
      localSocket.on('connect', () => {
        if (dataAgent.destroyed || stopping) return localSocket.destroy()
        enableSocketKeepAlive(localSocket)

        sendJson(dataAgent, {
          kind: CONNECTION_KINDS.DATA,
          type: TYPES.AGENT,
          ticket
        })
      })
      localSocket.connect(config.targetPort, config.targetHost)
    })

    trace = traceSocket?.(dataAgent, 'agent-data', { ticket })
    dataConnections.add(dataAgent)
    bridgeWhenReady(dataAgent, localSocket, {
      messaging,
      timeout: config.handshakeTimeout,
      trace,
      onSetupFailed: () => controlSession.send({ cancelTunnel: { ticket } })
    })

    dataAgent.on('error', error => log.err('DATA_AGENT', error.name || error.code, error.message))
    dataAgent.on('close', () => {
      dataConnections.delete(dataAgent)
    })
  }

  function close({ force = false } = {}) {
    if (closePromise) return closePromise
    stopping = true

    closePromise = (async () => {
      if (!force) await waitForSockets(dataConnections, config.shutdownTimeout)
      await Promise.all([destroySockets(localConnections), destroySockets(dataConnections)])
      await controlSession.close()
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
      connected: controlSession.getState().connected,
      ready
    }
  }

  return Object.assign(events, { start, close, getState })
}

module.exports = { createAgent }

if (require.main === module) runCli(createAgent)
