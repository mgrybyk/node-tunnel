'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { setTimeout: delay } = require('node:timers/promises')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'

const { PROTOCOL_VERSION, ERRORS } = require('../protocol')
const { writeMessage, createMessageDecoder } = require('../utils')
const {
  host,
  startChild,
  waitForOutput,
  waitForOutputCount,
  waitForListening,
  waitForExit,
  stopChild,
  formatChildLogs,
  reserveTopologyPorts,
  reservePort,
  listen,
  closeServer,
  waitForSocketClose
} = require('../test-support/helpers')

const cryptKey = process.env.N_T_CRYPT_KEY

test('client becomes usable when its agent connects later', { timeout: 20_000 }, async t => {
  const children = []
  const servers = []
  registerCleanup(t, children, servers)

  try {
    const backend = createEchoServer()
    await listen(backend)
    servers.push(backend)
    const ports = await reserveTopologyPorts(1, 1)
    const env = topologyEnv(ports)

    const server = startChild('server', 'server.js', env)
    const client = startChild('client', 'client.js', {
      ...env,
      N_T_CLIENT_NAME: 'late-agent',
      N_T_CLIENT_PORT: String(ports.clients[0])
    })
    children.push(server, client)

    await waitForListening(server, ports.service)
    await waitForOutput(client, 'waiting for agent')
    await expectConnectionToClose(ports.clients[0])

    const agent = startChild('agent', 'agent.js', {
      ...env,
      N_T_AGENT_NAME: 'late-agent',
      N_T_AGENT_DATA_HOST: host,
      N_T_AGENT_DATA_PORT: String(backend.address().port)
    })
    children.push(agent)

    await waitForOutput(client, 'Agent found, ready!')
    await assertEcho(ports.clients[0], Buffer.from('client connected before agent'))
  } catch (error) {
    t.diagnostic(formatChildLogs(children))
    throw error
  }
})

test('agent and client recover after repeated server restarts', { timeout: 30_000 }, async t => {
  const children = []
  const servers = []
  registerCleanup(t, children, servers)

  try {
    const backend = createEchoServer()
    await listen(backend)
    servers.push(backend)
    const ports = await reserveTopologyPorts(1, 1)
    const env = topologyEnv(ports)

    let currentServer = startChild('server-before-restart', 'server.js', env)
    const agent = startChild('agent', 'agent.js', {
      ...env,
      N_T_AGENT_NAME: 'restart-agent',
      N_T_AGENT_DATA_HOST: host,
      N_T_AGENT_DATA_PORT: String(backend.address().port)
    })
    const client = startChild('client', 'client.js', {
      ...env,
      N_T_CLIENT_NAME: 'restart-agent',
      N_T_CLIENT_PORT: String(ports.clients[0])
    })
    children.push(currentServer, agent, client)

    await waitForOutput(client, 'Agent found, ready!')
    await assertEcho(ports.clients[0], Buffer.from('before restart'))

    for (let restart = 1; restart <= 3; restart++) {
      await stopChild(currentServer)
      await Promise.all([
        waitForOutputCount(agent, 'Connection to server lost', restart),
        waitForOutputCount(client, 'Connection to server lost', restart)
      ])

      currentServer = startChild(`server-after-restart-${restart}`, 'server.js', env)
      children.push(currentServer)
      await waitForOutput(currentServer, 'Agent "restart-agent" connected, dedicated port')
      await waitForOutputCount(client, 'Agent found, ready!', restart + 1)
      await assertEcho(ports.clients[0], Buffer.from(`after restart ${restart}`))
    }
  } catch (error) {
    t.diagnostic(formatChildLogs(children))
    throw error
  }
})

test('connection resets and a slow reader do not poison later streams', { timeout: 30_000 }, async t => {
  const children = []
  const servers = []
  registerCleanup(t, children, servers)

  try {
    const backend = createEchoServer()
    await listen(backend)
    servers.push(backend)
    const ports = await reserveTopologyPorts(1, 1)
    const env = topologyEnv(ports)

    const server = startChild('server', 'server.js', env)
    const agent = startChild('agent', 'agent.js', {
      ...env,
      N_T_AGENT_NAME: 'reset-agent',
      N_T_AGENT_DATA_HOST: host,
      N_T_AGENT_DATA_PORT: String(backend.address().port)
    })
    const client = startChild('client', 'client.js', {
      ...env,
      N_T_CLIENT_NAME: 'reset-agent',
      N_T_CLIENT_PORT: String(ports.clients[0])
    })
    children.push(server, agent, client)

    await waitForOutput(client, 'Agent found, ready!')
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => {
        return resetConnection(ports.clients[0], Buffer.alloc(256 * 1024, index))
      })
    )
    await delay(200)

    const payload = Buffer.alloc(4 * 1024 * 1024)
    for (let index = 0; index < payload.length; index++) payload[index] = index & 0xff
    await assertEcho(ports.clients[0], payload, 10_000, 250)
  } catch (error) {
    t.diagnostic(formatChildLogs(children))
    throw error
  }
})

