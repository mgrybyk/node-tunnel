'use strict'

const net = require('node:net')
const { performance } = require('node:perf_hooks')

const frameHeaderBytes = 20
const frameMagic = 0x4e54424d

let config
let sessions = []
let closing = false
let running = false
let measuring = false
let collectingMeasurement = false
let ticker
let peakRss = process.memoryUsage().rss
let latencies = []
let stats = createStats()
const cpuStart = process.cpuUsage()
const rssSampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 25)

if (!process.send) throw new Error('traffic load generator must run with an IPC channel')

process.on('message', async message => {
  if (!message || typeof message !== 'object') return

  try {
    if (message.type === 'start') {
      start(message.config)
      send({ type: 'started', state: getState() })
    } else if (message.type === 'state') {
      respond(message, getState())
    } else if (message.type === 'metrics') {
      respond(message, getMetrics())
    } else if (message.type === 'run') {
      const value = await runTraffic(message.config)
      respond(message, value)
    } else if (message.type === 'close') {
      await close()
    }
  } catch (error) {
    send({ type: 'fatal', error: serializeError(error) })
  }
})

process.once('disconnect', () => {
  clearInterval(rssSampler)
  if (!closing) close(true).finally(() => process.exit(1))
})

function start(value) {
  config = value
  sessions = value.sessions.map(sessionConfig => createSession(sessionConfig))
  for (const session of sessions) connectSession(session)
}

function createSession(sessionConfig) {
  const maximumPayload = Math.max(...config.framePayloadBytes)
  const pattern = Buffer.allocUnsafe(maximumPayload)
  let state = (config.routeIndex + 1) * 1009 + (sessionConfig.clientIndex + 1) * 7919
  for (let index = 0; index < pattern.length; index++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    pattern[index] = state & 0xff
  }

  return {
    ...sessionConfig,
    pattern,
    socket: null,
    ready: false,
    connected: false,
    hadReadyConnection: false,
    sequence: 1,
    pending: [],
    received: Buffer.alloc(0),
    reconnectTimer: null,
    backpressured: false,
    stats: createStats()
  }
}

function connectSession(session) {
  if (closing || session.socket) return
  const socket = net.createConnection({ host: config.host, port: session.localPort, allowHalfOpen: true })
  session.socket = socket
  session.ready = false
  session.connected = false
  session.received = Buffer.alloc(0)
  session.pending = []
  session.backpressured = false

  socket.setNoDelay(true)
  socket.on('connect', () => {
    session.connected = true
    sendProbe(session)
  })
  socket.on('data', data => receiveData(session, data))
  socket.on('end', () => socket.end())
  socket.on('drain', () => {
    session.backpressured = false
  })
  socket.on('error', error => {
    if (collectingMeasurement) {
      stats.socketErrors++
      session.stats.socketErrors++
      stats.lastError = serializeError(error)
    }
  })
  socket.on('close', () => handleSessionClose(session, socket))
}

function sendProbe(session) {
  const frame = createFrame(session, 0, 64)
  session.pending.push({ frame, sentAt: performance.now(), measured: false, probe: true })
  session.socket.write(frame)
}

function receiveData(session, data) {
  session.received = session.received.length === 0 ? data : Buffer.concat([session.received, data])

  while (session.pending.length > 0 && session.received.length >= session.pending[0].frame.length) {
    const pending = session.pending.shift()
    const receivedFrame = session.received.subarray(0, pending.frame.length)
    session.received = session.received.subarray(pending.frame.length)

    if (!receivedFrame.equals(pending.frame)) {
      recordIntegrityError(session, 'echoed frame did not match the transmitted frame', pending.measured)
      return session.socket.destroy()
    }

    if (pending.probe) {
      const wasReady = session.hadReadyConnection
      session.ready = true
      session.hadReadyConnection = true
      if (collectingMeasurement && wasReady) {
        stats.reconnections++
        session.stats.reconnections++
      }
      continue
    }

    if (pending.measured) {
      const latencyMs = performance.now() - pending.sentAt
      stats.framesCompleted++
      stats.bytesAgentToClient += pending.frame.length
      session.stats.framesCompleted++
      session.stats.bytesAgentToClient += pending.frame.length
      latencies.push(latencyMs)
      session.stats.latencies.push(latencyMs)
    }
  }

  if (session.pending.length === 0 && session.received.length > 0) {
    recordIntegrityError(session, 'received bytes without a corresponding transmitted frame', collectingMeasurement)
    session.socket.destroy()
  }
}

function handleSessionClose(session, socket) {
  if (session.socket !== socket) return
  const wasReady = session.ready
  if (collectingMeasurement) {
    const incomplete = session.pending.filter(frame => frame.measured).length
    stats.incompleteFrames += incomplete
    session.stats.incompleteFrames += incomplete
    if (wasReady) {
      stats.disconnects++
      session.stats.disconnects++
    }
  }

  session.socket = null
  session.ready = false
  session.connected = false
  session.pending = []
  session.received = Buffer.alloc(0)
  session.backpressured = false
  if (!closing) {
    clearTimeout(session.reconnectTimer)
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null
      connectSession(session)
    }, config.reconnectIntervalMs)
  }
}

