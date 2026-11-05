'use strict'

const { createMessaging } = require('../utils')

function createMessageQueue(socket, timeout = 3_000, messaging = createMessaging()) {
  const messages = []
  const waiters = []
  let failure
  const decode = messaging.createMessageDecoder(
    value => {
      if (failure) return
      try {
        const message = JSON.parse(value)
        const waiter = waiters.shift()
        if (waiter) waiter.resolve(message)
        else messages.push(message)
      } catch (error) {
        fail(error)
      }
    },
    () => fail(new Error('invalid control frame'))
  )

  function fail(error) {
    failure ||= error
    socket.off('data', decode)
    for (const waiter of waiters.splice(0)) waiter.reject(failure)
  }

  socket.on('data', decode)
  socket.on('error', fail)
  socket.once('end', () => fail(new Error('control socket ended')))
  socket.once('close', () => fail(new Error('control socket closed')))

  return {
    next() {
      if (messages.length) return Promise.resolve(messages.shift())
      if (failure) return Promise.reject(failure)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error(`control message did not arrive within ${timeout}ms`)), timeout)
        waiters.push({
          resolve(message) {
            clearTimeout(timer)
            resolve(message)
          },
          reject(error) {
            clearTimeout(timer)
            reject(error)
          }
        })
      })
    }
  }
}

module.exports = { createMessageQueue }
