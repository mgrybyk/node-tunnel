'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'

const { createRelay } = require('../relay')
const { createClient } = require('../client')
const { getRelayConfig, getClientConfig } = require('../config')
const { log } = require('../utils')
const { closeServer, host, listen } = require('../test-support/helpers')

for (const [name, createApplication, config] of [
  ['relay', createRelay, { ...getRelayConfig({}), serviceHost: host, servicePort: 0 }],
  ['client', createClient, { ...getClientConfig({}), relayPort: 0, localHost: host, localPort: 0 }]
]) {
  test(`${name} concurrent starts create one listener and shutdown releases it`, { timeout: 5_000 }, async t => {
    const servers = observeListeners(t)
    const application = createApplication(config)
    t.after(async () => {
      await application.close({ force: true })
      await Promise.all(servers.map(closeServer))
    })

    await Promise.all([application.start(), application.start(), application.start()])
    assert.equal(servers.length, 1, 'concurrent callers must share the same startup')
    await application.close({ force: true })
    assert.ok(
      servers.every(server => !server.listening),
      'shutdown must release every listener'
    )
    assert.equal(application.getState().started, false)
    await assert.rejects(application.start(), /closing/)
  })

  test(`${name} shutdown waits for an in-progress startup`, { timeout: 5_000 }, async t => {
    const servers = observeListeners(t)
    const application = createApplication(config)
    t.after(async () => {
      await application.close({ force: true })
      await Promise.all(servers.map(closeServer))
    })
    const starting = application.start()
    const closing = application.close({ force: true })
    await Promise.all([starting, closing])
    assert.ok(servers.every(server => !server.listening))
    assert.equal(application.getState().started, false)
  })

  test(`${name} can retry startup after its port becomes available`, { timeout: 5_000 }, async t => {
    t.mock.method(log, 'info', () => {})
    const blocker = net.createServer()
    await listen(blocker)
    const port = blocker.address().port
    const application = createApplication({ ...config, servicePort: port, localPort: port })
    t.after(async () => {
      await application.close({ force: true })
      await closeServer(blocker)
    })
    await assert.rejects(application.start(), error => error.code === 'EADDRINUSE')
    await closeServer(blocker)
    await Promise.all([application.start(), application.start()])
    assert.equal(application.getState().started, true)
    await application.close({ force: true })
    const replacement = net.createServer()
    t.after(() => closeServer(replacement))
    await listen(replacement, port)
  })
}

function observeListeners(t) {
  t.mock.method(log, 'info', () => {})
  const servers = []
  const createServer = net.createServer
  t.mock.method(net, 'createServer', (...args) => {
    const server = createServer(...args)
    servers.push(server)
    return server
  })
  return servers
}
