'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const tls = require('node:tls')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'

const { createPeerSession } = require('../peer-session')
const { PROTOCOL_VERSION, TYPES } = require('../protocol')
const { crypt } = require('../utils')

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

function createSession({ handshakeTimeout, onConnected }) {
  return createPeerSession({
    config: {
      useTLS: true,
      relayHost: 'relay.example.test',
      relayPort: 443,
      reconnectDelay: 100,
      reconnectMaxDelay: 100,
      reconnectJitterPercent: 0,
      handshakeTimeout
    },
    type: TYPES.CLIENT,
    name: 'tls-readiness-test',
    getUuid: () => undefined,
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