test('unavailable agent target closes the client stream without hanging', { timeout: 20_000 }, async t => {
  const children = []
  registerCleanup(t, children, [])

  try {
    const unavailableTarget = await reservePort()
    const targetPort = unavailableTarget.port
    await closeServer(unavailableTarget.server)
    const ports = await reserveTopologyPorts(1, 1)
    const env = topologyEnv(ports)

    const server = startChild('server', 'server.js', env)
    const agent = startChild('agent', 'agent.js', {
      ...env,
      N_T_AGENT_NAME: 'unavailable-target',
      N_T_AGENT_DATA_HOST: host,
      N_T_AGENT_DATA_PORT: String(targetPort)
    })
    const client = startChild('client', 'client.js', {
      ...env,
      N_T_CLIENT_NAME: 'unavailable-target',
      N_T_CLIENT_PORT: String(ports.clients[0])
    })
    children.push(server, agent, client)

    await waitForOutput(client, 'Agent found, ready!')
    await expectConnectionToClose(ports.clients[0], Buffer.from('cannot be delivered'))
  } catch (error) {
    t.diagnostic(formatChildLogs(children))
    throw error
  }
})

test('duplicate agents and exhausted data ports terminate rejected agents', { timeout: 20_000 }, async t => {
  const children = []
  registerCleanup(t, children, [])

  try {
    const ports = await reserveTopologyPorts(1, 0)
    const env = topologyEnv(ports)
    const server = startChild('server', 'server.js', env)
    const firstAgent = startChild('first-agent', 'agent.js', {
      ...env,
      N_T_AGENT_NAME: 'occupied-name'
    })
    children.push(server, firstAgent)

    await waitForOutput(server, 'Agent "occupied-name" connected, dedicated port')

    const duplicateAgent = startChild('duplicate-agent', 'agent.js', {
      ...env,
      N_T_AGENT_NAME: 'occupied-name'
    })
    children.push(duplicateAgent)
    const duplicateExit = await waitForExit(duplicateAgent)
    assert.equal(duplicateExit.code, 1)
    assert.match(duplicateAgent.stdout + duplicateAgent.stderr, /agent with this name already exists/)

    const noPortAgent = startChild('no-port-agent', 'agent.js', {
      ...env,
      N_T_AGENT_NAME: 'different-name'
    })
    children.push(noPortAgent)
    const noPortExit = await waitForExit(noPortAgent)
    assert.equal(noPortExit.code, 1)
    assert.match(noPortAgent.stdout + noPortAgent.stderr, /no data ports available/)
  } catch (error) {
    t.diagnostic(formatChildLogs(children))
    throw error
  }
})

test('server rejects mismatched and legacy protocol handshakes', { timeout: 15_000 }, async t => {
  const children = []
  registerCleanup(t, children, [])

  try {
    const ports = await reserveTopologyPorts(1, 0)
    const env = topologyEnv(ports)
    const server = startChild('server', 'server.js', env)
    children.push(server)
    await waitForListening(server, ports.service)

    const mismatch = await sendControlMessage(ports.service, {
      protocolVersion: PROTOCOL_VERSION + 1,
      type: 'client',
      name: 'wrong-version'
    })
    assert.equal(mismatch.error, ERRORS.VERSION_MISMATCH)
    assert.equal(mismatch.protocolVersion, PROTOCOL_VERSION)
    assert.equal(mismatch.receivedProtocolVersion, PROTOCOL_VERSION + 1)

    const legacySocket = net.createConnection({ host, port: ports.service })
    legacySocket.on('error', () => {})
    legacySocket.write('legacy message without a frame delimiter')
    await waitForSocketClose(legacySocket, 3_000)
  } catch (error) {
    t.diagnostic(formatChildLogs(children))
    throw error
  }
})

