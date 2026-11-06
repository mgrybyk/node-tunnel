'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { once } = require('node:events')
const { createRelay } = require('../relay')
const { createAgent } = require('../agent')
const { createClient } = require('../client')
const { getAgentConfig, getClientConfig, getRelayConfig } = require('../config')
const { ERRORS } = require('../protocol')
const { createMessaging } = require('../utils')
const { createMessageQueue } = require('../test-support/message-queue')
const { host, listen, closeServer, reserveTopologyPorts, waitForCondition } = require('../test-support/helpers')

const env = { N_T_CRYPT_KEY: '0123456789abcdef0123456789abcdef' }
const messaging = createMessaging(getRelayConfig(env))

function send(socket, message) {
  messaging.sendJson(socket, message)
}

async function setup(t, clientCount = 2) {
  t.mock.method(console, 'log', () => {})
  const ports = await reserveTopologyPorts(clientCount)
  const relay = createRelay({ ...getRelayConfig(env), serviceHost: host, servicePort: ports.service })
  const applications = [relay]
  t.after(async () => {
    await Promise.all(applications.slice(1).map(application => application.close({ force: true })))
    await relay.close({ force: true })
  })
  await relay.start()
  const common = { ...env, N_T_RELAY_HOST: host, N_T_RELAY_PORT: String(ports.service) }
  const agent = targetPorts => {
    const application = createAgent({
      ...getAgentConfig({ ...common, N_T_AGENT_DATA_PORTS: targetPorts.join(',') }),
      targetHost: host
    })
    applications.push(application)
    return application
  }
  const client = (localPorts = ports.clients) => {
    const application = createClient(getClientConfig({ ...common, N_T_CLIENT_PORTS: localPorts.join(',') }))
    applications.push(application)
    return application
  }
  return { ports, relay, agent, client }
}

test('multiple listeners map by position, share a prefix, and recover after an agent outage', {
  timeout: 10_000
}, async t => {
  const topology = await setup(t, 3)
  const connections = [0, 0, 0]
  const backends = await Promise.all(
    connections.map(async (_, index) => {
      const server = net.createServer(socket => {
        connections[index]++
        socket.on('error', () => {})
        socket.end(`backend-${index}`)
      })
      t.after(() => closeServer(server))
      await listen(server)
      return server
    })
  )
  // Deliberately use an order unrelated to the numeric port order.
  const targets = [backends[2], backends[0], backends[1]].map(server => server.address().port)
  const agent = topology.agent(targets)
  const localPorts = [topology.ports.clients[1], topology.ports.clients[0]]
  const client = topology.client(localPorts)
  const otherClient = topology.client([topology.ports.clients[2]])
  await Promise.all([agent.start(), client.start(), otherClient.start()])
  await waitForCondition(() => client.getState().ready && otherClient.getState().ready)
  assert.deepEqual(await Promise.all([...localPorts, topology.ports.clients[2]].map(readResponse)), [
    'backend-2',
    'backend-0',
    'backend-2'
  ])
  assert.deepEqual(connections, [1, 0, 2], 'the unused agent port must receive no connections')

  await agent.close({ force: true })
  await waitForCondition(() => !client.getState().ready && !otherClient.getState().ready)
  const replacement = topology.agent([...targets].reverse())
  await replacement.start()
  await waitForCondition(() => client.getState().ready && otherClient.getState().ready)
  assert.deepEqual(await Promise.all(localPorts.map(readResponse)), ['backend-1', 'backend-0'])
  await client.close({ force: true })
  // All local listeners must be available again after shutdown.
  for (const port of localPorts) {
    const server = net.createServer()
    t.after(() => closeServer(server))
    await listen(server, port)
  }
})

for (const agentFirst of [true, false]) {
  test(`excess client ports fail pairing when ${agentFirst ? 'agent' : 'client'} arrives first`, {
    timeout: 5_000
  }, async t => {
    const topology = await setup(t)
    const agent = topology.agent([8888])
    const client = topology.client()
    const fatal = once(client, 'fatal')
    if (agentFirst) {
      await agent.start()
      await waitForCondition(() => agent.getState().ready)
      await client.start()
    } else {
      await client.start()
      await waitForCondition(() => client.getState().connected)
      assert.equal(client.getState().ready, false)
      await agent.start()
    }
    assert.equal((await fatal)[0].message, ERRORS.PORT_COUNT_MISMATCH)
    assert.equal(client.getState().ready, false)
    assert.equal(topology.relay.getState().pendingTunnels, 0)
  })
}

