'use strict'

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { loadEnvironment, getRelayConfig } = require('./config')

if (require.main === module) loadEnvironment(process.argv[2])

const { traceSocket, traceTunnel } = require('./diagnostics')
const { PROTOCOL_VERSION, CONNECTION_KINDS, TYPES, ERRORS } = require('./protocol')
const {
  tryParseJSON,
  log,
  verifyDataJson,
  writeMessage,
  createMessageDecoder,
  createFirstMessageDecoder
} = require('./utils')
const { enableSocketKeepAlive, startSocketDeadline, stopListening, destroySockets, runCli } = require('./lifecycle')
const { createTcpDataTransport } = require('./tcp-data-transport')
const { CLIENT, AGENT } = TYPES

function createRelay(config = getRelayConfig()) {
  const events = new EventEmitter()
  const routes = new Map()
  const controlSockets = new Set()
  const handshakeSockets = new Set()
  const dataTransport = createTcpDataTransport(config)

  let relayRelay
  let started = false
  let closing = false
  let startPromise
  let closePromise
  let fatalError = false

  function start() {
    if (closing) return Promise.reject(new Error('relay is closing'))
    if (startPromise) return startPromise

    relayRelay = net.createServer({ allowHalfOpen: true }, handleIncomingSocket)

    startPromise = new Promise((resolve, reject) => {
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
    }).catch(error => {
      startPromise = undefined
      throw error
    })
    return startPromise
  }

  function onRuntimeError(error) {
    log.info('Something went wrong with relay. Stopping...\n', error.name || error.code, error.message)
    emitFatal(error)
  }

  function handleIncomingSocket(socket) {
    if (closing) return socket.destroy()

    const trace = traceSocket?.(socket, 'relay-incoming')
    if (trace) socket.tunnelTrace = trace
    enableSocketKeepAlive(socket)
    handshakeSockets.add(socket)
    const clearHandshakeDeadline = startSocketDeadline(
      socket,
      config.handshakeTimeout,
      trace &&
        (() => {
          trace('first-message-timeout', { timeoutMs: config.handshakeTimeout })
        })
    )
    const onHandshakeError = error => log.err('RELAY_SOCKET', error.name || error.code, error.message)
    const decodeFirstMessage = createFirstMessageDecoder(
      (data, remainder) => {
        socket.removeListener('data', decodeFirstMessage)
        if (classifySocket(socket, data, remainder)) {
          clearHandshakeDeadline()
          handshakeSockets.delete(socket)
          socket.removeListener('error', onHandshakeError)
        }
      },
      () => {
        socket.tunnelTrace?.('invalid-first-frame')
        socket.destroy()
      }
    )

    socket.on('data', decodeFirstMessage)
    socket.on('error', onHandshakeError)
    socket.on('close', () => {
      clearHandshakeDeadline()
      handshakeSockets.delete(socket)
    })
  }

  function classifySocket(socket, data, remainder) {
    const message = tryParseJSON(data)
    socket.tunnelTrace?.('first-message-received', {
      kind: message?.kind,
      type: message?.type,
      remainderBytes: remainder.length
    })
    if (!message || typeof message !== 'object') {
      socket.destroy()
      return false
    }
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      sendJson(socket, {
        error: ERRORS.VERSION_MISMATCH,
        receivedProtocolVersion: message.protocolVersion ?? null
      })
      socket.end()
      return false
    }

    if (message.kind === CONNECTION_KINDS.DATA) {
      socket.pause()
      dataTransport.acceptSocket(socket, message, remainder)
      return true
    }
    if (message.kind !== CONNECTION_KINDS.CONTROL) {
      socket.destroy()
      return false
    }
    registerControlSocket(socket, message, remainder)
    return controlSockets.has(socket)
  }

  function registerControlSocket(socket, message, remainder) {
    if (!verifyDataJson(message) || !message.name) return socket.destroy()

    let route = routes.get(message.name)
    if (!route) {
      route = { agent: undefined, clients: new Map() }
      routes.set(message.name, route)
    }
    const uuid = message.uuid || randomUUID()
    const previous = message.type === AGENT ? route.agent : route.clients.get(uuid)
    if (message.type === AGENT && previous && previous.cProps.uuid !== uuid) {
      sendJson(socket, { error: ERRORS.DUPLICATE_AGENT })
      return socket.end()
    }

    socket.cProps = { name: message.name, uuid, type: message.type }
    if (message.type === AGENT) route.agent = socket
    else route.clients.set(uuid, socket)

    if (previous) {
      log.info(`${message.type} "${message.name}" reconnected!`)
      dataTransport.replaceSession(previous, socket)
      delete previous.cProps
      previous.destroy()
    } else if (message.type === CLIENT) {
      log.info(`Client "${message.name}" connected.`)
    } else {
      log.info(`Agent "${message.name}" connected on shared relay port ${config.servicePort}`)
    }

    finishControlRegistration(socket, remainder)
    notifyRegistration(socket, route)
    if (message.type === AGENT && !previous) {
      for (const client of route.clients.values()) notifyRegistration(client, route)
    }
  }

  function finishControlRegistration(socket, remainder) {
    controlSockets.add(socket)
    socket.setTimeout(config.controlIdleTimeout, () => {
      socket.tunnelTrace?.('control-idle-timeout')
      socket.destroy()
    })
    const decodeMessage = createMessageDecoder(
      data => onControlMessage(socket, data),
      () => socket.destroy()
    )
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

  function notifyRegistration(socket, route) {
    socket.tunnelTrace?.('registration-response-queued', { type: socket.cProps.type })
    sendJson(socket, {
      registration: {
        uuid: socket.cProps.uuid,
        ready: socket.cProps.type === AGENT || Boolean(route.agent && !route.agent.destroyed)
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
      dataTransport.cancelPendingTunnel(cancelTicket, socket, 'peer-cancelled')
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
    const route = routes.get(cProps.name)
    const agent = route?.agent
    if (route?.clients.get(cProps.uuid) !== clientSocket || !agent || agent.destroyed) {
      return sendTunnelError(clientSocket, requestId, ERRORS.TUNNEL_UNAVAILABLE)
    }

    const ticket = dataTransport.createPendingTunnel({
      clientSession: clientSocket,
      agentSession: agent
    })
    if (!ticket) return sendTunnelError(clientSocket, requestId, ERRORS.TOO_MANY_PENDING_TUNNELS)

    traceTunnel?.('open-request-dispatched', ticket, { requestId })
    const sentToAgent = sendJson(agent, { openTunnel: { ticket } })
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
    if (!cProps) return
    const route = routes.get(cProps.name)
    if (!route) return

    if (cProps.type === CLIENT) {
      if (route.clients.get(cProps.uuid) !== socket) return
      route.clients.delete(cProps.uuid)
    } else {
      if (route.agent !== socket) return
      route.agent = undefined
      if (!closing) {
        for (const client of route.clients.values()) {
          sendJson(client, { agentDied: true })
          client.end()
        }
        dataTransport.closeAgentSession(socket)
      }
    }
    dataTransport.cancelPendingForSession(socket)
    if (!route.agent && route.clients.size === 0) routes.delete(cProps.name)
    log.info(`${cProps.type} "${cProps.name}" went offline.`)
  }

  function close({ force = false } = {}) {
    if (closePromise) return closePromise
    closing = true

    closePromise = (async () => {
      await startPromise?.catch(() => {})
      stopListening(relayRelay)
      await dataTransport.close({ force, timeout: config.shutdownTimeout })
      await Promise.all([destroySockets(handshakeSockets), destroySockets(controlSockets)])

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
      connectionNames: routes.size,
      serviceSockets: controlSockets.size,
      handshakeSockets: handshakeSockets.size,
      pendingTunnels: transportState.pendingTunnels,
      activeTunnels: transportState.activeTunnels,
      dataSockets: transportState.dataSockets
    }
  }

  function emitFatal(error) {
    if (fatalError) return
    fatalError = true
    events.emit('fatal', error)
  }

  return Object.assign(events, { start, close, getState })
}

function sendJson(socket, data) {
  return writeMessage(socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...data }))
}

module.exports = { createRelay }

if (require.main === module) runCli(createRelay)
