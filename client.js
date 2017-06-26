'use strict'

const net = require('net')
const { tryParseJSON, log, removeElement } = require('./utils')
const uuid = require('uuid/v4')

const clientName = process.env.N_T_CLIENT_NAME || 'dbg'
const serverHost = process.env.N_T_SERVER_HOST || 'localhost'
const serverPort = parseInt(process.env.N_T_SERVER_PORT) || 1337
const localPort = parseInt(process.env.N_T_CLIENT_PORT) || 8000

let localConnections = []
let dataConnections = []

let serviceClient = new net.Socket()
let isDataClient = false

let dataJson

// local
net.createServer(localSocket => {
  let isDataClientConnected = false
  let firstData = null

  if (!isDataClient || !dataJson) {
    return localSocket.destroy()
  }

  localConnections.push(localSocket)
  let dataClient = new net.Socket()
  dataClient.uuid = 'client-' + uuid()
  dataConnections.push(dataClient)
  dataClient.on('connect', () => {
    dataClient.write(`{ "type": "client", "uuid": "${dataClient.uuid}" }`)
  })
  dataClient.once('data', data => {
    dataClient.pipe(localSocket)
    localSocket.pipe(dataClient)
    isDataClientConnected = true
    if (firstData) dataClient.write(firstData)
  })

  dataClient.connect(dataJson.port, serverHost)

  dataClient.on('close', error => {
    removeElement(dataConnections, dataClient)
    if (error) log(`closed dataClient (${dataClient.uuid})`)
    if (localSocket && !localSocket.destroyed) localSocket.destroy()
  })
  dataClient.on('error', errorIgnored => {
    // log(`dataClient ${clientName}(${dataJson.uuid.substr(-3)}), error: `, error)
  })

  function localSocketDataLsnr (data) {
    if (!isDataClientConnected) {
      firstData = data
    } else localSocket.removeListener('data', localSocketDataLsnr)
  }
  localSocket.on('data', localSocketDataLsnr)

  localSocket.on('error', errorIgnored => {
    // log(error)
  })

  localSocket.on('close', hadError => {
    removeElement(localConnections, localSocket)
    if (isDataClientConnected) {
      dataClient.unpipe(localSocket)
      localSocket.unpipe(dataClient)
      if (!dataClient.destroyed) dataClient.destroy()
    }
  })
}).listen(localPort)

serviceClient.on('data', data => {
  let tmpJson = tryParseJSON(data.toString('utf8'))
  if (tmpJson.pong) return
  if (tmpJson.agentDied || !tmpJson.port) {
    dataJson = null
    return
  }
  dataJson = tmpJson
  log(dataJson)
  if (dataJson.port === null) return
  isDataClient = true
})

let pinger
serviceClient.on('connect', () => {
  log('Connection established.')
  let msg = { type: 'client', name: clientName }
  if (dataJson && dataJson.uuid) msg.uuid = dataJson.uuid
  serviceClient.write(JSON.stringify(msg))
  pinger = setInterval(() => {
    serviceClient.write('0')
  }, 15000)
  if (dataJson) isDataClient = true
})

serviceClient.on('error', errorIgnored => {
  // log(error.name, error.message)
})

serviceClient.on('close', hadError => {
  if (pinger) clearInterval(pinger)
  if (!serviceClient.destroyed) serviceClient.destroy()
  isDataClient = false
  // log('closed with error: ', hadError)
  // if (hadError === true) {
  connectWithDelay(5000)
  // }
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
  log(`Local: ${localConnections.length}, Data: ${dataConnections.length}`)
  localConnections.forEach(localConnection => {
    if (localConnection && !localConnection.destroyed) localConnection.destroy()
  })
  dataConnections.forEach(dataConnection => {
    if (dataConnection && !dataConnection.destroyed) dataConnection.destroy()
  })
  serviceClient.end()
  serviceClient.destroy()
})

process.on('SIGINT', () => {
  process.exit()
})
