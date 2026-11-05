'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'

const { MAX_CONTROL_FRAME_BYTES, createMessaging } = require('../utils')
const { crypt, writeMessage, sendJson, createMessageDecoder, createFirstMessageDecoder } = createMessaging()
const { getRelayConfig, readPort } = require('../config')
const { PROTOCOL_VERSION } = require('../protocol')

test('control decoder handles fragmented and coalesced frames', () => {
  const encoded = []
  const socket = {
    destroyed: false,
    write(data) {
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
    () => {
      invalidMessages++
    }
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
    write(data) {
      encoded.push(Buffer.from(data))
      return true
    }
  }
  const rawData = Buffer.from([0, 1, 10, 255, 42])
  let decoded

  writeMessage(socket, 'handshake')
  const decode = createFirstMessageDecoder(
    (message, remainder) => {
      decoded = { message, remainder: Buffer.from(remainder) }
    },
    () => assert.fail('valid handshake was rejected')
  )

  decode(Buffer.concat([encoded[0], rawData]))

  assert.equal(decoded.message, 'handshake')
  assert.deepEqual(decoded.remainder, rawData)
})

test('decoder stops after an invalid authenticated frame', () => {
  const invalidFrame = Buffer.from('not-valid-ciphertext\n')
  let invalidMessages = 0
  let decodedMessages = 0
  const decode = createMessageDecoder(
    () => {
      decodedMessages++
    },
    () => {
      invalidMessages++
    }
  )

  decode(invalidFrame)
  decode(invalidFrame)

  assert.equal(decodedMessages, 0)
  assert.equal(invalidMessages, 1)
})

for (const [name, createDecoder] of Object.entries({
  control: createMessageDecoder,
  first: createFirstMessageDecoder
})) {
  test(`${name} decoder bounds copying and scanning under heavy fragmentation`, t => {
    const payload = 'x'.repeat(MAX_CONTROL_FRAME_BYTES / 2)
    const frame = Buffer.from(`${crypt.encrypt(payload)}\n`)
    const concat = Buffer.concat
    const indexOf = Buffer.prototype.indexOf
    let copied = 0
    let scanned = 0
    t.mock.method(Buffer, 'concat', (buffers, ...args) => {
      copied += buffers.reduce((sum, buffer) => sum + buffer.length, 0)
      return concat(buffers, ...args)
    })
    t.mock.method(Buffer.prototype, 'indexOf', function (value, offset = 0) {
      scanned += this.length - offset
      return indexOf.call(this, value, offset)
    })
    const messages = []
    const decode = createDecoder(
      message => messages.push(message),
      () => assert.fail('valid fragmented frame rejected')
    )
    for (let offset = 0; offset < frame.length; offset++) decode(frame.subarray(offset, offset + 1))
    assert.deepEqual(messages, [payload])
    assert.ok(copied < 2 * frame.length, `${copied} copied bytes for ${frame.length} wire bytes`)
    assert.equal(scanned, frame.length)
  })

  test(`${name} decoder rejects oversized frames regardless of fragmentation`, async t => {
    const frame = Buffer.from(`${crypt.encrypt('x'.repeat(MAX_CONTROL_FRAME_BYTES))}\n`)
    for (const splitAt of [frame.length, frame.length - 1, 100]) {
      await t.test(`first chunk contains ${splitAt} bytes`, () => {
        let messages = 0
        let invalid = 0
        const decode = createDecoder(
          () => messages++,
          () => invalid++
        )
        decode(frame.subarray(0, splitAt))
        decode(frame.subarray(splitAt))
        decode(frame)
        assert.equal(messages, 0, 'oversized authenticated frames must never be delivered')
        assert.equal(invalid, 1, 'the decoder must stop after rejecting a frame')
      })
    }
  })
}

test('frame limit applies to each encoded frame, including the exact boundary', () => {
  // Base64 expands every 3 bytes to 4; encryption adds a version byte, 12-byte IV, and 16-byte tag.
  const payload = 'x'.repeat((MAX_CONTROL_FRAME_BYTES / 4) * 3 - 29)
  const frame = Buffer.from(`${crypt.encrypt(payload)}\n`)
  assert.equal(frame.length - 1, 4096)
  const messages = []
  const decode = createMessageDecoder(
    message => messages.push(message),
    () => assert.fail('valid frame rejected')
  )
  decode(Buffer.concat([frame, frame]))
  assert.deepEqual(messages, [payload, payload])
})

test('maximum-length registration fields fit within the control-frame limit even with JSON escaping', () => {
  // Control characters require six JSON bytes per character, more than UTF-8 names.
  const registration = { kind: 'control', type: 'client', name: '\u0000'.repeat(128), uuid: '\u0000'.repeat(128) }
  let frame
  sendJson({ write: data => (frame = Buffer.from(data)) }, registration)
  assert.ok(frame.length - 1 < MAX_CONTROL_FRAME_BYTES)
  const messages = []
  createMessageDecoder(
    data => messages.push(JSON.parse(data)),
    () => assert.fail('maximum-length registration rejected')
  )(frame)
  assert.deepEqual(messages, [{ protocolVersion: PROTOCOL_VERSION, ...registration }])
})

test('first-message frame limit excludes coalesced raw payload bytes', () => {
  const frame = Buffer.from(`${crypt.encrypt('ready')}\n`)
  const payload = Buffer.alloc(2 * 1024 * 1024, 0xff)
  let received
  const decode = createFirstMessageDecoder(
    (message, remainder) => {
      received = { message, remainder }
    },
    () => assert.fail('raw tunnel bytes must not count against the frame limit')
  )
  decode(Buffer.concat([frame, payload]))
  assert.equal(received.message, 'ready')
  assert.deepEqual(received.remainder, payload)
})

test('port configuration rejects invalid values', () => {
  process.env.N_T_TEST_PORT = '70000'
  assert.throws(() => readPort('N_T_TEST_PORT', 1234), /between 1 and 65535/)
  delete process.env.N_T_TEST_PORT
})

test('relay configuration exposes only the shared relay port', () => {
  const config = getRelayConfig({ N_T_RELAY_PORT: '3006' })
  assert.equal(config.servicePort, 3006)
  assert.equal('portsFrom' in config, false)
  assert.equal('portsTo' in config, false)
})

test('runtime startup rejects a crypt key with the wrong byte length', () => {
  const result = spawnSync(process.execPath, ['-e', 'require("./relay").createRelay()'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, N_T_CRYPT_KEY: 'too-short' },
    encoding: 'utf8'
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /N_T_CRYPT_KEY must contain exactly 32 UTF-8 bytes/)
})

test('a control message queued under backpressure counts as sent', () => {
  let writes = 0
  const socket = {
    write() {
      writes++
      return false
    }
  }
  assert.equal(writeMessage(socket, 'queued'), true)
  assert.equal(writes, 1)
  socket.writableEnded = true
  assert.equal(writeMessage(socket, 'too late'), false)
  assert.equal(writes, 1)
})
