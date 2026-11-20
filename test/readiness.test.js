'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'

const { createAgent } = require('../agent')
const { createClient } = require('../client')
const { PROTOCOL_VERSION } = require('../protocol')
const { writeMessage, createFirstMessageDecoder, createMessageDecoder } = require('../utils').createMessaging()
const { host, listen, closeServer, waitForCondition, reservePort } = require('../test-support/helpers')

for (const role of ['agent', 'client']) {
  for (const failure of [
    'stall',
    'invalid version',
    'invalid frame',
    'invalid readiness',
    'FIN',
    ...(role === 'agent' ? ['target stall'] : [])
  ]) {
    test(`${role} releases local sockets after data readiness failure: ${failure}`, { timeout: 5_000 }, async t => {
      const sockets = new Set()
      let dataPrefaces = 0
      let cancellations = 0
      let targetConnects = 0
      const track = socket => {
        sockets.add(socket)
        socket.on('error', () => {})
        socket.once('close', () => sockets.delete(socket))
      }
      // Deliberately keep the target's writable half open after receiving FIN.
      const target = net.createServer({ allowHalfOpen: true }, track)
      const relay = net.createServer(socket => {
        track(socket)
        const send = message => writeMessage(socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message }))
        const first = createFirstMessageDecoder(data => {
          socket.off('data', first)
          const message = JSON.parse(data)
          if (message.kind === 'data') {
            dataPrefaces++
            if (failure === 'invalid version') {
              return writeMessage(socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION + 1, ready: true }))
            }
            if (failure === 'invalid frame') return socket.write('invalid-frame\n')
            if (failure === 'invalid readiness') return send({ ready: 'yes' })
            if (failure === 'FIN') return socket.end()
            // Trickle an incomplete frame; incoming bytes must not extend the deadline.
            const timer = setInterval(() => socket.write('x'), 10)
            socket.once('close', () => clearInterval(timer))
            return
          }
          send({ registration: { uuid: 'test-id', ready: true } })
          if (role === 'agent') send({ openTunnel: { ticket: 'test-ticket' } })
          socket.on(
            'data',
            createMessageDecoder(data => {
              const message = JSON.parse(data)
              if (message.openTunnel) send({ openTunnel: { ...message.openTunnel, ticket: 'test-ticket' } })
              if (message.cancelTunnel) cancellations++
            })
          )
        })
        socket.on('data', first)
      })
      let application
      t.after(async () => {
        await application?.close({ force: true })
        for (const socket of sockets) socket.destroy()
        await Promise.all([closeServer(target), closeServer(relay)])
      })
      await listen(target)
      await listen(relay)
      const reservation = await reservePort()
      const localPort = reservation.port
      await closeServer(reservation.server)
      const config = {
        relayHost: host,
        relayPort: relay.address().port,
        name: 'stalled-data',
        targetHost: host,
        targetPorts: [target.address().port],
        localHost: host,
        localPorts: [localPort],
        handshakeTimeout: 300,
        reconnectDelay: 100,
        reconnectMaxDelay: 100,
        reconnectJitterPercent: 0,
        shutdownTimeout: 0
      }
      if (failure === 'target stall') {
        const connect = net.Socket.prototype.connect
        t.mock.method(net.Socket.prototype, 'connect', function (...args) {
          if (args[0] === config.targetPorts[0]) {
            targetConnects++
            return this
          }
          return connect.apply(this, args)
        })
      }
      application = role === 'agent' ? createAgent(config) : createClient(config)
      await application.start()
      await waitForCondition(() => application.getState().ready)
      if (role === 'client') track(net.createConnection({ host, port: localPort, allowHalfOpen: true }))
      await waitForCondition(() => (failure === 'target stall' ? targetConnects === 1 : dataPrefaces === 1))
      await waitForCondition(() => application.getState().dataConnections === 0)
      await waitForCondition(() => application.getState().localConnections === 0)
      await waitForCondition(() => cancellations === 1)
      assert.equal(application.getState().connected, true)
    })
  }
}
