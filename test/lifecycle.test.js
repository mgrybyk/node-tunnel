'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'
process.env.N_T_LOG_ERROR = 'true'

const { createServer } = require('../server')
const { createAgent } = require('../agent')
const { createClient } = require('../client')
const { createBackoff } = require('../lifecycle')
const { PROTOCOL_VERSION } = require('../protocol')
const { writeMessage, createMessageDecoder, log } = require('../utils')
const {
  host,
  reserveTopologyPorts,
  reservePort,
  listen,
  closeServer,
  waitForSocketClose,
  waitForCondition
} = require('../test-support/helpers')

test('application modules expose lifecycle factories without starting on import', () => {
  assert.equal(typeof createServer, 'function')
  assert.equal(typeof createAgent, 'function')
  assert.equal(typeof createClient, 'function')
})

test('reconnect backoff grows to its cap and can be reset', () => {
  const backoff = createBackoff({
    baseDelay: 100,
    maxDelay: 400,
    jitterPercent: 20,
    random: () => 0.5
  })

  assert.deepEqual([backoff.next(), backoff.next(), backoff.next(), backoff.next()], [100, 200, 400, 400])
  backoff.reset()
  assert.equal(backoff.next(), 100)

  const lowerBound = createBackoff({ baseDelay: 100, maxDelay: 400, jitterPercent: 20, random: () => 0 })
  const upperBound = createBackoff({ baseDelay: 100, maxDelay: 400, jitterPercent: 20, random: () => 1 })
  assert.equal(lowerBound.next(), 80)
  assert.equal(upperBound.next(), 120)
})

test('server and client reject occupied listener ports without leaking handles', async t => {
  silenceInfoLogs(t)
  const serviceBlocker = net.createServer()
  await listenOnAllInterfaces(serviceBlocker)
  const dataReservation = await reservePort()
  const server = createServer({
    servicePort: serviceBlocker.address().port,
    portsFrom: dataReservation.port,
    portsTo: dataReservation.port,
    handshakeTimeout: 500,
    controlIdleTimeout: 5_000,
    shutdownTimeout: 100
  })
  const client = createClient(
    peerConfig(
      { service: serviceBlocker.address().port },
      {
        name: 'occupied-listener',
        localPort: serviceBlocker.address().port,
        shutdownTimeout: 100
      }
    )
  )

  t.after(async () => {
    await Promise.all([server.close({ force: true }), client.close({ force: true })])
    await Promise.all([closeServer(serviceBlocker), closeServer(dataReservation.server)])
  })

  await assert.rejects(server.start(), error => error.code === 'EADDRINUSE')
  await assert.rejects(client.start(), error => error.code === 'EADDRINUSE')
})

test('graceful close drains an active stream through all three applications', { timeout: 15_000 }, async t => {
  silenceInfoLogs(t)
  const payload = Buffer.alloc(1024 * 1024)
  for (let index = 0; index < payload.length; index++) payload[index] = index & 0xff

  let requestReceivedResolve
  const requestReceived = new Promise(resolve => {
    requestReceivedResolve = resolve
  })
  const backend = createDelayedEchoServer(requestReceivedResolve)
  await listen(backend)

  const ports = await reserveTopologyPorts(1, 1)
  const server = createServer(serverConfig(ports))
  const agent = createAgent(
    peerConfig(ports, {
      name: 'graceful-close',
      targetHost: host,
      targetPort: backend.address().port
    })
  )
  const client = createClient(
    peerConfig(ports, {
      name: 'graceful-close',
      localPort: ports.clients[0]
    })
  )

  t.after(async () => {
    await Promise.all([client.close({ force: true }), agent.close({ force: true }), server.close({ force: true })])
    await closeServer(backend)
  })

  await server.start()
  await agent.start()
  await client.start()
  await waitForCondition(() => client.getState().ready, 5_000)

  const responsePromise = requestTunnel(ports.clients[0], payload)
  await requestReceived

  const closePromise = Promise.all([client.close(), agent.close(), server.close()])
  const response = await responsePromise
  await closePromise

  assert.deepEqual(response, payload)
  assert.equal(client.getState().dataConnections, 0)
  assert.equal(agent.getState().dataConnections, 0)
  assert.equal(server.getState().dataSockets, 0)
})

test('shutdown deadline force-closes a stream that does not drain', { timeout: 10_000 }, async t => {
  silenceInfoLogs(t)
  let receivedResolve
  const received = new Promise(resolve => {
    receivedResolve = resolve
  })
  const backend = createHoldingServer(receivedResolve)
  await listen(backend)

  const ports = await reserveTopologyPorts(1, 1)
  const server = createServer(serverConfig(ports))
  const agent = createAgent(
    peerConfig(ports, {
      name: 'forced-close',
      targetHost: host,
      targetPort: backend.address().port
    })
  )
  const client = createClient(
    peerConfig(ports, {
      name: 'forced-close',
      localPort: ports.clients[0],
      shutdownTimeout: 150
    })
  )

  t.after(async () => {
    await Promise.all([client.close({ force: true }), agent.close({ force: true }), server.close({ force: true })])
    await closeServer(backend)
  })

  await server.start()
  await agent.start()
  await client.start()
  await waitForCondition(() => client.getState().ready)

  const localSocket = net.createConnection({ host, port: ports.clients[0] })
  localSocket.on('error', () => {})
  localSocket.on('connect', () => localSocket.write('held-open-stream'))
  await received

  const startedAt = Date.now()
  await client.close()
  const elapsed = Date.now() - startedAt
  await waitForSocketClose(localSocket)

  assert.ok(elapsed >= 100, `shutdown returned before its deadline (${elapsed}ms)`)
  assert.ok(elapsed < 2_000, `shutdown exceeded its bounded deadline (${elapsed}ms)`)
  assert.equal(client.getState().dataConnections, 0)
  assert.equal(client.getState().localConnections, 0)
})

