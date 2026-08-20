'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { createTcpByteChannel, bridgeByteChannels } = require('../byte-channel')
const { host, listen, closeServer, waitForSocketClose } = require('../test-support/helpers')

test('byte channel bridge preserves simultaneous data and half-close', async t => {
  const left = await createSocketPair()
  const right = await createSocketPair()
  t.after(async () => {
    left.external.destroy()
    left.internal.destroy()
    right.external.destroy()
    right.internal.destroy()
    await Promise.all([closeServer(left.server), closeServer(right.server)])
  })

  bridgeByteChannels(createTcpByteChannel(left.internal), createTcpByteChannel(right.internal))

  const leftResponse = collect(left.external)
  const rightResponse = collect(right.external)
  left.external.end('from-left')
  right.external.end('from-right')

  assert.equal((await leftResponse).toString(), 'from-right')
  assert.equal((await rightResponse).toString(), 'from-left')
})

test('byte channel bridge forwards payload already decoded with a handshake', async t => {
  const left = await createSocketPair()
  const right = await createSocketPair()
  t.after(async () => {
    left.external.destroy()
    left.internal.destroy()
    right.external.destroy()
    right.internal.destroy()
    await Promise.all([closeServer(left.server), closeServer(right.server)])
  })

  bridgeByteChannels(
    createTcpByteChannel(left.internal, { initialData: Buffer.from('left-remainder') }),
    createTcpByteChannel(right.internal, { initialData: Buffer.from('right-remainder') })
  )

  assert.equal((await readBytes(left.external, 'right-remainder'.length)).toString(), 'right-remainder')
  assert.equal((await readBytes(right.external, 'left-remainder'.length)).toString(), 'left-remainder')
})

test('byte channel bridge propagates an abrupt socket failure', async t => {
  const left = await createSocketPair()
  const right = await createSocketPair()
  t.after(async () => {
    left.external.destroy()
    left.internal.destroy()
    right.external.destroy()
    right.internal.destroy()
    await Promise.all([closeServer(left.server), closeServer(right.server)])
  })

  left.internal.on('error', () => {})
  right.internal.on('error', () => {})
  const leftChannel = createTcpByteChannel(left.internal)
  bridgeByteChannels(leftChannel, createTcpByteChannel(right.internal))

  leftChannel.abort(new Error('simulated reset'))
  await waitForSocketClose(right.internal)

  assert.equal(right.internal.destroyed, true)
})

test('TCP byte channel exposes chunk reads and backpressured writes', async t => {
  const pair = await createSocketPair()
  t.after(async () => {
    pair.external.destroy()
    pair.internal.destroy()
    await closeServer(pair.server)
  })

  const channel = createTcpByteChannel(pair.internal, { initialData: Buffer.from('initial-') })
  const inbound = collectChannel(channel)
  const outbound = collect(pair.external)

  pair.external.end('payload')
  await channel.write(Buffer.from('response'))
  channel.closeWrite()

  assert.equal((await inbound).toString(), 'initial-payload')
  assert.equal((await outbound).toString(), 'response')
  await channel.closed
  await assert.rejects(channel.write(Buffer.from('late')), /byte channel is closed/)
})

test('generic byte channel bridge pumps, aborts, and propagates failures', async () => {
  const left = createMemoryChannel(['left'])
  const right = createMemoryChannel(['right'])
  const bridge = bridgeByteChannels(left, right)
  await bridge.completed

  assert.deepEqual(left.writes, ['right'])
  assert.deepEqual(right.writes, ['left'])
  assert.equal(left.writeClosed, true)
  assert.equal(right.writeClosed, true)

  const manualAbort = new Error('manual abort')
  bridge.abort(manualAbort)
  assert.equal(left.aborted, manualAbort)
  assert.equal(right.aborted, manualAbort)

  const source = createMemoryChannel(['fails'])
  const destination = createMemoryChannel([], { writeError: new Error('write failed') })
  const failedBridge = bridgeByteChannels(source, destination)
  await assert.rejects(failedBridge.completed, /write failed/)
  assert.match(source.aborted.message, /write failed/)
  assert.match(destination.aborted.message, /write failed/)
})

async function createSocketPair() {
  let resolveInternal
  const internalPromise = new Promise(resolve => {
    resolveInternal = resolve
  })
  const server = net.createServer({ allowHalfOpen: true }, resolveInternal)
  await listen(server)
  const external = net.createConnection({ host, port: server.address().port, allowHalfOpen: true })
  external.on('error', () => {})
  const internal = await internalPromise
  internal.on('error', () => {})
  return { server, external, internal }
}

function collect(socket) {
  return new Promise((resolve, reject) => {
    const chunks = []
    socket.on('data', chunk => chunks.push(chunk))
    socket.on('end', () => resolve(Buffer.concat(chunks)))
    socket.on('error', reject)
  })
}

function readBytes(socket, expectedLength) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0

    function onData(chunk) {
      chunks.push(chunk)
      length += chunk.length
      if (length < expectedLength) return
      cleanup()
      resolve(Buffer.concat(chunks, length))
    }

    function cleanup() {
      socket.off('data', onData)
      socket.off('error', onError)
    }

    function onError(error) {
      cleanup()
      reject(error)
    }

    socket.on('data', onData)
    socket.on('error', onError)
  })
}

async function collectChannel(channel) {
  const chunks = []
  for await (const chunk of channel.read()) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function createMemoryChannel(chunks, { writeError } = {}) {
  return {
    writes: [],
    writeClosed: false,
    aborted: undefined,
    async *read() {
      for (const chunk of chunks) yield Buffer.from(chunk)
    },
    async write(chunk) {
      if (writeError) throw writeError
      this.writes.push(chunk.toString())
    },
    closeWrite() {
      this.writeClosed = true
    },
    abort(error) {
      this.aborted = error
    },
    closed: Promise.resolve()
  }
}