test('agent and client exit when a server reports another protocol version', { timeout: 15_000 }, async t => {
  const children = []
  const servers = []
  registerCleanup(t, children, servers)

  try {
    const fakeServer = net.createServer(socket => {
      writeMessage(
        socket,
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION + 1,
          error: ERRORS.VERSION_MISMATCH
        })
      )
      socket.end()
    })
    await listen(fakeServer)
    servers.push(fakeServer)

    const commonEnv = {
      N_T_CRYPT_KEY: cryptKey,
      N_T_SERVER_HOST: host,
      N_T_SERVER_PORT: String(fakeServer.address().port),
      N_T_RECONNECT_DELAY_MS: '100'
    }
    const agent = startChild('version-mismatch-agent', 'agent.js', {
      ...commonEnv,
      N_T_AGENT_NAME: 'version-check-agent'
    })
    children.push(agent)
    const agentExit = await waitForExit(agent)
    assert.equal(agentExit.code, 1)
    assert.match(agent.stdout + agent.stderr, /protocol version mismatch/)

    const clientPortReservation = await reservePort()
    const clientPort = clientPortReservation.port
    await closeServer(clientPortReservation.server)
    const client = startChild('version-mismatch-client', 'client.js', {
      ...commonEnv,
      N_T_CLIENT_NAME: 'version-check-client',
      N_T_CLIENT_PORT: String(clientPort)
    })
    children.push(client)
    const clientExit = await waitForExit(client)
    assert.equal(clientExit.code, 1)
    assert.match(client.stdout + client.stderr, /protocol version mismatch/)
  } catch (error) {
    t.diagnostic(formatChildLogs(children))
    throw error
  }
})

function topologyEnv(ports) {
  return {
    N_T_CRYPT_KEY: cryptKey,
    N_T_LOG_DEBUG: 'false',
    N_T_LOG_ERROR: 'true',
    N_T_SERVER_HOST: host,
    N_T_SERVER_PORT: String(ports.service),
    N_T_SERVER_PORTS_FROM: String(ports.dataFrom),
    N_T_SERVER_PORTS_TO: String(ports.dataTo),
    N_T_RECONNECT_DELAY_MS: '200',
    N_T_HANDSHAKE_TIMEOUT_MS: '300',
    N_T_CONTROL_IDLE_TIMEOUT_MS: '5000'
  }
}

function createEchoServer() {
  return net.createServer({ allowHalfOpen: true }, socket => socket.pipe(socket))
}

function assertEcho(port, payload, timeout = 5_000, readPause = 0) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    const socket = net.createConnection({ host, port })
    const timer = setTimeout(() => finish(new Error('echo request timed out')), timeout)

    socket.on('connect', () => {
      if (readPause > 0) {
        socket.pause()
        setTimeout(() => socket.resume(), readPause)
      }
      socket.end(payload)
    })
    socket.on('data', data => {
      chunks.push(data)
      length += data.length
    })
    socket.on('end', () => {
      try {
        assert.deepEqual(Buffer.concat(chunks, length), payload)
        finish()
      } catch (error) {
        finish(error)
      }
    })
    socket.on('error', finish)

    function finish(error) {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
  })
}

function resetConnection(port, payload) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port })
    socket.on('connect', () => {
      socket.write(payload)
      if (socket.resetAndDestroy) socket.resetAndDestroy()
      else socket.destroy()
    })
    socket.on('error', () => resolve())
    socket.on('close', () => resolve())
  })
}

function expectConnectionToClose(port, payload, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('connection remained open'))
    }, timeout)

    socket.on('connect', () => {
      if (payload) socket.end(payload)
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function sendControlMessage(port, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const timer = setTimeout(() => finish(new Error('control response timed out')), 5_000)
    const decode = createMessageDecoder(
      data => {
        try {
          finish(null, JSON.parse(data))
        } catch (error) {
          finish(error)
        }
      },
      () => finish(new Error('server returned an invalid control frame'))
    )

    socket.on('connect', () => writeMessage(socket, JSON.stringify(message)))
    socket.on('data', decode)
    socket.on('error', error => finish(error))

    function finish(error, response) {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(response)
    }
  })
}

function registerCleanup(t, children, servers) {
  t.after(async () => {
    await Promise.all(children.map(stopChild))
    await Promise.all(servers.map(closeServer))
  })
}
