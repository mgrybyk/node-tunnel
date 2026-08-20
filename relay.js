'use strict'

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { loadEnvironment, getRelayConfig } = require('./config')

if (require.main === module) loadEnvironment(process.argv[2])

const { PROTOCOL_VERSION, CONNECTION_KINDS, TYPES, ERRORS } = require('./protocol')
const {
  tryParseJSON,
  log,
  verifyDataJson,
  writeMessage,
  createMessageDecoder,
  createFirstMessageDecoder
} = require('./utils')
const { enableSocketKeepAlive, stopListening, destroySockets, runCli } = require('./lifecycle')
const { createTcpDataTransport } = require('./tcp-data-transport')
const { CLIENT, AGENT } = TYPES

function createRelay(config = getRelayConfig()) {
  const events = new EventEmitter()
  const connections = Object.create(null)
  const controlSockets = new Set()
  const handshakeSockets = new Set()
  const dataTransport = createTcpDataTransport(config)

  let relayRelay
  let started = false
  let closing = false
  let closePromise
  let fatalError = false

  function start() {
    if (started) return Promise.resolve()
    if (closing) return Promise.reject(new Error('relay is closing'))

    relayRelay = net.createServer({ allowHalfOpen: true }, handleIncomingSocket)

    return new Promise((resolve, reject) => {
      const onStartupError = error => {
        relayRelay.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        relayRelay.off('error', onStartupError)
        relayRelay.on('error', onRuntimeError)
        started = true
        log.info(`Relay listening on ${config.serviceHost}:${config.servicePort}`)
        resolve()
      }

      relayRelay.once('error', onStartupError)
      relayRelay.once('listening', onListening)
      relayRelay.listen(config.servicePort, config.serviceHost)
    })
  }

  function onRuntimeError(error) {
    log.info('Something went wrong with relay. Stopping...\n', error.name || error.code, error.message)
    emitFatal(error)
  }

  function handleIncomingSocket(socket) {
    if (closing) return socket.destroy()

    enableSocketKeepAlive(socket)
    handshakeSockets.add(socket)
    socket.setTimeout(config.handshakeTimeout, () => socket.destroy())
    const onHandshakeError = error => log.err('RELAY_SOCKET', error.name || error.code, error.message)
    const decodeFirstMessage = createFirstMessageDecoder(
      (data, remainder) => classifySocket(socket, decodeFirstMessage, onHandshakeError, data, remainder),
      () => socket.destroy()
    )

    socket.on('data', decodeFirstMessage)
    socket.on('error', onHandshakeError)
    socket.on('close', () => handshakeSockets.delete(socket))
  }

  function classifySocket(socket, decodeFirstMessage, onHandshakeError, data, remainder) {
    socket.removeListener('data', decodeFirstMessage)
    socket.removeListener('error', onHandshakeError)
    handshakeSockets.delete(socket)

    const message = tryParseJSON(data)
    log.debug(message)
    if (!message || typeof message !== 'object') return socket.destroy()
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      sendJson(socket, {
        error: ERRORS.VERSION_MISMATCH,
        receivedProtocolVersion: message.protocolVersion ?? null
      })
      return socket.end()
    }

    if (message.kind === CONNECTION_KINDS.DATA) {
      socket.pause()
      return dataTransport.acceptSocket(socket, message, remainder)
    }
    if (message.kind !== CONNECTION_KINDS.CONTROL) return socket.destroy()
    registerControlSocket(socket, message, remainder)
  }

  function registerControlSocket(socket, message, remainder) {
    if (!verifyDataJson(message) || !message.name) return socket.destroy()

    if (!connections[message.name]) connections[message.name] = Object.create(null)
    const connectionGroup = connections[message.name]
    if (!connectionGroup[message.type]) connectionGroup[message.type] = Object.create(null)
    const roleGroup = connectionGroup[message.type]
    if (!message.uuid) message.uuid = randomUUID()

    if (roleGroup[message.uuid]) {
      const connection = roleGroup[message.uuid]
      const deadSocket = connection.socket
      log.info(`${message.type} "${message.name}" reconnected!`)
      dataTransport.replaceSession(deadSocket, socket)
      socket.cProps = { ...deadSocket.cProps }
      connection.socket = socket
      delete deadSocket.cProps
      deadSocket.destroy()
      finishControlRegistration(socket, remainder)
      notifyRegistration(socket, connectionGroup)
      return
    }

    if (message.type === AGENT && Object.keys(roleGroup).length > 0) {
      sendJson(socket, { error: ERRORS.DUPLICATE_AGENT })
      return socket.end()
    }

    socket.cProps = { name: message.name, uuid: message.uuid, type: message.type }
    roleGroup[message.uuid] = { socket }
    finishControlRegistration(socket, remainder)

    if (message.type === CLIENT) registerClient(socket, connectionGroup)
    else registerAgent(socket, connectionGroup)
  }

  function finishControlRegistration(socket, remainder) {
    controlSockets.add(socket)
    socket.setTimeout(config.controlIdleTimeout)
    const decodeMessage = createMessageDecoder(
      data => onControlMessage(socket, data),
      () => socket.destroy()
    )
    socket.controlDecoder = decodeMessage
    socket.on('data', decodeMessage)
    const finishReadableSide = () => {
      if (!socket.writableEnded) socket.end()
    }
    if (socket.readableEnded) finishReadableSide()
    else socket.on('end', finishReadableSide)
    socket.on('error', error => log.err('CONTROL_SOCKET', error.name || error.code, error.message))
    socket.on('close', () => {
      controlSockets.delete(socket)
      socket.removeListener('data', decodeMessage)
      cleanupControlSocket(socket)
    })
    if (remainder.length > 0) decodeMessage(remainder)
  }

  function registerClient(socket, connectionGroup) {
    log.info(`Client "${socket.cProps.name}" connected.`)
    notifyRegistration(socket, connectionGroup)
  }

  function registerAgent(socket, connectionGroup) {
    log.info(`Agent "${socket.cProps.name}" connected on shared relay port ${config.servicePort}`)
    notifyRegistration(socket, connectionGroup)

    const clientGroup = connectionGroup[CLIENT]
    if (!clientGroup) return
    for (const client of Object.values(clientGroup)) notifyRegistration(client.socket, connectionGroup)
  }

  function notifyRegistration(socket, connectionGroup) {
    const agent = firstConnection(connectionGroup[AGENT])
    sendJson(socket, {
      registration: {
        uuid: socket.cProps.uuid,
        ready: socket.cProps.type === AGENT || Boolean(agent?.socket && !agent.socket.destroyed)
      }
    })
  }

  function onControlMessage(socket, data) {
    const message = tryParseJSON(data)
    if (!message || typeof message !== 'object') return socket.destroy()
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      sendJson(socket, { error: ERRORS.VERSION_MISMATCH, receivedProtocolVersion: message.protocolVersion ?? null })
      return socket.end()
    }
    if (message.ping) return sendJson(socket, { pong: Math.random() })

    const cancelTicket = message.cancelTunnel?.ticket
    if (typeof cancelTicket === 'string' && cancelTicket.length > 0 && cancelTicket.length <= 128) {
      dataTransport.cancelPendingTunnel(cancelTicket, socket)
      return
    }

    const requestId = message.openTunnel?.requestId
    if (
      socket.cProps?.type !== CLIENT ||
      typeof requestId !== 'string' ||
      requestId.length === 0 ||
      requestId.length > 128
    ) {
      return socket.destroy()
    }
    openTunnel(socket, requestId)
  }

  function openTunnel(clientSocket, requestId) {
    const cProps = clientSocket.cProps
    const connectionGroup = connections[cProps.name]
    const client = connectionGroup?.[CLIENT]?.[cProps.uuid]
    const agent = firstConnection(connectionGroup?.[AGENT])
    if (client?.socket !== clientSocket || !agent?.socket || agent.socket.destroyed) {
      return sendTunnelError(clientSocket, requestId, ERRORS.TUNNEL_UNAVAILABLE)
    }

    const ticket = dataTransport.createPendingTunnel({
      routeName: cProps.name,
      clientUuid: cProps.uuid,
      agentUuid: agent.socket.cProps.uuid,
      clientSession: clientSocket,
      agentSession: agent.socket
    })
    if (!ticket) return sendTunnelError(clientSocket, requestId, ERRORS.TOO_MANY_PENDING_TUNNELS)

    const sentToAgent = sendJson(agent.socket, { openTunnel: { ticket } })
    const sentToClient = sendJson(clientSocket, { openTunnel: { requestId, ticket } })
    if (sentToAgent && sentToClient) return true

    dataTransport.cancelPendingTunnel(ticket)
    if (sentToClient) sendTunnelError(clientSocket, requestId, ERRORS.TUNNEL_UNAVAILABLE)
    return false
  }

  function sendTunnelError(socket, requestId, error) {
    return sendJson(socket, { tunnelError: { requestId, error } })
  }

  function cleanupControlSocket(socket) {
    const cProps = socket.cProps
    if (!cProps) return log.debug('unknown connection closed')

    const connectionGroup = connections[cProps.name]
    const roleGroup = connectionGroup?.[cProps.type]
    const connection = roleGroup?.[cProps.uuid]
    if (!connection || connection.socket !== socket) return

    dataTransport.cancelPendingForSession(socket)
    delete roleGroup[cProps.uuid]

    if (cProps.type === CLIENT) {
      log.info(`${cProps.type} "${cProps.name}" went offline.`)
      pruneConnectionGroup(cProps.name)
      return
    }

    if (!closing) {
      const clientGroup = connectionGroup[CLIENT]
      if (clientGroup) {
        for (const client of Object.values(clientGroup)) {
          sendJson(client.socket, { agentDied: true })
          client.socket.end()
        }
      }
      dataTransport.closeAgentSession(socket)
    }
    pruneConnectionGroup(cProps.name)
    log.info(cProps.type, cProps.name, 'went offline')
  }

  function close({ force = false } = {}) {
    if (closePromise) return closePromise
    closing = true

    closePromise = (async () => {
      stopListening(relayRelay)
      await dataTransport.close({ force, timeout: config.shutdownTimeout })
      await Promise.all([destroySockets(handshakeSockets), destroySockets(controlSockets)])
      if (relayRelay?.closeAllConnections) relayRelay.closeAllConnections()

      await new Promise(resolve => setImmediate(resolve))
      started = false
      log.info('Relay stopped. Connections closed:', controlSockets.size + dataTransport.getState().dataSockets)
    })()

    return closePromise
  }

  function getState() {
    const transportState = dataTransport.getState()
    return {
      started,
      closing,
      connectionNames: Object.keys(connections).length,
      serviceSockets: controlSockets.size,
      handshakeSockets: handshakeSockets.size,
      pendingTunnels: transportState.pendingTunnels,
      activeTunnels: transportState.activeTunnels,
      dataSockets: transportState.dataSockets
    }
  }

  function pruneConnectionGroup(name) {
    const connectionGroup = connections[name]
    if (!connectionGroup) return
    if (connectionGroup[AGENT] && Object.keys(connectionGroup[AGENT]).length === 0) delete connectionGroup[AGENT]
    if (connectionGroup[CLIENT] && Object.keys(connectionGroup[CLIENT]).length === 0) delete connectionGroup[CLIENT]
    if (Object.keys(connectionGroup).length === 0) delete connections[name]
  }

  function emitFatal(error) {
    if (fatalError) return
    fatalError = true
    events.emit('fatal', error)
  }

  return Object.assign(events, { start, close, getState })
}

function firstConnection(group) {
  if (!group) return undefined
  return group[Object.keys(group)[0]]
}

function sendJson(socket, data) {
  return writeMessage(socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...data }))
}

module.exports = { createRelay }

if (require.main === module) runCli(createRelay)
