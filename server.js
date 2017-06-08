'use strict'

require('dotenv').config()
const net = require('net')
const uuid = require('uuid/v4')
const utils = require('./utils')

const config = require('./config')
const ports = Array(config.ports.to - config.ports.from).fill().map((e, i) => i + config.ports.from)

const AGENT = 'agent'
const CLIENT = 'client'

let connections = {}
let pipes = {}

net.createServer(serviceSocket => {
  function onData (data) {
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

    serviceSocket.cProps = {
      name: dataJson.name,
      uuid: dataJson.uuid,
      type: dataJson.type
    }
    if (dataJson.type === CLIENT) {
      // client
      if (!connections[dataJson.name][CLIENT][dataJson.uuid]) {
        connections[dataJson.name][CLIENT][dataJson.uuid] = {}
      }
      connections[dataJson.name][CLIENT][dataJson.uuid].socket = serviceSocket
      if (connections[dataJson.name][AGENT] && connections[dataJson.name][AGENT].port) {
        // notify(connections[dataJson.name][AGENT].socket, connections[dataJson.name][AGENT].port, dataJson.uuid)
        notify(serviceSocket, connections[dataJson.name][AGENT].port, dataJson.uuid)
      }
      console.log(connections)
    } else if (dataJson.type === AGENT) {
      // agent
      if (!connections[dataJson.name][AGENT].uuid) {
        connections[dataJson.name][AGENT].uuid = dataJson.uuid
      } else {
        console.log('err: agent already exist', dataJson.name)
        return serviceSocket.end()
      }
      if (!connections[dataJson.name][AGENT].port) {
        connections[dataJson.name][AGENT].port = ports.shift()
        createServer(dataJson.name)
        connections[dataJson.name][AGENT].socket = serviceSocket
        if (!connections[dataJson.name][CLIENT]) return
        // let notifier = null
        Object.keys(connections[dataJson.name][CLIENT]).forEach(clientUuid => {
          // if (!notifier) {
          //   notifier = notify(connections[dataJson.name][AGENT].socket, connections[dataJson.name][AGENT].port, dataJson.uuid)
          // } else {
          //   notifier.then(() => {
          //     notifier = notify(connections[dataJson.name][AGENT].socket, connections[dataJson.name][AGENT].port, dataJson.uuid)
          //   })
          // }
          notify(connections[dataJson.name][CLIENT][clientUuid].socket, connections[dataJson.name][AGENT].port, clientUuid)
        })
      }
    }
  }

  serviceSocket.on('data', onData)
  serviceSocket.on('close', hadError => {
    let cProps = serviceSocket.cProps
    if (!cProps) return console.log('unkown connection closed')

    if (cProps.type === AGENT) {
      // notify clients that agent went offline
      if (connections[cProps.name][CLIENT]) {
        Object.keys(connections[cProps.name][CLIENT]).forEach(clientUuid => {
          notify(connections[cProps.name][CLIENT][clientUuid].socket, null, clientUuid)
        })
      }
      // stop server
      pipes[cProps.name].server.close(someArg => {
        console.log('server stopped', cProps.name)

        // add port that is no longer in use
        ports.push(connections[cProps.name][AGENT].port)

        // delete agent from connections
        delete connections[cProps.name][AGENT]
        delete pipes[cProps.name].pipes
      })
    } else if (cProps.type === CLIENT) {
      delete connections[cProps.name][CLIENT][cProps.uuid]
    }
  })
}).listen(process.env.N_T_SERVER_PORT || 1337)

function notify (socket, port, uuid) {
  return new Promise((resolve, reject) => {
    if (!socket) return resolve()
    socket.write(`{ "port": ${port}, "uuid": "${uuid}" }`, () => {
      resolve()
    })
  })
}

function createServer (connectionName) {
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

      if (dataJson.type !== CLIENT &&
        dataJson.type !== AGENT) {
        console.log('err: socket: invalid type: ' + dataJson.type)
        return socket.end()
      }

      // if (connections[connectionName][dataJson.type].uuid !== dataJson.uuid) {
      //   console.log('err: socket: invalid uuid:', dataJson.uuid, 'for', dataJson.type)
      //   return socket.end()
      // }

      socket.uuid = dataJson.uuid
      console.log(Object.keys(conPipes).length)
      conPipes[socket.uuid] = { type: dataJson.type }
      console.log(Object.keys(conPipes).length)
      console.log(socket.uuid)
      if (dataJson.type === AGENT) {
        console.log('before creating pipe; by agent; client sockets:', clientSockets.length)
        if (clientSockets.length > 0) {
          let clientSocket = clientSockets.shift()
          console.log('creating pipe; by client')
          socket.pipe(clientSocket)
          clientSocket.pipe(socket)
          notify(clientSocket, 'to', 'do') // todo
          console.log(Object.keys(conPipes).length)
          conPipes[socket.uuid].socket = clientSocket
          if (!clientSocket.uuid || !conPipes[clientSocket.uuid]) {
            console.log(clientSocket.uuid)
          } else conPipes[clientSocket.uuid].socket = socket
          console.log(Object.keys(conPipes).length)
        } else agentSockets.push(socket)
      } else
        // client
        if (dataJson.type === CLIENT) {
          console.log('before creating pipe; by client; is agent sockets:', agentSockets.length)
          if (agentSockets.length > 0) {
            let agentSocket = agentSockets.shift()
            console.log('creating pipe; by client')
            socket.pipe(agentSocket)
            agentSocket.pipe(socket)
            console.log(Object.keys(conPipes).length)
            conPipes[socket.uuid].socket = agentSocket
            conPipes[agentSocket.uuid].socket = socket
            console.log(Object.keys(conPipes).length)
          } else {
            clientSockets.push(socket)
            console.log('SENDING NOTIFICATION TO AGENT')
            notify(connections[connectionName][AGENT].socket, connections[connectionName][AGENT].port, dataJson.uuid)
          }
        }

      socket.removeListener('data', onData)
    }

    socket.on('data', onData)

    socket.on('error', function (err) {
      console.error('ERROR FROM: ', socket.remoteAddress)
      console.error(err.stack)
    })

    socket.on('close', error => {
      if (!socket.uuid || !conPipes[socket.uuid]) return
      console.log(`closed ${conPipes[socket.uuid].type} socket with uuid: '${socket.uuid}', error:`, error)
      if (conPipes[socket.uuid].socket) {
        socket.unpipe(conPipes[socket.uuid].socket)
        conPipes[socket.uuid].socket.unpipe(socket)
      }
      console.log(socket.destroyed, conPipes[socket.uuid].socket ? conPipes[socket.uuid].socket.destroyed : 'yes')
      delete conPipes[socket.uuid]
    })
  }).listen(connections[connectionName][AGENT].port)
}
