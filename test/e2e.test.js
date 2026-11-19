'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const net = require('node:net')
const {
  host,
  startChild,
  waitForOutput,
  waitForListening,
  stopChild,
  formatChildLogs,
  reserveTopologyPorts,
  listen,
  closeServer
} = require('../test-support/helpers')

const cryptKey = '0123456789abcdef0123456789abcdef'
const startupTimeout = 15_000
const streamTimeout = 30_000
const testTimeout = 120_000
const agentsCount = 2
const clientsPerAgent = 3
const streamsPerClient = 4
const waveSizes = [256 * 1024, 1024 * 1024, 2 * 1024 * 1024]
const bannerSize = 32 * 1024

test('parallel clients transfer uncorrupted data through multiple agents', { timeout: testTimeout }, async t => {
  const children = []
  const backends = []

  t.after(async () => {
    await Promise.all(children.map(stopChild))
    await Promise.all(backends.map(backend => backend.close()))
  })

  try {
    for (let agentIndex = 0; agentIndex < agentsCount; agentIndex++) {
      backends.push(await startBackend(agentIndex))
    }

    const ports = await reserveTopologyPorts(agentsCount * clientsPerAgent)
    const commonEnv = {
      N_T_CRYPT_KEY: cryptKey,
      N_T_LOG_DEBUG: 'false',
      N_T_LOG_ERROR: 'true',
      N_T_RELAY_HOST: host,
      N_T_RELAY_PORT: String(ports.service)
    }

    const relay = startChild('relay', 'relay.js', commonEnv)
    children.push(relay)
    await waitForListening(relay, ports.service, startupTimeout)

    for (let agentIndex = 0; agentIndex < agentsCount; agentIndex++) {
      const name = agentName(agentIndex)
      const agent = startChild(`agent-${agentIndex}`, 'agent.js', {
        ...commonEnv,
        N_T_AGENT_NAME: name,
        N_T_AGENT_DATA_HOST: host,
        N_T_AGENT_DATA_PORT: String(backends[agentIndex].port)
      })

      children.push(agent)
      await waitForOutput(relay, `Agent "${name}" connected on shared relay port`, startupTimeout)
    }

    const clients = []
    let localPortIndex = 0

    for (let agentIndex = 0; agentIndex < agentsCount; agentIndex++) {
      for (let clientIndex = 0; clientIndex < clientsPerAgent; clientIndex++) {
        const client = startChild(`client-${agentIndex}-${clientIndex}`, 'client.js', {
          ...commonEnv,
          N_T_CLIENT_NAME: agentName(agentIndex),
          N_T_CLIENT_PORT: String(ports.clients[localPortIndex++])
        })

        client.agentIndex = agentIndex
        client.clientIndex = clientIndex
        client.localPort = ports.clients[localPortIndex - 1]
        clients.push(client)
        children.push(client)
      }
    }

    await Promise.all(clients.map(client => waitForOutput(client, 'Agent found, ready!', startupTimeout)))

    for (let waveIndex = 0; waveIndex < waveSizes.length; waveIndex++) {
      const streams = []

      for (const client of clients) {
        const backend = backends[client.agentIndex]

        for (let streamIndex = 0; streamIndex < streamsPerClient; streamIndex++) {
          const seed = (waveIndex + 1) * 10_000 + client.agentIndex * 1_000 + client.clientIndex * 100 + streamIndex
          const payload = createPayload(waveSizes[waveIndex] + (seed % 997), seed)

          streams.push(
            runTunnelStream({
              localPort: client.localPort,
              payload,
              expectedBanner: backend.banner,
              transformMask: backend.transformMask,
              label: `wave=${waveIndex} agent=${client.agentIndex} client=${client.clientIndex} stream=${streamIndex}`,
              writePattern: streamIndex
            })
          )
        }
      }

      await Promise.all(streams)
    }

    for (const backend of backends) {
      assert.deepEqual(backend.errors, [], `backend ${backend.index} reported socket errors`)
      assert.equal(
        backend.connections,
        clientsPerAgent * streamsPerClient * waveSizes.length,
        `backend ${backend.index} received an unexpected number of connections`
      )
    }
  } catch (error) {
    t.diagnostic(formatChildLogs(children))
    throw error
  }
})

function agentName(index) {
  return `e2e-agent-${index}`
}

