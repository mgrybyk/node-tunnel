import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createCore } from '../rust/client-core.js'
import { createWasmClientProtocol } from '../rust/client-protocol.js'
import utils from '../utils.js'

const cryptKey = '0123456789abcdef0123456789abcdef'
const name = 'route-🌍'
const { crypt } = utils.createMessaging({ cryptKey })
const module = new WebAssembly.Module(await readFile(new URL('../rust/client.wasm', import.meta.url)))

function encode(message) {
  return Buffer.from(crypt.encrypt(JSON.stringify({ protocolVersion: 9, ...message })))
}

function decode(action) {
  assert.equal(action.type, 'send')
  assert.equal(action.frame.at(-1), 0x0a)
  const body = crypt.decrypt(action.frame.subarray(0, -1).toString('ascii'))
  assert.ok(body)
  return JSON.parse(body)
}

test('WASM is import-free and produces the v9 envelope byte for byte for identical plaintext', () => {
  assert.deepEqual(WebAssembly.Module.imports(module), [])
  const nonce = Buffer.from('000102030405060708090a0b', 'hex')
  const core = createCore(module, { cryptKey, name, portCount: 2 }, () => nonce)
  const registration = core.register()
  assert.deepEqual(decode(registration), { protocolVersion: 9, kind: 'control', type: 'client', name, portCount: 2 })

  const envelope = Buffer.from(registration.frame.toString('ascii'), 'base64')
  const plain = crypt.decrypt(registration.frame.toString('ascii'))
  const cipher = createCipheriv('chacha20-poly1305', Buffer.from(cryptKey), nonce, { authTagLength: 16 })
  cipher.setAAD(Buffer.from('node-tunnel-control'))
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  assert.deepEqual(envelope, Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]))
})

test('JS and WASM exchange registration, heartbeat, tunnel, and reconnect messages', () => {
  const core = createCore(module, { cryptKey, name, portCount: 2 })
  core.register()
  assert.deepEqual(core.controlFrame(encode({ pong: true })), { type: 'reject' })
  assert.deepEqual(core.controlFrame(encode({ registration: { uuid: 'peer-1', ready: false } })), {
    type: 'registration',
    ready: false
  })
  assert.deepEqual(core.openTunnel('request-1', 0), { type: 'reject' })
  assert.deepEqual(decode(core.ping()), { protocolVersion: 9, ping: true })
  assert.deepEqual(core.controlFrame(encode({ pong: true })), { type: 'pong' })
  assert.deepEqual(core.controlFrame(encode({ registration: { uuid: 'peer-1', ready: true } })), {
    type: 'registration',
    ready: true
  })
  assert.deepEqual(core.openTunnel('request-1', 2), { type: 'reject' })
  assert.deepEqual(decode(core.openTunnel('request-1', 1)), {
    protocolVersion: 9,
    openTunnel: { requestId: 'request-1', portIndex: 1 }
  })
  const ticket = { ticket: 'ticket-1' }
  assert.deepEqual(core.controlFrame(encode({ openTunnel: { requestId: 'request-1', ...ticket } })), {
    type: 'open-data',
    requestId: 'request-1',
    ...ticket
  })
  assert.deepEqual(decode(core.dataPreface(ticket.ticket)), {
    protocolVersion: 9,
    kind: 'data',
    type: 'client',
    ...ticket
  })
  assert.deepEqual(decode(core.cancel(ticket.ticket)), { protocolVersion: 9, cancelTunnel: ticket })
  const tunnelError = { requestId: 'request-1', error: 'tunnel is unavailable' }
  assert.deepEqual(core.controlFrame(encode({ tunnelError })), { type: 'tunnel-error', ...tunnelError })
  assert.deepEqual(core.dataFrame(encode({ ready: true })), { type: 'start-forwarding' })
  assert.deepEqual(core.dataFrame(encode({ ready: false })), { type: 'reject' })
  core.disconnect()
  assert.deepEqual(core.ping(), { type: 'reject' })
  assert.equal(decode(core.register()).uuid, 'peer-1')
})

test('incoming frames enforce authentication, protocol version, JSON, and the 4 KiB limit', () => {
  const core = createCore(module, { cryptKey, name, portCount: 1 })
  const wire = encode({ registration: { uuid: 'peer-1', ready: true } })
  const envelope = Buffer.from(wire.toString(), 'base64')
  envelope[13] ^= 1
  assert.deepEqual(core.controlFrame(Buffer.from(envelope.toString('base64'))), { type: 'reject' })
  assert.deepEqual(core.controlFrame(Buffer.from(crypt.encrypt('['))), { type: 'reject' })
  assert.deepEqual(core.controlFrame(encode({ protocolVersion: 10 })), {
    type: 'fatal',
    error: 'protocol version mismatch: client=9, relay=10'
  })
  assert.deepEqual(core.controlFrame(encode({ error: 'client requests more ports than the agent provides' })), {
    type: 'fatal',
    error: 'client requests more ports than the agent provides'
  })
  assert.deepEqual(core.dataFrame(encode({ protocolVersion: 10, ready: true })), { type: 'reject' })
  const urlSafe = Buffer.from(wire.toString(), 'base64').toString('base64url')
  assert.deepEqual(core.controlFrame(Buffer.from(`${urlSafe.slice(0, 5)} \t${urlSafe.slice(5)}`)), {
    type: 'registration',
    ready: true
  })
  const padding = ' '.repeat(4096 - wire.length)
  const boundary = Buffer.concat([Buffer.from(padding), wire])
  assert.deepEqual(core.controlFrame(boundary), { type: 'registration', ready: true })
  assert.deepEqual(core.controlFrame(Buffer.concat([Buffer.from(' '), boundary])), { type: 'reject' })
})

test('WASM readiness decoder returns coalesced data as a view of the original chunk', () => {
  const protocol = createWasmClientProtocol({ cryptKey, name }, 1)
  const ready = encode({ ready: true })
  const payload = randomBytes(64 * 1024)
  const chunk = Buffer.concat([ready.subarray(5), Buffer.from('\n'), payload])
  const remainders = []
  const decodeReady = protocol.createReadyDecoder(remainder => remainders.push(remainder), assert.fail)

  decodeReady(ready.subarray(0, 5))
  assert.equal(remainders.length, 0)
  decodeReady(chunk)
  decodeReady(payload)
  assert.deepEqual(remainders, [payload])
  assert.equal(remainders[0].buffer, chunk.buffer)
  assert.equal(remainders[0].byteOffset, chunk.byteOffset + ready.length - 5 + 1)
})

test('WASM control decoder handles coalesced frames and rejects an oversized fragmented frame', () => {
  const protocol = createWasmClientProtocol({ cryptKey, name }, 1)
  const registration = encode({ registration: { uuid: 'peer-1', ready: true } })
  const pong = encode({ pong: true })
  const events = []
  let rejections = 0
  const decodeControl = protocol.createDecoder(
    event => events.push(event),
    () => rejections++
  )

  decodeControl(registration.subarray(0, 7))
  decodeControl(Buffer.concat([registration.subarray(7), Buffer.from('\n'), pong, Buffer.from('\n')]))
  assert.deepEqual(events, [
    { registration: true, message: { registration: { ready: true } } },
    { pong: true, message: {} }
  ])
  decodeControl(Buffer.alloc(4096, 0x41))
  assert.equal(rejections, 0)
  decodeControl(Buffer.from('A\n'))
  assert.equal(rejections, 1)
  assert.equal(events.length, 2)
})
