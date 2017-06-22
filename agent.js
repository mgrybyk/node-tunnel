'use strict'

require('dotenv').config()
const net = require('net')
const utils = require('./utils')
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

// remote
let serviceAgent = new net.Socket()

serviceAgent.on('data', data => {
  let dataArr = data.toString('utf8').split('}')
  dataArr.forEach(value => {
    if (!value) return
    let dataJson = utils.tryParseJSON(value + '}')
    if (dataJson.error) {
      console.error(dataJson.error)
      fatalError = true
      return serviceAgent.destroy()
    }
    if (dataJson.pong) { return }
    if (dataJson.uuid && dataJson.port) {
      serviceUuid = dataJson.uuid
      dataPort = dataJson.port
      return console.log('setting port and uuid:', dataJson.port, dataJson.uuid)
    }
    if (!dataJson.data || !dataPort) {
      console.log('fuck', dataJson)
      return
    }

    console.log('service agent', dataJson)
    let dataAgent = new net.Socket()

    dataAgent.on('close', error => {
      if (error) console.error(`closed dataAgent '${dataAgent.uuid}'`)
    })
    dataAgent.on('error', error => {})
    // let currentCounter = ++agentCounter
    dataAgent.on('connect', () => {
      console.log('data agent connected!')
      dataAgent.uuid = 'agent-' + uuid()
      dataAgent.write(`{ "type": "agent", "uuid": "${dataAgent.uuid}" }`)
      let localSocket = new net.Socket()
      let isPiped = false
      let firstData = ''
      dataAgent.once('data', data => {
        firstData = data
        localSocket.connect(pipePort, pipeHost)
      })

      localSocket.on('connect', function () {
        console.log('Connection to local port established.')

        if (dataAgent.destroyed) {
          localSocket.destroy()
        } else {
          dataAgent.pipe(localSocket)
          localSocket.pipe(dataAgent)
          isPiped = true
        }
        localSocket.write(firstData)
      })

      localSocket.on('error', err => {})

      localSocket.on('close', () => {
        console.log('Connection to local port closed')
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
  console.log('Connection established.')
  let msg = { type: 'agent', name: agentName }
  if (serviceUuid) msg.uuid = serviceUuid
  serviceAgent.write(JSON.stringify(msg))
  if (pinger) clearInterval(pinger)
  pinger = setInterval(() => {
    serviceAgent.write('0')
  }, 15000)
})

serviceAgent.on('error', error => {
  // console.error(error.name, error.message)
})

serviceAgent.on('close', hadError => {
  if (pinger) clearInterval(pinger)
  serviceAgent.destroy()
  if (hadError === true) {
    console.log('closed with error: ', hadError)
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
  console.log(`About to exit with code: ${code}`)
  serviceAgent.end()
  serviceAgent.destroy()
  serviceAgent.unref()
})

process.on('SIGINT', () => {
  process.exit()
})

