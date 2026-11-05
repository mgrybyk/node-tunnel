'use strict'

const { createHash } = require('node:crypto')

let nextId = 0

function createDiagnostics(log) {
  // Optional calls skip argument construction and socket observers when disabled.
  if (!log.debug) return {}

  function debug(event, details = {}) {
    log.debug(`${new Date().toISOString()} ${event} ${JSON.stringify(details)}`)
  }

  // Observe socket events without changing listener order or consuming data.
  function traceSocket(socket, label, { ticket, ...context } = {}) {
    const id = `${label}-${++nextId}`
    const startedAt = Date.now()
    const details = ticket ? { ...context, tunnelRef: tunnelReference(ticket) } : context
    let phase = 'connecting'
    const trace = (event, extra = {}) => debug(`${id} ${event}`, { ...details, ...extra })
    const mark = (event, extra) => {
      phase = event
      trace(event, extra)
    }
    socket.on('connect', () => mark('tcp-connected'))
    socket.on('secureConnect', () =>
      trace('tls-connected', {
        authorized: socket.authorized,
        protocol: socket.getProtocol?.(),
        issuer: socket.getPeerCertificate?.()?.issuer?.O
      })
    )
    socket.on('error', error => trace('error', { code: error.code, message: error.message }))
    socket.once('close', hadError =>
      trace('closed', {
        phase,
        elapsedMs: Date.now() - startedAt,
        bytesRead: socket.bytesRead,
        bytesWritten: socket.bytesWritten,
        hadError
      })
    )
    mark.id = id
    return mark
  }

  // Correlate peers without logging the redeemable tunnel ticket.
  function tunnelReference(ticket) {
    if (typeof ticket !== 'string') return undefined
    return createHash('sha256').update(ticket).digest('hex').slice(0, 16)
  }

  function traceTunnel(event, ticket, details = {}) {
    debug(`tunnel ${event}`, { tunnelRef: tunnelReference(ticket), ...details })
  }

  return { debug, traceSocket, traceTunnel, tunnelReference }
}

module.exports = { createDiagnostics }
