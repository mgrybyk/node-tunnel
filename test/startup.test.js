'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'

const { createRelay } = require('../relay')
const { createClient } = require('../client')
const { createAgent } = require('../agent')
const { getRelayConfig, getClientConfig } = require('../config')

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

  test(`${name} shutdown waits for the listener close callback`, { timeout: 5_000 }, async t => {
    const servers = observeListeners(t)
    const application = createApplication(config)
    let finishClose
    t.after(async () => {
      finishClose?.()
      await application.close({ force: true })
    })
    await application.start()
    const server = servers[0]
    const close = server.close.bind(server)
    let callbackReached
    const listenerClosed = new Promise(resolve => {
      callbackReached = resolve
    })
    t.mock.method(server, 'close', callback =>
      close(error => {
        finishClose = () => callback(error)
        callbackReached()
      })
    )
    let settled = false
    const closing = application.close({ force: true }).then(() => {
      settled = true
    })
    await listenerClosed
    await Promise.resolve()
    assert.equal(settled, false, 'close must wait for listener completion')
    finishClose()
    await closing
    assert.equal(application.getState().started, false)
  })

  test(`${name} can retry startup after its port becomes available`, { timeout: 5_000 }, async t => {
    t.mock.method(console, 'log', () => {})
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

test('agent cannot restart while its shutdown is in progress', async t => {
  t.mock.method(console, 'log', () => {})
  const agent = createAgent()
  await agent.start()
  const closing = agent.close({ force: true })
  t.after(() => closing)
  await assert.rejects(agent.start(), /closing/)
  await closing
})

function observeListeners(t) {
  t.mock.method(console, 'log', () => {})
  const servers = []
  const createServer = net.createServer
  t.mock.method(net, 'createServer', (...args) => {
    const server = createServer(...args)
    servers.push(server)
    return server
  })
  return servers
}
