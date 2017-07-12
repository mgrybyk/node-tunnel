'use strict'

const net = require('net')
const { log } = require('../utils')

const localPort = parseInt(process.env.N_T_CLIENT_PORT) || 8000
const pipePort = parseInt(process.env.N_T_AGENT_DATA_PORT) || 8888

// server for agent

const replyPrefix = new Buffer(`from_remote::`)

let localServer = net.createServer(localSocket => {
  localSocket.on('data', data => {
    log.info(+new Date(), 'DATA_FROM_LOCAL: ', data.toString())
    localSocket.write(Buffer.concat([replyPrefix, data]))
  })

  localSocket.on('error', noop)
  localSocket.on('close', hadError => {
    localSocket.removeAllListeners('data')
  })
})
localServer.listen(pipePort)
localServer.on('listening', listener => log.info(`Remote listening on port ${pipePort}. Connecting to server...`))
localServer.on('error', err => {
  log.info('Something went wrong with remote server. Stopping...\n', err.name || err.code, err.message)
  localServer.close()
  process.exit(1)
})

// connection to client

function sendMsg () {
  let localSocket = new net.Socket()
  localSocket.connect(localPort, 'localhost')
  localSocket.on('connect', function () {
    localSocket.write('[local-msg]')
  })
  localSocket.on('data', data => {
    log.info(+new Date(), 'DATA_FROM_REMOTE: ', data.toString())
  })
  localSocket.on('error', noop)
  localSocket.on('close', hadError => {
    localSocket.removeAllListeners('data')
  })
}

setInterval(sendMsg, 4000)

function noop () { }
