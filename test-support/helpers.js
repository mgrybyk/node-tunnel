'use strict'

const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const host = '127.0.0.1'

function startChild(label, script, env) {
  const child = spawn(process.execPath, [path.join(projectRoot, script)], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const info = { label, child, stdout: '', stderr: '' }

  child.stdout.on('data', data => {
    info.stdout += data.toString()
  })
  child.stderr.on('data', data => {
    info.stderr += data.toString()
  })

  return info
}

function waitForOutput(info, expected, timeout = 10_000) {
  return waitForOutputCount(info, expected, 1, timeout)
}

function waitForOutputCount(info, expected, count, timeout = 10_000) {
  const matches = () => (info.stdout + info.stderr).split(expected).length - 1
  if (matches() >= count) return Promise.resolve()
  if (info.child.exitCode !== null || info.child.signalCode !== null) {
    return Promise.reject(childExitError(info))
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (matches() >= count) {
        cleanup()
        resolve()
        return
      }

      cleanup()
      reject(
        new Error(
          `${info.label} did not output "${expected}" ${count} time(s) within ${timeout}ms\n${formatChildLogs([info])}`
        )
      )
    }, timeout)
    const pollTimer = setInterval(onData, 10)

    function onData() {
      if (matches() < count) return
      cleanup()
      resolve()
    }

    function onExit(code, signal) {
      cleanup()
      reject(childExitError(info, code, signal))
    }

    function onError(error) {
      cleanup()
      reject(error)
    }

    function cleanup() {
      clearTimeout(timer)
      clearInterval(pollTimer)
      info.child.stdout.off('data', onData)
      info.child.stderr.off('data', onData)
      info.child.off('exit', onExit)
      info.child.off('error', onError)
    }

    info.child.stdout.on('data', onData)
    info.child.stderr.on('data', onData)
    info.child.once('exit', onExit)
    info.child.once('error', onError)
  })
}

function childExitError(info, code = info.child.exitCode, signal = info.child.signalCode) {
  return new Error(`${info.label} exited early (code=${code}, signal=${signal})\n${formatChildLogs([info])}`)
}

function waitForListening(info, port, timeout = 10_000) {
  if (info.child.exitCode !== null || info.child.signalCode !== null) {
    return Promise.reject(childExitError(info))
  }

  return new Promise((resolve, reject) => {
    let socket
    let retryTimer
    let settled = false
    const timeoutTimer = setTimeout(() => {
      finish(
        new Error(`${info.label} did not listen on ${host}:${port} within ${timeout}ms\n${formatChildLogs([info])}`)
      )
    }, timeout)

    function attempt() {
      if (settled) return
      if (info.child.exitCode !== null || info.child.signalCode !== null) {
        finish(childExitError(info))
        return
      }

      socket = net.createConnection({ host, port })
      socket.once('connect', () => finish())
      socket.once('error', () => {
        socket.destroy()
        retryTimer = setTimeout(attempt, 10)
      })
    }

    function onExit(code, signal) {
      finish(childExitError(info, code, signal))
    }

    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(retryTimer)
      if (socket) socket.destroy()
      info.child.off('exit', onExit)
      info.child.off('error', finish)
      if (error) reject(error)
      else resolve()
    }

    info.child.once('exit', onExit)
    info.child.once('error', finish)
    attempt()
  })
}

function waitForExit(info, timeout = 10_000) {
  if (info.child.exitCode !== null || info.child.signalCode !== null) {
    return Promise.resolve({ code: info.child.exitCode, signal: info.child.signalCode })
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`${info.label} did not exit within ${timeout}ms`))
    }, timeout)
    const onExit = (code, signal) => {
      cleanup()
      resolve({ code, signal })
    }
    const onError = error => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timer)
      info.child.off('exit', onExit)
      info.child.off('error', onError)
    }

    info.child.once('exit', onExit)
    info.child.once('error', onError)
  })
}

async function stopChild(info) {
  const child = info.child
  if (child.exitCode !== null || child.signalCode !== null) return

  await new Promise(resolve => {
    const forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
    child.once('exit', () => {
      clearTimeout(forceTimer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

function formatChildLogs(children) {
  if (children.length === 0) return 'No child processes were started.'

  return children
    .map(info => {
      const output = `${info.stdout}${info.stderr}`.trim()
      return `--- ${info.label} ---\n${output.slice(-8_000) || '(no output)'}`
    })
    .join('\n')
}

async function reserveTopologyPorts(dataPortsCount, clientsCount) {
  const dataReservation = await reservePortRange(dataPortsCount)
  const otherReservations = []

  try {
    for (let index = 0; index < 1 + clientsCount; index++) {
      otherReservations.push(await reservePort())
    }

    return {
      service: otherReservations[0].port,
      dataFrom: dataReservation.base,
      dataTo: dataReservation.base + dataPortsCount - 1,
      clients: otherReservations.slice(1).map(reservation => reservation.port)
    }
  } finally {
    await Promise.all([
      ...dataReservation.servers.map(closeServer),
      ...otherReservations.map(reservation => closeServer(reservation.server))
    ])
  }
}

async function reservePortRange(count) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = 20_000 + Math.floor(Math.random() * (35_000 - count))
    const servers = []

    try {
      for (let offset = 0; offset < count; offset++) {
        const server = net.createServer()
        await listen(server, base + offset)
        servers.push(server)
      }
      return { base, servers }
    } catch (_error) {
      await Promise.all(servers.map(closeServer))
    }
  }

  throw new Error(`could not reserve ${count} consecutive ports`)
}

async function reservePort() {
  const server = net.createServer()
  await listen(server, 0)
  return { server, port: server.address().port }
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      cleanup()
      resolve()
    }
    const onError = error => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      server.off('listening', onListening)
      server.off('error', onError)
    }

    server.once('listening', onListening)
    server.once('error', onError)
    server.listen(port, host)
  })
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(fallbackTimer)
      resolve()
    }
    const fallbackTimer = setTimeout(finish, 1_000)
    server.close(finish)
    if (server.closeAllConnections) server.closeAllConnections()
  })
}

function waitForSocketClose(socket, timeout = 5_000) {
  if (socket.closed || socket.destroyed) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('socket did not close in time'))
    }, timeout)
    const onClose = () => {
      cleanup()
      resolve()
    }
    const onError = () => {}
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('close', onClose)
      socket.off('error', onError)
    }

    socket.once('close', onClose)
    socket.on('error', onError)
  })
}

function waitForCondition(condition, timeout = 5_000, interval = 10) {
  if (condition()) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - startedAt >= timeout) {
        clearInterval(timer)
        reject(new Error('condition was not met in time'))
      }
    }, interval)
  })
}

module.exports = {
  host,
  startChild,
  waitForOutput,
  waitForOutputCount,
  waitForListening,
  waitForExit,
  stopChild,
  formatChildLogs,
  reserveTopologyPorts,
  reservePort,
  listen,
  closeServer,
  waitForSocketClose,
  waitForCondition
}
