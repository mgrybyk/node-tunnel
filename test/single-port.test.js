'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { setTimeout: delay } = require('node:timers/promises')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'

const { createRelay } = require('../relay')
const { PROTOCOL_VERSION, TYPES, CONNECTION_KINDS } = require('../protocol')
const { crypt, writeMessage, createMessageDecoder, createFirstMessageDecoder, log } = require('../utils')
const { host, reservePort, closeServer, waitForSocketClose } = require('../test-support/helpers')

test('one relay port pairs ticketed data sockets, preserves preface remainders, and rejects replay', async t => {
  t.mock.method(log, 'info', () => {})
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

  const [clientReady, receivedByAgent] = await Promise.all([
    readFirstFrameAndBytes(clientData, agentPayload.length),
    readBytes(agentData, clientPayload.length + clientPayloadBeforePair.length)
  ])
  assert.equal(clientReady.message.ready, true)
  assert.deepEqual(clientReady.payload, agentPayload)
  assert.deepEqual(receivedByAgent, Buffer.concat([clientPayload, clientPayloadBeforePair]))

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
  const replacementAgent = await connectControl(
    port,
    TYPES.AGENT,
    'single-port-route',
    agentRegistration.registration.uuid
  )
  sockets.push(replacementAgent.socket)
  await replacementAgent.messages.next()
  replacementAgent.socket.destroy()
  await Promise.all([waitForSocketClose(clientData), waitForSocketClose(agentData)])
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

function createMessageQueue(socket) {
  const messages = []
  const waiters = []
  const decode = createMessageDecoder(message => {
    const parsed = JSON.parse(message)
    const waiter = waiters.shift()
    if (waiter) waiter(parsed)
    else messages.push(parsed)
  })
  socket.on('data', decode)

  return {
    next() {
      if (messages.length > 0) return Promise.resolve(messages.shift())
      return new Promise(resolve => waiters.push(resolve))
    }
  }
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

    function onError(error) {
      cleanup()
      reject(error)
    }

    function cleanup() {
      socket.off('data', onData)
      socket.off('error', onError)
    }

    socket.on('data', onData)
    socket.on('error', onError)
  })
}
