'use strict'

require('dotenv').config()
const net = require('net')
const utils = require('./utils')
const uuid = require('uuid/v4')

const clientName = process.env.N_T_CLIENT_NAME || 'dbg'
const serverHost = process.env.N_T_SERVER_HOST || 'localhost'
const serverPort = parseInt(process.env.N_T_SERVER_PORT) || 1337
const localPort = parseInt(process.env.N_T_CLIENT_PORT) || 8000

let serviceClient = new net.Socket()
let isDataClient = false

let dataJson

// local
net.createServer(localSocket => {
  let isDataClientConnected = false
  let firstData = null

  if (!isDataClient) {
    return localSocket.destroy()
  }

  let dataClient = new net.Socket()
  dataClient.uuid = 'client-' + uuid()
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
    if (error) console.log(`closed dataClient (${dataClient.uuid})`)
    if (localSocket && !localSocket.destroyed) localSocket.destroy()
  })
  dataClient.on('error', error => {
    // console.log(`dataClient ${clientName}(${dataJson.uuid.substr(-3)}), error: `, error)
  })

  function localSocketDataLsnr (data) {
    if (!isDataClientConnected) {
      firstData = data
    } else localSocket.removeListener('data', localSocketDataLsnr)
  }
  localSocket.on('data', localSocketDataLsnr)

  localSocket.on('error', error => {
    // console.error(error)
  })

  localSocket.on('close', hadError => {
    // console.log('LOCAL CLOSE')
    if (isDataClientConnected) {
      dataClient.unpipe(localSocket)
      localSocket.unpipe(dataClient)
      if (!dataClient.destroyed) dataClient.destroy()
    }
  })
}).listen(localPort)

serviceClient.on('data', data => {
  let tmpJson = utils.tryParseJSON(data.toString('utf8'))
  if (tmpJson.pong) return
  if (tmpJson.agentDied || !tmpJson.port) return dataJson = null
  dataJson = tmpJson
  console.log(dataJson)
  if (dataJson.port === null) return
  isDataClient = true
})

let pinger
serviceClient.on('connect', () => {
  console.log('Connection established.')
  let msg = { type: 'client', name: clientName }
  if (dataJson && dataJson.uuid) msg.uuid = dataJson.uuid
  serviceClient.write(JSON.stringify(msg))
  pinger = setInterval(() => {
    serviceClient.write('0')
  }, 15000)
  if (dataJson) isDataClient = true
})

serviceClient.on('error', error => {
  // console.log(error.name, error.message)
})

serviceClient.on('close', hadError => {
  if (pinger) clearInterval(pinger)
  if (!serviceClient.destroyed) serviceClient.destroy()
  isDataClient = false
  // console.log('closed with error: ', hadError)
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
  console.log(`About to exit with code: ${code}`)
  serviceClient.destroy()
})

process.on('SIGINT', () => {
  process.exit()
})
