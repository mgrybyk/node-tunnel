'use strict'

const net = require('net')
const { tryParseJSON, log, removeElement, crypt, bufShift } = require('./utils')
const uuid = require('uuid/v4')

const clientName = process.env.N_T_CLIENT_NAME || 'dbg'
let shiftConstant = clientName.length
if (clientName.length > 128) {
  log.info('Name should not be more than 128 symbols length.')
  process.exit(1)
}
const serverHost = process.env.N_T_SERVER_HOST || 'localhost'
const serverPort = parseInt(process.env.N_T_SERVER_PORT) || 1337
const localPort = parseInt(process.env.N_T_CLIENT_PORT) || 8000

let connectionToServerLost = false
let localConnections = []
let dataConnections = []

let serviceClient = new net.Socket()
let isDataClient = false

let dataJson

// local
let localServer = net.createServer({ pauseOnConnect: true }, localSocket => {
  let isDataClientConnected = false
  let throughInc, throughDec

  if (!isDataClient || !dataJson) {
    return localSocket.destroy()
  }

  localConnections.push(localSocket)
  let dataClient = new net.Socket()
  dataClient.uuid = 'client-' + uuid()
  dataConnections.push(dataClient)
  dataClient.on('connect', () => {
    dataClient.write(crypt.encrypt(`{ "type": "client", "uuid": "${dataClient.uuid}" }`))
  })
  dataClient.once('data', data => {
    throughInc = bufShift(shiftConstant)
    throughDec = bufShift(-shiftConstant)
    dataClient
      .pipe(throughDec)
      .pipe(localSocket)
      .pipe(throughInc)
      .pipe(dataClient)
    isDataClientConnected = true
    localSocket.resume()
  })

  dataClient.connect(dataJson.port, serverHost)

  dataClient.on('close', err => {
    removeElement(dataConnections, dataClient)
    if (err) log.err(`closed dataClient (${dataClient.uuid})`)
    if (localSocket && !localSocket.destroyed) localSocket.destroy()
  })
  dataClient.on('error', err => log.err('DATA_CLIENT', err.name || err.code, err.message))
  localSocket.on('error', err => log.err('LOCAL_SOCKET', err.name || err.code, err.message))

  localSocket.on('close', hadError => {
    removeElement(localConnections, localSocket)
    if (isDataClientConnected) {
      dataClient
        .unpipe(throughDec)
        .unpipe(localSocket)
        .unpipe(throughInc)
        .unpipe(dataClient)
      if (!dataClient.destroyed) dataClient.destroy()
    }
  })
})
localServer.listen(localPort)
localServer.on('listening', listener => log.info(`Client listening on port ${localPort}. Connecting to server...`))
localServer.on('error', err => {
  log.info('Something went wrong with client server. Stopping...\n', err.name || err.code, err.message)
  localServer.close()
  process.exit(1)
})

serviceClient.on('data', dataEnc => {
  // try decrypt otherwise - kill
  let data = crypt.decrypt(dataEnc.toString('utf8'))
  if (data === null) return

  let tmpJson = tryParseJSON(data.toString('utf8'))
  if (tmpJson.pong) return
  if (tmpJson.agentDied || !tmpJson.port) {
    dataJson = null
    return
  }
  dataJson = tmpJson
  log.debug(dataJson)
  if (dataJson.port === null) return
  log.info('Agent found, ready!')
  isDataClient = true
})

let pinger
serviceClient.on('connect', () => {
  log.info('Connection to server established, waiting for agent.')
  let msg = { type: 'client', name: clientName }
  if (dataJson && dataJson.uuid) msg.uuid = dataJson.uuid
  serviceClient.write(crypt.encrypt(JSON.stringify(msg)))
  pinger = setInterval(() => {
    serviceClient.write(crypt.encrypt('' + Math.random()))
  }, 15000)
  if (dataJson) isDataClient = true
})

serviceClient.on('error', err => log.err('SERVICE_SOCKET', err.name || err.code, err.message))

serviceClient.on('close', hadError => {
  if (!connectionToServerLost) {
    connectionToServerLost = true
    log.info('Connection to server lost')
  }
  if (pinger) clearInterval(pinger)
  if (!serviceClient.destroyed) serviceClient.destroy()
  isDataClient = false
  connectWithDelay(5000)
})

function connect () {
  serviceClient.connect(serverPort, serverHost)
}

function connectWithDelay (delay) {
  if (!delay) return connect()

  setTimeout(connect, delay)
}

connectWithDelay(500)

process.on('exit', (code) => {
  log.info(`Stopping client, trying to close connections - Local: ${localConnections.length}, Data: ${dataConnections.length}`)
  localConnections.forEach(localConnection => {
    if (localConnection && !localConnection.destroyed) {
      localConnection.unpipe()
      localConnection.destroy()
    }
  })
  dataConnections.forEach(dataConnection => {
    if (dataConnection && !dataConnection.destroyed) {
      dataConnection.unpipe()
      dataConnection.destroy()
    }
  })
  serviceClient.end()
  serviceClient.destroy()
})

process.on('SIGINT', () => {
  process.exit()
})
