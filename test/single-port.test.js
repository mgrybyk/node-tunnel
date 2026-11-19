'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'

const { createRelay } = require('../relay')
const { PROTOCOL_VERSION, TYPES, CONNECTION_KINDS } = require('../protocol')
const { crypt, writeMessage, createFirstMessageDecoder } = require('../utils').createMessaging()
const { createMessageQueue } = require('../test-support/message-queue')
const { host, reservePort, closeServer, waitForSocketClose, waitForCondition } = require('../test-support/helpers')

test('one relay port pairs ticketed data sockets, preserves preface remainders, and rejects replay', {
  timeout: 5_000
}, async t => {
  t.mock.method(console, 'log', () => {})
  const reservation = await reservePort()
  const port = reservation.port
  await closeServer(reservation.server)
  const relay = createRelay({
    servicePort: port,
    handshakeTimeout: 500,
    controlIdleTimeout: 5_000,
    shutdownTimeout: 500
  })
  const sockets = []

  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await relay.close({ force: true })
  })

  await relay.start()
  const agent = await connectControl(port, TYPES.AGENT, 'single-port-route')
  const client = await connectControl(port, TYPES.CLIENT, 'single-port-route')
  sockets.push(agent.socket, client.socket)

  const agentRegistration = await agent.messages.next()
  const clientRegistration = await client.messages.next()
  assert.equal(agentRegistration.registration.ready, true)
  assert.equal(clientRegistration.registration.ready, true)

  const requestId = 'open-1'
  writeMessage(client.socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, openTunnel: { requestId } }))
  const [clientOpen, agentOpen] = await Promise.all([client.messages.next(), agent.messages.next()])
  assert.equal(clientOpen.openTunnel.requestId, requestId)
  assert.equal(clientOpen.openTunnel.ticket, agentOpen.openTunnel.ticket)

  const clientPayload = Buffer.from('payload-coalesced-with-client-preface')
  const clientPayloadBeforePair = Buffer.from('payload-in-a-later-chunk-before-pairing')
  const agentPayload = Buffer.from('payload-coalesced-with-agent-preface')
  const clientData = await connectData(port)
  const agentData = await connectData(port)
  sockets.push(clientData, agentData)

  clientData.write(
    encodeFirstFrame(
      {
        protocolVersion: PROTOCOL_VERSION,
        kind: CONNECTION_KINDS.DATA,
        type: TYPES.CLIENT,
        ticket: clientOpen.openTunnel.ticket
      },
      clientPayload
    )
  )
  clientData.write(clientPayloadBeforePair)
  await delay(20)
  agentData.write(
    encodeFirstFrame(
      {
        protocolVersion: PROTOCOL_VERSION,
        kind: CONNECTION_KINDS.DATA,
        type: TYPES.AGENT,
        ticket: agentOpen.openTunnel.ticket
      },
      agentPayload
    )
  )

  const [clientReady, agentReady] = await Promise.all([
    readFirstFrameAndBytes(clientData, agentPayload.length),
    readFirstFrameAndBytes(agentData, clientPayload.length + clientPayloadBeforePair.length)
  ])
  assert.equal(clientReady.message.ready, true)
  assert.equal(agentReady.message.ready, true)
  assert.deepEqual(clientReady.payload, agentPayload)
  assert.deepEqual(agentReady.payload, Buffer.concat([clientPayload, clientPayloadBeforePair]))

  const replay = await connectData(port)
  sockets.push(replay)
  replay.on('end', () => replay.end())
  writeMessage(
    replay,
    JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      kind: CONNECTION_KINDS.DATA,
      type: TYPES.CLIENT,
      ticket: clientOpen.openTunnel.ticket
    })
  )
  await waitForSocketClose(replay)
  assert.equal(replay.destroyed, true)

  clientData.on('end', () => clientData.end())
  agentData.on('end', () => agentData.end())
  const replacementClient = await connectControl(
    port,
    TYPES.CLIENT,
    'single-port-route',
    clientRegistration.registration.uuid
  )
  sockets.push(replacementClient.socket)
  await replacementClient.messages.next()
  const receivedByAgent = once(agentData, 'data')
  clientData.write(Buffer.from([0x7f]))
  assert.deepEqual((await receivedByAgent)[0], Buffer.from([0x7f]))

  const replacementAgent = await connectControl(
    port,
    TYPES.AGENT,
    'single-port-route',
    agentRegistration.registration.uuid
  )
  sockets.push(replacementAgent.socket)
  await replacementAgent.messages.next()
  const receivedByClient = once(clientData, 'data')
  agentData.write(Buffer.from([0x80]))
  assert.deepEqual((await receivedByClient)[0], Buffer.from([0x80]))
  replacementAgent.socket.destroy()
  await Promise.all([waitForSocketClose(clientData), waitForSocketClose(agentData)])
})

