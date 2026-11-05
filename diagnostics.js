'use strict'

const { log } = require('./utils')

let nextId = 0

// Do not attach a data listener: it would resume sockets paused for tunnel readiness.
function traceSocket(socket, label) {
  if (process.env.N_T_LOG_DEBUG !== 'true') return () => {}
  const id = `${label}-${++nextId}`
  const startedAt = Date.now()
  let phase = 'connecting'
  const trace = (event, details = {}) => {
    log.debug(new Date().toISOString(), id, event, {
      phase,
      elapsedMs: Date.now() - startedAt,
      bytesRead: socket.bytesRead,
      bytesWritten: socket.bytesWritten,
      readableLength: socket.readableLength,
      writableLength: socket.writableLength,
      writableNeedDrain: socket.writableNeedDrain,
      ...details
    })
  }
  const mark = (event, details) => {
    phase = event
    trace(event, details)
  }
  trace('created')
  socket.on('lookup', (error, address, family) => trace('dns', { code: error?.code, address, family }))
  socket.prependListener('connect', () =>
    mark('tcp-connected', { remoteAddress: socket.remoteAddress, remotePort: socket.remotePort })
  )
  socket.prependListener('secureConnect', () =>
    mark('tls-connected', {
      authorized: socket.authorized,
      authorizationError: socket.authorizationError,
      protocol: socket.getProtocol?.(),
      alpn: socket.alpnProtocol,
      issuer: socket.getPeerCertificate?.()?.issuer?.O
    })
  )
  socket.on('end', () => trace('read-end'))
  socket.on('finish', () => trace('write-finish'))
  socket.on('drain', () => trace('write-drain'))
  socket.on('error', error => trace('error', { code: error.code, message: error.message }))
  const timer = setInterval(() => trace('snapshot'), 15_000)
  timer.unref()
  socket.once('close', hadError => {
    clearInterval(timer)
    trace('closed', { hadError })
  })
  return (event, details) => mark(event, details)
}

module.exports = { traceSocket }
