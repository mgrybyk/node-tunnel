'use strict'

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { loadEnvironment, getAgentConfig } = require('./config')

if (require.main === module) loadEnvironment(process.argv[2])

const { PROTOCOL_VERSION, TYPES, ERRORS } = require('./protocol')
const { log, writeMessage } = require('./utils')
const { enableSocketKeepAlive, destroySockets, waitForSockets, runCli } = require('./lifecycle')
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
  let dataPort
  const controlSession = createPeerSession({
    config,
    type: TYPES.AGENT,
    name: config.name,
    getUuid: () => serviceUuid,
    onConnected() {
      log.info('Connection to server established.')
    },
    onDisconnected() {
      if (!stopping) log.info('Connection to server lost')
      dataPort = undefined
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
    if (message.uuid && message.port) {
      serviceUuid = message.uuid
      dataPort = message.port
      return log.debug('setting port and uuid:', message.port, message.uuid)
    }
    if (!message.data || !dataPort || stopping) return log.debug('ignored service message', message)

    openDataConnection()
  }

  function openDataConnection() {
    const dataAgent = new net.Socket({ allowHalfOpen: true })
    let localSocket
    let bridge

    dataConnections.add(dataAgent)
    dataAgent.uuid = `agent-${randomUUID()}`
    dataAgent.setTimeout(config.handshakeTimeout, () => dataAgent.destroy())
    dataAgent.on('error', error => log.err('DATA_AGENT', error.name || error.code, error.message))
    dataAgent.on('close', hadError => {
      dataConnections.delete(dataAgent)
      if (hadError) log.debug(`closed dataAgent '${dataAgent.uuid}'`)
      if (!bridge && localSocket && !localSocket.destroyed) {
        if (hadError) localSocket.destroy()
        else if (!localSocket.writableEnded) localSocket.end()
      }
    })
    dataAgent.on('connect', () => {
      if (stopping) return dataAgent.destroy()
      enableSocketKeepAlive(dataAgent)

      localSocket = new net.Socket({ allowHalfOpen: true })
      localConnections.add(localSocket)
      localSocket.setTimeout(config.handshakeTimeout, () => localSocket.destroy())
      localSocket.on('error', error => log.err('LOCAL_SOCKET', error.name || error.code, error.message))
      localSocket.on('connect', () => {
        if (dataAgent.destroyed || stopping) return localSocket.destroy()
        enableSocketKeepAlive(localSocket)

        writeMessage(
          dataAgent,
          JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            type: TYPES.AGENT,
            uuid: dataAgent.uuid
          })
        )
        bridge = bridgeByteChannels(createTcpByteChannel(dataAgent), createTcpByteChannel(localSocket))
      })
      localSocket.on('close', hadError => {
        localConnections.delete(localSocket)
        if (!bridge && !dataAgent.destroyed) {
          if (hadError) dataAgent.destroy()
          else if (!dataAgent.writableEnded) dataAgent.end()
        }
      })
      localSocket.connect(config.targetPort, config.targetHost)
    })
    dataAgent.connect(dataPort, config.serverHost)
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
      dataPort
    }
  }

  return Object.assign(events, { start, close, getState })
}

module.exports = { createAgent }

if (require.main === module) runCli(createAgent)
