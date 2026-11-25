'use strict'

const test = require('node:test')
const { requiredEnv } = require('../test-support/config')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { createClient } = require('../client')
const { loadEnvironment, getAgentConfig, getClientConfig, getRelayConfig } = require('../config')
const { createMessaging } = require('../utils')
const { createDiagnostics } = require('../diagnostics')

test('imports are silent without a key and factories validate configuration after import', () => {
  const env = { ...process.env, ...requiredEnv }
  delete env.N_T_CRYPT_KEY
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict')
    const factories = [require('./relay').createRelay, require('./agent').createAgent, require('./client').createClient]
    for (const create of factories) assert.throws(() => create(), /exactly 32 UTF-8 bytes/)
    process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'
    for (const create of factories) create()
  `
    ],
    { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('only the implicit default environment file may be missing', t => {
  const calls = []
  t.mock.method(process, 'loadEnvFile', filePath => {
    calls.push(filePath)
    throw Object.assign(new Error('missing file'), { code: 'ENOENT' })
  })
  assert.doesNotThrow(() => loadEnvironment())
  assert.throws(() => loadEnvironment('missing.env'), { code: 'ENOENT' })
  assert.throws(() => loadEnvironment('.env'), { code: 'ENOENT' })
  assert.deepEqual(calls, ['.env', 'missing.env', '.env'])
})

test('environment file read errors propagate and successful loads preserve the requested path', t => {
  t.mock.method(process, 'loadEnvFile', () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
  })
  assert.throws(() => loadEnvironment(), { code: 'EACCES' })
  const calls = []
  t.mock.method(process, 'loadEnvFile', filePath => calls.push(filePath))
  loadEnvironment('chosen.env')
  assert.deepEqual(calls, ['chosen.env'])
})

test('config builders include key and logging options from the supplied environment', () => {
  const env = { ...requiredEnv, N_T_CRYPT_KEY: 'a'.repeat(32), N_T_LOG_DEBUG: 'true', N_T_LOG_ERROR: 'true' }
  for (const build of [getAgentConfig, getClientConfig, getRelayConfig]) {
    const config = build(env)
    assert.equal(config.cryptKey, env.N_T_CRYPT_KEY)
    assert.equal(config.logDebug, true)
    assert.equal(config.logError, true)
  }
})

test('application keys and diagnostic settings are independent within one process', t => {
  const logs = []
  const errors = []
  t.mock.method(console, 'log', line => logs.push(line))
  t.mock.method(console, 'error', (...args) => errors.push(args))
  const first = createMessaging({ cryptKey: 'a'.repeat(32), logDebug: true, logError: true })
  const second = createMessaging({ cryptKey: 'b'.repeat(32), logDebug: false, logError: false })
  const frame = first.crypt.encrypt('isolated')
  assert.equal(first.crypt.decrypt(frame), 'isolated')
  assert.equal(second.crypt.decrypt(frame), null)
  assert.deepEqual(errors, [])
  assert.equal(first.crypt.decrypt(second.crypt.encrypt('wrong key')), null)
  assert.equal(errors.length, 1)
  createDiagnostics(first.log).debug('enabled')
  assert.equal(logs.length, 1)
  assert.deepEqual(createDiagnostics(second.log), {})
})

for (const [build, plural, property] of [
  [getClientConfig, 'N_T_CLIENT_PORTS', 'localPorts'],
  [getAgentConfig, 'N_T_AGENT_DATA_PORTS', 'targetPorts']
]) {
  test(`${plural} supports single ports and ordered ranges`, () => {
    assert.deepEqual(
      build({ ...requiredEnv, [plural]: ' 9999, 11100 - 11102, 12000 ' })[property],
      [9999, 11100, 11101, 11102, 12000]
    )
    assert.deepEqual(build({ ...requiredEnv, [plural]: '65535,1-1' })[property], [65535, 1])
    assert.deepEqual(build({ ...requiredEnv, [plural]: '1234' })[property], [1234])
  })

  test(`${plural} rejects malformed, out-of-range, duplicate, and overlapping entries`, () => {
    for (const value of [
      ' ',
      ',',
      '80,',
      '80,,81',
      '-1',
      '0',
      '65536',
      '2-1',
      '0-2',
      '1-65536',
      '1.5',
      '1e3',
      '0x50',
      '1-2-3',
      '80,80',
      '80-82,82-84',
      '8888,8800-8900'
    ]) {
      assert.throws(() => build({ ...requiredEnv, [plural]: value }), undefined, value)
    }
  })

  test(`${plural} allows 32 ports and rejects larger ranges or combined lists`, () => {
    assert.equal(build({ ...requiredEnv, [plural]: '10000-10031' })[property].length, 32)
    for (const value of [
      '10000-10032',
      '1-65535',
      '9999,10000-10031',
      Array.from({ length: 33 }, (_, i) => i + 1).join(',')
    ]) {
      assert.throws(() => build({ ...requiredEnv, [plural]: value }), /must not exceed 32 ports/)
    }
    for (const value of ['80,80', '80-82,82-84']) {
      assert.throws(() => build({ ...requiredEnv, [plural]: value }), /duplicate or overlapping ports/)
    }
  })
}

test('only the exact wasm backend value opts out of JavaScript', () => {
  assert.equal(getClientConfig(requiredEnv).protocolBackend, 'js')
  assert.equal(getClientConfig({ ...requiredEnv, N_T_CLIENT_PROTOCOL_BACKEND: 'wasm' }).protocolBackend, 'wasm')
  for (const value of ['', 'js', 'unknown', 'WASM', ' wasm ']) {
    assert.equal(getClientConfig({ ...requiredEnv, N_T_CLIENT_PROTOCOL_BACKEND: value }).protocolBackend, 'js')
    assert.doesNotThrow(() => createClient({ ...getClientConfig(requiredEnv), protocolBackend: value }))
  }
})

for (const [role, build, required] of [
  ['relay', getRelayConfig, ['N_T_RELAY_BIND_HOST', 'N_T_RELAY_PORT']],
  [
    'agent',
    getAgentConfig,
    ['N_T_RELAY_HOST', 'N_T_RELAY_PORT', 'N_T_ROUTE_ID', 'N_T_AGENT_DATA_HOST', 'N_T_AGENT_DATA_PORTS']
  ],
  [
    'client',
    getClientConfig,
    ['N_T_RELAY_HOST', 'N_T_RELAY_PORT', 'N_T_ROUTE_ID', 'N_T_CLIENT_BIND_HOST', 'N_T_CLIENT_PORTS']
  ]
]) {
  test(`${role} rejects every missing or blank required setting`, () => {
    for (const name of required) {
      for (const value of [undefined, '', '   ']) {
        assert.throws(
          () => build({ ...requiredEnv, [name]: value }),
          error => error.message.includes(name),
          `${name}=${value}`
        )
      }
    }
    for (const key of [undefined, '', ' ', 'too-short']) {
      assert.throws(() => build({ ...requiredEnv, N_T_CRYPT_KEY: key }), /exactly 32 UTF-8 bytes/)
    }
  })

  test(`${role} CLI fails before listening when a required setting is missing`, () => {
    const name = required.at(-1)
    const env = { ...process.env, ...requiredEnv, [name]: '' }
    const result = spawnSync(process.execPath, [`${role}.js`], {
      cwd: path.resolve(__dirname, '..'),
      env,
      encoding: 'utf8'
    })
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(name), result.stderr)
    assert.equal(result.stdout, '')
  })

  test(`${role} example contains all required settings except the private key`, () => {
    const { readFileSync } = require('node:fs')
    const { parseEnv } = require('node:util')
    const example = parseEnv(readFileSync(path.resolve(__dirname, `../${role}.example.env`), 'utf8'))
    assert.throws(() => build(example), /exactly 32 UTF-8 bytes/)
    assert.doesNotThrow(() => build({ ...example, N_T_CRYPT_KEY: requiredEnv.N_T_CRYPT_KEY }))
  })
}

test('legacy singular port settings cannot silently select default ports', () => {
  const agentEnv = { ...requiredEnv, N_T_AGENT_DATA_PORT: '22' }
  delete agentEnv.N_T_AGENT_DATA_PORTS
  assert.throws(() => getAgentConfig(agentEnv), /N_T_AGENT_DATA_PORTS is required/)
  const clientEnv = { ...requiredEnv, N_T_CLIENT_PORT: '9999' }
  delete clientEnv.N_T_CLIENT_PORTS
  assert.throws(() => getClientConfig(clientEnv), /N_T_CLIENT_PORTS is required/)
})

test('peer timeout bounds retain short test deadlines and longer deployment settings', () => {
  for (const build of [getAgentConfig, getClientConfig]) {
    const config = build({
      ...requiredEnv,
      N_T_HANDSHAKE_TIMEOUT_MS: '300',
      N_T_HEARTBEAT_INTERVAL_MS: '100',
      N_T_HEARTBEAT_TIMEOUT_MS: '100',
      N_T_SHUTDOWN_TIMEOUT_MS: '300000'
    })
    assert.equal(config.handshakeTimeout, 300)
    assert.equal(config.heartbeatInterval, 100)
    assert.equal(config.heartbeatTimeout, 100)
    assert.equal(config.shutdownTimeout, 300000)
    assert.equal(build(requiredEnv).handshakeTimeout, 5000)
  }
})
