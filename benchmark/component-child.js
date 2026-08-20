'use strict'

const role = process.argv[2]
const factories = {
  server: () => require('../server').createServer,
  agent: () => require('../agent').createAgent,
  client: () => require('../client').createClient
}

let application
let closing = false
let peakRss = process.memoryUsage().rss
const cpuStart = process.cpuUsage()
const rssSampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 25)

if (!factories[role] || !process.send) {
  throw new Error(`invalid benchmark component role: ${role || '<missing>'}`)
}

process.on('message', async message => {
  if (!message || typeof message !== 'object') return

  try {
    if (message.type === 'start') {
      const createApplication = factories[role]()
      application = createApplication(message.config)
      application.once('fatal', error => send({ type: 'fatal', error: serializeError(error) }))
      await application.start()
      send({ type: 'started', state: application.getState() })
      return
    }

    if (message.type === 'state') {
      send({ type: 'response', requestId: message.requestId, value: application?.getState() })
      return
    }

    if (message.type === 'metrics') {
      send({ type: 'response', requestId: message.requestId, value: getMetrics() })
      return
    }

    if (message.type === 'close') {
      if (closing) return
      closing = true
      clearInterval(rssSampler)
      await application?.close({ force: Boolean(message.force) })
      send({ type: 'closed', metrics: getMetrics() })
      process.disconnect()
    }
  } catch (error) {
    send({ type: 'fatal', error: serializeError(error) })
  }
})

process.once('disconnect', () => {
  clearInterval(rssSampler)
  if (!closing) application?.close({ force: true }).finally(() => process.exit(1))
})

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

function send(message) {
  if (process.connected) process.send(message)
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack
  }
}
