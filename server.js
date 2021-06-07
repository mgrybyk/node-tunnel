'use strict'

const net = require('net')
const { v4: uuid } = require('uuid')
const { tryParseJSON, log, types, verifyDataJson, crypt } = require('./utils')
const { CLIENT, AGENT } = types

let portsFrom = parseInt(process.env.N_T_SERVER_PORTS_FROM) || 3005
let portsTo = parseInt(process.env.N_T_SERVER_PORTS_TO) || 3009
let ports = Array(1 + portsTo - portsFrom).fill().map((e, i) => i + portsFrom)
const serviceServerPort = parseInt(process.env.N_T_SERVER_PORT) || 1337

let connections = {}
let pipes = {}

let serviceServer = net.createServer(serviceSocket => {
  function onData (dataEnc) {
    // known agent or client, sending pong
    if (serviceSocket.cProps && serviceSocket.cProps.uuid) {
      return serviceSocket.write(crypt.encrypt(`{"pong":${Math.random()}}`))
    }

    // try decrypt otherwise - kill
    let data = crypt.decrypt(dataEnc.toString('utf8'))
    if (data === null) return serviceSocket.destroy()

    // parse json and validate its structure
    let dataJson = tryParseJSON(data)
    log.debug(dataJson)

    if (!verifyDataJson(dataJson) || !dataJson.name) return serviceSocket.destroy()

    // build connections for agent/client
    if (!connections[dataJson.name]) {
      connections[dataJson.name] = {}
    }
    if (!connections[dataJson.name][dataJson.type]) {
      connections[dataJson.name][dataJson.type] = {}
    }
    if (!dataJson.uuid) {
      dataJson.uuid = uuid()
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
      return
    }

    // kill agent with the same name
    if (dataJson.type === AGENT && Object.keys(connections[dataJson.name][AGENT]).length > 0) {
      serviceSocket.write(crypt.encrypt('{ "error": "agent with this name already exist" }'))
      return serviceSocket.destroy()
    }

    // set connection props. It might be awful idea modify socket object
    serviceSocket.cProps = {
      name: dataJson.name,
      uuid: dataJson.uuid,
      type: dataJson.type
    }

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
        if (!agentObj.port) { return serviceSocket.destroy() } // todo notify agent that there are no free ports

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

  serviceSocket.on('data', onData)
  serviceSocket.on('error', err => log.err('SERVICE_SOCKET', err.name || err.code, err.message))
  serviceSocket.on('close', hadError => {
    serviceSocket.removeAllListeners('data')
    let cProps = serviceSocket.cProps
    if (!cProps) return log.debug('unknown connection closed')

    if (cProps.type === AGENT) {
      // notify clients that agent went offline
      if (connections[cProps.name][CLIENT]) {
        Object.keys(connections[cProps.name][CLIENT]).forEach(clientUuid => {
          connections[cProps.name][CLIENT][clientUuid].socket.write(crypt.encrypt('{"agentDied": true}'))
          connections[cProps.name][CLIENT][clientUuid].socket.destroy()
        })
      }

      pipes[cProps.name].server.maxConnections = 0

      // kill all dedicated server sockets
      if (pipes[cProps.name].pipes) {
        Object.keys(pipes[cProps.name].pipes).forEach(pipeUuid => {
          if (pipes[cProps.name].pipes[pipeUuid].socket) {
            pipes[cProps.name].pipes[pipeUuid].socket.unpipe()
            pipes[cProps.name].pipes[pipeUuid].socket.destroy()
          }
        })
      }

      // stop server
      let serverDead = false
      let portToRelease = connections[cProps.name][AGENT][cProps.uuid].port
      pipes[cProps.name].server.close(someArg => {
        // add port that is no longer in use
        ports.push(portToRelease)

        log.info(cProps.type, cProps.name, 'went offline and release port', portToRelease)

        // delete agent from connections
        serverDead = true
        setTimeout(() => {
          delete pipes[cProps.name]
          delete connections[cProps.name][AGENT]
        }, 5000)
      })
      // sometimes server not stopping
      // but we need to live at least somehow
      setTimeout(() => {
        if (!serverDead) {
          delete pipes[cProps.name]
          delete connections[cProps.name][AGENT]
        }
      }, 40000)
    } else if (cProps.type === CLIENT) {
      log.info(`${cProps.type} "${cProps.name}" went offline.`)
      delete connections[cProps.name][CLIENT][cProps.uuid]
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

  pipes[connectionName].server = net.createServer(socket => {
    socket.once('data', dataEnc => {
      // try decrypt otherwise - kill
      let data = crypt.decrypt(dataEnc.toString('utf8'))
      if (data === null) return socket.destroy()

      // parse json and validate its structure
      let dataJson = tryParseJSON(data.toString('utf8'))
      log.debug(dataJson)

      if (!verifyDataJson(dataJson) || !dataJson.uuid) return socket.end()

      socket.uuid = dataJson.uuid
      conPipes[socket.uuid] = { type: dataJson.type }

      if (dataJson.type === AGENT) {
        log.debug('before creating pipe; by agent; client sockets:', clientSockets.length)

        // if there are free client sockets ...
        if (clientSockets.length > 0) {
          // grab the first client socket available
          let clientSocket = clientSockets.shift()
          log.debug('creating pipe; by client')

          // client socket may die before pipes are created
          if (!clientSocket.uuid || !conPipes[clientSocket.uuid]) {
            clientSocket.destroy()
            socket.destroy()
          } else conPipes[clientSocket.uuid].socket = socket

          // pipe agent <-> client
          socket.pipe(clientSocket)
          clientSocket.pipe(socket)

          conPipes[socket.uuid].socket = clientSocket

          // notify client that pipe created and we are ready to go
          clientSocket.write(crypt.encrypt('' + Math.random())) // just something, it doesn't matter for now
        } else agentSockets.push(socket)
      } else
        // client
        if (dataJson.type === CLIENT) {
          clientSockets.push(socket)
          // notify agent that there is a client
          log.debug('SENDING NOTIFICATION TO AGENT')
          connections[connectionName][AGENT][serviceAgentUuid].socket.write(crypt.encrypt('{"data":true}'))
        }
    })

    socket.on('error', err => log.err('AGENT_SERVER_SOCKET', err.name || err.code, err.message))

    socket.on('close', error => {
      socket.removeAllListeners('data')
      // unknown or not piped connection closed
      if (!socket.uuid || !conPipes[socket.uuid]) return

      if (error) log.err(`closed ${conPipes[socket.uuid].type} socket with uuid: '${socket.uuid}'`)

      // unpipe and destroy socket piped to (if not destroyed)
      if (conPipes[socket.uuid].socket) {
        socket.unpipe(conPipes[socket.uuid].socket)
        conPipes[socket.uuid].socket.unpipe(socket)
        if (!conPipes[socket.uuid].socket.destroyed) { conPipes[socket.uuid].socket.destroy() }
      }

      delete conPipes[socket.uuid]
    })
  })

  pipes[connectionName].server.listen(dataServerPort)
  pipes[connectionName].server.on('listening', listener => log.info(`Agent "${connectionName}" connected, dedicated port ${dataServerPort}`))
  pipes[connectionName].server.on('error', err => {
    log.info('Something went wrong with agent server. Killing agent...\n', err.name || err.code, err.message)
    connections[connectionName][AGENT][serviceAgentUuid].socket.destroy()
  })
}

function notify (socket, port, uuid) {
  return socket && !socket.destroyed && socket.write(crypt.encrypt(`{"port":${port},"uuid":"${uuid}"}`))
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
      if (connections[name].AGENT) {
        // service agents
        Object.keys(connections[name].AGENT).forEach(agentUuid => {
          let agentObj = connections[name].AGENT[agentUuid]
          if (agentObj && agentObj.socket && !agentObj.socket.destroyed) {
            agentObj.socket.destroy()
            connectionsKilled++
          }
        })
      }
      if (connections[name].CLIENT) {
        // service clients
        Object.keys(connections[name].CLIENT).forEach(clientUuid => {
          let clientObj = connections[name].CLIENT[clientUuid]
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
