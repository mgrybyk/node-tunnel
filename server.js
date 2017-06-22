'use strict'

require('dotenv').config()
const net = require('net')
const uuid = require('uuid/v4')
const utils = require('./utils')

let portsFrom = parseInt(process.env.N_T_SERVER_PORTS_FROM) || 3005
let portsTo = parseInt(process.env.N_T_SERVER_PORTS_TO) || 3009
const ports = Array(portsTo - portsFrom).fill().map((e, i) => i + portsFrom)

const AGENT = 'agent'
const CLIENT = 'client'

let connections = {}
let pipes = {}

net.createServer(serviceSocket => {
  function onData (data) {
    if (serviceSocket.cProps && serviceSocket.cProps.uuid) {
      return pingPong(serviceSocket)
    }
    // parse json and validate its structure
    let dataJson = utils.tryParseJSON(data.toString('utf8'))
    console.log(dataJson)
    if (!dataJson.type || !dataJson.name) {
      console.log('err: json data')
      return serviceSocket.end()
    }

    if (dataJson.type !== CLIENT && dataJson.type !== AGENT) {
      console.log('err: invalid type: ' + dataJson.type)
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
      console.log(`found ${dataJson.name} by id!`)
      let deadSocket = connections[dataJson.name][dataJson.type][dataJson.uuid].socket
      serviceSocket.cProps = Object.assign({}, deadSocket.cProps)
      console.log(serviceSocket.cProps)
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
      connections[dataJson.name][CLIENT][dataJson.uuid].socket = serviceSocket

      // some madness to get port. TODO: fix
      if (connections[dataJson.name][AGENT] && Object.keys(connections[dataJson.name][AGENT]).length > 0) {
        let agentObj = connections[dataJson.name][AGENT][Object.keys(connections[dataJson.name][AGENT])[0]]
        if (agentObj && agentObj.port) {
          notify(serviceSocket, agentObj.port, dataJson.uuid)
        }
      }

      console.log(connections)
    } else if (dataJson.type === AGENT) {
      // agent
      let agentObj = connections[dataJson.name][dataJson.type][dataJson.uuid]
      if (!agentObj.port) { // why do I check this??
        agentObj.port = ports.shift()
        createServer(dataJson.name, dataJson.uuid)
        agentObj.socket = serviceSocket
        notify(serviceSocket, agentObj.port, dataJson.uuid)
        if (!connections[dataJson.name][CLIENT]) return
        Object.keys(connections[dataJson.name][CLIENT]).forEach(clientUuid => {
          notify(connections[dataJson.name][CLIENT][clientUuid].socket, agentObj.port, clientUuid)
        })
      }
    }
  }

  serviceSocket.on('data', onData)
  serviceSocket.on('error', errIgnored => {})
  serviceSocket.on('close', hadError => {
    let cProps = serviceSocket.cProps
    if (!cProps) return console.log('unkown connection closed')

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
          pipes[cProps.name].pipes[pipeUuid].socket.unpipe()
          pipes[cProps.name].pipes[pipeUuid].socket.destroy()
        })
      }
      // stop server
      let serverDead = false
      pipes[cProps.name].server.close(someArg => {
        console.log('server stopped', cProps.name)

        // add port that is no longer in use
        ports.push(connections[cProps.name][AGENT].port)

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
      delete connections[cProps.name][CLIENT][cProps.uuid]
    }
  })
}).listen(parseInt(process.env.N_T_SERVER_PORT) || 1337)

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

  pipes[connectionName].server = net.createServer(socket => {
    function onData (data) {
      // parse json and validate its structure
      let dataJson = utils.tryParseJSON(data.toString('utf8'))
      console.log(dataJson)
      if (!dataJson.type || !dataJson.uuid) {
        console.log('err: socket: json data')
        return socket.end()
      }

      if (dataJson.type !== CLIENT && dataJson.type !== AGENT) {
        console.log('err: socket: invalid type: ' + dataJson.type)
        return socket.end()
      }

      // if (connections[connectionName][dataJson.type].uuid !== dataJson.uuid) {
      //   console.log('err: socket: invalid uuid:', dataJson.uuid, 'for', dataJson.type)
      //   return socket.end()
      // }

      socket.uuid = dataJson.uuid
      // console.log(Object.keys(conPipes).length)
      conPipes[socket.uuid] = { type: dataJson.type }
      // console.log(Object.keys(conPipes).length)
      // console.log(socket.uuid)
      if (dataJson.type === AGENT) {
        // console.log('before creating pipe; by agent; client sockets:', clientSockets.length)
        if (clientSockets.length > 0) {
          let clientSocket = clientSockets.shift()
          console.log('creating pipe; by client')
          socket.pipe(clientSocket)
          clientSocket.pipe(socket)
          clientSocket.write('0') // just something, it doesn't matter for now
          // console.log(Object.keys(conPipes).length)
          conPipes[socket.uuid].socket = clientSocket
          if (!clientSocket.uuid || !conPipes[clientSocket.uuid]) {
            console.log('DEFECT', clientSocket.uuid) // unable to reproduce this one
          } else conPipes[clientSocket.uuid].socket = socket
          // console.log(Object.keys(conPipes).length)
        } else agentSockets.push(socket)
      } else
        // client
        if (dataJson.type === CLIENT) {
          // console.log('before creating pipe; by client; is agent sockets:', agentSockets.length)
          if (agentSockets.length > 0) {
            let agentSocket = agentSockets.shift()
            console.log('creating pipe; by client')
            socket.pipe(agentSocket)
            agentSocket.pipe(socket)
            // console.log(Object.keys(conPipes).length)
            conPipes[socket.uuid].socket = agentSocket
            conPipes[agentSocket.uuid].socket = socket
            // console.log(Object.keys(conPipes).length)
          } else {
            clientSockets.push(socket)
            // console.log('SENDING NOTIFICATION TO AGENT')
            connections[connectionName][AGENT][serviceAgentUuid].socket.write('{ "data": true }')
          }
        }

      socket.removeListener('data', onData)
    }

    socket.on('data', onData)

    socket.on('error', function (errIgnored) {
      // console.error('ERROR FROM: ', socket.remoteAddress)
      // console.error(err.stack)
    })

    socket.on('close', error => {
      if (!socket.uuid || !conPipes[socket.uuid]) return
      if (error) console.log(`closed ${conPipes[socket.uuid].type} socket with uuid: '${socket.uuid}'`)
      if (conPipes[socket.uuid].socket) {
        socket.unpipe(conPipes[socket.uuid].socket)
        conPipes[socket.uuid].socket.unpipe(socket)
      }
      // console.log(socket.destroyed, conPipes[socket.uuid].socket ? conPipes[socket.uuid].socket.destroyed : 'yes')
      delete conPipes[socket.uuid]
    })
  }).listen(connections[connectionName][AGENT][serviceAgentUuid].port)
}


