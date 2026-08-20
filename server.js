'use strict'

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { loadEnvironment, getServerConfig } = require('./config')

if (require.main === module) loadEnvironment(process.argv[2])

const { PROTOCOL_VERSION, ERRORS } = require('./protocol')
const { tryParseJSON, log, types, verifyDataJson, writeMessage, createMessageDecoder } = require('./utils')
const { enableSocketKeepAlive, stopListening, destroySockets, runCli } = require('./lifecycle')
const { createTcpDataTransport } = require('./tcp-data-transport')
const { CLIENT, AGENT } = types

function createServer(config = getServerConfig()) {
  const events = new EventEmitter()
  const connections = Object.create(null)
  const serviceSockets = new Set()
  const dataTransport = createTcpDataTransport(config, {
    onTunnelRequested,
    onRouteError
  })

  let serviceServer
  let started = false
  let closing = false
  let closePromise
  let fatalError = false

  function start() {
    if (started) return Promise.resolve()
    if (closing) return Promise.reject(new Error('server is closing'))

    serviceServer = net.createServer(handleServiceSocket)

    return new Promise((resolve, reject) => {
      const onStartupError = error => {
        serviceServer.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        serviceServer.off('error', onStartupError)
        serviceServer.on('error', onRuntimeError)
        started = true
        log.info('Server listening on port', config.servicePort)
        resolve()
      }

      serviceServer.once('error', onStartupError)
      serviceServer.once('listening', onListening)
      serviceServer.listen(config.servicePort)
    })
  }

  function onRuntimeError(error) {
    log.info('Something went wrong with service server. Stopping...\n', error.name || error.code, error.message)
    emitFatal(error)
  }

  function handleServiceSocket(serviceSocket) {
    if (closing) return serviceSocket.destroy()

    enableSocketKeepAlive(serviceSocket)
    serviceSockets.add(serviceSocket)
    serviceSocket.setTimeout(config.handshakeTimeout, () => serviceSocket.destroy())

    function onMessage(data) {
      if (serviceSocket.cProps?.uuid) {
        return sendJson(serviceSocket, { pong: Math.random() })
      }

      const dataJson = tryParseJSON(data)
      log.debug(dataJson)

      if (!dataJson || typeof dataJson !== 'object') return serviceSocket.destroy()
      if (dataJson.protocolVersion !== PROTOCOL_VERSION) {
        sendJson(serviceSocket, {
          error: ERRORS.VERSION_MISMATCH,
          receivedProtocolVersion: dataJson.protocolVersion ?? null
        })
        return serviceSocket.end()
      }
      if (!verifyDataJson(dataJson) || !dataJson.name) return serviceSocket.destroy()

      if (!connections[dataJson.name]) connections[dataJson.name] = Object.create(null)
      const connectionGroup = connections[dataJson.name]
      if (!connectionGroup[dataJson.type]) connectionGroup[dataJson.type] = Object.create(null)
      const roleGroup = connectionGroup[dataJson.type]
      if (!dataJson.uuid) dataJson.uuid = randomUUID()

      if (roleGroup[dataJson.uuid]) {
        log.info(`${dataJson.type} "${dataJson.name}" reconnected!`)
        const deadSocket = roleGroup[dataJson.uuid].socket
        serviceSocket.cProps = { ...deadSocket.cProps }
        roleGroup[dataJson.uuid].socket = serviceSocket
        delete deadSocket.cProps
        deadSocket.destroy()
        serviceSocket.setTimeout(config.controlIdleTimeout)
        return
      }

      if (dataJson.type === AGENT && Object.keys(roleGroup).length > 0) {
        sendJson(serviceSocket, { error: ERRORS.DUPLICATE_AGENT })
        return serviceSocket.end()
      }

      serviceSocket.cProps = {
        name: dataJson.name,
        uuid: dataJson.uuid,
        type: dataJson.type
      }
      serviceSocket.setTimeout(config.controlIdleTimeout)
      roleGroup[dataJson.uuid] = Object.create(null)

      if (dataJson.type === CLIENT) {
        registerClient(serviceSocket, dataJson, connectionGroup, roleGroup)
      } else {
        registerAgent(serviceSocket, dataJson, connectionGroup, roleGroup)
      }
    }

    const decodeMessage = createMessageDecoder(onMessage, () => serviceSocket.destroy())
    serviceSocket.on('data', decodeMessage)
    serviceSocket.on('error', error => log.err('SERVICE_SOCKET', error.name || error.code, error.message))
    serviceSocket.on('close', () => {
      serviceSockets.delete(serviceSocket)
      serviceSocket.removeListener('data', decodeMessage)
      cleanupServiceSocket(serviceSocket)
    })
  }

  function registerClient(serviceSocket, dataJson, connectionGroup, clientGroup) {
    log.info(`Client "${dataJson.name}" connected.`)
    clientGroup[dataJson.uuid].socket = serviceSocket

    const agentGroup = connectionGroup[AGENT]
    const agentObj = agentGroup?.[Object.keys(agentGroup)[0]]
    if (agentObj?.port) notify(serviceSocket, agentObj.port, dataJson.uuid)
  }

  function registerAgent(serviceSocket, dataJson, connectionGroup, agentGroup) {
    const agentObj = agentGroup[dataJson.uuid]
    agentObj.socket = serviceSocket
    agentObj.dataRoute = dataTransport.openRoute({ name: dataJson.name, agentUuid: dataJson.uuid })
    agentObj.port = agentObj.dataRoute?.port

    if (!agentObj.port) {
      sendJson(serviceSocket, { error: ERRORS.NO_PORTS })
      delete agentGroup[dataJson.uuid]
      delete serviceSocket.cProps
      pruneConnectionGroup(dataJson.name)
      return serviceSocket.end()
    }

    notify(serviceSocket, agentObj.port, dataJson.uuid)

    const clientGroup = connectionGroup[CLIENT]
    if (!clientGroup) return
    for (const clientUuid of Object.keys(clientGroup)) {
      notify(clientGroup[clientUuid].socket, agentObj.port, clientUuid)
    }
  }

  function cleanupServiceSocket(serviceSocket) {
    const cProps = serviceSocket.cProps
    if (!cProps) return log.debug('unknown connection closed')

    const connectionGroup = connections[cProps.name]
    const roleGroup = connectionGroup?.[cProps.type]
    const connection = roleGroup?.[cProps.uuid]
    if (!connection || connection.socket !== serviceSocket) return

    if (cProps.type === CLIENT) {
      delete roleGroup[cProps.uuid]
      log.info(`${cProps.type} "${cProps.name}" went offline.`)
      pruneConnectionGroup(cProps.name)
      return
    }

    const clientGroup = connectionGroup[CLIENT]
    if (clientGroup && !closing) {
      for (const clientUuid of Object.keys(clientGroup)) {
        const clientSocket = clientGroup[clientUuid].socket
        sendJson(clientSocket, { agentDied: true })
        clientSocket.end()
      }
    }

    const portToRelease = connection.port
    const dataRoute = connection.dataRoute
    delete roleGroup[cProps.uuid]
    pruneConnectionGroup(cProps.name)

    dataTransport.closeRoute(dataRoute, { closeConnections: !closing })
    log.info(cProps.type, cProps.name, 'went offline and released port', portToRelease)
  }

  function onTunnelRequested(route) {
    const agentGroup = connections[route.name]?.[AGENT]
    const agentObj = agentGroup?.[route.agentUuid]
    return Boolean(agentObj && sendJson(agentObj.socket, { data: true }))
  }

  function onRouteError(route) {
    const agentGroup = connections[route.name]?.[AGENT]
    const agentObj = agentGroup?.[route.agentUuid]
    if (agentObj?.socket) agentObj.socket.destroy()
  }

  function close({ force = false } = {}) {
    if (closePromise) return closePromise
    closing = true

    closePromise = (async () => {
      stopListening(serviceServer)
      await dataTransport.close({ force, timeout: config.shutdownTimeout })
      await destroySockets(serviceSockets)
      if (serviceServer?.closeAllConnections) serviceServer.closeAllConnections()

      await new Promise(resolve => setImmediate(resolve))
      started = false
      log.info('Server stopped. Connections closed:', serviceSockets.size + dataTransport.getState().dataSockets)
    })()

    return closePromise
  }

  function getState() {
    const transportState = dataTransport.getState()
    return {
      started,
      closing,
      connectionNames: Object.keys(connections).length,
      pipes: transportState.routes,
      availablePorts: transportState.availablePorts,
      serviceSockets: serviceSockets.size,
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

  function notify(socket, port, uuid) {
    return sendJson(socket, { port, uuid })
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

module.exports = { createServer }

if (require.main === module) runCli(createServer)