async function startBackend(index) {
  const sockets = new Set()
  const errors = []
  const banner = createPayload(bannerSize, 50_000 + index)
  const transformMask = 0xa5 ^ index
  const backend = {
    index,
    banner,
    transformMask,
    connections: 0,
    errors
  }

  const server = net.createServer({ allowHalfOpen: true }, socket => {
    backend.connections++
    sockets.add(socket)
    socket.setNoDelay(true)

    writeAndThrottle(socket, banner)

    socket.on('data', data => {
      writeAndThrottle(socket, xor(data, transformMask))
    })
    socket.on('end', () => socket.end())
    socket.on('error', error => errors.push(error.code || error.message))
    socket.on('close', () => sockets.delete(socket))
  })

  await listen(server, 0)
  backend.port = server.address().port
  backend.close = async () => {
    for (const socket of sockets) socket.destroy()
    await closeServer(server)
  }

  return backend
}

function writeAndThrottle(socket, data) {
  if (socket.write(data)) return

  socket.pause()
  socket.once('drain', () => socket.resume())
}

function runTunnelStream({ localPort, payload, expectedBanner, transformMask, label, writePattern }) {
  const expected = Buffer.concat([expectedBanner, xor(payload, transformMask)])

  return new Promise((resolve, reject) => {
    const received = []
    let receivedLength = 0
    let settled = false
    const socket = net.createConnection({ host, port: localPort })
    const timer = setTimeout(() => {
      finish(new Error(`${label} timed out after ${streamTimeout}ms`))
    }, streamTimeout)

    socket.setNoDelay(true)
    socket.on('connect', () => {
      writePayload(socket, payload, writePattern)
        .then(() => socket.end())
        .catch(finish)
    })
    socket.on('data', data => {
      received.push(data)
      receivedLength += data.length

      if (receivedLength > expected.length) {
        finish(new Error(`${label} received ${receivedLength} bytes; expected ${expected.length}`))
      }
    })
    socket.on('end', () => {
      try {
        assertBuffersEqual(Buffer.concat(received, receivedLength), expected, label)
        finish()
      } catch (error) {
        finish(error)
      }
    })
    socket.on('error', finish)
    socket.on('close', () => {
      if (!settled) finish(new Error(`${label} socket closed before the response ended`))
    })

    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
  })
}

async function writePayload(socket, payload, patternIndex) {
  const patterns = [
    [payload.length],
    [64 * 1024],
    [1, 7, 31, 257, 4093, 16 * 1024, 64 * 1024],
    [128 * 1024, 8 * 1024, 32 * 1024]
  ]
  const pattern = patterns[patternIndex % patterns.length]
  let offset = 0
  let chunkIndex = 0

  while (offset < payload.length) {
    const size = Math.min(pattern[chunkIndex++ % pattern.length], payload.length - offset)
    const canContinue = socket.write(payload.subarray(offset, offset + size))
    offset += size

    if (!canContinue) await waitForDrain(socket)
  }
}

function waitForDrain(socket) {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = error => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('socket closed while waiting for drain'))
    }
    const cleanup = () => {
      socket.off('drain', onDrain)
      socket.off('error', onError)
      socket.off('close', onClose)
    }

    socket.once('drain', onDrain)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

function assertBuffersEqual(actual, expected, label) {
  if (actual.equals(expected)) return

  const firstDifference = findFirstDifference(actual, expected)
  assert.fail(
    `${label} response mismatch: actualLength=${actual.length}, ` +
      `expectedLength=${expected.length}, firstDifference=${firstDifference}, ` +
      `actualSha256=${sha256(actual)}, expectedSha256=${sha256(expected)}`
  )
}

function findFirstDifference(actual, expected) {
  const comparedLength = Math.min(actual.length, expected.length)
  for (let index = 0; index < comparedLength; index++) {
    if (actual[index] !== expected[index]) return index
  }
  return comparedLength
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function createPayload(size, seed) {
  const payload = Buffer.allocUnsafe(size)
  for (let index = 0; index < size; index++) {
    payload[index] = (seed + index * 31 + (index >>> 8) * 17) & 0xff
  }
  return payload
}

function xor(data, mask) {
  const transformed = Buffer.allocUnsafe(data.length)
  for (let index = 0; index < data.length; index++) {
    transformed[index] = data[index] ^ mask
  }
  return transformed
}
