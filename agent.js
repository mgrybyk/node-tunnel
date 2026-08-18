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
  readInteger,
  readPort
} = require('./utils')

const agentName = process.env.N_T_AGENT_NAME || 'dbg'

if (agentName.length > 128) {
  log.info('Name should not be more than 128 symbols length.')
  process.exit(1)
}
const serverHost = process.env.N_T_SERVER_HOST || 'localhost'
const serverPort = readPort('N_T_SERVER_PORT', 1337)

// NOTE: I can actually pass these values from client,
// but it is EXTREMELY not secure
const pipeHost = process.env.N_T_AGENT_DATA_HOST || 'localhost'
const pipePort = readPort('N_T_AGENT_DATA_PORT', 8888)
const reconnectDelay = readInteger('N_T_RECONNECT_DELAY_MS', 5_000, { min: 100, max: 300_000 })
const handshakeTimeout = readInteger('N_T_HANDSHAKE_TIMEOUT_MS', 10_000, { min: 100, max: 300_000 })
let fatalError = false
let sameNameRetries = 3
let serviceUuid
let dataPort

let connectionToServerLost = false
let localConnections = []
let dataConnections = []

// remote
let serviceAgent
let reconnectTimer
let pinger

function onServiceMessage (socket, data) {
  let dataJson = tryParseJSON(data)
  if (!dataJson || typeof dataJson !== 'object') return socket.destroy()

  if (dataJson.protocolVersion !== PROTOCOL_VERSION) {
    return stopFatal(
      `${ERRORS.VERSION_MISMATCH}: agent=${PROTOCOL_VERSION}, server=${dataJson.protocolVersion ?? 'unknown'}`
    )
  }

  if (dataJson.error) {
    log.info(dataJson.error)
    if (sameNameRetries > 0 && dataJson.error === ERRORS.DUPLICATE_AGENT) {
      log.info('attempting to reconnect, retries left:', sameNameRetries)
      sameNameRetries--
      return socket.destroy()
    }
    return stopFatal(dataJson.error)
  }
  sameNameRetries = 3
  if (dataJson.pong) { return }
  if (dataJson.uuid && dataJson.port) {
    serviceUuid = dataJson.uuid
    dataPort = dataJson.port
    return log.debug('setting port and uuid:', dataJson.port, dataJson.uuid)
  }
  if (!dataJson.data || !dataPort) {
    return log.debug('todo', dataJson)
  }

  log.debug('service agent', dataJson)
  let dataAgent = new net.Socket({ allowHalfOpen: true })
  let localSocket
  dataConnections.push(dataAgent)
  dataAgent.uuid = 'agent-' + randomUUID()
  dataAgent.setTimeout(handshakeTimeout, () => dataAgent.destroy())

  dataAgent.on('close', hadError => {
    removeElement(dataConnections, dataAgent)
    if (hadError) log.debug(`closed dataAgent '${dataAgent.uuid}'`)
    if (localSocket && !localSocket.destroyed) {
      if (hadError) localSocket.destroy()
      else if (!localSocket.writableEnded) localSocket.end()
    }
  })
  dataAgent.on('error', err => log.err('DATA_AGENT', err.name || err.code, err.message))
  dataAgent.on('connect', () => {
    log.debug('data agent connected!')
    localSocket = new net.Socket({ allowHalfOpen: true })
    localConnections.push(localSocket)
    let isPiped = false
    localSocket.setTimeout(handshakeTimeout, () => localSocket.destroy())
    localSocket.connect(pipePort, pipeHost)

    localSocket.on('connect', function () {
      log.debug('Connection to local port established.')
      if (dataAgent.destroyed) {
        localSocket.destroy()
      } else {
        dataAgent.setTimeout(0)
        localSocket.setTimeout(0)
        writeMessage(dataAgent, JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          type: 'agent',
          uuid: dataAgent.uuid
        }))
        dataAgent
          .pipe(localSocket)
          .pipe(dataAgent)
        isPiped = true
      }
    })

    localSocket.on('error', err => log.err('LOCAL_SOCKET', err.name || err.code, err.message))

    localSocket.on('close', hadError => {
      removeElement(localConnections, localSocket)
      log.debug('Connection to local port closed')
      if (isPiped) {
        dataAgent
          .unpipe(localSocket)
          .unpipe(dataAgent)
        isPiped = false
      }
      if (!dataAgent.destroyed) {
        if (hadError) dataAgent.destroy()
        else if (!dataAgent.writableEnded) dataAgent.end()
      }
    })
  })
  dataAgent.connect(dataPort, serverHost)
}

function connect () {
  if (fatalError) return

  const socket = new net.Socket()
  const decodeServiceMessage = createMessageDecoder(
    data => onServiceMessage(socket, data),
    () => socket.destroy()
  )
  serviceAgent = socket

  socket.on('data', decodeServiceMessage)
  socket.on('connect', () => {
    connectionToServerLost = false
    log.info('Connection to server established.')
    let msg = { protocolVersion: PROTOCOL_VERSION, type: 'agent', name: agentName }
    if (serviceUuid) msg.uuid = serviceUuid
    writeMessage(socket, JSON.stringify(msg))
    if (pinger) clearInterval(pinger)
    pinger = setInterval(() => {
      writeMessage(socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ping: Math.random() }))
    }, 15000)
  })
  socket.on('error', err => log.err('SERVICE_AGENT', err.name || err.code, err.message))
  socket.on('close', () => {
    socket.removeListener('data', decodeServiceMessage)
    if (socket !== serviceAgent) return

    if (!connectionToServerLost) {
      connectionToServerLost = true
      log.info('Connection to server lost')
    }
    if (pinger) clearInterval(pinger)
    pinger = undefined
    dataPort = undefined
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
  if (serviceAgent && !serviceAgent.destroyed) serviceAgent.destroy()
  setImmediate(() => process.exit(1))
}

connectWithDelay(500)

process.on('exit', (code) => {
  log.info(`Stopping agent, trying to close connections - Local: ${localConnections.length}, Data: ${dataConnections.length}`)
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
  if (serviceAgent) {
    serviceAgent.end()
    serviceAgent.destroy()
  }
})

process.on('SIGINT', () => {
  process.exit()
})

process.on('SIGTERM', () => {
  process.exit()
})
