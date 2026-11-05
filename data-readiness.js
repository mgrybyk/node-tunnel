'use strict'

const { PROTOCOL_VERSION } = require('./protocol')
const { tryParseJSON, createFirstMessageDecoder } = require('./utils')
const { startSocketDeadline } = require('./lifecycle')

function waitForDataReady(socket, { timeout, trace }, onReady) {
  const clearDeadline = startSocketDeadline(
    socket,
    timeout,
    trace &&
      (() => {
        trace('data-readiness-timeout', { timeoutMs: timeout })
      })
  )
  const decodeReady = createFirstMessageDecoder(
    (data, remainder) => {
      const message = tryParseJSON(data)
      if (!message || message.protocolVersion !== PROTOCOL_VERSION || !message.ready) {
        trace?.('invalid-data-ready')
        return socket.destroy()
      }
      trace?.('bridge-ready', { remainderBytes: remainder.length })
      cleanup()
      onReady(remainder)
    },
    () => {
      trace?.('invalid-data-frame')
      socket.destroy()
    }
  )
  const onEnd = () => socket.destroy()
  socket.on('data', decodeReady)
  socket.once('end', onEnd)
  socket.once('close', cleanup)

  function cleanup() {
    clearDeadline()
    socket.off('data', decodeReady)
    socket.off('end', onEnd)
    socket.off('close', cleanup)
  }
}

module.exports = { waitForDataReady }
