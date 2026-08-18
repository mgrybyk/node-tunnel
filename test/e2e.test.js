'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const host = '127.0.0.1'
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

    const ports = await reserveTopologyPorts(agentsCount, agentsCount * clientsPerAgent)
    const commonEnv = {
      N_T_CRYPT_KEY: cryptKey,
      N_T_LOG_DEBUG: 'false',
      N_T_LOG_ERROR: 'true',
      N_T_SERVER_HOST: host,
      N_T_SERVER_PORT: String(ports.service),
      N_T_SERVER_PORTS_FROM: String(ports.dataFrom),
      N_T_SERVER_PORTS_TO: String(ports.dataTo)
    }

    const server = startChild('server', 'server.js', commonEnv)
    children.push(server)
    await waitForOutput(server, `Server listening on port ${ports.service}`)

    for (let agentIndex = 0; agentIndex < agentsCount; agentIndex++) {
      const name = agentName(agentIndex)
      const agent = startChild(`agent-${agentIndex}`, 'agent.js', {
        ...commonEnv,
        N_T_AGENT_NAME: name,
        N_T_AGENT_DATA_HOST: host,
        N_T_AGENT_DATA_PORT: String(backends[agentIndex].port)
      })

      children.push(agent)
      await waitForOutput(server, `Agent "${name}" connected, dedicated port`)
    }

    const clients = []
    let localPortIndex = 0

    for (let agentIndex = 0; agentIndex < agentsCount; agentIndex++) {
      for (let clientIndex = 0; clientIndex < clientsPerAgent; clientIndex++) {
        const client = startChild(
          `client-${agentIndex}-${clientIndex}`,
          'client.js',
          {
            ...commonEnv,
            N_T_CLIENT_NAME: agentName(agentIndex),
            N_T_CLIENT_PORT: String(ports.clients[localPortIndex++])
          }
        )

        client.agentIndex = agentIndex
        client.clientIndex = clientIndex
        client.localPort = ports.clients[localPortIndex - 1]
        clients.push(client)
        children.push(client)
      }
    }

    await Promise.all(clients.map(client => waitForOutput(client, 'Agent found, ready!')))

    for (let waveIndex = 0; waveIndex < waveSizes.length; waveIndex++) {
      const streams = []

      for (const client of clients) {
        const backend = backends[client.agentIndex]

        for (let streamIndex = 0; streamIndex < streamsPerClient; streamIndex++) {
          const seed = ((waveIndex + 1) * 10_000) +
            (client.agentIndex * 1_000) +
            (client.clientIndex * 100) +
            streamIndex
          const payload = createPayload(waveSizes[waveIndex] + seed % 997, seed)

          streams.push(runTunnelStream({
            localPort: client.localPort,
            payload,
            expectedBanner: backend.banner,
            transformMask: backend.transformMask,
            label: `wave=${waveIndex} agent=${client.agentIndex} client=${client.clientIndex} stream=${streamIndex}`,
            writePattern: streamIndex
          }))
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

function agentName (index) {
  return `e2e-agent-${index}`
}

async function startBackend (index) {
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

function writeAndThrottle (socket, data) {
  if (socket.write(data)) return

  socket.pause()
  socket.once('drain', () => socket.resume())
}

function startChild (label, script, env) {
  const child = spawn(process.execPath, [path.join(projectRoot, script)], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const info = { label, child, stdout: '', stderr: '' }

  child.stdout.on('data', data => { info.stdout += data.toString() })
  child.stderr.on('data', data => { info.stderr += data.toString() })

  return info
}

function waitForOutput (info, expected, timeout = startupTimeout) {
  const allOutput = () => info.stdout + info.stderr

  if (allOutput().includes(expected)) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`${info.label} did not output "${expected}" within ${timeout}ms`))
    }, timeout)

    const onData = () => {
      if (!allOutput().includes(expected)) return
      cleanup()
      resolve()
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(new Error(`${info.label} exited before startup completed (code=${code}, signal=${signal})`))
    }
    const onError = error => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timer)
      info.child.stdout.off('data', onData)
      info.child.stderr.off('data', onData)
      info.child.off('exit', onExit)
      info.child.off('error', onError)
    }

    info.child.stdout.on('data', onData)
    info.child.stderr.on('data', onData)
    info.child.once('exit', onExit)
    info.child.once('error', onError)
  })
}

