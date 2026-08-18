'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const net = require('node:net')
const { host, waitForOutput, waitForListening, listen, closeServer } = require('../test-support/helpers')

test('output waiter immediately reports a child that already exited', async () => {
  const child = new EventEmitter()
  child.exitCode = 1
  child.signalCode = null
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()

  const info = {
    label: 'failed-server',
    child,
    stdout: '',
    stderr: 'Error: listen EADDRINUSE\n'
  }

  await assert.rejects(waitForOutput(info, 'Server listening', 200), error => {
    assert.match(error.message, /failed-server exited early \(code=1, signal=null\)/)
    assert.match(error.message, /listen EADDRINUSE/)
    return true
  })
})

test('output waiter observes captured output even when a stream notification is missed', async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()

  const info = {
    label: 'server',
    child,
    stdout: '',
    stderr: ''
  }

  const ready = waitForOutput(info, 'Server listening on port 58141', 200)
  info.stdout = 'INFO: Server listening on port 58141\n'

  await ready
})

test('listening waiter uses the TCP port instead of child output', async t => {
  const reservation = net.createServer()
  await listen(reservation)
  const port = reservation.address().port
  await closeServer(reservation)

  const server = net.createServer()
  t.after(() => closeServer(server))

  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  const info = { label: 'silent-server', child, stdout: '', stderr: '' }
  const ready = waitForListening(info, port, 500)

  setTimeout(() => server.listen(port, host), 25)
  await ready
})