process.on('exit', (code) => {
  console.log(`Pipes: ${Object.keys(pipes).length}`)
  let connectionsKilled = 0
  Object.keys(pipes).forEach(name => {
    if (pipes[name].server) pipes[name].server.close()
    if (pipes[name].pipes) {
      Object.keys(pipes[name].pipes).forEach(pipeUuid => {
        if (pipes[name].pipes[pipeUuid]) {
          pipes[name].pipes[pipeUuid].socket.unpipe()
          pipes[name].pipes[pipeUuid].socket.destroy()
          connectionsKilled++
        }
      })
    }
    if (connections[name]) {
      if (connections[name].AGENT) {
        Object.keys(connections[name].AGENT).forEach(agentUuid => {
          if (connections[name].AGENT[agentUuid]) {
            connections[name].AGENT[agentUuid].destroy()
            connectionsKilled++
          }
        })
      }
      if (connections[name].CLIENT) {
        Object.keys(connections[name].CLIENT).forEach(clientUuid => {
          if (connections[name].CLIENT[clientUuid]) {
            connections[name].CLIENT[clientUuid].destroy()
            connectionsKilled++
          }
        })
      }
    }
  })

  console.log('Killed:', connectionsKilled)
})

process.on('SIGINT', () => {
  process.exit()
})