async function runTraffic(runConfig) {
  if (running) throw new Error('traffic load generator is already running')
  running = true

  await waitUntil(runConfig.runAt)
  ticker = setInterval(sendTrafficTick, config.frameIntervalMs)
  sendTrafficTick()

  const measurementStart = runConfig.runAt + runConfig.warmupMs
  await waitUntil(measurementStart)
  resetMeasurementStats()
  collectingMeasurement = true
  measuring = true

  await waitUntil(measurementStart + runConfig.durationMs)
  measuring = false
  running = false
  clearInterval(ticker)
  ticker = null

  await waitForMeasuredFrames(runConfig.drainTimeoutMs)
  finalizeIncompleteFrames()
  collectingMeasurement = false
  return buildResult(runConfig.durationMs)
}

function sendTrafficTick() {
  for (const session of sessions) {
    if (!session.ready || session.backpressured || session.pending.length >= config.inFlightFrames) continue
    const payloadBytes = config.framePayloadBytes[(session.sequence - 1) % config.framePayloadBytes.length]
    const frame = createFrame(session, session.sequence++, payloadBytes)
    const measured = measuring
    session.pending.push({ frame, sentAt: performance.now(), measured, probe: false })
    if (measured) {
      stats.framesSent++
      stats.bytesClientToAgent += frame.length
      session.stats.framesSent++
      session.stats.bytesClientToAgent += frame.length
    }
    if (!session.socket.write(frame)) session.backpressured = true
  }
}

function createFrame(session, sequence, payloadBytes) {
  const frame = Buffer.allocUnsafe(frameHeaderBytes + payloadBytes)
  frame.writeUInt32BE(frameMagic, 0)
  frame.writeUInt32BE(config.routeIndex, 4)
  frame.writeUInt32BE(session.clientIndex, 8)
  frame.writeUInt32BE(sequence >>> 0, 12)
  frame.writeUInt32BE(payloadBytes, 16)
  session.pattern.copy(frame, frameHeaderBytes, 0, payloadBytes)
  return frame
}

function resetMeasurementStats() {
  stats = createStats()
  latencies = []
  for (const session of sessions) session.stats = createStats()
}

function createStats() {
  return {
    framesSent: 0,
    framesCompleted: 0,
    bytesClientToAgent: 0,
    bytesAgentToClient: 0,
    disconnects: 0,
    reconnections: 0,
    incompleteFrames: 0,
    integrityErrors: 0,
    socketErrors: 0,
    lastError: null,
    latencies: []
  }
}

function recordIntegrityError(session, message, measured) {
  if (!measured) return
  stats.integrityErrors++
  session.stats.integrityErrors++
  stats.lastError = { name: 'Error', message, code: 'INTEGRITY_ERROR', stack: null }
}

async function waitForMeasuredFrames(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (sessions.every(session => session.pending.every(frame => !frame.measured))) return
    await delay(10)
  }
}

function finalizeIncompleteFrames() {
  for (const session of sessions) {
    const incomplete = session.pending.filter(frame => frame.measured).length
    stats.incompleteFrames += incomplete
    session.stats.incompleteFrames += incomplete
    for (const frame of session.pending) frame.measured = false
  }
}

function buildResult(durationMs) {
  const sessionResults = sessions.map(session => ({
    id: session.id,
    clientIndex: session.clientIndex,
    ready: session.ready,
    ...withoutLatencies(session.stats),
    latenciesMs: session.stats.latencies
  }))
  return {
    routeIndex: config.routeIndex,
    durationMs,
    readySessions: sessions.filter(session => session.ready).length,
    expectedSessions: sessions.length,
    ...withoutLatencies(stats),
    latenciesMs: latencies,
    sessions: sessionResults
  }
}

function withoutLatencies(value) {
  const { latencies: _latencies, ...result } = value
  return result
}

function getState() {
  return {
    started: sessions.length > 0,
    readySessions: sessions.filter(session => session.ready).length,
    connectedSessions: sessions.filter(session => session.connected).length,
    expectedSessions: sessions.length,
    running,
    measuring,
    closing
  }
}

function getMetrics() {
  const cpu = process.cpuUsage(cpuStart)
  const memory = process.memoryUsage()
  peakRss = Math.max(peakRss, memory.rss)
  return {
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
    rssBytes: memory.rss,
    peakRssBytes: peakRss
  }
}

async function close(force = false) {
  if (closing) return
  closing = true
  running = false
  measuring = false
  collectingMeasurement = false
  clearInterval(rssSampler)
  clearInterval(ticker)
  for (const session of sessions) {
    clearTimeout(session.reconnectTimer)
    session.socket?.destroy()
  }
  await delay(0)
  send({ type: 'closed', force, metrics: getMetrics() })
  process.disconnect()
}

function waitUntil(timestamp) {
  return delay(Math.max(0, timestamp - Date.now()))
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function respond(message, value) {
  send({ type: 'response', requestId: message.requestId, value })
}

function send(message) {
  if (process.connected) process.send(message)
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || null,
    stack: error?.stack || null
  }
}
