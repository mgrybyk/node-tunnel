'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'

const { createRelay } = require('../relay')
const { getRelayConfig } = require('../config')
const { PROTOCOL_VERSION, CONNECTION_KINDS, TYPES, ERRORS } = require('../protocol')
const { writeMessage, createMessageDecoder, log } = require('../utils')
const { host, waitForSocketClose } = require('../test-support/helpers')

for (const rejection of ['version mismatch', 'duplicate agent']) {
  for (const action of ['deadline', 'forced shutdown']) {
    test(`relay releases a half-open ${rejection} connection on ${action}`, { timeout: 5_000 }, async t => {
      t.mock.method(log, 'info', () => {})
      const accepted = []
      const peers = []
      let server
      const createServer = net.createServer
      t.mock.method(net, 'createServer', (...args) => {
        server = createServer(...args)
        server.on('connection', socket => accepted.push(socket))
        return server
      })
      const relay = createRelay({
        ...getRelayConfig({}),
        serviceHost: host,
        servicePort: 0,
        handshakeTimeout: 100
      })
      t.after(async () => {
        for (const socket of [...peers, ...accepted]) socket.destroy()
        await relay.close({ force: true })
      })
      await relay.start()

      async function register(protocolVersion) {
        // Deliberately withhold FIN after the relay sends its rejection.
        const socket = net.createConnection({ host, port: server.address().port, allowHalfOpen: true })
        peers.push(socket)
        socket.on('error', () => {})
        const response = new Promise((resolve, reject) => {
          socket.on(
            'data',
            createMessageDecoder(message => resolve(JSON.parse(message)), reject)
          )
          socket.once('error', reject)
        })
        writeMessage(
          socket,
          JSON.stringify({
            protocolVersion,
            kind: CONNECTION_KINDS.CONTROL,
            type: TYPES.AGENT,
            name: 'rejected-route'
          })
        )
        return response
      }

      if (rejection === 'duplicate agent') await register(PROTOCOL_VERSION)
      const response = await register(PROTOCOL_VERSION + (rejection === 'version mismatch' ? 1 : 0))
      assert.equal(response.error, rejection === 'version mismatch' ? ERRORS.VERSION_MISMATCH : ERRORS.DUPLICATE_AGENT)
      const rejected = accepted.at(-1)

      if (action === 'forced shutdown') await relay.close({ force: true })
      else await waitForSocketClose(rejected, 1_000)

      assert.equal(rejected.destroyed, true, 'a rejected peer must not retain a relay socket by withholding FIN')
      assert.equal(relay.getState().handshakeSockets, 0)
    })
  }
}
