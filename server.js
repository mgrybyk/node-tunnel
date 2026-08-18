'use strict'

const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { PROTOCOL_VERSION, ERRORS } = require('./protocol')
const {
  tryParseJSON,
  log,
  types,
  verifyDataJson,
  removeElement,
  writeMessage,
  createMessageDecoder,
  createFirstMessageDecoder,
  readInteger,
  readPort
} = require('./utils')
const { CLIENT, AGENT } = types

let portsFrom = readPort('N_T_SERVER_PORTS_FROM', 3005)
let portsTo = readPort('N_T_SERVER_PORTS_TO', 3009)
if (portsTo < portsFrom) {
  throw new Error('N_T_SERVER_PORTS_TO must be greater than or equal to N_T_SERVER_PORTS_FROM')
}
let ports = Array(1 + portsTo - portsFrom).fill().map((e, i) => i + portsFrom)
const serviceServerPort = readPort('N_T_SERVER_PORT', 1337)
const handshakeTimeout = readInteger('N_T_HANDSHAKE_TIMEOUT_MS', 10_000, { min: 100, max: 300_000 })
const controlIdleTimeout = readInteger('N_T_CONTROL_IDLE_TIMEOUT_MS', 45_000, { min: 1_000, max: 3_600_000 })

let connections = Object.create(null)
let pipes = Object.create(null)

let serviceServer = net.createServer(serviceSocket => {
  serviceSocket.setTimeout(handshakeTimeout, () => serviceSocket.destroy())

  function onMessage (data) {
    // known agent or client, sending pong
    if (serviceSocket.cProps && serviceSocket.cProps.uuid) {
      return sendJson(serviceSocket, { pong: Math.random() })
    }

    // parse json and validate its structure
    let dataJson = tryParseJSON(data)
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

    // build connections for agent/client
    if (!connections[dataJson.name]) {
      connections[dataJson.name] = {}
    }
    if (!connections[dataJson.name][dataJson.type]) {
      connections[dataJson.name][dataJson.type] = {}
    }
    if (!dataJson.uuid) {
      dataJson.uuid = randomUUID()
    }

    // handle case if agent or client has reconnected
    if (connections[dataJson.name][dataJson.type][dataJson.uuid]) {
      log.info(`${dataJson.type} "${dataJson.name}" reconnected!`)
      let deadSocket = connections[dataJson.name][dataJson.type][dataJson.uuid].socket
      serviceSocket.cProps = Object.assign({}, deadSocket.cProps)
      log.debug(serviceSocket.cProps)
      delete connections[dataJson.name][dataJson.type][dataJson.uuid].socket
      connections[dataJson.name][dataJson.type][dataJson.uuid].socket = serviceSocket
      delete deadSocket.cProps
      deadSocket.destroy()
      serviceSocket.setTimeout(controlIdleTimeout)
      return
    }

    // kill agent with the same name
    if (dataJson.type === AGENT && Object.keys(connections[dataJson.name][AGENT]).length > 0) {
      sendJson(serviceSocket, { error: ERRORS.DUPLICATE_AGENT })
      return serviceSocket.end()
    }

    // set connection props. It might be awful idea modify socket object
    serviceSocket.cProps = {
      name: dataJson.name,
      uuid: dataJson.uuid,
      type: dataJson.type
    }
    serviceSocket.setTimeout(controlIdleTimeout)

    // proceeding to build connections for agent/client
    if (!connections[dataJson.name][dataJson.type][dataJson.uuid]) {
      connections[dataJson.name][dataJson.type][dataJson.uuid] = {}
    }

    if (dataJson.type === CLIENT) {
      // client
      log.info(`Client "${dataJson.name}" connected.`)
      connections[dataJson.name][CLIENT][dataJson.uuid].socket = serviceSocket

      // notify client if agent exists. Otherwise agent will notify client once connected
      // some madness to get port. TODO: fix
      let agent = connections[dataJson.name][AGENT]
      if (agent && Object.keys(agent).length > 0) {
        let agentObj = agent[Object.keys(agent)[0]]
        if (agentObj && agentObj.port) {
          notify(serviceSocket, agentObj.port, dataJson.uuid)
        }
      }
    } else if (dataJson.type === AGENT) {
      // agent
      let agentObj = connections[dataJson.name][dataJson.type][dataJson.uuid]
      if (!agentObj.port) { // why do I check this??
        agentObj.socket = serviceSocket

        // get first available port for agent
        agentObj.port = ports.shift()
        if (!agentObj.port) {
          sendJson(serviceSocket, { error: ERRORS.NO_PORTS })
          delete connections[dataJson.name][AGENT][dataJson.uuid]
          delete serviceSocket.cProps
          return serviceSocket.end()
        }

        // create dedicated server for agent
        createServer(dataJson.name, dataJson.uuid)

        // let agent know data port
        notify(serviceSocket, agentObj.port, dataJson.uuid)

        // notify all connected client that agent is now online
        // all client that will come later will be notified separately (see above)
        if (!connections[dataJson.name][CLIENT]) return
        Object.keys(connections[dataJson.name][CLIENT]).forEach(clientUuid => {
          notify(connections[dataJson.name][CLIENT][clientUuid].socket, agentObj.port, clientUuid)
        })
      }
    }
  }

  const decodeMessage = createMessageDecoder(onMessage, () => serviceSocket.destroy())
  serviceSocket.on('data', decodeMessage)
  serviceSocket.on('error', err => log.err('SERVICE_SOCKET', err.name || err.code, err.message))
  serviceSocket.on('close', hadError => {
    serviceSocket.removeListener('data', decodeMessage)
    let cProps = serviceSocket.cProps
    if (!cProps) return log.debug('unknown connection closed')

    if (cProps.type === AGENT) {
      const connectionGroup = connections[cProps.name]
      const agentObj = connectionGroup && connectionGroup[AGENT] && connectionGroup[AGENT][cProps.uuid]
      if (!agentObj || agentObj.socket !== serviceSocket) return

      // notify clients that agent went offline
      if (connectionGroup[CLIENT]) {
        Object.keys(connectionGroup[CLIENT]).forEach(clientUuid => {
          const clientSocket = connectionGroup[CLIENT][clientUuid].socket
          sendJson(clientSocket, { agentDied: true })
          clientSocket.end()
        })
      }

      const pipeObj = pipes[cProps.name]
      const portToRelease = agentObj.port

      delete connectionGroup[AGENT][cProps.uuid]
      if (Object.keys(connectionGroup[AGENT]).length === 0) delete connectionGroup[AGENT]
      if (pipes[cProps.name] === pipeObj) delete pipes[cProps.name]

      // kill all dedicated server sockets
      if (pipeObj && pipeObj.pipes) {
        Object.keys(pipeObj.pipes).forEach(pipeUuid => {
          if (pipeObj.pipes[pipeUuid].socket) {
            pipeObj.pipes[pipeUuid].socket.unpipe()
            pipeObj.pipes[pipeUuid].socket.destroy()
          }
        })
      }

      if (pipeObj && pipeObj.server) {
        pipeObj.server.close(() => {
          releasePort(portToRelease)
          log.info(cProps.type, cProps.name, 'went offline and released port', portToRelease)
        })
        pipeObj.server.closeAllConnections()
      } else {
        releasePort(portToRelease)
        log.info(cProps.type, cProps.name, 'went offline and release port', portToRelease)
      }
    } else if (cProps.type === CLIENT) {
      log.info(`${cProps.type} "${cProps.name}" went offline.`)
      const clientGroup = connections[cProps.name] && connections[cProps.name][CLIENT]
      const clientObj = clientGroup && clientGroup[cProps.uuid]
      if (clientObj && clientObj.socket === serviceSocket) delete clientGroup[cProps.uuid]
    }
  })
})
serviceServer.listen(serviceServerPort)
serviceServer.on('listening', listener => log.info('Server listening on port', serviceServerPort))
serviceServer.on('error', err => {
  log.info('Something went wrong with service server. Stopping...\n', err.name || err.code, err.message)
  serviceServer.close()
  process.exit(1)
})

