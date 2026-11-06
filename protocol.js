'use strict'

const PROTOCOL_VERSION = 8

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
  PORT_COUNT_MISMATCH: 'client requests more ports than the agent provides',
  INVALID_PORT_INDEX: 'invalid port index',
  VERSION_MISMATCH: 'protocol version mismatch'
})

module.exports = {
  PROTOCOL_VERSION,
  CONNECTION_KINDS,
  TYPES,
  ERRORS
}
