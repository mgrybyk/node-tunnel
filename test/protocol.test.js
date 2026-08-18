'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'

const {
  writeMessage,
  createMessageDecoder,
  createFirstMessageDecoder,
  readPort
} = require('../utils')

test('control decoder handles fragmented and coalesced frames', () => {
  const encoded = []
  const socket = {
    destroyed: false,
    write (data) {
      encoded.push(Buffer.from(data))
      return true
    }
  }

  writeMessage(socket, 'first')
  writeMessage(socket, 'second')

  const wireData = Buffer.concat(encoded)
  const messages = []
  let invalidMessages = 0
  const decode = createMessageDecoder(
    message => messages.push(message),
    () => { invalidMessages++ }
  )

  decode(wireData.subarray(0, 3))
  decode(wireData.subarray(3, wireData.length - 5))
  decode(wireData.subarray(wireData.length - 5))

  assert.deepEqual(messages, ['first', 'second'])
  assert.equal(invalidMessages, 0)
})

test('first-message decoder preserves coalesced raw tunnel bytes', () => {
  const encoded = []
  const socket = {
    destroyed: false,
    write (data) {
      encoded.push(Buffer.from(data))
      return true
    }
  }
  const rawData = Buffer.from([0, 1, 10, 255, 42])
  let decoded

  writeMessage(socket, 'handshake')
  const decode = createFirstMessageDecoder((message, remainder) => {
    decoded = { message, remainder: Buffer.from(remainder) }
  }, () => assert.fail('valid handshake was rejected'))

  decode(Buffer.concat([encoded[0], rawData]))

  assert.equal(decoded.message, 'handshake')
  assert.deepEqual(decoded.remainder, rawData)
})

test('decoder stops after an invalid authenticated frame', () => {
  const invalidFrame = Buffer.from('not-valid-ciphertext\n')
  let invalidMessages = 0
  let decodedMessages = 0
  const decode = createMessageDecoder(
    () => { decodedMessages++ },
    () => { invalidMessages++ }
  )

  decode(invalidFrame)
  decode(invalidFrame)

  assert.equal(decodedMessages, 0)
  assert.equal(invalidMessages, 1)
})

test('port configuration rejects invalid values', () => {
  process.env.N_T_TEST_PORT = '70000'
  assert.throws(() => readPort('N_T_TEST_PORT', 1234), /between 1 and 65535/)
  delete process.env.N_T_TEST_PORT
})

test('runtime startup rejects a crypt key with the wrong byte length', () => {
  const result = spawnSync(process.execPath, ['-e', 'require("./utils")'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, N_T_CRYPT_KEY: 'too-short' },
    encoding: 'utf8'
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /N_T_CRYPT_KEY must contain exactly 32 UTF-8 bytes/)
})
