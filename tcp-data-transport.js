'use strict'

const crypto = require('node:crypto')
const { traceTunnel } = require('./diagnostics')
const { PROTOCOL_VERSION, TYPES } = require('./protocol')
const { log, writeMessage } = require('./utils')
const { bridgeSockets } = require('./socket-bridge')
const { destroySockets, waitForSockets } = require('./lifecycle')

const MAX_PENDING_TUNNELS = 1024

function createTcpDataTransport(config) {
  const pendingTunnels = new Map()
  const activeTunnels = new Set()
  const dataSockets = new Set()
  let closing = false

  function createPendingTunnel(metadata) {
    if (closing || pendingTunnels.size >= MAX_PENDING_TUNNELS) return null

    let ticket
    do {
      ticket = crypto.randomBytes(32).toString('base64url')
    } while (pendingTunnels.has(ticket))

    const pending = {
      ...metadata,
      ticket,
      client: undefined,
      agent: undefined,
      timer: setTimeout(() => cancelPendingTunnel(ticket, undefined, 'pairing-timeout'), config.handshakeTimeout)
    }
    pendingTunnels.set(ticket, pending)
    return ticket
  }

  function acceptSocket(socket, message, remainder) {
    socket.on('error', error => log.err('DATA_SOCKET', error.name || error.code, error.message))
    if (closing || !isDataMessage(message)) return socket.destroy()
    const pending = pendingTunnels.get(message.ticket)
    if (!pending || pending[message.type]) {
      traceTunnel?.('data-rejected', message.ticket, {
        type: message.type,
        reason: pending ? 'duplicate-side' : 'unknown-or-expired-ticket'
      })
      return socket.destroy()
    }
    traceTunnel?.('data-accepted', message.ticket, { type: message.type, socketId: socket.tunnelTrace?.id })

    dataSockets.add(socket)
    const side = {
      socket,
      initialData: remainder
    }
    pending[message.type] = side
    socket.on('close', () => {
      dataSockets.delete(socket)
      if (pendingTunnels.get(pending.ticket) === pending)
        cancelPendingTunnel(pending.ticket, undefined, 'data-socket-closed')
      const active = socket.activeTunnel
      if (!active) return
      active.sockets.delete(socket)
      if (active.sockets.size === 0) activeTunnels.delete(active)
    })

    if (!pending.client || !pending.agent) {
      traceTunnel?.('waiting-for-peer', pending.ticket, { waitingFor: pending.client ? 'agent' : 'client' })
      return
    }

    pendingTunnels.delete(pending.ticket)
    clearTimeout(pending.timer)
    const active = {
      agentSession: pending.agentSession,
      sockets: new Set([pending.client.socket, pending.agent.socket])
    }
    activeTunnels.add(active)
    pending.client.socket.activeTunnel = active
    pending.agent.socket.activeTunnel = active

    traceTunnel?.('paired-ready-queued', pending.ticket)
    pending.client.socket.tunnelTrace?.('bridge-ready')
    pending.agent.socket.tunnelTrace?.('bridge-ready')
    sendJson(pending.client.socket, { ready: true })
    sendJson(pending.agent.socket, { ready: true })
    bridgeSockets(pending.agent.socket, pending.client.socket, {
      leftInitialData: pending.agent.initialData,
      rightInitialData: pending.client.initialData
    })
    pending.agent.initialData = undefined
    pending.client.initialData = undefined
  }

  function cancelPendingTunnel(ticket, session, reason = 'cancelled') {
    const pending = pendingTunnels.get(ticket)
    if (!pending) return false
    if (session && pending.clientSession !== session && pending.agentSession !== session) return false
    traceTunnel?.('pending-cancelled', ticket, {
      reason,
      clientArrived: Boolean(pending.client),
      agentArrived: Boolean(pending.agent)
    })
    pendingTunnels.delete(ticket)
    clearTimeout(pending.timer)
    for (const side of [pending.client, pending.agent]) {
      if (side?.socket && !side.socket.destroyed) side.socket.destroy()
    }
    return true
  }

  function cancelPendingForSession(session) {
    for (const pending of [...pendingTunnels.values()]) {
      if (pending.clientSession === session || pending.agentSession === session)
        cancelPendingTunnel(pending.ticket, undefined, 'control-session-closed')
    }
  }

  function replaceSession(previousSession, nextSession) {
    cancelPendingForSession(previousSession)
    for (const active of activeTunnels) {
      if (active.agentSession === previousSession) active.agentSession = nextSession
    }
  }

  function closeAgentSession(session) {
    cancelPendingForSession(session)
    for (const active of [...activeTunnels]) {
      if (active.agentSession !== session) continue
      for (const socket of active.sockets) {
        if (!socket.destroyed) socket.destroy()
      }
    }
  }

  async function close({ force = false, timeout = config.shutdownTimeout } = {}) {
    closing = true
    for (const ticket of [...pendingTunnels.keys()]) cancelPendingTunnel(ticket)
    if (!force) await waitForSockets(dataSockets, timeout)
    await destroySockets(dataSockets)
    activeTunnels.clear()
  }

  function getState() {
    return {
      pendingTunnels: pendingTunnels.size,
      activeTunnels: activeTunnels.size,
      dataSockets: dataSockets.size
    }
  }

  return {
    createPendingTunnel,
    acceptSocket,
    cancelPendingTunnel,
    cancelPendingForSession,
    replaceSession,
    closeAgentSession,
    close,
    getState
  }
}

function isDataMessage(message) {
  return (
    message &&
    (message.type === TYPES.CLIENT || message.type === TYPES.AGENT) &&
    typeof message.ticket === 'string' &&
    message.ticket.length > 0
  )
}

function sendJson(socket, data) {
  return writeMessage(socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...data }))
}

module.exports = { MAX_PENDING_TUNNELS, createTcpDataTransport }