test('server removes empty connection-name state after client churn', { timeout: 10_000 }, async t => {
  silenceInfoLogs(t)
  const ports = await reserveTopologyPorts(1, 0)
  const server = createServer(serverConfig(ports))
  t.after(() => server.close({ force: true }))
  await server.start()

  await Promise.all(
    Array.from({ length: 40 }, (_, index) => {
      return registerAndDisconnect(ports.service, `short-lived-${index}`)
    })
  )

  await waitForCondition(() => server.getState().connectionNames === 0, 3_000)
  assert.equal(server.getState().connectionNames, 0)
  assert.equal(server.getState().serviceSockets, 0)
})

test('server repeatedly releases and reuses an agent data port', { timeout: 15_000 }, async t => {
  silenceInfoLogs(t)
  const ports = await reserveTopologyPorts(1, 0)
  const server = createServer(serverConfig(ports))
  const fatalErrors = []
  server.on('fatal', error => fatalErrors.push(error))
  t.after(() => server.close({ force: true }))
  await server.start()

  for (let index = 0; index < 30; index++) {
    const assignedPort = await registerAgentAndDisconnect(ports.service, `port-churn-${index}`)
    assert.equal(assignedPort, ports.dataFrom)
    await waitForCondition(() => {
      const state = server.getState()
      return state.connectionNames === 0 && state.pipes === 0 && state.availablePorts.length === 1
    })
  }

  assert.deepEqual(fatalErrors, [])
  assert.deepEqual(server.getState().availablePorts, [ports.dataFrom])
})

function serverConfig(ports) {
  return {
    servicePort: ports.service,
    portsFrom: ports.dataFrom,
    portsTo: ports.dataTo,
    handshakeTimeout: 500,
    controlIdleTimeout: 5_000,
    shutdownTimeout: 3_000
  }
}

function peerConfig(ports, roleConfig) {
  return {
    serverHost: host,
    serverPort: ports.service,
    reconnectDelay: 100,
    reconnectMaxDelay: 400,
    reconnectJitterPercent: 0,
    handshakeTimeout: 500,
    shutdownTimeout: 3_000,
    ...roleConfig
  }
}

function createDelayedEchoServer(onRequest) {
  return net.createServer({ allowHalfOpen: true }, socket => {
    const chunks = []
    let length = 0

    socket.on('data', data => {
      chunks.push(data)
      length += data.length
    })
    socket.on('end', () => {
      const response = Buffer.concat(chunks, length)
      onRequest()
      setTimeout(() => writeSlowly(socket, response), 100)
    })
    socket.on('error', () => {})
  })
}

function createHoldingServer(onData) {
  let received = false
  return net.createServer({ allowHalfOpen: true }, socket => {
    socket.on('data', () => {
      if (received) return
      received = true
      onData()
    })
    socket.on('error', () => {})
  })
}

function writeSlowly(socket, data) {
  let offset = 0
  const timer = setInterval(() => {
    if (socket.destroyed) return clearInterval(timer)
    const end = Math.min(offset + 32 * 1024, data.length)
    socket.write(data.subarray(offset, end))
    offset = end
    if (offset === data.length) {
      clearInterval(timer)
      socket.end()
    }
  }, 5)
}

function requestTunnel(port, payload) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    const socket = net.createConnection({ host, port })

    socket.on('connect', () => socket.end(payload))
    socket.on('data', data => {
      chunks.push(data)
      length += data.length
    })
    socket.on('end', () => resolve(Buffer.concat(chunks, length)))
    socket.on('error', reject)
  })
}

function registerAndDisconnect(port, name) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    socket.on('connect', () => {
      writeMessage(socket, JSON.stringify({ protocolVersion: 2, type: 'client', name }))
      socket.end()
    })
    socket.on('error', reject)
    waitForSocketClose(socket).then(resolve, reject)
  })
}

function registerAgentAndDisconnect(port, name) {
  return new Promise((resolve, reject) => {
    let assignedPort
    let settled = false
    const socket = net.createConnection({ host, port })
    const timer = setTimeout(() => finish(new Error('agent registration timed out')), 3_000)
    const decode = createMessageDecoder(
      message => {
        try {
          const response = JSON.parse(message)
          if (!response.port) return
          assignedPort = response.port
          socket.end()
        } catch (error) {
          finish(error)
        }
      },
      () => finish(new Error('agent registration returned an invalid frame'))
    )

    socket.on('connect', () => {
      writeMessage(socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'agent', name }))
    })
    socket.on('data', decode)
    socket.on('error', finish)
    socket.on('close', () => {
      if (!assignedPort) return finish(new Error('agent disconnected before receiving a data port'))
      finish(null, assignedPort)
    })

    function finish(error, result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(result)
    }
  })
}

function listenOnAllInterfaces(server) {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
    server.listen(0)
  })
}

function silenceInfoLogs(t) {
  t.mock.method(log, 'info', () => {})
}
