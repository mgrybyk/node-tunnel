'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const tls = require('node:tls')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'

const { createPeerSession } = require('../peer-session')
const { getAgentConfig, getClientConfig } = require('../config')
const { PROTOCOL_VERSION, TYPES } = require('../protocol')
const messaging = require('../utils').createMessaging()
const { crypt } = messaging

test('TLS control sessions become connected only after relay registration', async t => {
  const sockets = []
  t.mock.method(tls, 'connect', (_options, onSecureConnect) => {
    const socket = new MockSocket(onSecureConnect)
    sockets.push(socket)
    return socket
  })

  let connectedCalls = 0
  const session = createSession({
    handshakeTimeout: 100,
    onConnected: () => {
      connectedCalls++
    }
  })

  session.start()
  const socket = sockets[0]
  socket.completeTlsHandshake()

  assert.equal(session.getState().connected, false)
  assert.equal(connectedCalls, 0)

  socket.receive({
    protocolVersion: PROTOCOL_VERSION,
    registration: { uuid: 'relay-issued-id', ready: true }
  })

  assert.equal(session.getState().connected, true)
  assert.equal(connectedCalls, 1)
  await delay(2 * 100)
  assert.equal(socket.destroyed, false)
  await session.close()
})

test('TLS control sessions close when relay registration stalls despite incoming bytes', async t => {
  const sockets = []
  t.mock.method(tls, 'connect', (_options, onSecureConnect) => {
    const socket = new MockSocket(onSecureConnect)
    sockets.push(socket)
    return socket
  })

  let connectedCalls = 0
  const session = createSession({
    handshakeTimeout: 25,
    onConnected: () => {
      connectedCalls++
    }
  })

  session.start()
  const socket = sockets[0]
  socket.completeTlsHandshake()
  const trickle = setInterval(() => socket.emit('data', Buffer.from('x')), 5)
  t.after(() => clearInterval(trickle))
  await once(socket, 'close')
  clearInterval(trickle)

  assert.equal(socket.destroyed, true)
  assert.equal(session.getState().connected, false)
  assert.equal(connectedCalls, 0)
  await session.close()
})

for (const type of [TYPES.AGENT, TYPES.CLIENT]) {
  test(`${type} control sessions reuse their relay-issued UUID after reconnecting`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const sockets = []
    t.mock.method(tls, 'connect', (_options, onSecureConnect) => {
      const socket = new MockSocket(onSecureConnect)
      sockets.push(socket)
      return socket
    })
    const session = createSession({ type, handshakeTimeout: 100, onConnected() {} })
    t.after(() => session.close())
    session.start()
    sockets[0].completeTlsHandshake()
    const firstRegistration = JSON.parse(crypt.decrypt(sockets[0].writes[0].toString().trim()))
    assert.equal(firstRegistration.uuid, undefined)
    sockets[0].receive({ protocolVersion: PROTOCOL_VERSION, registration: { uuid: 'issued-id', ready: true } })
    // Readiness changes must preserve identity even while an agent is offline.
    sockets[0].receive({ protocolVersion: PROTOCOL_VERSION, registration: { uuid: 'issued-id', ready: false } })
    sockets[0].destroy()
    t.mock.timers.tick(100)
    assert.equal(sockets.length, 2)
    sockets[1].completeTlsHandshake()
    const nextRegistration = JSON.parse(crypt.decrypt(sockets[1].writes[0].toString().trim()))
    assert.equal(nextRegistration.uuid, 'issued-id')
    assert.equal(nextRegistration.type, type)
  })
}

function createSession({ handshakeTimeout, onConnected, type = TYPES.CLIENT, ...config }) {
  return createPeerSession({
    messaging,
    config: {
      useTLS: true,
      relayHost: 'relay.example.test',
      relayPort: 443,
      reconnectDelay: 100,
      reconnectMaxDelay: 100,
      reconnectJitterPercent: 0,
      handshakeTimeout,
      ...config
    },
    type,
    name: 'tls-readiness-test',
    onConnected,
    onDisconnected() {},
    onMessage() {},
    onFatal(error) {
      throw error
    }
  })
}

class MockSocket extends EventEmitter {
  constructor(onSecureConnect) {
    super()
    this.onSecureConnect = onSecureConnect
    this.destroyed = false
    this.closed = false
    this.writableEnded = false
    this.writes = []
  }

