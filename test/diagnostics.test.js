'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'
process.env.N_T_LOG_DEBUG = 'true'

const { traceSocket, tunnelReference } = require('../diagnostics')
const { log } = require('../utils')

function fields(line) {
  return JSON.parse(line.slice(line.indexOf('{')))
}

test('disabled diagnostics skip arguments, hashes, and socket listeners', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict')
    const { EventEmitter } = require('node:events')
    require('node:crypto').createHash = () => { throw new Error('unexpected debug hash') }
    const diagnostics = require('./diagnostics')
    const socket = new EventEmitter()
    let evaluated = 0
    diagnostics.traceSocket?.(socket, 'disabled', { ticket: String(++evaluated) })
    diagnostics.traceTunnel?.('disabled', String(++evaluated))
    diagnostics.debug?.('disabled', { count: ++evaluated })
    assert.equal(evaluated, 0)
    assert.deepEqual(socket.eventNames(), [])
    assert.deepEqual(Object.keys(diagnostics), [])
  `
    ],
    {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, N_T_LOG_DEBUG: 'false' },
      encoding: 'utf8'
    }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
})

test('socket tracing uses compact events without timers, data listeners, or listener reordering', t => {
  const logs = []
  t.mock.method(log, 'debug', line => logs.push(line))
  t.mock.method(global, 'setInterval', () => assert.fail('diagnostics must not create timers'))
  const socket = new EventEmitter()
  socket.bytesRead = 123
  socket.bytesWritten = 456
  socket.getProtocol = () => 'TLSv1.3'
  socket.getPeerCertificate = () => ({ issuer: { O: 'Test issuer' } })
  socket.on('secureConnect', () => trace('registration-sent'))
  const trace = traceSocket(socket, 'test', { ticket: 'secret-ticket' })
  assert.equal(socket.listenerCount('data'), 0)
  assert.equal(socket.listenerCount('drain'), 0)
  assert.equal(socket.listenerCount('end'), 0)
  assert.equal(socket.listenerCount('finish'), 0)
  socket.emit('secureConnect')
  trace('relay-registered')
  socket.emit('close', false)
  const closed = fields(logs.find(line => line.includes(' closed ')))
  assert.equal(closed.phase, 'relay-registered')
  assert.equal(closed.bytesRead, 123)
  assert.equal(closed.bytesWritten, 456)
  assert.equal(closed.tunnelRef, tunnelReference('secret-ticket'))
  assert.equal(fields(logs.find(line => line.includes(' tls-connected '))).issuer, 'Test issuer')
  assert.ok(
    logs.findIndex(line => line.includes(' registration-sent ')) <
      logs.findIndex(line => line.includes(' tls-connected '))
  )
  assert.equal(
    logs.some(line => line.includes('\n') || line.includes('secret-ticket')),
    false
  )
})

test('tunnel diagnostics identify a missing peer without exposing the ticket', async t => {
  const { createTcpDataTransport } = require('../tcp-data-transport')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const logs = []
  t.mock.method(log, 'debug', line => logs.push(line))
  const transport = createTcpDataTransport({ handshakeTimeout: 3_000, shutdownTimeout: 0 })
  const ticket = transport.createPendingTunnel({})
  const socket = new EventEmitter()
  socket.destroy = () => {
    socket.destroyed = true
    socket.closed = true
    socket.emit('close')
  }
  transport.acceptSocket(socket, { type: 'agent', ticket }, Buffer.alloc(0))
  const waiting = fields(logs.find(line => line.includes(' waiting-for-peer ')))
  assert.equal(waiting.waitingFor, 'client')
  assert.equal(waiting.tunnelRef, tunnelReference(ticket))
  t.mock.timers.tick(3_000)
  const expired = fields(logs.find(line => line.includes(' pending-cancelled ')))
  assert.equal(expired.reason, 'pairing-timeout')
  assert.equal(expired.agentArrived, true)
  assert.equal(expired.clientArrived, false)
  assert.equal(socket.destroyed, true)
  assert.equal(transport.getState().pendingTunnels, 0)
  assert.equal(JSON.stringify(logs).includes(ticket), false)
  await transport.close({ force: true })
})
