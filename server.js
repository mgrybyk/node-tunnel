'use strict'

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { loadEnvironment, getServerConfig } = require('./config')

if (require.main === module) loadEnvironment(process.argv[2])

const { PROTOCOL_VERSION, ERRORS } = require('./protocol')
const {
  tryParseJSON,
  log,
  types,
  verifyDataJson,
  removeElement,
  writeMessage,
  createMessageDecoder,
  createFirstMessageDecoder
} = require('./utils')
const { stopListening, destroySockets, waitForSockets, runCli } = require('./lifecycle')
const { CLIENT, AGENT } = types

function createServer(config = getServerConfig()) {
  const events = new EventEmitter()
  const availablePorts = Array.from(
    { length: 1 + config.portsTo - config.portsFrom },
    (_, index) => config.portsFrom + index
  )
  const connections = Object.create(null)
  const pipes = Object.create(null)
  const serviceSockets = new Set()
  const dataSockets = new Set()

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
    agentObj.port = availablePorts.shift()

    if (!agentObj.port) {
      sendJson(serviceSocket, { error: ERRORS.NO_PORTS })
      delete agentGroup[dataJson.uuid]
      delete serviceSocket.cProps
      pruneConnectionGroup(dataJson.name)
      return serviceSocket.end()
    }

    createDataServer(dataJson.name, dataJson.uuid)
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

    const pipeObj = pipes[cProps.name]
    const portToRelease = connection.port
    delete roleGroup[cProps.uuid]
    if (pipes[cProps.name] === pipeObj) delete pipes[cProps.name]
    pruneConnectionGroup(cProps.name)

    if (pipeObj) destroyPipe(pipeObj, !closing)
    releasePort(portToRelease)
    log.info(cProps.type, cProps.name, 'went offline and released port', portToRelease)
  }

  function createDataServer(connectionName, serviceAgentUuid) {
    const agentSockets = []
    const clientSockets = []
    const conPipes = Object.create(null)
    const dataServerPort = connections[connectionName][AGENT][serviceAgentUuid].port
    const pipeObj = { pipes: conPipes }
    pipes[connectionName] = pipeObj

    const dataServer = net.createServer({ allowHalfOpen: true }, socket => {
      if (closing) return socket.destroy()

      dataSockets.add(socket)
      socket.setTimeout(config.handshakeTimeout, () => socket.destroy())

      const decodeHandshake = createFirstMessageDecoder(
        (data, remainder) => {
          socket.removeListener('data', decodeHandshake)
          socket.pause()

          const dataJson = tryParseJSON(data)
          log.debug(dataJson)

          if (!dataJson || dataJson.protocolVersion !== PROTOCOL_VERSION) return socket.end()
          if (!verifyDataJson(dataJson) || !dataJson.uuid) return socket.end()

          socket.setTimeout(0)
          socket.uuid = dataJson.uuid
          socket.initialData = remainder.length > 0 ? Buffer.from(remainder) : null
          conPipes[socket.uuid] = { type: dataJson.type }

          if (dataJson.type === AGENT) {
            const clientSocket = takeOpenSocket(clientSockets, conPipes)
            if (clientSocket) pairSockets(socket, clientSocket, conPipes)
            else agentSockets.push(socket)
            return
          }

          const agentSocket = takeOpenSocket(agentSockets, conPipes)
          if (agentSocket) {
            pairSockets(agentSocket, socket, conPipes)
          } else {
            clientSockets.push(socket)
            const agentGroup = connections[connectionName]?.[AGENT]
            const agentObj = agentGroup?.[serviceAgentUuid]
            if (!agentObj || !sendJson(agentObj.socket, { data: true })) socket.destroy()
          }
        },
        () => socket.destroy()
      )

      socket.on('data', decodeHandshake)
      socket.on('error', error => log.err('AGENT_SERVER_SOCKET', error.name || error.code, error.message))
      socket.on('close', hadError => {
        dataSockets.delete(socket)
        socket.removeListener('data', decodeHandshake)
        removeElement(agentSockets, socket)
        removeElement(clientSockets, socket)
        if (!socket.uuid || !conPipes[socket.uuid]) return

        const connection = conPipes[socket.uuid]
        if (hadError) log.err(`closed ${connection.type} socket with uuid: '${socket.uuid}'`)

        const pairedSocket = connection.socket
        if (pairedSocket) {
          socket.unpipe(pairedSocket)
          pairedSocket.unpipe(socket)
          if (!pairedSocket.destroyed) {
            if (hadError) pairedSocket.destroy()
            else if (!pairedSocket.writableEnded) pairedSocket.end()
          }
        }

        delete conPipes[socket.uuid]
      })
    })

    pipeObj.server = dataServer
    dataServer.listen(dataServerPort)
    dataServer.on('listening', () => log.info(`Agent "${connectionName}" connected, dedicated port ${dataServerPort}`))
    dataServer.on('error', error => {
      log.info('Something went wrong with agent server. Killing agent...\n', error.name || error.code, error.message)
      const agentGroup = connections[connectionName]?.[AGENT]
      const agentObj = agentGroup?.[serviceAgentUuid]
      if (agentObj?.socket) agentObj.socket.destroy()
    })
  }

  function close({ force = false } = {}) {
    if (closePromise) return closePromise
    closing = true

    closePromise = (async () => {
      stopListening(serviceServer)
      for (const pipeObj of Object.values(pipes)) stopListening(pipeObj.server)

      if (!force) await waitForSockets(dataSockets, config.shutdownTimeout)

      destroySockets(dataSockets)
      for (const socket of serviceSockets) socket.destroy()
      if (serviceServer?.closeAllConnections) serviceServer.closeAllConnections()
      for (const pipeObj of Object.values(pipes)) {
        if (pipeObj.server?.closeAllConnections) pipeObj.server.closeAllConnections()
      }

      await new Promise(resolve => setImmediate(resolve))
      started = false
      log.info('Server stopped. Connections closed:', serviceSockets.size + dataSockets.size)
    })()

    return closePromise
  }

  function getState() {
    return {
      started,
      closing,
      connectionNames: Object.keys(connections).length,
      pipes: Object.keys(pipes).length,
      availablePorts: [...availablePorts],
      serviceSockets: serviceSockets.size,
      dataSockets: dataSockets.size
    }
  }

  function pruneConnectionGroup(name) {
    const connectionGroup = connections[name]
    if (!connectionGroup) return
    if (connectionGroup[AGENT] && Object.keys(connectionGroup[AGENT]).length === 0) delete connectionGroup[AGENT]
    if (connectionGroup[CLIENT] && Object.keys(connectionGroup[CLIENT]).length === 0) delete connectionGroup[CLIENT]
    if (Object.keys(connectionGroup).length === 0) delete connections[name]
  }

  function destroyPipe(pipeObj, closeConnections) {
    if (!pipeObj) return
    stopListening(pipeObj.server)
    if (!closeConnections) return

    for (const pipe of Object.values(pipeObj.pipes || {})) {
      if (pipe.socket) pipe.socket.destroy()
    }
    if (pipeObj.server?.closeAllConnections) pipeObj.server.closeAllConnections()
  }

  function notify(socket, port, uuid) {
    return sendJson(socket, { port, uuid })
  }

  function releasePort(port) {
    if (!port || availablePorts.includes(port)) return
    availablePorts.push(port)
    availablePorts.sort((left, right) => left - right)
  }

  function emitFatal(error) {
    if (fatalError) return
    fatalError = true
    events.emit('fatal', error)
  }

  return Object.assign(events, { start, close, getState })
}

function takeOpenSocket(sockets, conPipes) {
  while (sockets.length > 0) {
    const socket = sockets.shift()
    if (!socket.destroyed && socket.uuid && conPipes[socket.uuid]) return socket
  }
}

function pairSockets(agentSocket, clientSocket, conPipes) {
  log.debug('creating pipe')
  conPipes[agentSocket.uuid].socket = clientSocket
  conPipes[clientSocket.uuid].socket = agentSocket

  agentSocket.pipe(clientSocket)
  clientSocket.pipe(agentSocket)
  sendJson(clientSocket, { ready: true })

  if (agentSocket.initialData) clientSocket.write(agentSocket.initialData)
  if (clientSocket.initialData) agentSocket.write(clientSocket.initialData)
  agentSocket.initialData = null
  clientSocket.initialData = null

  agentSocket.resume()
  clientSocket.resume()
}

function sendJson(socket, data) {
  return writeMessage(socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...data }))
}

module.exports = { createServer }

if (require.main === module) runCli(createServer)
