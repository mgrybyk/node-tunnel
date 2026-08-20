'use strict'

const net = require('node:net')
const tls = require('node:tls')

/**
 * Creates Socket or TLSSocket (depending on `config.useTLS`) connection
 * @param {*} config
 * @param {tls.ConnectionOptions | net.NetConnectOpts} options
 * @param {() => void} onConnected
 * @returns {tls.TLSSocket | net.Socket}
 */
function connectToRelay(config, options = {}, onConnected) {
  const connectionOptions = {
    ...options,
    host: config.relayHost,
    port: config.relayPort
  }

  if (!config.useTLS) {
    return net.createConnection(connectionOptions, onConnected)
  }

  return tls.connect(
    {
      ...connectionOptions,
      servername: config.relayHost
    },
    onConnected
  )
}

module.exports = { connectToRelay }
