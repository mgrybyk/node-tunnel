'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const tls = require('node:tls')
const fs = require('node:fs')
const path = require('node:path')
const { Transform } = require('node:stream')
const { once } = require('node:events')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'
process.env.N_T_LOG_DEBUG = 'true'

const { createRelay } = require('../relay')
const { createAgent } = require('../agent')
const { createClient } = require('../client')
const { getRelayConfig, getAgentConfig, getClientConfig } = require('../config')
const { log } = require('../utils')
const { host, listen, closeServer, reserveTopologyPorts, waitForCondition } = require('../test-support/helpers')

const key = fs.readFileSync(path.join(__dirname, 'fixtures/localhost-key.pem'))
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/localhost-cert.pem'))

for (const useTLS of [false, true]) {
  for (const speaksFirst of ['client', 'target']) {
    test(`interactive ${useTLS ? 'TLS' : 'TCP'} tunnel progresses without FIN when ${speaksFirst} speaks first`, {
      timeout: 10_000
    }, async t => {
      t.mock.method(log, 'info', () => {})
      t.mock.method(log, 'debug', () => {})
      // Exercise the diagnostics listeners too, without writing diagnostic output.
      const sockets = new Set()
      const track = socket => {
        sockets.add(socket)
        socket.on('error', () => {})
        socket.once('close', () => sockets.delete(socket))
        return socket
      }
      const ports = await reserveTopologyPorts(1)
      const clientBanner = Buffer.from('SSH-2.0-interactive-client\r\n')
      const targetBanner = Buffer.from('SSH-2.0-interactive-target\r\n')
      const target = net.createServer({ allowHalfOpen: true }, socket => {
        track(socket)
        let identification = Buffer.alloc(0)
        let identified = false
        if (speaksFirst === 'target') socket.write(targetBanner)
        socket.on('data', data => {
          if (identified) return void socket.write(data)
          identification = Buffer.concat([identification, data])
          if (identification.length < clientBanner.length) return
          assert.deepEqual(identification.subarray(0, clientBanner.length), clientBanner)
          identified = true
          if (speaksFirst === 'client') socket.write(targetBanner)
          const remainder = identification.subarray(clientBanner.length)
          if (remainder.length) socket.write(remainder)
        })
      })
      const relay = createRelay({ ...getRelayConfig({}), serviceHost: host, servicePort: ports.service })
      let agent, client, proxy
      t.after(async () => {
        await Promise.all([agent?.close({ force: true }), client?.close({ force: true }), relay.close({ force: true })])
        for (const socket of sockets) socket.destroy()
        await Promise.all([closeServer(target), ...(proxy ? [closeServer(proxy)] : [])])
      })
      await listen(target)
      await relay.start()
      let relayPort = ports.service
      if (useTLS) {
        const originalConnect = tls.connect
        t.mock.method(tls, 'connect', (options, callback) => originalConnect({ ...options, ca: cert }, callback))
        proxy = tls.createServer({ key, cert, allowHalfOpen: true }, socket => {
          track(socket)
          const backend = track(net.createConnection({ host, port: ports.service, allowHalfOpen: true }))
          // Split both registration/readiness frames and adjacent payload writes.
          socket.pipe(fragment()).pipe(backend)
          backend.pipe(fragment()).pipe(socket)
          socket.once('close', () => backend.destroy())
          backend.once('close', () => socket.destroy())
        })
        proxy.on('connection', track)
        await listen(proxy)
        relayPort = proxy.address().port
      }
      const common = { relayHost: useTLS ? 'localhost' : host, relayPort, useTLS, name: 'interactive' }
      agent = createAgent({ ...getAgentConfig({}), ...common, targetHost: host, targetPort: target.address().port })
      client = createClient({ ...getClientConfig({}), ...common, localHost: host, localPort: ports.clients[0] })
      await Promise.all([agent.start(), client.start()])
      await waitForCondition(() => client.getState().ready)
      const external = track(net.createConnection({ host, port: ports.clients[0], allowHalfOpen: true }))
      const reader = readQueue(external)
      await once(external, 'connect')
      if (speaksFirst === 'client') external.write(clientBanner)
      assert.deepEqual(await reader.take(targetBanner.length), targetBanner)
      if (speaksFirst === 'target') external.write(clientBanner)
      for (const size of [1, 23, 256 * 1024, 7]) {
        const payload = Buffer.alloc(size)
        for (let i = 0; i < size; i++) payload[i] = i % 251
        external.write(payload)
        assert.deepEqual(await reader.take(size), payload)
        assert.equal(external.writableEnded, false)
        assert.equal(external.readableEnded, false)
      }
      assert.equal(relay.getState().activeTunnels, 1)
    })
  }
}

function fragment() {
  return new Transform({
    transform(chunk, _encoding, callback) {
      this.push(chunk.subarray(0, 1))
      if (chunk.length > 1) this.push(chunk.subarray(1, 7))
      if (chunk.length > 7) this.push(chunk.subarray(7))
      callback()
    }
  })
}

function readQueue(socket) {
  let pending = Buffer.alloc(0)
  let waiter
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk])
    flush()
  })
  socket.on('end', () => waiter?.reject(new Error('unexpected EOF during interactive exchange')))
  socket.on('error', error => waiter?.reject(error))
  function flush() {
    if (!waiter || pending.length < waiter.size) return
    const active = waiter
    waiter = undefined
    const data = pending.subarray(0, active.size)
    pending = pending.subarray(active.size)
    active.resolve(data)
  }
  return {
    take(size) {
      return new Promise((resolve, reject) => {
        waiter = { size, resolve, reject }
        flush()
      })
    }
  }
}