function createServer (connectionName, serviceAgentUuid) {
  let agentSockets = []
  let clientSockets = []
  pipes[connectionName] = {}
  pipes[connectionName].pipes = {}
  let conPipes = pipes[connectionName].pipes
  const dataServerPort = connections[connectionName][AGENT][serviceAgentUuid].port

  pipes[connectionName].server = net.createServer({ allowHalfOpen: true }, socket => {
    socket.setTimeout(handshakeTimeout, () => socket.destroy())

    const decodeHandshake = createFirstMessageDecoder((data, remainder) => {
      socket.removeListener('data', decodeHandshake)
      socket.pause()

      // parse json and validate its structure
      let dataJson = tryParseJSON(data)
      log.debug(dataJson)

      if (!dataJson || dataJson.protocolVersion !== PROTOCOL_VERSION) return socket.end()
      if (!verifyDataJson(dataJson) || !dataJson.uuid) return socket.end()

      socket.setTimeout(0)
      socket.uuid = dataJson.uuid
      socket.initialData = remainder.length > 0 ? Buffer.from(remainder) : null
      conPipes[socket.uuid] = { type: dataJson.type }

      if (dataJson.type === AGENT) {
        log.debug('before creating pipe; by agent; client sockets:', clientSockets.length)

        const clientSocket = takeOpenSocket(clientSockets)
        if (clientSocket) pairSockets(socket, clientSocket)
        else agentSockets.push(socket)
      } else
        // client
        if (dataJson.type === CLIENT) {
          const agentSocket = takeOpenSocket(agentSockets)
          if (agentSocket) pairSockets(agentSocket, socket)
          else {
            clientSockets.push(socket)
            // notify agent that there is a client
            log.debug('SENDING NOTIFICATION TO AGENT')
            const agentObj = connections[connectionName] &&
              connections[connectionName][AGENT] &&
              connections[connectionName][AGENT][serviceAgentUuid]
            if (!agentObj || !sendJson(agentObj.socket, { data: true })) socket.destroy()
          }
        }
    }, () => socket.destroy())

    socket.on('data', decodeHandshake)

    socket.on('error', err => log.err('AGENT_SERVER_SOCKET', err.name || err.code, err.message))

    socket.on('close', error => {
      socket.removeListener('data', decodeHandshake)
      removeElement(agentSockets, socket)
      removeElement(clientSockets, socket)
      // unknown or not piped connection closed
      if (!socket.uuid || !conPipes[socket.uuid]) return

      if (error) log.err(`closed ${conPipes[socket.uuid].type} socket with uuid: '${socket.uuid}'`)

      // unpipe and destroy socket piped to (if not destroyed)
      if (conPipes[socket.uuid].socket) {
        const pairedSocket = conPipes[socket.uuid].socket
        socket.unpipe(pairedSocket)
        pairedSocket.unpipe(socket)
        if (!pairedSocket.destroyed) {
          if (error) pairedSocket.destroy()
          else if (!pairedSocket.writableEnded) pairedSocket.end()
        }
      }

      delete conPipes[socket.uuid]
    })
  })

  function takeOpenSocket (sockets) {
    let socket
    while ((socket = sockets.shift())) {
      if (!socket.destroyed && socket.uuid && conPipes[socket.uuid]) return socket
    }
  }

  function pairSockets (agentSocket, clientSocket) {
    log.debug('creating pipe')
    conPipes[agentSocket.uuid].socket = clientSocket
    conPipes[clientSocket.uuid].socket = agentSocket

    agentSocket.pipe(clientSocket)
    clientSocket.pipe(agentSocket)

    // Tell the client that subsequent bytes are tunneled application data.
    sendJson(clientSocket, { ready: true })

    if (agentSocket.initialData) clientSocket.write(agentSocket.initialData)
    if (clientSocket.initialData) agentSocket.write(clientSocket.initialData)
    agentSocket.initialData = null
    clientSocket.initialData = null

    agentSocket.resume()
    clientSocket.resume()
  }

  pipes[connectionName].server.listen(dataServerPort)
  pipes[connectionName].server.on('listening', listener => log.info(`Agent "${connectionName}" connected, dedicated port ${dataServerPort}`))
  pipes[connectionName].server.on('error', err => {
    log.info('Something went wrong with agent server. Killing agent...\n', err.name || err.code, err.message)
    const agentObj = connections[connectionName] &&
      connections[connectionName][AGENT] &&
      connections[connectionName][AGENT][serviceAgentUuid]
    if (agentObj && agentObj.socket) agentObj.socket.destroy()
  })
}

