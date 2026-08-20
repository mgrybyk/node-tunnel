'use strict'

const net = require('node:net')

let server
let closing = false
let peakRss = process.memoryUsage().rss
let stats = createStats()
const sockets = new Set()
const cpuStart = process.cpuUsage()
const rssSampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 25)

if (!process.send) throw new Error('traffic target must run with an IPC channel')

process.on('message', async message => {
  if (!message || typeof message !== 'object') return

  try {
    if (message.type === 'start') {
      await start(message.config)
      send({ type: 'started', state: getState() })
    } else if (message.type === 'state') {
      respond(message, getState())
    } else if (message.type === 'metrics') {
      respond(message, getMetrics())
    } else if (message.type === 'stats') {
      respond(message, { ...stats })
    } else if (message.type === 'reset-stats') {
      stats = createStats()
      respond(message, true)
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

async function start(config) {
  server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket)
    socket.setNoDelay(true)
    socket.on('data', data => {
      stats.bytesReceived += data.length
      if (socket.write(data)) {
        stats.bytesSent += data.length
      } else {
        stats.bytesSent += data.length
        socket.pause()
        socket.once('drain', () => socket.resume())
      }
    })
    socket.on('end', () => socket.end())
    socket.on('error', error => {
      stats.socketErrors++
      stats.lastError = serializeError(error)
    })
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    const onListening = () => finish(resolve)
    const onError = error => finish(() => reject(error))
    const finish = callback => {
      server.off('listening', onListening)
      server.off('error', onError)
      callback()
    }
    server.once('listening', onListening)
    server.once('error', onError)
    server.listen(config.port, config.host)
  })
}

function getState() {
  return { started: Boolean(server?.listening), connections: sockets.size, closing }
}

function createStats() {
  return { bytesReceived: 0, bytesSent: 0, socketErrors: 0, lastError: null }
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
  clearInterval(rssSampler)
  for (const socket of sockets) socket.destroy()
  if (server?.listening) {
    await new Promise(resolve => server.close(() => resolve()))
  }
  send({ type: 'closed', force, metrics: getMetrics() })
  process.disconnect()
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
