'use strict'

require('dotenv').config()
const net = require('net')
const utils = require('./utils')

const agentName = process.env.N_T_AGENT_NAME || 'dbg'
const serverHost = process.env.N_T_SERVER_HOST || 'localhost'
const serverPort = parseInt(process.env.N_T_SERVER_PORT) || 1337
const dataHost = process.env.N_T_AGENT_DATA_HOST || 'localhost'
const dataPort = parseInt(process.env.N_T_AGENT_DATA_PORT) || 22

// let connections = {}
let pipes = {}

// remote
let serviceAgent = new net.Socket()
let agentCounter = 0

serviceAgent.on('data', data => {
  let dataArr = data.toString('utf8').split('}')
  dataArr.forEach(value => {
    if (value) return
    let dataJson = utils.tryParseJSON(value + '}')
    console.log('service agent', dataJson)
  // if (isDataAgent) return
  // isDataAgent = true
    let dataAgent = new net.Socket()

    dataAgent.on('close', error => {
      console.error(`closed dataAgent '${dataJson.uuid.substr(-3)}:${currentCounter}', error:`, error)
    })
    let currentCounter = ++agentCounter
    dataAgent.on('connect', () => {
      console.log('data agent connected!')
      dataAgent.write(`{ "type": "agent", "uuid": "${dataJson.uuid}:${currentCounter}" }`)
      let localSocket = new net.Socket()
      let firstData = ''
      dataAgent.once('data', data => {
        firstData = data
        localSocketConnect(1)
      })
    // dataAgent.on('data', data => {
    //   console.log('\n\nDATA', isFirstData, isConnected, '\n\n', data.toString())
    // })

      function localSocketConnect (delay, data) {
        setTimeout(() => {
          localSocket.connect(dataPort, dataHost)
        }, delay)
      }

      localSocket.on('connect', function () {
        console.log('Connection to local port established.', currentCounter)

        if (dataAgent.destroyed) {
          localSocket.destroy()
        } else {
          dataAgent.pipe(localSocket)
          localSocket.pipe(dataAgent)
          pipes[currentCounter] = true
        }
        localSocket.write(firstData)
      })

      localSocket.on('error', err => {
        console.error(err)
      })

    // localSocket.on('data', data => {
    //   console.log(currentCounter)
    // })

      localSocket.on('close', function () {
        console.log('Connection to local port closed')
        if (pipes[currentCounter] === true) {
          dataAgent.unpipe(localSocket)
          localSocket.unpipe(dataAgent)
          pipes[currentCounter] = false
          if (!dataAgent.destroy) dataAgent.destroy()
        }
      })
    })
    dataAgent.connect(dataJson.port, serverHost)
  })
})

serviceAgent.on('connect', () => {
  console.log('Connection established.')
  serviceAgent.write(`{ "type": "agent", "name": "${agentName}" }`)
})

serviceAgent.on('error', error => {
  console.error(error.name, error.message)
})

serviceAgent.on('close', hadError => {
  serviceAgent.destroy()
  console.log('closed with error: ', hadError)
  if (hadError === true) {
    connectWithDelay(5000)
  }
})

serviceAgent.end('end', () => {
  console.log('ended')
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
  serviceAgent.destroy()
})

process.on('SIGINT', () => {
  process.exit()
})

