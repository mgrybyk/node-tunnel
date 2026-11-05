'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { bridgeSockets } = require('../socket-bridge')
const { host, listen, closeServer, waitForSocketClose } = require('../test-support/helpers')

test('socket bridge preserves simultaneous data and half-close', async t => {
  const left = await createSocketPair()
  const right = await createSocketPair()
  t.after(async () => {
    left.external.destroy()
    left.internal.destroy()
    right.external.destroy()
    right.internal.destroy()
    await Promise.all([closeServer(left.server), closeServer(right.server)])
  })

  bridgeSockets(left.internal, right.internal)

  const leftResponse = collect(left.external)
  const rightResponse = collect(right.external)
  left.external.end('from-left')
  right.external.end('from-right')

  assert.equal((await leftResponse).toString(), 'from-right')
  assert.equal((await rightResponse).toString(), 'from-left')
})

test('socket bridge forwards payload already decoded with a handshake', async t => {
  const left = await createSocketPair()
  const right = await createSocketPair()
  t.after(async () => {
    left.external.destroy()
    left.internal.destroy()
    right.external.destroy()
    right.internal.destroy()
    await Promise.all([closeServer(left.server), closeServer(right.server)])
  })

  bridgeSockets(left.internal, right.internal, {
    leftInitialData: Buffer.from('left-remainder'),
    rightInitialData: Buffer.from('right-remainder')
  })

  assert.equal((await readBytes(left.external, 'right-remainder'.length)).toString(), 'right-remainder')
  assert.equal((await readBytes(right.external, 'left-remainder'.length)).toString(), 'left-remainder')
})

test('socket bridge propagates an abrupt socket failure', async t => {
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
  bridgeSockets(left.internal, right.internal)

  left.internal.destroy(new Error('simulated reset'))
  await waitForSocketClose(right.internal)

  assert.equal(right.internal.destroyed, true)
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
