'use strict'

const PROTOCOL_VERSION = 4

const CONNECTION_KINDS = Object.freeze({
  CONTROL: 'control',
  DATA: 'data'
})

const TYPES = Object.freeze({
  AGENT: 'agent',
  CLIENT: 'client'
})

const ERRORS = Object.freeze({
  DUPLICATE_AGENT: 'agent with this name already exists',
  TOO_MANY_PENDING_TUNNELS: 'too many pending tunnels',
  TUNNEL_UNAVAILABLE: 'tunnel is unavailable',
  VERSION_MISMATCH: 'protocol version mismatch'
})

module.exports = {
  PROTOCOL_VERSION,
  CONNECTION_KINDS,
  TYPES,
  ERRORS
}