  completeTlsHandshake() {
    this.onSecureConnect()
  }

  receive(message) {
    this.emit('data', Buffer.from(`${crypt.encrypt(JSON.stringify(message))}\n`))
  }

  setKeepAlive() {}

  write(data) {
    this.writes.push(Buffer.from(data))
    return true
  }

  unpipe() {}

  destroy() {
    if (this.destroyed) return this
    this.destroyed = true
    this.closed = true
    this.emit('close', false)
    return this
  }
}

for (const [label, config] of [
  ['API fallbacks', {}],
  ['agent defaults', getAgentConfig({})],
  ['client defaults', getClientConfig({})]
]) {
  test(`${label} detect missing pongs after nine seconds without extra pings or extending the deadline`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const sockets = []
    t.mock.method(tls, 'connect', (_options, onSecureConnect) => {
      const socket = new MockSocket(onSecureConnect)
      sockets.push(socket)
      return socket
    })
    const session = createSession({
      ...config,
      useTLS: true,
      reconnectDelay: 100,
      reconnectMaxDelay: 100,
      reconnectJitterPercent: 0,
      handshakeTimeout: 100,
      onConnected() {}
    })
    t.after(() => session.close())
    session.start()
    const socket = sockets[0]
    socket.completeTlsHandshake()
    const registration = { protocolVersion: PROTOCOL_VERSION, registration: { uuid: 'id', ready: true } }
    socket.receive(registration)
    t.mock.timers.tick(1_999)
    assert.equal(socket.writes.length, 1)
    t.mock.timers.tick(1)
    assert.deepEqual(JSON.parse(crypt.decrypt(socket.writes[1].toString().trim())), {
      protocolVersion: PROTOCOL_VERSION,
      ping: true
    })
    for (let i = 0; i < 6; i++) {
      t.mock.timers.tick(1_000)
      socket.receive(registration)
    }
    assert.equal(socket.writes.length, 2)
    t.mock.timers.tick(999)
    assert.equal(socket.destroyed, false)
    t.mock.timers.tick(1)
    assert.equal(socket.destroyed, true)
    assert.equal(session.getState().connected, false)
    t.mock.timers.tick(99)
    assert.equal(sockets.length, 1)
    t.mock.timers.tick(1)
    assert.equal(sockets.length, 2)
  })
}

test('registered TLS control reconnects after missing pongs despite incoming traffic', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const sockets = []
  t.mock.method(tls, 'connect', (_options, onSecureConnect) => {
    const socket = new MockSocket(onSecureConnect)
    sockets.push(socket)
    return socket
  })
  const session = createSession({
    handshakeTimeout: 100,
    heartbeatInterval: 10,
    heartbeatTimeout: 25,
    onConnected() {}
  })
  t.after(() => session.close())
  session.start()
  const socket = sockets[0]
  socket.completeTlsHandshake()
  socket.receive({ protocolVersion: PROTOCOL_VERSION, registration: { uuid: 'id', ready: true } })
  t.mock.timers.tick(10)
  assert.equal(socket.writes.length, 2) // Registration and first ping.
  for (let i = 0; i < 3; i++) {
    socket.receive({ protocolVersion: PROTOCOL_VERSION, registration: { uuid: 'id', ready: true } })
    t.mock.timers.tick(10)
  }
  assert.equal(socket.destroyed, true)
  assert.equal(session.getState().connected, false)
  t.mock.timers.tick(100)
  assert.equal(sockets.length, 2)
})

test('pongs keep a registered TLS control alive and close clears its watchdog', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let socket
  t.mock.method(tls, 'connect', (_options, onSecureConnect) => {
    socket = new MockSocket(onSecureConnect)
    return socket
  })
  const session = createSession({
    handshakeTimeout: 100,
    heartbeatInterval: 10,
    heartbeatTimeout: 25,
    onConnected() {}
  })
  session.start()
  socket.completeTlsHandshake()
  socket.receive({ protocolVersion: PROTOCOL_VERSION, registration: { uuid: 'id', ready: true } })
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(10)
    socket.receive({ protocolVersion: PROTOCOL_VERSION, pong: 1 })
  }
  assert.equal(socket.destroyed, false)
  t.mock.timers.tick(10) // Leave a pong outstanding at shutdown.
  await session.close()
  t.mock.timers.tick(1_000)
  assert.equal(session.getState().fatal, false)
})
