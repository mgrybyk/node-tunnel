'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Duplex } = require('node:stream')
const { once } = require('node:events')
const { createTcpDataTransport } = require('../tcp-data-transport')
const { createMessaging } = require('../utils')

test('session cleanup cancels every matching pending ticket and preserves unrelated sessions', async t => {
  const transport = createTransport(t)
  const session = {}
  const sockets = []
  for (let i = 0; i < 6; i++) {
    const ticket = transport.createPendingTunnel(
      i % 2 ? { agentSession: session, clientSession: {} } : { agentSession: {}, clientSession: session }
    )
    const socket = createSocket()
    sockets.push(socket)
    transport.acceptSocket(socket, { type: 'client', ticket }, Buffer.alloc(0))
  }
  const otherTicket = transport.createPendingTunnel({ agentSession: {}, clientSession: {} })
  const otherSocket = createSocket()
  transport.acceptSocket(otherSocket, { type: 'client', ticket: otherTicket }, Buffer.alloc(0))
  const closed = sockets.map(socket => once(socket, 'close'))
  transport.closeAgentSession(session)
  await Promise.all(closed)
  assert.deepEqual(transport.getState(), { pendingTunnels: 1, activeTunnels: 0, dataSockets: 1 })
  assert.equal(otherSocket.destroyed, false)
})

test('closing an unpaired data socket cancels its ticket', async t => {
  const transport = createTransport(t)
  const ticket = transport.createPendingTunnel({})
  const socket = createSocket()
  transport.acceptSocket(socket, { type: 'client', ticket }, Buffer.alloc(0))
  const closed = once(socket, 'close')
  socket.destroy()
  await closed
  assert.deepEqual(transport.getState(), { pendingTunnels: 0, activeTunnels: 0, dataSockets: 0 })
  assert.equal(transport.cancelPendingTunnel(ticket), false)
})

test('replacement sessions own all established tunnels after pending setup has been released', async t => {
  const transport = createTransport(t)
  const oldSession = {}
  const newSession = {}
  const sockets = []
  for (let i = 0; i < 3; i++) {
    const ticket = transport.createPendingTunnel({ agentSession: oldSession, clientSession: {} })
    for (const type of ['client', 'agent']) {
      const socket = createSocket()
      sockets.push(socket)
      transport.acceptSocket(socket, { type, ticket }, Buffer.alloc(0))
    }
  }
  transport.replaceSession(oldSession, newSession)
  transport.closeAgentSession(oldSession)
  assert.ok(sockets.every(socket => !socket.destroyed))
  assert.deepEqual(transport.getState(), { pendingTunnels: 0, activeTunnels: 3, dataSockets: 6 })
  const closed = sockets.map(socket => once(socket, 'close'))
  transport.closeAgentSession(newSession)
  await Promise.all(closed)
  assert.deepEqual(transport.getState(), { pendingTunnels: 0, activeTunnels: 0, dataSockets: 0 })
})

function createTransport(t) {
  const messaging = createMessaging({ cryptKey: '0123456789abcdef0123456789abcdef' })
  const transport = createTcpDataTransport({ handshakeTimeout: 5_000, shutdownTimeout: 0 }, messaging)
  t.after(() => transport.close({ force: true }))
  return transport
}

function createSocket() {
  const socket = new Duplex({
    allowHalfOpen: true,
    read() {},
    write(_chunk, _encoding, done) {
      done()
    }
  })
  socket.setTimeout = () => socket
  return socket
}
