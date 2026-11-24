'use strict'

const { PROTOCOL_VERSION } = require('./protocol')
const { tryParseJSON } = require('./utils')
const { startSocketDeadline } = require('./lifecycle')
const { bridgeSockets } = require('./socket-bridge')

function bridgeWhenReady(
  dataSocket,
  localSocket,
  { messaging, createReadyDecoder = createJsonReadyDecoder(messaging), timeout, trace, onSetupFailed }
) {
  const clearDeadline = startSocketDeadline(
    dataSocket,
    timeout,
    trace && (() => trace('data-readiness-timeout', { timeoutMs: timeout }))
  )
  const decodeReady = createReadyDecoder(
    remainder => {
      if (localSocket.destroyed) return dataSocket.destroy()
      trace?.('bridge-ready', { remainderBytes: remainder.length })
      cleanup()
      bridgeSockets(dataSocket, localSocket, { leftInitialData: remainder })
    },
    reason => {
      trace?.(reason)
      dataSocket.destroy()
    }
  )
  const onEnd = () => dataSocket.destroy()
  const onLocalClose = () => dataSocket.destroy()
  const onDataClose = () => {
    cleanup()
    onSetupFailed?.()
    localSocket.destroy()
  }
  dataSocket.on('data', decodeReady)
  dataSocket.once('end', onEnd)
  dataSocket.once('close', onDataClose)
  localSocket.once('close', onLocalClose)

  function cleanup() {
    clearDeadline()
    dataSocket.off('data', decodeReady)
    dataSocket.off('end', onEnd)
    dataSocket.off('close', onDataClose)
    localSocket.off('close', onLocalClose)
  }
}

function createJsonReadyDecoder(messaging) {
  return (onReady, onInvalid) =>
    messaging.createFirstMessageDecoder(
      (data, remainder) => {
        const message = tryParseJSON(data)
        if (!message || message.protocolVersion !== PROTOCOL_VERSION || message.ready !== true) {
          return onInvalid('invalid-data-ready')
        }
        onReady(remainder)
      },
      () => onInvalid('invalid-data-frame')
    )
}

module.exports = { bridgeWhenReady }
