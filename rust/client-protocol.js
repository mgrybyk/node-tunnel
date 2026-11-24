'use strict'

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createFrameDecoder, getControlKey } = require('../utils')
const { createCore } = require('./client-core')

let compiledModule

function createWasmClientProtocol(config, portCount) {
  const cryptKey = getControlKey(config)
  if (!compiledModule) compiledModule = loadModule()
  const core = createCore(compiledModule, { cryptKey, name: config.name, portCount })

  return {
    register(socket) {
      if (!writeAction(socket, core.register())) socket.destroy()
    },
    disconnect: core.disconnect,
    ping: socket => writeAction(socket, core.ping()),
    send(socket, message) {
      if (!socket || socket.destroyed || socket.writableEnded) return false
      if (message.openTunnel) {
        const { requestId, portIndex } = message.openTunnel
        return writeAction(socket, core.openTunnel(requestId, portIndex))
      }
      if (message.cancelTunnel) return writeAction(socket, core.cancel(message.cancelTunnel.ticket))
      return false
    },
    sendDataPreface(socket, ticket) {
      if (!writeAction(socket, core.dataPreface(ticket))) socket.destroy()
    },
    createDecoder(onEvent, onInvalid) {
      return createFrameDecoder(
        frame => {
          const action = core.controlFrame(frame)
          switch (action.type) {
            case 'registration':
              onEvent({ registration: true, message: { registration: { ready: action.ready } } })
              break
            case 'pong':
              onEvent({ pong: true, message: {} })
              break
            case 'open-data':
              onEvent({ message: { openTunnel: { requestId: action.requestId, ticket: action.ticket } } })
              break
            case 'tunnel-error':
              onEvent({ message: { tunnelError: { requestId: action.requestId, error: action.error } } })
              break
            case 'fatal':
              onEvent({ fatal: action.error })
              break
            case 'reject':
              return false
          }
        },
        onInvalid,
        { maxBytes: core.maxFrameBytes }
      )
    },
    createReadyDecoder(onReady, onInvalid) {
      return createFrameDecoder(
        (frame, remainder) => {
          if (core.dataFrame(frame).type !== 'start-forwarding') return onInvalid('invalid-data-ready')
          onReady(remainder)
        },
        () => onInvalid('invalid-data-frame'),
        { firstOnly: true, maxBytes: core.maxFrameBytes }
      )
    }
  }
}

function writeAction(socket, action) {
  if (action.type !== 'send' || socket.destroyed || socket.writableEnded) return false
  socket.write(action.frame)
  return true
}

function loadModule() {
  try {
    return new WebAssembly.Module(readFileSync(join(__dirname, 'client.wasm')))
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('WASM client module is missing. Run npm run build:wasm in a source checkout.', { cause: error })
    }
    throw new Error(`Unable to load WASM client module: ${error.message}`, { cause: error })
  }
}

module.exports = { createWasmClientProtocol }
