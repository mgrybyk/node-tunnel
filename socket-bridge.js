'use strict'

function bridgeSockets(left, right, { leftInitialData, rightInitialData } = {}) {
  left.setTimeout(0)
  right.setTimeout(0)

  left.once('close', hadError => closePeer(left, right, hadError))
  right.once('close', hadError => closePeer(right, left, hadError))

  left.pipe(right)
  right.pipe(left)

  if (leftInitialData?.length) right.write(leftInitialData)
  if (rightInitialData?.length) left.write(rightInitialData)

  left.resume()
  right.resume()
}

function closePeer(socket, peer, hadError) {
  socket.unpipe(peer)
  peer.unpipe(socket)
  if (peer.destroyed) return
  if (hadError) peer.destroy()
  else if (!peer.writableEnded) peer.end()
}

module.exports = { bridgeSockets }