test('client replacement cancels pending tickets and routes keep session identities isolated', {
  timeout: 5_000
}, async t => {
  t.mock.method(console, 'log', () => {})
  const reservation = await reservePort()
  const port = reservation.port
  await closeServer(reservation.server)
  const relay = createRelay({
    serviceHost: host,
    servicePort: port,
    handshakeTimeout: 2_000,
    controlIdleTimeout: 5_000
  })
  const sockets = []
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await relay.close({ force: true })
  })
  await relay.start()
  const register = async (type, name) => {
    const connection = await connectControl(port, type, name, 'shared-uuid')
    sockets.push(connection.socket)
    const response = await connection.messages.next()
    return { ...connection, registration: response.registration }
  }
  const send = (connection, message) =>
    writeMessage(connection.socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message }))
  const agent = await register(TYPES.AGENT, 'first-route')
  const client = await register(TYPES.CLIENT, 'first-route')
  const otherClient = await register(TYPES.CLIENT, 'other-route')
  assert.equal(client.registration.ready, true)
  assert.equal(otherClient.registration.ready, false)
  assert.equal(relay.getState().connectionNames, 2)

  send(client, { openTunnel: { requestId: 'before-replacement' } })
  const [firstOpen] = await Promise.all([client.messages.next(), agent.messages.next()])
  assert.equal(relay.getState().pendingTunnels, 1)
  const replacement = await register(TYPES.CLIENT, 'first-route')
  await waitForCondition(() => relay.getState().pendingTunnels === 0)

  send(replacement, { openTunnel: { requestId: 'after-replacement' } })
  const [nextOpen] = await Promise.all([replacement.messages.next(), agent.messages.next()])
  const ticket = nextOpen.openTunnel.ticket
  assert.notEqual(ticket, firstOpen.openTunnel.ticket)
  send(otherClient, { cancelTunnel: { ticket } })
  send(otherClient, { ping: true })
  await otherClient.messages.next()
  assert.equal(relay.getState().pendingTunnels, 1, 'another route cannot cancel the replacement session ticket')

  send(otherClient, { openTunnel: { requestId: 'unavailable-route' } })
  assert.ok((await otherClient.messages.next()).tunnelError)
  send(replacement, { cancelTunnel: { ticket } })
  send(replacement, { ping: true })
  await replacement.messages.next()
  assert.equal(relay.getState().pendingTunnels, 0)
})

test('invalid registration fields are rejected before allocating a route', { timeout: 5_000 }, async t => {
  t.mock.method(console, 'log', () => {})
  const reservation = await reservePort()
  const port = reservation.port
  await closeServer(reservation.server)
  const relay = createRelay({
    serviceHost: host,
    servicePort: port,
    handshakeTimeout: 500,
    controlIdleTimeout: 5_000,
    shutdownTimeout: 0
  })
  t.after(() => relay.close({ force: true }))
  await relay.start()
  for (const fields of [
    { name: {} },
    { name: 42 },
    { name: '' },
    { name: 'x'.repeat(129) },
    { uuid: {} },
    { uuid: 42 },
    { uuid: '' },
    { uuid: 'x'.repeat(129) },
    { uuid: null },
    { type: 'unknown' }
  ]) {
    const socket = await connectData(port)
    t.after(() => socket.destroy())
    socket.on('end', () => socket.end())
    socket.resume()
    writeMessage(
      socket,
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        kind: CONNECTION_KINDS.CONTROL,
        type: TYPES.CLIENT,
        name: 'valid-route',
        ...fields
      })
    )
    await waitForSocketClose(socket)
    assert.equal(relay.getState().connectionNames, 0)
    assert.equal(relay.getState().serviceSockets, 0)
  }
  const valid = await connectControl(port, TYPES.CLIENT, 'x'.repeat(128), 'u'.repeat(128))
  t.after(() => valid.socket.destroy())
  assert.equal((await valid.messages.next()).registration.ready, false)
})

async function connectControl(port, type, name, uuid) {
  const socket = await connectData(port)
  const messages = createMessageQueue(socket)
  writeMessage(
    socket,
    JSON.stringify({ protocolVersion: PROTOCOL_VERSION, kind: CONNECTION_KINDS.CONTROL, type, name, uuid })
  )
  return { socket, messages }
}

function connectData(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, allowHalfOpen: true })
    socket.on('error', () => {})
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function encodeFirstFrame(message, payload) {
  return Buffer.concat([Buffer.from(`${crypt.encrypt(JSON.stringify(message))}\n`), payload])
}

function readFirstFrameAndBytes(socket, expectedPayloadLength) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    let message
    const decode = createFirstMessageDecoder(
      (value, remainder) => {
        message = JSON.parse(value)
        socket.removeListener('data', decode)
        if (remainder.length > 0) append(remainder)
        socket.on('data', append)
        finishIfComplete()
      },
      () => reject(new Error('invalid ready frame'))
    )

    function append(chunk) {
      chunks.push(Buffer.from(chunk))
      length += chunk.length
      finishIfComplete()
    }

    function finishIfComplete() {
      if (!message || length < expectedPayloadLength) return
      socket.removeListener('data', append)
      resolve({ message, payload: Buffer.concat(chunks, length) })
    }

    socket.on('data', decode)
    socket.once('error', reject)
  })
}