function notify (socket, port, uuid) {
  return sendJson(socket, { port, uuid })
}

function sendJson (socket, data) {
  return writeMessage(socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...data }))
}

function releasePort (port) {
  if (!port || ports.includes(port)) return
  ports.push(port)
  ports.sort((a, b) => a - b)
}

// try kill sockets before exit
process.on('exit', (code) => {
  let connectionsKilled = 0
  Object.keys(pipes).forEach(name => {
    if (pipes[name].server) pipes[name].server.close()
    if (pipes[name].pipes) {
      // dedicated server sockets
      Object.keys(pipes[name].pipes).forEach(pipeUuid => {
        if (pipes[name].pipes[pipeUuid] && pipes[name].pipes[pipeUuid].socket) {
          pipes[name].pipes[pipeUuid].socket.unpipe()
          pipes[name].pipes[pipeUuid].socket.destroy()
          connectionsKilled++
        }
      })
    }
    if (connections[name]) {
      if (connections[name][AGENT]) {
        // service agents
        Object.keys(connections[name][AGENT]).forEach(agentUuid => {
          let agentObj = connections[name][AGENT][agentUuid]
          if (agentObj && agentObj.socket && !agentObj.socket.destroyed) {
            agentObj.socket.destroy()
            connectionsKilled++
          }
        })
      }
      if (connections[name][CLIENT]) {
        // service clients
        Object.keys(connections[name][CLIENT]).forEach(clientUuid => {
          let clientObj = connections[name][CLIENT][clientUuid]
          if (clientObj && clientObj.socket && !clientObj.socket.destroyed) {
            clientObj.socket.destroy()
            connectionsKilled++
          }
        })
      }
    }
  })

  log.info('Server stopped. Connections killed:', connectionsKilled)
})

process.on('SIGINT', () => {
  process.exit()
})

process.on('SIGTERM', () => {
  process.exit()
})
