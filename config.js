'use strict'

function loadEnvironment(filePath = process.argv[2] || '.env') {
  try {
    process.loadEnvFile(filePath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
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

function readName(name, fallback, env = process.env) {
  const value = env[name] || fallback
  if (value.length > 128) throw new Error(`${name} must not exceed 128 characters`)
  return value
}

function readCommonConfig(env = process.env) {
  const reconnectDelay = readInteger('N_T_RECONNECT_DELAY_MS', 5_000, { min: 100, max: 300_000 }, env)
  const reconnectMaxDelay = readInteger(
    'N_T_RECONNECT_MAX_DELAY_MS',
    Math.max(30_000, reconnectDelay),
    { min: reconnectDelay, max: 3_600_000 },
    env
  )

  return {
    serverHost: env.N_T_SERVER_HOST || 'localhost',
    serverPort: readPort('N_T_SERVER_PORT', 1337, env),
    reconnectDelay,
    reconnectMaxDelay,
    reconnectJitterPercent: readInteger('N_T_RECONNECT_JITTER_PERCENT', 20, { min: 0, max: 100 }, env),
    handshakeTimeout: readInteger('N_T_HANDSHAKE_TIMEOUT_MS', 10_000, { min: 100, max: 300_000 }, env),
    shutdownTimeout: readInteger('N_T_SHUTDOWN_TIMEOUT_MS', 5_000, { min: 0, max: 300_000 }, env)
  }
}

function getServerConfig(env = process.env) {
  return {
    servicePort: readPort('N_T_SERVER_PORT', 1337, env),
    handshakeTimeout: readInteger('N_T_HANDSHAKE_TIMEOUT_MS', 10_000, { min: 100, max: 300_000 }, env),
    controlIdleTimeout: readInteger('N_T_CONTROL_IDLE_TIMEOUT_MS', 45_000, { min: 1_000, max: 3_600_000 }, env),
    shutdownTimeout: readInteger('N_T_SHUTDOWN_TIMEOUT_MS', 5_000, { min: 0, max: 300_000 }, env)
  }
}

function getAgentConfig(env = process.env) {
  return {
    ...readCommonConfig(env),
    name: readName('N_T_AGENT_NAME', 'dbg', env),
    targetHost: env.N_T_AGENT_DATA_HOST || 'localhost',
    targetPort: readPort('N_T_AGENT_DATA_PORT', 8888, env)
  }
}

function getClientConfig(env = process.env) {
  return {
    ...readCommonConfig(env),
    name: readName('N_T_CLIENT_NAME', 'dbg', env),
    localPort: readPort('N_T_CLIENT_PORT', 8000, env)
  }
}

module.exports = {
  loadEnvironment,
  readInteger,
  readPort,
  readName,
  getServerConfig,
  getAgentConfig,
  getClientConfig
}
