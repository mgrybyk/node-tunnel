'use strict'

const { once } = require('node:events')

const tcpSocket = Symbol('tcpSocket')
const takeInitialData = Symbol('takeInitialData')

function createTcpByteChannel(socket, { initialData } = {}) {
  let pending = initialData?.length ? Buffer.from(initialData) : null
  const closed = socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve))

  return {
    async *read() {
      const firstChunk = takePending()
      if (firstChunk) yield firstChunk
      for await (const chunk of socket) yield chunk
    },

    async write(chunk) {
      if (socket.destroyed) throw new Error('byte channel is closed')
      if (!socket.write(chunk)) await once(socket, 'drain')
    },

    closeWrite() {
      if (!socket.destroyed && !socket.writableEnded) socket.end()
    },

    abort(error) {
      if (!socket.destroyed) socket.destroy(error)
    },

    closed,
    [tcpSocket]: socket,
    [takeInitialData]: takePending
  }

  function takePending() {
    const chunk = pending
    pending = null
    return chunk
  }
}

function bridgeByteChannels(left, right) {
  const leftSocket = left[tcpSocket]
  const rightSocket = right[tcpSocket]

  if (leftSocket && rightSocket) return bridgeTcpChannels(left, right, leftSocket, rightSocket)

  const completed = Promise.all([pump(left, right), pump(right, left)]).catch(error => {
    left.abort(error)
    right.abort(error)
    throw error
  })
  completed.catch(() => {})

  return {
    completed,
    abort(error) {
      left.abort(error)
      right.abort(error)
    }
  }
}

function bridgeTcpChannels(left, right, leftSocket, rightSocket) {
  leftSocket.setTimeout?.(0)
  rightSocket.setTimeout?.(0)

  leftSocket.once('close', hadError => closePeer(leftSocket, rightSocket, hadError))
  rightSocket.once('close', hadError => closePeer(rightSocket, leftSocket, hadError))

  leftSocket.pipe(rightSocket)
  rightSocket.pipe(leftSocket)

  const leftInitialData = left[takeInitialData]()
  const rightInitialData = right[takeInitialData]()
  if (leftInitialData) rightSocket.write(leftInitialData)
  if (rightInitialData) leftSocket.write(rightInitialData)

  leftSocket.resume()
  rightSocket.resume()

  return {
    completed: Promise.all([left.closed, right.closed]),
    abort(error) {
      left.abort(error)
      right.abort(error)
    }
  }
}

async function pump(source, destination) {
  for await (const chunk of source.read()) await destination.write(chunk)
  destination.closeWrite()
}

function closePeer(socket, peer, hadError) {
  socket.unpipe(peer)
  peer.unpipe(socket)
  if (peer.destroyed) return
  if (hadError) peer.destroy()
  else if (!peer.writableEnded) peer.end()
}

module.exports = { createTcpByteChannel, bridgeByteChannels }
