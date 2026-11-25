'use strict'

const { randomBytes } = require('node:crypto')

const CONFIGURE = 0
const REGISTER = 1
const DISCONNECT = 2
const CONTROL_FRAME = 3
const OPEN_TUNNEL = 4
const PING = 5
const DATA_PREFACE = 6
const DATA_FRAME = 7
const CANCEL = 8
const EMPTY = new Uint8Array(0)
const utf8 = new TextDecoder()

function createCore(module, { cryptKey, name, portCount }, nonce = () => randomBytes(12)) {
  const { exports: wasm } = new WebAssembly.Instance(module)
  const capacity = wasm.buffer_capacity()
  const pointer = wasm.buffer_ptr()
  const key = Buffer.from(cryptKey)
  if (key.length !== 32) throw new Error('control key must contain 32 bytes')
  try {
    if (call(CONFIGURE, key, json({ name, portCount })).type !== 'none') throw new Error('invalid client configuration')
  } finally {
    key.fill(0)
  }

  function call(operation, prefix = EMPTY, body = EMPTY) {
    if (prefix.length + body.length > capacity) return { type: 'reject' }
    const input = new Uint8Array(wasm.memory.buffer, pointer, capacity)
    input.set(prefix)
    input.set(body, prefix.length)
    const length = wasm.step(operation, prefix.length + body.length)
    if (length < 0) return { type: 'reject' }
    if (length === 0) return { type: 'none' }
    if (length > capacity) throw new Error('invalid WASM result length')

    // A Rust allocation can grow memory and detach the input view during the call.
    const output = new Uint8Array(wasm.memory.buffer, pointer, length)
    if (output[0] === 1) return { type: 'send', frame: Buffer.from(output.subarray(1)) }
    if (output[0] === 2) return JSON.parse(utf8.decode(output.subarray(1)))
    throw new Error('invalid WASM result type')
  }

  function send(operation, message) {
    const iv = nonce()
    if (iv.length !== 12) throw new Error('invalid control nonce length')
    return call(operation, iv, message === undefined ? undefined : json(message))
  }

  return {
    maxFrameBytes: wasm.max_frame_bytes(),
    register: () => send(REGISTER),
    disconnect: () => call(DISCONNECT),
    controlFrame: frame => call(CONTROL_FRAME, frame),
    openTunnel: (requestId, portIndex) => send(OPEN_TUNNEL, { requestId, portIndex }),
    ping: () => send(PING),
    dataPreface: ticket => send(DATA_PREFACE, ticket),
    dataFrame: frame => call(DATA_FRAME, frame),
    cancel: ticket => send(CANCEL, ticket)
  }
}

function json(value) {
  return Buffer.from(JSON.stringify(value))
}

module.exports = { createCore }
