'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { setTimeout: delay } = require('node:timers/promises')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'
process.env.N_T_LOG_ERROR = 'true'

const { createServer } = require('../server')
const { createAgent } = require('../agent')
const { createClient } = require('../client')
const { TCP_KEEP_ALIVE_INITIAL_DELAY, enableSocketKeepAlive, createBackoff } = require('../lifecycle')
const { PROTOCOL_VERSION, CONNECTION_KINDS, TYPES } = require('../protocol')
const { writeMessage, createMessageDecoder, log } = require('../utils')
const {
  host,
  reserveTopologyPorts,
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

test('TCP keepalive uses a short initial idle delay', () => {
  const calls = []
  const socket = {
    setKeepAlive(enabled, initialDelay) {
      calls.push({ enabled, initialDelay })
    }
  }

  enableSocketKeepAlive(socket)

  assert.deepEqual(calls, [{ enabled: true, initialDelay: 30_000 }])
  assert.equal(TCP_KEEP_ALIVE_INITIAL_DELAY, 30_000)
})

test('server and client reject occupied listener ports without leaking handles', async t => {
  silenceInfoLogs(t)
  const serviceBlocker = net.createServer()
  await listenOnAllInterfaces(serviceBlocker)
  const server = createServer({
    servicePort: serviceBlocker.address().port,
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
    await closeServer(serviceBlocker)
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

  const ports = await reserveTopologyPorts(1)
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

  const ports = await reserveTopologyPorts(1)
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

test('a paired stream remains open beyond the handshake timeout', { timeout: 10_000 }, async t => {
  silenceInfoLogs(t)
  let receivedResolve
  const received = new Promise(resolve => {
    receivedResolve = resolve
  })
  const backend = createHoldingServer(receivedResolve)
  await listen(backend)

  const ports = await reserveTopologyPorts(1)
  const handshakeTimeout = 100
  const server = createServer({ ...serverConfig(ports), handshakeTimeout })
  const agent = createAgent(
    peerConfig(ports, {
      name: 'long-lived-stream',
      targetHost: host,
      targetPort: backend.address().port,
      handshakeTimeout
    })
  )
  const client = createClient(
    peerConfig(ports, {
      name: 'long-lived-stream',
      localPort: ports.clients[0],
      handshakeTimeout
    })
  )
  let localSocket

  t.after(async () => {
    localSocket?.destroy()
    await Promise.all([client.close({ force: true }), agent.close({ force: true }), server.close({ force: true })])
    await closeServer(backend)
  })

  await server.start()
  await agent.start()
  await client.start()
  await waitForCondition(() => client.getState().ready)
  localSocket = net.createConnection({ host, port: ports.clients[0] })
  localSocket.on('error', () => {})
  await new Promise((resolve, reject) => {
    localSocket.once('connect', resolve)
    localSocket.once('error', reject)
  })
  localSocket.write('keep this stream open')
  await received
  await delay(3 * handshakeTimeout)

  assert.equal(localSocket.destroyed, false)
  assert.equal(server.getState().dataSockets, 2)
  assert.equal(agent.getState().dataConnections, 1)
  assert.equal(client.getState().dataConnections, 1)
})

test('server removes empty connection-name state after client churn', { timeout: 10_000 }, async t => {
  silenceInfoLogs(t)
  const ports = await reserveTopologyPorts(0)
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

test('server repeatedly removes agent route state without creating data listeners', { timeout: 15_000 }, async t => {
  silenceInfoLogs(t)
  const ports = await reserveTopologyPorts(0)
  const server = createServer(serverConfig(ports))
  const fatalErrors = []
  server.on('fatal', error => fatalErrors.push(error))
  t.after(() => server.close({ force: true }))
  await server.start()

  for (let index = 0; index < 30; index++) {
    const agent = await registerControl(ports.service, TYPES.AGENT, `route-churn-${index}`)
    await agent.messages.next()
    agent.socket.end()
    await waitForSocketClose(agent.socket)
    await waitForCondition(() => server.getState().connectionNames === 0)
  }

  assert.deepEqual(fatalErrors, [])
  assert.equal(server.getState().serviceSockets, 0)
  assert.equal(server.getState().dataSockets, 0)
})

test('server expires a valid data socket that waits too long for its peer', { timeout: 5_000 }, async t => {
  silenceInfoLogs(t)
  const ports = await reserveTopologyPorts(0)
  const server = createServer({ ...serverConfig(ports), handshakeTimeout: 250 })
  let agent
  let client
  let dataSocket

  t.after(async () => {
    dataSocket?.destroy()
    agent?.socket.destroy()
    client?.socket.destroy()
    await server.close({ force: true })
  })

  await server.start()
  agent = await registerControl(ports.service, TYPES.AGENT, 'unmatched-data-socket')
  client = await registerControl(ports.service, TYPES.CLIENT, 'unmatched-data-socket')
  await Promise.all([agent.messages.next(), client.messages.next()])
  writeMessage(
    client.socket,
    JSON.stringify({ protocolVersion: PROTOCOL_VERSION, openTunnel: { requestId: 'unmatched-open' } })
  )
  const [clientOpen] = await Promise.all([client.messages.next(), agent.messages.next()])
  dataSocket = net.createConnection({ host, port: ports.service })
  dataSocket.on('error', () => {})
  await new Promise((resolve, reject) => {
    dataSocket.once('connect', resolve)
    dataSocket.once('error', reject)
  })
  writeMessage(
    dataSocket,
    JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      kind: CONNECTION_KINDS.DATA,
      type: TYPES.CLIENT,
      ticket: clientOpen.openTunnel.ticket
    })
  )

  await waitForCondition(() => server.getState().dataSockets === 1 && server.getState().pendingTunnels === 1)
  await waitForSocketClose(dataSocket, 2_000)
  await waitForCondition(() => server.getState().dataSockets === 0)
  assert.equal(server.getState().serviceSockets, 2)
})

function serverConfig(ports) {
  return {
    servicePort: ports.service,
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

async function registerAndDisconnect(port, name) {
  const client = await registerControl(port, TYPES.CLIENT, name)
  await client.messages.next()
  client.socket.end()
  await waitForSocketClose(client.socket)
}

function registerControl(port, type, name) {
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = net.createConnection({ host, port })
    const timer = setTimeout(() => finish(new Error('control connection timed out')), 3_000)
    const messages = createMessageQueue(socket)

    socket.on('connect', () => {
      writeMessage(
        socket,
        JSON.stringify({ protocolVersion: PROTOCOL_VERSION, kind: CONNECTION_KINDS.CONTROL, type, name })
      )
      finish(null, { socket, messages })
    })
    socket.on('error', finish)

    function finish(error, result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        socket.destroy()
        reject(error)
      } else {
        resolve(result)
      }
    }
  })
}

function createMessageQueue(socket) {
  const messages = []
  const waiters = []
  const decode = createMessageDecoder(message => {
    const parsed = JSON.parse(message)
    const waiter = waiters.shift()
    if (waiter) waiter(parsed)
    else messages.push(parsed)
  })
  socket.on('data', decode)
  return {
    next() {
      if (messages.length > 0) return Promise.resolve(messages.shift())
      return new Promise(resolve => waiters.push(resolve))
    }
  }
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
