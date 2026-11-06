'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { loadEnvironment, getAgentConfig, getClientConfig, getRelayConfig } = require('../config')
const { createMessaging } = require('../utils')
const { createDiagnostics } = require('../diagnostics')

test('imports are silent without a key and factories validate configuration after import', () => {
  const env = { ...process.env }
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
  const env = { N_T_CRYPT_KEY: 'a'.repeat(32), N_T_LOG_DEBUG: 'true', N_T_LOG_ERROR: 'true' }
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

for (const [build, plural, property, fallback] of [
  [getClientConfig, 'N_T_CLIENT_PORTS', 'localPorts', 8000],
  [getAgentConfig, 'N_T_AGENT_DATA_PORTS', 'targetPorts', 8888]
]) {
  test(`${plural} supports single ports, ordered ranges, and default port arrays`, () => {
    assert.deepEqual(build({ [plural]: ' 9999, 11100 - 11102, 12000 ' })[property], [9999, 11100, 11101, 11102, 12000])
    assert.deepEqual(build({ [plural]: '65535,1-1' })[property], [65535, 1])
    assert.deepEqual(build({})[property], [fallback])
    assert.deepEqual(build({ [plural]: '' })[property], [fallback])
    assert.deepEqual(build({ [plural]: '1234' })[property], [1234])
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
      assert.throws(() => build({ [plural]: value }), undefined, value)
    }
  })

  test(`${plural} allows 32 ports and rejects larger ranges or combined lists`, () => {
    assert.equal(build({ [plural]: '10000-10031' })[property].length, 32)
    for (const value of [
      '10000-10032',
      '1-65535',
      '9999,10000-10031',
      Array.from({ length: 33 }, (_, i) => i + 1).join(',')
    ]) {
      assert.throws(() => build({ [plural]: value }), /must not exceed 32 ports/)
    }
    for (const value of ['80,80', '80-82,82-84']) {
      assert.throws(() => build({ [plural]: value }), /duplicate or overlapping ports/)
    }
  })
}
