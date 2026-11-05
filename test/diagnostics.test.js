'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'

const { traceSocket } = require('../diagnostics')
const { log } = require('../utils')

test('socket tracing preserves paused reads and stops snapshots on close', t => {
  const previous = process.env.N_T_LOG_DEBUG
  process.env.N_T_LOG_DEBUG = 'true'
  t.after(() => {
    if (previous === undefined) delete process.env.N_T_LOG_DEBUG
    else process.env.N_T_LOG_DEBUG = previous
  })
  t.mock.timers.enable({ apis: ['setInterval'] })
  const logs = []
  t.mock.method(log, 'debug', (...args) => logs.push(args))
  const socket = new EventEmitter()
  socket.bytesRead = 123
  socket.bytesWritten = 456
  socket.writableLength = 789
  socket.getProtocol = () => 'TLSv1.3'
  socket.getPeerCertificate = () => ({ issuer: { O: 'Test issuer' } })
  socket.on('secureConnect', () => trace('registration-sent'))
  const trace = traceSocket(socket, 'test')
  assert.equal(socket.listenerCount('data'), 0)
  socket.emit('secureConnect')
  trace('relay-registered')
  t.mock.timers.tick(15_000)
  const snapshot = logs.find(args => args[2] === 'snapshot')[3]
  assert.equal(snapshot.phase, 'relay-registered')
  assert.equal(snapshot.bytesRead, 123)
  assert.equal(snapshot.writableLength, 789)
  assert.equal(logs.find(args => args[2] === 'tls-connected')[3].issuer, 'Test issuer')
  assert.ok(
    logs.findIndex(args => args[2] === 'tls-connected') < logs.findIndex(args => args[2] === 'registration-sent')
  )
  socket.emit('close', false)
  const count = logs.length
  t.mock.timers.tick(30_000)
  assert.equal(logs.length, count)
})

test('tunnel diagnostics identify a missing peer without exposing the ticket', async t => {
  const { tunnelReference } = require('../diagnostics')
  const { createTcpDataTransport } = require('../tcp-data-transport')
  const previous = process.env.N_T_LOG_DEBUG
  process.env.N_T_LOG_DEBUG = 'true'
  t.after(() => {
    if (previous === undefined) delete process.env.N_T_LOG_DEBUG
    else process.env.N_T_LOG_DEBUG = previous
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const logs = []
  t.mock.method(log, 'debug', (...args) => logs.push(args))
  const transport = createTcpDataTransport({ handshakeTimeout: 3_000, shutdownTimeout: 0 })
  const ticket = transport.createPendingTunnel({})
  const socket = new EventEmitter()
  socket.destroy = () => {
    socket.destroyed = true
    socket.closed = true
    socket.emit('close')
  }
  transport.acceptSocket(socket, { type: 'agent', ticket }, Buffer.alloc(0))
  const waiting = logs.find(args => args[2] === 'waiting-for-peer')[3]
  assert.equal(waiting.waitingFor, 'client')
  assert.equal(waiting.tunnelRef, tunnelReference(ticket))
  t.mock.timers.tick(3_000)
  const expired = logs.find(args => args[2] === 'pending-cancelled')[3]
  assert.equal(expired.reason, 'pairing-timeout')
  assert.equal(expired.agentArrived, true)
  assert.equal(expired.clientArrived, false)
  assert.equal(socket.destroyed, true)
  assert.equal(transport.getState().pendingTunnels, 0)
  assert.equal(JSON.stringify(logs).includes(ticket), false)
  await transport.close({ force: true })
})
