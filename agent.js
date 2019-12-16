'use strict'

const net = require('net')
const { tryParseJSON, log, removeElement, crypt, bufShift } = require('./utils')
const uuid = require('uuid/v4')

const agentName = process.env.N_T_AGENT_NAME || 'dbg'
let shiftConstant = agentName.length
if (agentName.length > 128) {
  log.info('Name should not be more than 128 symbols length.')
  process.exit(1)
}
const serverHost = process.env.N_T_SERVER_HOST || 'localhost'
const serverPort = parseInt(process.env.N_T_SERVER_PORT) || 1337

// NOTE: I can actually pass these values from client,
// but it is EXTREMELY not secure
const pipeHost = process.env.N_T_AGENT_DATA_HOST || 'localhost'
const pipePort = parseInt(process.env.N_T_AGENT_DATA_PORT) || 8888
let fatalError = false
let sameNameRetries = 3
let serviceUuid
let dataPort

let connectionToServerLost = false
let localConnections = []
let dataConnections = []

// remote
let serviceAgent = new net.Socket()

serviceAgent.on('data', dataEnc => {
  // try decrypt otherwise - kill
  let data = crypt.decrypt(dataEnc.toString('utf8'))
  if (data === null) return

  let dataArr = data.split('}')
  dataArr.forEach(value => {
    if (!value) return
    let dataJson = tryParseJSON(value + '}')
    if (dataJson.error) {
      log.info(dataJson.error)
      if (sameNameRetries > 0 && dataJson.error === 'agent with this name already exist') {
        log.info('attempting to reconnect, retries left:', sameNameRetries)
        sameNameRetries--
      } else fatalError = true
      return serviceAgent.destroy()
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
    let dataAgent = new net.Socket()
    dataConnections.push(dataAgent)
    dataAgent.uuid = 'agent-' + uuid()

    dataAgent.on('close', error => {
      removeElement(dataConnections, dataAgent)
      if (error) log.debug(`closed dataAgent '${dataAgent.uuid}'`)
    })
    dataAgent.on('error', err => log.err('DATA_AGENT', err.name || err.code, err.message))
    dataAgent.on('connect', () => {
      log.debug('data agent connected!')
      let throughInc, throughDec
      let localSocket = new net.Socket()
      localConnections.push(localSocket)
      let isPiped = false
      localSocket.connect(pipePort, pipeHost)

      localSocket.on('connect', function () {
        log.debug('Connection to local port established.')
        if (dataAgent.destroyed) {
          localSocket.destroy()
        } else {
          dataAgent.write(crypt.encrypt(`{ "type": "agent", "uuid": "${dataAgent.uuid}" }`))
          throughInc = bufShift(shiftConstant)
          throughDec = bufShift(-shiftConstant)
          dataAgent
            .pipe(throughDec)
            .pipe(localSocket)
            .pipe(throughInc)
            .pipe(dataAgent)
          isPiped = true
        }
      })

      localSocket.on('error', err => log.err('LOCAL_SOCKET', err.name || err.code, err.message))

      localSocket.on('close', () => {
        removeElement(localConnections, localSocket)
        log.debug('Connection to local port closed')
        if (isPiped) {
          dataAgent
            .unpipe(throughDec)
            .unpipe(localSocket)
            .unpipe(throughInc)
            .unpipe(dataAgent)
          isPiped = false
        }
        if (!dataAgent.destroy) dataAgent.destroy()
      })
    })
    dataAgent.connect(dataPort, serverHost)
  })
})

let pinger
serviceAgent.on('connect', () => {
  log.info('Connection to server established.')
  let msg = { type: 'agent', name: agentName }
  if (serviceUuid) msg.uuid = serviceUuid
  serviceAgent.write(crypt.encrypt(JSON.stringify(msg)))
  if (pinger) clearInterval(pinger)
  pinger = setInterval(() => {
    serviceAgent.write(crypt.encrypt('' + Math.random()))
  }, 15000)
})

serviceAgent.on('error', err => log.err('SERVICE_AGENT', err.name || err.code, err.message))

serviceAgent.on('close', hadError => {
  if (!connectionToServerLost) {
    connectionToServerLost = true
    log.info('Connection to server lost')
  }
  if (pinger) clearInterval(pinger)
  dataPort = undefined
  serviceAgent.destroy()
  if (!fatalError) {
    connectWithDelay(50000)
  }
})

function connect () {
  serviceAgent.connect(serverPort, serverHost)
}

function connectWithDelay (delay) {
  if (!delay) return connect()

  setTimeout(connect, delay)
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
  serviceAgent.end()
  serviceAgent.destroy()
})

process.on('SIGINT', () => {
  process.exit()
})