async function stopChild (info) {
  const child = info.child
  if (child.exitCode !== null || child.signalCode !== null) return

  await new Promise(resolve => {
    const forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
    child.once('exit', () => {
      clearTimeout(forceTimer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

function formatChildLogs (children) {
  if (children.length === 0) return 'No child processes were started.'

  return children.map(info => {
    const output = `${info.stdout}${info.stderr}`.trim()
    const tail = output.slice(-8_000)
    return `--- ${info.label} ---\n${tail || '(no output)'}`
  }).join('\n')
}

function runTunnelStream ({
  localPort,
  payload,
  expectedBanner,
  transformMask,
  label,
  writePattern
}) {
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

    function finish (error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
  })
}

async function writePayload (socket, payload, patternIndex) {
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

function waitForDrain (socket) {
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

function assertBuffersEqual (actual, expected, label) {
  if (actual.equals(expected)) return

  const firstDifference = findFirstDifference(actual, expected)
  assert.fail(
    `${label} response mismatch: actualLength=${actual.length}, ` +
    `expectedLength=${expected.length}, firstDifference=${firstDifference}, ` +
    `actualSha256=${sha256(actual)}, expectedSha256=${sha256(expected)}`
  )
}

function findFirstDifference (actual, expected) {
  const comparedLength = Math.min(actual.length, expected.length)
  for (let index = 0; index < comparedLength; index++) {
    if (actual[index] !== expected[index]) return index
  }
  return comparedLength
}

function sha256 (data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function createPayload (size, seed) {
  const payload = Buffer.allocUnsafe(size)
  for (let index = 0; index < size; index++) {
    payload[index] = (seed + (index * 31) + ((index >>> 8) * 17)) & 0xff
  }
  return payload
}

function xor (data, mask) {
  const transformed = Buffer.allocUnsafe(data.length)
  for (let index = 0; index < data.length; index++) {
    transformed[index] = data[index] ^ mask
  }
  return transformed
}

async function reserveTopologyPorts (dataPortsCount, clientsCount) {
  const dataReservation = await reservePortRange(dataPortsCount)
  const otherReservations = []

  try {
    for (let index = 0; index < 1 + clientsCount; index++) {
      otherReservations.push(await reservePort())
    }

    return {
      service: otherReservations[0].port,
      dataFrom: dataReservation.base,
      dataTo: dataReservation.base + dataPortsCount - 1,
      clients: otherReservations.slice(1).map(reservation => reservation.port)
    }
  } finally {
    await Promise.all([
      ...dataReservation.servers.map(closeServer),
      ...otherReservations.map(reservation => closeServer(reservation.server))
    ])
  }
}

async function reservePortRange (count) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = 20_000 + Math.floor(Math.random() * (35_000 - count))
    const servers = []

    try {
      for (let offset = 0; offset < count; offset++) {
        const server = net.createServer()
        await listen(server, base + offset)
        servers.push(server)
      }
      return { base, servers }
    } catch (error) {
      await Promise.all(servers.map(closeServer))
    }
  }

  throw new Error(`could not reserve ${count} consecutive ports`)
}

async function reservePort () {
  const server = net.createServer()
  await listen(server, 0)
  return { server, port: server.address().port }
}

function listen (server, port) {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      cleanup()
      resolve()
    }
    const onError = error => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      server.off('listening', onListening)
      server.off('error', onError)
    }

    server.once('listening', onListening)
    server.once('error', onError)
    server.listen(port, host)
  })
}

function closeServer (server) {
  if (!server.listening) return Promise.resolve()
  return new Promise(resolve => server.close(resolve))
}
