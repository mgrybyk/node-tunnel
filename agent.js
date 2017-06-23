'use strict'

const net = require('net')
const { tryParseJSON, log, removeElement } = require('./utils')
const uuid = require('uuid/v4')

const agentName = process.env.N_T_AGENT_NAME || 'dbg'
const serverHost = process.env.N_T_SERVER_HOST || 'localhost'
const serverPort = parseInt(process.env.N_T_SERVER_PORT) || 1337

// NOTE: I can actually pass these values from client,
// but it is EXTREAMLY not secure
const pipeHost = process.env.N_T_AGENT_DATA_HOST || 'localhost'
const pipePort = parseInt(process.env.N_T_AGENT_DATA_PORT) || 22
let fatalError = false
let serviceUuid
let dataPort

let localConnections = []
let dataConnections = []

// remote
let serviceAgent = new net.Socket()

serviceAgent.on('data', data => {
  let dataArr = data.toString('utf8').split('}')
  dataArr.forEach(value => {
    if (!value) return
    let dataJson = tryParseJSON(value + '}')
    if (dataJson.error) {
      log(dataJson.error)
      fatalError = true
      return serviceAgent.destroy()
    }
    if (dataJson.pong) { return }
    if (dataJson.uuid && dataJson.port) {
      serviceUuid = dataJson.uuid
      dataPort = dataJson.port
      return log('setting port and uuid:', dataJson.port, dataJson.uuid)
    }
    if (!dataJson.data || !dataPort) {
      log('fuck', dataJson)
      return
    }

    log('service agent', dataJson)
    let dataAgent = new net.Socket()
    dataConnections.push(dataAgent)
    dataAgent.uuid = 'agent-' + uuid()

    dataAgent.on('close', error => {
      removeElement(dataConnections, dataAgent)
      if (error) log(`closed dataAgent '${dataAgent.uuid}'`)
    })
    dataAgent.on('error', errorIgnored => {})
    // let currentCounter = ++agentCounter
    dataAgent.on('connect', () => {
      log('data agent connected!')
      dataAgent.write(`{ "type": "agent", "uuid": "${dataAgent.uuid}" }`)
      let localSocket = new net.Socket()
      localConnections.push(localSocket)
      let isPiped = false
      let firstData = ''
      dataAgent.once('data', data => {
        firstData = data
        localSocket.connect(pipePort, pipeHost)
      })

      localSocket.on('connect', function () {
        log('Connection to local port established.')

        if (dataAgent.destroyed) {
          localSocket.destroy()
        } else {
          dataAgent.pipe(localSocket)
          localSocket.pipe(dataAgent)
          isPiped = true
        }
        localSocket.write(firstData)
      })

      localSocket.on('error', errIgnored => {})

      localSocket.on('close', () => {
        removeElement(localConnections, localSocket)
        log('Connection to local port closed')
        if (isPiped) {
          dataAgent.unpipe(localSocket)
          localSocket.unpipe(dataAgent)
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
  log('Connection established.')
  let msg = { type: 'agent', name: agentName }
  if (serviceUuid) msg.uuid = serviceUuid
  serviceAgent.write(JSON.stringify(msg))
  if (pinger) clearInterval(pinger)
  pinger = setInterval(() => {
    serviceAgent.write('0')
  }, 15000)
})

serviceAgent.on('error', errorIgnored => {
  // log(error.name, error.message)
})

serviceAgent.on('close', hadError => {
  if (pinger) clearInterval(pinger)
  serviceAgent.destroy()
  if (hadError === true) {
    log('closed with error: ', hadError)
  }
  if (!fatalError) {
    connectWithDelay(5000)
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
  log(`Local: ${localConnections.length}, Data: ${dataConnections.length}`)
  localConnections.forEach(localConnection => {
    if (localConnection && !localConnection.destroyed) localConnection.destroy()
  })
  dataConnections.forEach(dataConnection => {
    if (dataConnection && !dataConnection.destroyed) dataConnection.destroy()
  })
  serviceAgent.end()
  serviceAgent.destroy()
})

process.on('SIGINT', () => {
  process.exit()
})
