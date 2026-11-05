'use strict'

const { createHash } = require('node:crypto')
const { log } = require('./utils')

let nextId = 0

// Do not attach a data listener: it would resume sockets paused for tunnel readiness.
function traceSocket(socket, label, context = {}) {
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
      ...context,
      ...details
    })
  }
  const mark = (event, details) => {
    phase = event
    trace(event, details)
  }
  trace('created', { remoteAddress: socket.remoteAddress, remotePort: socket.remotePort })
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

// A non-redeemable reference lets peer and relay logs identify the same tunnel.
function tunnelReference(ticket) {
  if (typeof ticket !== 'string') return undefined
  return createHash('sha256').update(ticket).digest('hex').slice(0, 16)
}

function traceTunnel(event, ticket, details = {}) {
  if (process.env.N_T_LOG_DEBUG !== 'true') return
  log.debug(new Date().toISOString(), 'tunnel', event, { tunnelRef: tunnelReference(ticket), ...details })
}

module.exports = { traceSocket, tunnelReference, traceTunnel }
