'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'

const { crypt } = require('../utils').createMessaging()
const { createMessageQueue } = require('../test-support/message-queue')

const frame = value => Buffer.from(`${crypt.encrypt(value)}\n`)

test('message queue preserves buffered messages and pending reader order across fragmented frames', async () => {
  const socket = new EventEmitter()
  const messages = createMessageQueue(socket)
  socket.emit('data', frame('{"index":0}'))
  assert.deepEqual(await messages.next(), { index: 0 })
  const first = messages.next()
  const second = messages.next()
  const data = Buffer.concat([frame('{"index":1}'), frame('{"index":2}')])
  socket.emit('data', data.subarray(0, 3))
  socket.emit('data', data.subarray(3))
  assert.deepEqual(await Promise.all([first, second]), [{ index: 1 }, { index: 2 }])
})

for (const failure of ['error', 'end', 'close', 'invalid frame', 'invalid JSON']) {
  test(`message queue rejects pending and future reads after ${failure}`, async () => {
    const socket = new EventEmitter()
    const messages = createMessageQueue(socket)
    const pending = [assert.rejects(messages.next()), assert.rejects(messages.next())]
    if (failure === 'invalid frame') socket.emit('data', Buffer.from('invalid\n'))
    else if (failure === 'invalid JSON') socket.emit('data', frame('invalid'))
    else socket.emit(failure, new Error('socket failed'))
    await Promise.all(pending)
    await assert.rejects(messages.next())
  })
}

test('message queue bounds reads even when a peer keeps sending incomplete data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const socket = new EventEmitter()
  const messages = createMessageQueue(socket, 100)
  const rejected = assert.rejects(messages.next(), /control message did not arrive within 100ms/)
  socket.emit('data', Buffer.from('x'))
  t.mock.timers.tick(100)
  await rejected
})
