'use strict'

const net = require('node:net')
const { loadEnvironment, readPort } = require('../config')

loadEnvironment(process.argv[2])

const { log } = require('../utils')

const localPort = readPort('N_T_CLIENT_PORT', 8000)
const pipePort = readPort('N_T_AGENT_DATA_PORT', 8888)
const sockets = new Set()

// server for agent

const replyPrefix = Buffer.from('from_remote::')

const localServer = net.createServer(localSocket => {
  sockets.add(localSocket)
  localSocket.on('data', data => {
    log.info(Date.now(), 'DATA_FROM_LOCAL: ', data.toString())
    localSocket.write(Buffer.concat([replyPrefix, data]))
  })

  localSocket.on('error', noop)
  localSocket.on('close', () => {
    sockets.delete(localSocket)
    localSocket.removeAllListeners('data')
  })
})
localServer.listen(pipePort)
localServer.on('listening', () => log.info(`Remote listening on port ${pipePort}. Connecting to server...`))
localServer.on('error', err => {
  log.info('Something went wrong with remote server. Stopping...\n', err.name || err.code, err.message)
  localServer.close()
  process.exit(1)
})

// connection to client

function sendMsg() {
  const localSocket = new net.Socket()
  sockets.add(localSocket)
  localSocket.connect(localPort, 'localhost')
  localSocket.on('connect', () => {
    localSocket.write('[local-msg]')
  })
  localSocket.on('data', data => {
    log.info(Date.now(), 'DATA_FROM_REMOTE: ', data.toString())
  })
  localSocket.on('error', noop)
  localSocket.on('close', () => {
    sockets.delete(localSocket)
    localSocket.removeAllListeners('data')
  })
}

const sendTimer = setInterval(sendMsg, 4000)

function close() {
  clearInterval(sendTimer)
  localServer.close()
  for (const socket of sockets) socket.destroy()
}

process.once('SIGINT', close)
process.once('SIGTERM', close)

function noop() {}
