'use strict'

const PROTOCOL_VERSION = 2

const TYPES = Object.freeze({
  AGENT: 'agent',
  CLIENT: 'client'
})

const ERRORS = Object.freeze({
  DUPLICATE_AGENT: 'agent with this name already exists',
  NO_PORTS: 'no data ports available',
  VERSION_MISMATCH: 'protocol version mismatch'
})

module.exports = {
  PROTOCOL_VERSION,
  TYPES,
  ERRORS
}
