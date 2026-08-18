'use strict'

const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { PROTOCOL_VERSION, ERRORS } = require('./protocol')
const {
  tryParseJSON,
  log,
  removeElement,
  writeMessage,
  createMessageDecoder,
  createFirstMessageDecoder,
  readInteger,
  readPort
} = require('./utils')

const clientName = process.env.N_T_CLIENT_NAME || 'dbg'

if (clientName.length > 128) {
  log.info('Name should not be more than 128 symbols length.')
  process.exit(1)
}
const serverHost = process.env.N_T_SERVER_HOST || 'localhost'
const serverPort = readPort('N_T_SERVER_PORT', 1337)
const localPort = readPort('N_T_CLIENT_PORT', 8000)
const reconnectDelay = readInteger('N_T_RECONNECT_DELAY_MS', 5_000, { min: 100, max: 300_000 })
const handshakeTimeout = readInteger('N_T_HANDSHAKE_TIMEOUT_MS', 10_000, { min: 100, max: 300_000 })

let connectionToServerLost = false
let fatalError = false
let localConnections = []
let dataConnections = []

let serviceClient
let isDataClient = false
let reconnectTimer
let pinger

let dataJson

// local
let localServer = net.createServer({ pauseOnConnect: true, allowHalfOpen: true }, localSocket => {
  let isDataClientConnected = false

  if (!isDataClient || !dataJson) {
    return localSocket.destroy()
  }

  localConnections.push(localSocket)
  let dataClient = new net.Socket({ allowHalfOpen: true })
  dataClient.uuid = 'client-' + randomUUID()
  dataConnections.push(dataClient)
  dataClient.setTimeout(handshakeTimeout, () => dataClient.destroy())
  dataClient.on('connect', () => {
    writeMessage(dataClient, JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      type: 'client',
      uuid: dataClient.uuid
    }))
  })
  const decodeReady = createFirstMessageDecoder((message, remainder) => {
    const readyMessage = tryParseJSON(message)
    if (!readyMessage || readyMessage.protocolVersion !== PROTOCOL_VERSION || !readyMessage.ready) {
      return dataClient.destroy()
    }

    dataClient.removeListener('data', decodeReady)
    dataClient.setTimeout(0)
    dataClient
      .pipe(localSocket)
      .pipe(dataClient)
    isDataClientConnected = true
    if (remainder.length > 0) localSocket.write(remainder)
    localSocket.resume()
  }, () => dataClient.destroy())
  dataClient.on('data', decodeReady)

  dataClient.connect(dataJson.port, serverHost)

  dataClient.on('close', hadError => {
    dataClient.removeListener('data', decodeReady)
    removeElement(dataConnections, dataClient)
    if (hadError) log.err(`closed dataClient (${dataClient.uuid})`)
    if (localSocket && !localSocket.destroyed) {
      if (hadError) localSocket.destroy()
      else if (!localSocket.writableEnded) localSocket.end()
    }
  })
  dataClient.on('error', err => log.err('DATA_CLIENT', err.name || err.code, err.message))
  localSocket.on('error', err => log.err('LOCAL_SOCKET', err.name || err.code, err.message))

  localSocket.on('close', hadError => {
    removeElement(localConnections, localSocket)
    if (isDataClientConnected) {
      dataClient
        .unpipe(localSocket)
        .unpipe(dataClient)
      if (!dataClient.destroyed) {
        if (hadError) dataClient.destroy()
        else if (!dataClient.writableEnded) dataClient.end()
      }
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

function onServiceMessage (socket, data) {
  let tmpJson = tryParseJSON(data)
  if (!tmpJson || typeof tmpJson !== 'object') return socket.destroy()
  if (tmpJson.protocolVersion !== PROTOCOL_VERSION) {
    return stopFatal(
      `${ERRORS.VERSION_MISMATCH}: client=${PROTOCOL_VERSION}, server=${tmpJson.protocolVersion ?? 'unknown'}`
    )
  }
  if (tmpJson.error) return stopFatal(tmpJson.error)
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
}

function connect () {
  if (fatalError) return

  const socket = new net.Socket()
  const decodeServiceMessage = createMessageDecoder(
    data => onServiceMessage(socket, data),
    () => socket.destroy()
  )
  serviceClient = socket

  socket.on('data', decodeServiceMessage)
  socket.on('connect', () => {
    connectionToServerLost = false
    log.info('Connection to server established, waiting for agent.')
    let msg = { protocolVersion: PROTOCOL_VERSION, type: 'client', name: clientName }
    if (dataJson && dataJson.uuid) msg.uuid = dataJson.uuid
    writeMessage(socket, JSON.stringify(msg))
    if (pinger) clearInterval(pinger)
    pinger = setInterval(() => {
      writeMessage(socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ping: Math.random() }))
    }, 15000)
    if (dataJson) isDataClient = true
  })
  socket.on('error', err => log.err('SERVICE_SOCKET', err.name || err.code, err.message))
  socket.on('close', () => {
    socket.removeListener('data', decodeServiceMessage)
    if (socket !== serviceClient) return

    if (!connectionToServerLost) {
      connectionToServerLost = true
      log.info('Connection to server lost')
    }
    if (pinger) clearInterval(pinger)
    pinger = undefined
    isDataClient = false
    if (!fatalError) connectWithDelay(reconnectDelay)
  })

  socket.connect(serverPort, serverHost)
}

function connectWithDelay (delay) {
  if (fatalError) return
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (!delay) return connect()

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    connect()
  }, delay)
}

function stopFatal (message) {
  if (fatalError) return
  fatalError = true
  log.info(message)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (pinger) clearInterval(pinger)
  if (serviceClient && !serviceClient.destroyed) serviceClient.destroy()
  setImmediate(() => process.exit(1))
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
  if (serviceClient) {
    serviceClient.end()
    serviceClient.destroy()
  }
})

process.on('SIGINT', () => {
  process.exit()
})

process.on('SIGTERM', () => {
  process.exit()
})
