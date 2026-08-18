'use strict'

function createBackoff({ baseDelay, maxDelay, jitterPercent = 20, random = Math.random }) {
  let attempt = 0

  return {
    next() {
      const exponentialDelay = Math.min(maxDelay, baseDelay * 2 ** attempt++)
      const spread = (exponentialDelay * jitterPercent) / 100
      return Math.max(0, Math.round(exponentialDelay - spread + 2 * spread * random()))
    },
    reset() {
      attempt = 0
    }
  }
}

function stopListening(server) {
  if (!server?.listening) return
  server.close()
}

function destroySockets(sockets) {
  const closePromises = []

  for (const socket of [...sockets]) {
    if (!socket.closed) {
      closePromises.push(new Promise(resolve => socket.once('close', resolve)))
    }
    socket.unpipe()
    if (!socket.destroyed) socket.destroy()
  }

  return Promise.all(closePromises)
}

function waitForSockets(sockets, timeout) {
  const openSockets = [...sockets].filter(socket => !socket.destroyed)
  if (openSockets.length === 0) return Promise.resolve(true)
  if (timeout === 0) return Promise.resolve(false)

  return new Promise(resolve => {
    let remaining = openSockets.length
    let settled = false
    const timer = setTimeout(() => finish(false), timeout)

    for (const socket of openSockets) socket.once('close', onClose)

    function onClose() {
      remaining--
      if (remaining === 0) finish(true)
    }

    function finish(drained) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const socket of openSockets) socket.off('close', onClose)
      resolve(drained)
    }
  })
}

function runCli(createApplication) {
  let application
  let shutdownPromise

  const shutdown = (exitCode, force = false) => {
    if (shutdownPromise) return shutdownPromise
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)

    shutdownPromise = Promise.resolve()
      .then(() => application?.close({ force }))
      .catch(error => {
        console.error(error)
        exitCode = 1
      })
      .finally(() => {
        process.exitCode = exitCode
      })

    return shutdownPromise
  }

  const onSignal = () => {
    shutdown(0)
  }

  try {
    application = createApplication()
    application.once('fatal', () => shutdown(1, true))
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    Promise.resolve(application.start()).catch(error => {
      console.error(error)
      shutdown(1, true)
    })
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}

module.exports = {
  createBackoff,
  stopListening,
  destroySockets,
  waitForSockets,
  runCli
}
