'use strict'

const net = require('net')
const uuid = require('uuid/v4')
const { tryParseJSON, log } = require('./utils')

let portsFrom = parseInt(process.env.N_T_SERVER_PORTS_FROM) || 3005
let portsTo = parseInt(process.env.N_T_SERVER_PORTS_TO) || 3009
let ports = Array(1 + portsTo - portsFrom).fill().map((e, i) => i + portsFrom)
const serviceServerPort = parseInt(process.env.N_T_SERVER_PORT) || 1337

const AGENT = 'agent'
const CLIENT = 'client'

let connections = {}
let pipes = {}

let serviceServer = net.createServer(serviceSocket => {
  function onData (data) {
    if (serviceSocket.cProps && serviceSocket.cProps.uuid) {
      return pingPong(serviceSocket)
    }
    // parse json and validate its structure
    let dataJson = tryParseJSON(data.toString('utf8'))
    log.debug(dataJson)
    if (!dataJson.type || !dataJson.name) {
      log.err('json data')
      return serviceSocket.end()
    }

    if (dataJson.type !== CLIENT && dataJson.type !== AGENT) {
      log.err('invalid type: ' + dataJson.type)
      return serviceSocket.end()
    }

    if (!connections[dataJson.name]) {
      connections[dataJson.name] = {}
    }
    if (!connections[dataJson.name][dataJson.type]) {
      connections[dataJson.name][dataJson.type] = {}
    }
    if (!dataJson.uuid) {
      dataJson.uuid = uuid()
    }

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

    if (dataJson.type === AGENT && Object.keys(connections[dataJson.name][AGENT]).length > 0) {
      serviceSocket.write('{ "error": "agent with this name already exist" }')
      return serviceSocket.destroy()
    }

    serviceSocket.cProps = {
      name: dataJson.name,
      uuid: dataJson.uuid,
      type: dataJson.type
    }
    if (!connections[dataJson.name][dataJson.type][dataJson.uuid]) {
      connections[dataJson.name][dataJson.type][dataJson.uuid] = {}
    }
    if (dataJson.type === CLIENT) {
      // client
      log.info(`Client "${dataJson.name}" connected.`)
      connections[dataJson.name][CLIENT][dataJson.uuid].socket = serviceSocket

      // some madness to get port. TODO: fix
      if (connections[dataJson.name][AGENT] && Object.keys(connections[dataJson.name][AGENT]).length > 0) {
        let agentObj = connections[dataJson.name][AGENT][Object.keys(connections[dataJson.name][AGENT])[0]]
        if (agentObj && agentObj.port) {
          notify(serviceSocket, agentObj.port, dataJson.uuid)
        }
      }
    } else if (dataJson.type === AGENT) {
      // agent
      let agentObj = connections[dataJson.name][dataJson.type][dataJson.uuid]
      if (!agentObj.port) { // why do I check this??
        agentObj.socket = serviceSocket
        agentObj.port = ports.shift()
        if (!agentObj.port) { return serviceSocket.destroy() }
        createServer(dataJson.name, dataJson.uuid)
        notify(serviceSocket, agentObj.port, dataJson.uuid)
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
    if (!cProps) return log.debug('unkown connection closed')

    if (cProps.type === AGENT) {
      // notify clients that agent went offline
      if (connections[cProps.name][CLIENT]) {
        Object.keys(connections[cProps.name][CLIENT]).forEach(clientUuid => {
          connections[cProps.name][CLIENT][clientUuid].socket.write('{"agentDied": true}')
          connections[cProps.name][CLIENT][clientUuid].socket.destroy()
        })
      }
      pipes[cProps.name].server.maxConnections = 0
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

        log.info(cProps.type, cProps.name, 'went offilne and release port', portToRelease)

        // delete agent from connections
        serverDead = true
        delete connections[cProps.name][AGENT]
        delete pipes[cProps.name]
      })
      // sometimes server not stopping
      // but we need to live at least somehow
      setTimeout(() => {
        if (!serverDead) {
          delete connections[cProps.name][AGENT]
          delete pipes[cProps.name]
        }
      }, 10000)
    } else if (cProps.type === CLIENT) {
      log.info(`${cProps.type} "${cProps.name}" went offilne.`)
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

function notify (socket, port, uuid) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.destroyed) return resolve()
    socket.write(`{ "port": ${port}, "uuid": "${uuid}" }`, () => {
      resolve()
    })
  })
}

