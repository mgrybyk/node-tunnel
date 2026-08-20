'use strict'

const net = require('node:net')
const { PROTOCOL_VERSION } = require('./protocol')
const { tryParseJSON, log, verifyDataJson, removeElement, writeMessage, createFirstMessageDecoder } = require('./utils')
const { createTcpByteChannel, bridgeByteChannels } = require('./byte-channel')
const { enableSocketKeepAlive, stopListening, destroySockets, waitForSockets } = require('./lifecycle')

function createTcpDataTransport(config, { onTunnelRequested = () => false, onRouteError = () => {} } = {}) {
  const availablePorts = Array.from(
    { length: 1 + config.portsTo - config.portsFrom },
    (_, index) => config.portsFrom + index
  )
  const routes = new Set()
  const dataSockets = new Set()
  let closing = false

  function openRoute({ name, agentUuid }) {
    if (closing) return
    const port = availablePorts.shift()
    if (!port) return

    const route = {
      name,
      agentUuid,
      port,
      server: undefined,
      sockets: new Set(),
      agentSockets: [],
      clientSockets: [],
      connections: Object.create(null),
      closed: false
    }
    const dataServer = net.createServer({ allowHalfOpen: true }, socket => handleSocket(route, socket))
    route.server = dataServer
    routes.add(route)

    dataServer.listen(port)
    dataServer.on('listening', () => log.info(`Agent "${name}" connected, dedicated port ${port}`))
    dataServer.on('error', error => {
      if (route.closed || closing) return
      log.info('Something went wrong with agent server. Killing agent...\n', error.name || error.code, error.message)
      onRouteError(route, error)
    })

    return route
  }

  function handleSocket(route, socket) {
    if (closing || route.closed) return socket.destroy()

    enableSocketKeepAlive(socket)
    dataSockets.add(socket)
    route.sockets.add(socket)
    socket.setTimeout(config.handshakeTimeout, () => socket.destroy())

    const decodeHandshake = createFirstMessageDecoder(
      (data, remainder) => {
        socket.removeListener('data', decodeHandshake)
        socket.pause()

        const message = tryParseJSON(data)
        log.debug(message)
        if (!message || message.protocolVersion !== PROTOCOL_VERSION) return socket.end()
        if (!verifyDataJson(message) || !message.uuid) return socket.end()

        socket.uuid = message.uuid
        route.connections[socket.uuid] = {
          type: message.type,
          channel: createTcpByteChannel(socket, { initialData: remainder })
        }

        if (message.type === 'agent') {
          const clientSocket = takeOpenSocket(route.clientSockets, route.connections)
          if (clientSocket) pairSockets(route, socket, clientSocket)
          else route.agentSockets.push(socket)
          return
        }

        const agentSocket = takeOpenSocket(route.agentSockets, route.connections)
        if (agentSocket) {
          pairSockets(route, agentSocket, socket)
        } else {
          route.clientSockets.push(socket)
          if (!onTunnelRequested(route)) socket.destroy()
        }
      },
      () => socket.destroy()
    )

    socket.on('data', decodeHandshake)
    socket.on('error', error => log.err('AGENT_SERVER_SOCKET', error.name || error.code, error.message))
    socket.on('close', hadError => {
      dataSockets.delete(socket)
      route.sockets.delete(socket)
      socket.removeListener('data', decodeHandshake)
      removeElement(route.agentSockets, socket)
      removeElement(route.clientSockets, socket)
      if (!socket.uuid || !route.connections[socket.uuid]) return

      const connection = route.connections[socket.uuid]
      if (hadError) log.err(`closed ${connection.type} socket with uuid: '${socket.uuid}'`)
      delete route.connections[socket.uuid]
    })
  }

  function pairSockets(route, agentSocket, clientSocket) {
    log.debug('creating pipe')
    const agentConnection = route.connections[agentSocket.uuid]
    const clientConnection = route.connections[clientSocket.uuid]
    agentConnection.socket = clientSocket
    clientConnection.socket = agentSocket

    sendJson(clientSocket, { ready: true })
    bridgeByteChannels(agentConnection.channel, clientConnection.channel)
  }

  function closeRoute(route, { closeConnections = true } = {}) {
    if (!route || route.closed) return
    route.closed = true
    routes.delete(route)
    stopListening(route.server)

    if (closeConnections) {
      for (const socket of route.sockets) {
        if (!socket.destroyed) socket.destroy()
      }
    }
    if (route.server?.closeAllConnections) route.server.closeAllConnections()
    releasePort(route.port)
  }

  async function close({ force = false, timeout = config.shutdownTimeout } = {}) {
    closing = true
    for (const route of routes) stopListening(route.server)
    if (!force) await waitForSockets(dataSockets, timeout)
    await destroySockets(dataSockets)
    for (const route of [...routes]) closeRoute(route, { closeConnections: false })
  }

  function getState() {
    return {
      routes: routes.size,
      availablePorts: [...availablePorts],
      dataSockets: dataSockets.size
    }
  }

  function releasePort(port) {
    if (!port || availablePorts.includes(port)) return
    availablePorts.push(port)
    availablePorts.sort((left, right) => left - right)
  }

  return { openRoute, closeRoute, close, getState }
}

function takeOpenSocket(sockets, connections) {
  while (sockets.length > 0) {
    const socket = sockets.shift()
    if (!socket.destroyed && socket.uuid && connections[socket.uuid]) return socket
  }
}

function sendJson(socket, data) {
  return writeMessage(socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...data }))
}

module.exports = { createTcpDataTransport }
