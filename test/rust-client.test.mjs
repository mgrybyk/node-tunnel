import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import tls from 'node:tls'
import agentModule from '../agent.js'
import relayModule from '../relay.js'
import helpers from '../test-support/helpers.js'

const { host, listen, closeServer, reserveTopologyPorts, startChild, stopChild, waitForOutput } = helpers

test('both client backends exchange binary data across verified TLS control and data sockets', {
  timeout: 15_000
}, async t => {
  const certDir = mkdtempSync(join(tmpdir(), 'node-tunnel-client-tls-'))
  const key = join(certDir, 'key.pem')
  const cert = join(certDir, 'cert.pem')
  const children = []
  t.after(async () => {
    await Promise.all(children.map(stopChild))
    rmSync(certDir, { recursive: true, force: true })
  })
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      key,
      '-out',
      cert
    ],
    { stdio: 'pipe' }
  )

  const ports = await reserveTopologyPorts(2)
  const common = { name: 'tls-backend-test', cryptKey: '0123456789abcdef0123456789abcdef', handshakeTimeout: 2000 }
  const relay = relayModule.createRelay({
    ...common,
    serviceHost: host,
    servicePort: ports.service,
    controlIdleTimeout: 5000
  })
  t.after(() => relay.close({ force: true }))
  await relay.start()

  const target = net.createServer({ allowHalfOpen: true }, socket => socket.pipe(socket))
  t.after(() => closeServer(target))
  await listen(target)
  const agent = agentModule.createAgent({
    ...common,
    relayHost: host,
    relayPort: ports.service,
    targetHost: host,
    targetPorts: [target.address().port]
  })
  t.after(() => agent.close({ force: true }))
  await agent.start()

  let tlsConnections = 0
  const proxy = tls.createServer(
    { key: readFileSync(key), cert: readFileSync(cert), allowHalfOpen: true },
    downstream => {
      tlsConnections++
      const upstream = net.createConnection({ host, port: ports.service, allowHalfOpen: true })
      downstream.on('error', () => upstream.destroy())
      upstream.on('error', () => downstream.destroy())
      downstream.once('close', () => upstream.destroy())
      upstream.once('close', () => downstream.destroy())
      downstream.pipe(upstream)
      upstream.pipe(downstream)
    }
  )
  t.after(() => closeServer(proxy))
  await listen(proxy)

  for (const [index, backend] of ['js', 'wasm'].entries()) {
    const port = ports.clients[index]
    const before = tlsConnections
    const app = startChild(backend, 'client.js', {
      NODE_EXTRA_CA_CERTS: cert,
      NODE_TLS_REJECT_UNAUTHORIZED: '1',
      N_T_CRYPT_KEY: common.cryptKey,
      N_T_ROUTE_ID: common.name,
      N_T_USE_TLS: 'true',
      N_T_RELAY_HOST: 'localhost',
      N_T_RELAY_PORT: String(proxy.address().port),
      N_T_CLIENT_BIND_HOST: host,
      N_T_CLIENT_PORTS: String(port),
      N_T_CLIENT_PROTOCOL_BACKEND: backend
    })
    children.push(app)
    await waitForOutput(app, 'Agent found, ready!', 5000)
    const payload = Buffer.from([0, 0x0a, 0xff, 0x80])
    const socket = net.createConnection({ host, port })
    t.after(() => socket.destroy())
    socket.end(payload)
    const chunks = []
    for await (const chunk of socket) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), payload)
    assert.equal(tlsConnections - before, 2, backend)
    await stopChild(app)
  }
})
