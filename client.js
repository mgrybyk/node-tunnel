'use strict'

require('dotenv').config()
const net = require('net')
const utils = require('./utils')

const clientName = process.env.N_T_CLIENT_NAME || 'dbg'
const serverHost = process.env.N_T_SERVER_HOST || 'localhost'
const serverPort = parseInt(process.env.N_T_SERVER_PORT) || 1337
const localPort = parseInt(process.env.N_T_CLIENT_PORT) || 8000

let serviceClient = new net.Socket()
let isDataClient = false
let counter = 0

let dataJson
// serviceClient.setNoDelay(true)

// local
let localServer = net.createServer(localSocket => {
  let id = ++counter
  let isDataClientConnected = false
  let firstData = null

  if (!isDataClient) {
    return localSocket.destroy()
  }

  let dataClient = new net.Socket()
  dataClient.on('connect', () => {
    dataClient.write(`{ "type": "client", "uuid": "${dataJson.uuid}" }`)
    dataClient.pipe(localSocket)
    localSocket.pipe(dataClient)
    isDataClientConnected = true
    setTimeout(() => {
      if (firstData) dataClient.write(firstData)
    }, 100)
  })

  dataClient.connect(dataJson.port, serverHost)
  // dataClient.on('data', data => console.log(id))

  dataClient.on('close', error => {
    console.log(`closed dataClient ${clientName}(${dataJson.uuid.substr(-3)}), error: `, error)
  })
  dataClient.on('error', error => {
    console.log(`dataClient ${clientName}(${dataJson.uuid.substr(-3)}), error: `, error)
  })

  function localSocketDataLsnr (data) {
    console.log('LOCAL SOCKET', id)
    if (!isDataClientConnected) {
      firstData = data
    } else localSocket.removeListener('data', localSocketDataLsnr)
  }
  localSocket.on('data', localSocketDataLsnr)

  localSocket.on('error', error => {
    console.error(error)
  })

  localSocket.on('close', hadError => {
    console.log('LOCAL CLOSE', id)
    if (isDataClientConnected) {
      dataClient.unpipe(localSocket)
      localSocket.unpipe(dataClient)
      if (!dataClient.destroyed) dataClient.destroy()
    }
  })
}).listen(localPort)

serviceClient.on('data', data => {
  dataJson = utils.tryParseJSON(data.toString('utf8'))
  console.log(dataJson)
  if (isDataClient) {
    console.log('isDataClient')
    if (dataJson.port === null) {
      // dataClient.destroy('agent went offline') // todo do i need to destroy?
    }
    return
  }
  if (dataJson.port === null) return
  isDataClient = true
})

serviceClient.on('connect', () => {
  console.log('Connection established.')
  serviceClient.write(`{ "type": "client", "name": "${clientName}" }`)
})

serviceClient.on('error', error => {
  console.log(error.name, error.message)
})

serviceClient.on('close', hadError => {
  serviceClient.destroy()
  console.log('closed with error: ', hadError)
  if (hadError === true) {
    connectWithDelay(2000)
  }
})

serviceClient.end('end', () => {
  console.log('ended')
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