test('client startup rolls back earlier listeners on a bind failure and can retry', { timeout: 5_000 }, async t => {
  const topology = await setup(t)
  const blocker = net.createServer()
  t.after(() => closeServer(blocker))
  await listen(blocker, topology.ports.clients[1])
  const client = topology.client()
  await assert.rejects(client.start(), { code: 'EADDRINUSE' })
  assert.equal(client.getState().started, false)
  assert.equal(topology.relay.getState().serviceSockets, 0)
  const probe = net.createServer()
  t.after(() => closeServer(probe))
  await listen(probe, topology.ports.clients[0])
  await Promise.all([closeServer(probe), closeServer(blocker)])
  await Promise.all([client.start(), client.start()])
  assert.equal(client.getState().started, true)
})

test('relay rejects invalid indices before issuing tickets and rechecks counts on agent replacement', {
  timeout: 5_000
}, async t => {
  const { ports, relay } = await setup(t)
  const register = async (type, portCount, uuid) => {
    const socket = net.createConnection({ host, port: ports.service })
    t.after(() => socket.destroy())
    const messages = createMessageQueue(socket, 3000, messaging)
    send(socket, { kind: 'control', type, name: 'indices', portCount, uuid })
    const response = await messages.next()
    return { socket, messages, response }
  }
  const agent = await register('agent', 32)
  const client = await register('client', 2)
  for (const portIndex of [-1, 2, 3, 1.5, '1', null, {}]) {
    send(client.socket, { openTunnel: { requestId: 'invalid', portIndex } })
    assert.equal((await client.messages.next()).tunnelError.error, ERRORS.INVALID_PORT_INDEX)
    assert.equal(relay.getState().pendingTunnels, 0)
  }
  send(client.socket, { openTunnel: { requestId: 'valid', portIndex: 1 } })
  const [clientOpen, agentOpen] = await Promise.all([client.messages.next(), agent.messages.next()])
  assert.equal(agentOpen.openTunnel.portIndex, 1)
  assert.equal(agentOpen.openTunnel.ticket, clientOpen.openTunnel.ticket)
  await register('agent', 1, agent.response.registration.uuid)
  assert.equal((await client.messages.next()).error, ERRORS.PORT_COUNT_MISMATCH)
  assert.equal(relay.getState().pendingTunnels, 0)
})

test('agent independently rejects invalid indices without opening data or target connections', {
  timeout: 5_000
}, async t => {
  t.mock.method(console, 'log', () => {})
  let accepted = 0
  const relay = net.createServer()
  relay.on('connection', () => accepted++)
  t.after(() => closeServer(relay))
  await listen(relay)
  const connected = once(relay, 'connection')
  const agent = createAgent({
    ...getAgentConfig(env),
    relayHost: host,
    relayPort: relay.address().port,
    targetPorts: [8888, 8889]
  })
  t.after(() => agent.close({ force: true }))
  await agent.start()
  const [socket] = await connected
  const messages = createMessageQueue(socket, 3000, messaging)
  assert.equal((await messages.next()).portCount, 2)
  send(socket, { registration: { uuid: 'agent-id', ready: true } })
  for (const portIndex of [-1, 2, 1.5, '1', null, {}]) {
    send(socket, { openTunnel: { ticket: 'invalid-index-ticket', portIndex } })
    assert.deepEqual((await messages.next()).cancelTunnel, { ticket: 'invalid-index-ticket' })
  }
  assert.equal(accepted, 1)
  assert.equal(agent.getState().localConnections, 0)
  assert.equal(agent.getState().dataConnections, 0)
})

function readResponse(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const chunks = []
    socket.on('data', chunk => chunks.push(chunk))
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()))
    socket.on('error', reject)
  })
}

for (const [create, config, property] of [
  [createAgent, getAgentConfig(env), 'targetPorts'],
  [createClient, getClientConfig(env), 'localPorts']
]) {
  test(`${property} API accepts 32 ports and rejects excess or duplicate ports`, () => {
    const ports = Array.from({ length: 32 }, (_, index) => 10000 + index)
    assert.doesNotThrow(() => create({ ...config, [property]: ports }))
    assert.throws(() => create({ ...config, [property]: [...ports, 10032] }), /must not exceed 32 ports/)
    assert.throws(() => create({ ...config, [property]: [8888, 8888] }), /duplicate or overlapping ports/)
  })
}
