'use strict'

const MAX_PORTS = 32

function loadEnvironment(filePath) {
  try {
    process.loadEnvFile(filePath ?? '.env')
  } catch (error) {
    if (filePath !== undefined || error.code !== 'ENOENT') throw error
  }
}

function readInteger(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}, env = process.env) {
  const rawValue = env[name]
  if (rawValue === undefined || rawValue === '') return fallback

  const value = Number(rawValue)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }

  return value
}

function readPort(name, fallback, env = process.env) {
  return readInteger(name, fallback, { min: 1, max: 65535 }, env)
}

function readPortList(name, env) {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  const ports = []
  for (const entry of raw.split(',')) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(entry.trim())
    if (!match) throw new Error(`${name} must contain ports or ascending ranges separated by commas`)
    const first = Number(match[1])
    const last = Number(match[2] ?? match[1])
    if (first < 1 || last > 65535 || first > last) {
      throw new Error(`${name} ranges must be ascending and between 1 and 65535`)
    }
    if (ports.length + last - first + 1 > MAX_PORTS) throw new Error(`${name} must not exceed ${MAX_PORTS} ports`)
    for (let port = first; port <= last; port++) ports.push(port)
  }
  return validatePorts(ports, name)
}

function validatePorts(ports, name, allowEphemeral = false) {
  if (
    !Array.isArray(ports) ||
    ports.length === 0 ||
    ports.some(port => !Number.isInteger(port) || port < (allowEphemeral && ports.length === 1 ? 0 : 1) || port > 65535)
  ) {
    throw new Error(`${name} must contain ports between 1 and 65535`)
  }
  if (ports.length > MAX_PORTS) throw new Error(`${name} must not exceed ${MAX_PORTS} ports`)
  if (new Set(ports).size !== ports.length) throw new Error(`${name} contains duplicate or overlapping ports`)
  return [...ports]
}

function readName(name, fallback, env = process.env) {
  const value = env[name] || fallback
  if (value.length > 128) throw new Error(`${name} must not exceed 128 characters`)
  return value
}

function readCommonConfig(env = process.env) {
  const reconnectDelay = readInteger('N_T_RECONNECT_DELAY_MS', 4_000, { min: 100, max: 300_000 }, env)
  const reconnectMaxDelay = readInteger(
    'N_T_RECONNECT_MAX_DELAY_MS',
    Math.max(30_000, reconnectDelay),
    { min: reconnectDelay, max: 3_600_000 },
    env
  )

  return {
    ...readRuntimeConfig(env),
    relayHost: env.N_T_RELAY_HOST || '127.0.0.1',
    relayPort: readPort('N_T_RELAY_PORT', 1337, env),
    reconnectDelay,
    reconnectMaxDelay,
    reconnectJitterPercent: readInteger('N_T_RECONNECT_JITTER_PERCENT', 10, { min: 0, max: 100 }, env),
    handshakeTimeout: readInteger('N_T_HANDSHAKE_TIMEOUT_MS', 5_000, { min: 1_000, max: 60_000 }, env),
    heartbeatInterval: readInteger('N_T_HEARTBEAT_INTERVAL_MS', 2_000, { min: 1_000, max: 30_000 }, env),
    heartbeatTimeout: readInteger('N_T_HEARTBEAT_TIMEOUT_MS', 7_000, { min: 5_000, max: 600_000 }, env),
    shutdownTimeout: readInteger('N_T_SHUTDOWN_TIMEOUT_MS', 2_000, { min: 0, max: 10_000 }, env)
  }
}

function getRelayConfig(env = process.env) {
  return {
    ...readRuntimeConfig(env),
    serviceHost: env.N_T_RELAY_BIND_HOST || '0.0.0.0',
    servicePort: readPort('N_T_RELAY_PORT', 1337, env),
    handshakeTimeout: readInteger('N_T_HANDSHAKE_TIMEOUT_MS', 5_000, { min: 100, max: 300_000 }, env),
    controlIdleTimeout: readInteger('N_T_CONTROL_IDLE_TIMEOUT_MS', 15_000, { min: 1_000, max: 3_600_000 }, env),
    shutdownTimeout: readInteger('N_T_SHUTDOWN_TIMEOUT_MS', 2_000, { min: 0, max: 300_000 }, env)
  }
}

function readRuntimeConfig(env) {
  return {
    cryptKey: env.N_T_CRYPT_KEY,
    logDebug: env.N_T_LOG_DEBUG === 'true',
    logError: env.N_T_LOG_ERROR === 'true'
  }
}

function getAgentConfig(env = process.env) {
  return {
    ...readCommonConfig(env),
    useTLS: env.N_T_USE_TLS === 'true',
    name: readName('N_T_AGENT_NAME', 'dbg', env),
    targetHost: env.N_T_AGENT_DATA_HOST || 'localhost',
    targetPorts: readPortList('N_T_AGENT_DATA_PORTS', env) ?? [8888]
  }
}

function getClientConfig(env = process.env) {
  return {
    ...readCommonConfig(env),
    useTLS: env.N_T_USE_TLS === 'true',
    name: readName('N_T_CLIENT_NAME', 'dbg', env),
    localHost: env.N_T_CLIENT_BIND_HOST || '127.0.0.1',
    localPorts: readPortList('N_T_CLIENT_PORTS', env) ?? [8000]
  }
}

module.exports = {
  MAX_PORTS,
  loadEnvironment,
  readInteger,
  readPort,
  validatePorts,
  readName,
  getRelayConfig,
  getAgentConfig,
  getClientConfig
}
