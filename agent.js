'use strict'

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { connectToRelay } = require('./relay-connection')
const { loadEnvironment, getAgentConfig } = require('./config')

if (require.main === module) loadEnvironment(process.argv[2])

const { traceSocket } = require('./diagnostics')
const { PROTOCOL_VERSION, CONNECTION_KINDS, TYPES, ERRORS } = require('./protocol')
const { tryParseJSON, log, writeMessage, createFirstMessageDecoder } = require('./utils')
const { enableSocketKeepAlive, startSocketDeadline, destroySockets, waitForSockets, runCli } = require('./lifecycle')
const { createTcpByteChannel, bridgeByteChannels } = require('./byte-channel')
const { createPeerSession } = require('./peer-session')

function createAgent(config = getAgentConfig()) {
  const events = new EventEmitter()
  const localConnections = new Set()
  const dataConnections = new Set()

  let started = false
  let stopping = false
  let closePromise
  let sameNameRetries = 3
  let serviceUuid
  let ready = false
  let tunnelSequence = 0
  const controlSession = createPeerSession({
    config,
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
    if (started) return Promise.resolve()
    if (stopping) return Promise.reject(new Error('agent is closing'))
    started = true
    log.debug(new Date().toISOString(), 'agent-start', {
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
      return log.debug('agent registered:', serviceUuid)
    }
    if (!message.openTunnel?.ticket || !ready || stopping) return log.debug('ignored service message', message)

    log.debug(new Date().toISOString(), 'agent tunnel requested')
    openDataConnection(message.openTunnel.ticket)
  }

  function openDataConnection(ticket) {
    const tunnelId = ++tunnelSequence
    let localSocket
    let bridge
    let trace = () => {}
    const dataAgent = connectToRelay(config, { allowHalfOpen: true }, () => {
      if (stopping) return dataAgent.destroy()
      enableSocketKeepAlive(dataAgent)

      localSocket = new net.Socket({ allowHalfOpen: true })
      trace('target-connecting', { host: config.targetHost, port: config.targetPort })
      const traceTarget = traceSocket(localSocket, `agent-target-${tunnelId}`)
      localConnections.add(localSocket)
      const clearTargetDeadline = startSocketDeadline(localSocket, config.handshakeTimeout, () => {
        traceTarget('target-connect-timeout')
      })
      localSocket.on('error', error => log.err('LOCAL_SOCKET', error.name || error.code, error.message))
      localSocket.on('connect', () => {
        clearTargetDeadline()
        trace('data-registration-sent')
        if (dataAgent.destroyed || stopping) return localSocket.destroy()
        enableSocketKeepAlive(localSocket)

        writeMessage(
          dataAgent,
          JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            kind: CONNECTION_KINDS.DATA,
            type: TYPES.AGENT,
            ticket
          })
        )
      })
      localSocket.on('close', () => {
        clearTargetDeadline()
        localConnections.delete(localSocket)
        if (!bridge && !dataAgent.destroyed) {
          controlSession.send({ cancelTunnel: { ticket } })
          dataAgent.destroy()
        }
      })
      localSocket.connect(config.targetPort, config.targetHost)
    })

    trace = traceSocket(dataAgent, `agent-data-${tunnelId}`)
    dataConnections.add(dataAgent)
    const clearReadinessDeadline = startSocketDeadline(dataAgent, config.handshakeTimeout, () => {
      trace('data-readiness-timeout', { timeoutMs: config.handshakeTimeout })
    })
    const decodeReady = createFirstMessageDecoder(
      (message, remainder) => {
        const readyMessage = tryParseJSON(message)
        if (!readyMessage || readyMessage.protocolVersion !== PROTOCOL_VERSION || !readyMessage.ready || !localSocket) {
          trace('invalid-data-ready')
          return dataAgent.destroy()
        }

        trace('bridge-ready', { remainderBytes: remainder.length })
        clearReadinessDeadline()
        dataAgent.removeListener('data', decodeReady)
        bridge = bridgeByteChannels(
          createTcpByteChannel(dataAgent, { initialData: remainder }),
          createTcpByteChannel(localSocket)
        )
      },
      () => {
        trace('invalid-data-frame')
        dataAgent.destroy()
      }
    )

    dataAgent.on('data', decodeReady)
    dataAgent.on('error', error => log.err('DATA_AGENT', error.name || error.code, error.message))
    dataAgent.on('end', () => {
      if (!bridge) dataAgent.destroy()
    })
    dataAgent.on('close', hadError => {
      clearReadinessDeadline()
      dataAgent.removeListener('data', decodeReady)
      dataConnections.delete(dataAgent)
      if (hadError) log.debug('closed dataAgent')
      if (!bridge) controlSession.send({ cancelTunnel: { ticket } })
      if (!bridge && localSocket && !localSocket.destroyed) {
        localSocket.destroy()
      }
    })
  }

  function close({ force = false } = {}) {
    if (closePromise) return closePromise
    stopping = true

    closePromise = (async () => {
      if (!force) await waitForSockets(dataConnections, config.shutdownTimeout)
      await Promise.all([destroySockets(localConnections), destroySockets(dataConnections)])
      await controlSession.close()
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
      connected: controlSession.getState().connected,
      ready
    }
  }

  return Object.assign(events, { start, close, getState })
}

module.exports = { createAgent }

if (require.main === module) runCli(createAgent)