function pingPong (socket) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.destroyed) return resolve()
    socket.write('{ "pong": true }', () => {
      resolve()
    })
  })
}

function createServer (connectionName, serviceAgentUuid) {
  let agentSockets = []
  let clientSockets = []
  pipes[connectionName] = {}
  pipes[connectionName].pipes = {}
  let conPipes = pipes[connectionName].pipes
  const dataServerPort = connections[connectionName][AGENT][serviceAgentUuid].port

  pipes[connectionName].server = net.createServer(socket => {
    function onData (data) {
      // parse json and validate its structure
      let dataJson = tryParseJSON(data.toString('utf8'))
      log.debug(dataJson)
      if (!dataJson.type || !dataJson.uuid) {
        log.err('err: socket: json data')
        return socket.end()
      }

      if (dataJson.type !== CLIENT && dataJson.type !== AGENT) {
        log.err('err: socket: invalid type: ' + dataJson.type)
        return socket.end()
      }

      socket.uuid = dataJson.uuid
      conPipes[socket.uuid] = { type: dataJson.type }

      if (dataJson.type === AGENT) {
        log.debug('before creating pipe; by agent; client sockets:', clientSockets.length)
        if (clientSockets.length > 0) {
          let clientSocket = clientSockets.shift()
          log.debug('creating pipe; by client')
          if (!clientSocket.uuid || !conPipes[clientSocket.uuid]) {
            clientSocket.destroy()
            socket.destroy()
          } else conPipes[clientSocket.uuid].socket = socket
          socket.pipe(clientSocket)
          clientSocket.pipe(socket)
          clientSocket.write('0') // just something, it doesn't matter for now
          conPipes[socket.uuid].socket = clientSocket
        } else agentSockets.push(socket)
      } else
        // client
        if (dataJson.type === CLIENT) {
          log.debug('before creating pipe; by client; is agent sockets:', agentSockets.length)
          if (agentSockets.length > 0) {
            let agentSocket = agentSockets.shift()
            log.debug('creating pipe; by client')
            socket.pipe(agentSocket)
            agentSocket.pipe(socket)
            conPipes[socket.uuid].socket = agentSocket
            conPipes[agentSocket.uuid].socket = socket
          } else {
            clientSockets.push(socket)
            log.debug('SENDING NOTIFICATION TO AGENT')
            connections[connectionName][AGENT][serviceAgentUuid].socket.write('{ "data": true }')
          }
        }

      socket.removeListener('data', onData)
    }

    socket.on('data', onData)

    socket.on('error', err => log.err('AGENT_SERVER_SOCKET', err.name || err.code, err.message))

    socket.on('close', error => {
      if (!socket.uuid || !conPipes[socket.uuid]) return
      if (error) log.err(`closed ${conPipes[socket.uuid].type} socket with uuid: '${socket.uuid}'`)
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

process.on('exit', (code) => {
  let connectionsKilled = 0
  Object.keys(pipes).forEach(name => {
    if (pipes[name].server) pipes[name].server.close()
    if (pipes[name].pipes) {
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
        Object.keys(connections[name].AGENT).forEach(agentUuid => {
          let agentObj = connections[name].AGENT[agentUuid]
          if (agentObj && agentObj.socket && !agentObj.socket.destroyed) {
            agentObj.socket.destroy()
            connectionsKilled++
          }
        })
      }
      if (connections[name].CLIENT) {
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
