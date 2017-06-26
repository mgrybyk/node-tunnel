const net = require('net')
const socks = require('socks5')
const { log, removeElement } = require('../utils')
const blockedList = ['0.', '10.', '127.', '169.254.', '224.0.0.']
for (let idx = 239; idx < 256; idx++) { blockedList.push(`${idx}.`) }

// Create server
// The server accepts SOCKS connections. This particular server acts as a proxy.
const HOST = process.env.N_T_PROXY_HOST || '127.0.0.1'
const PORT = process.env.N_T_PROXY_PORT || '8888'
const blockLocal = process.env.N_T_PROXY_BLOCK_LOCAL === 'true'
let proxies = []
let sockets = []
const server = socks.createServer(function (socket, port, address, proxyReady) {
  // WARN: it just a simply proxy, no encryption, not secure!!
  sockets.push(socket)
  var proxy = net.createConnection({ port: port, host: address, localAddress: undefined }, proxyReady)
  proxies.push(proxy)
  var localAddress, localPort
  proxy.on('connect', function () {
    log('%s:%d <== %s:%d ==> %s:%d', socket.remoteAddress, socket.remotePort,
      proxy.localAddress, proxy.localPort, proxy.remoteAddress, proxy.remotePort)
    localAddress = proxy.localAddress
    localPort = proxy.localPort
    if (blockLocal) {
      blockedList.forEach(element => {
        if (proxy.remoteAddress.startsWith(element)) { proxy.destroy() }
      })
    }
  })
  socket.on('drain', function () {
    if (proxy && proxy.isPaused()) proxy.resume()
  })
  proxy.on('data', function (d) {
      if (socket && !socket.write(d)) {
        proxy.pause()
        if (!proxy.destroyed && proxy.isPaused()) proxy.resume()
      }
  })
  proxy.on('drain', function () {
    if (socket && socket.isPaused()) socket.resume()
  })
  socket.on('data', function (d) {
    // If the application tries to send data before the proxy is ready, then that is it's own problem.
      if (proxy && !proxy.write(d)) {
        socket.pause()
        if (!socket.destroyed && socket.isPaused()) socket.resume()
      }
  })

  proxy.on('error', errIgnored => { })
  proxy.on('close', hadError => {
    removeElement(proxies, proxy)
    if (!localAddress || !localPort || hadError) {
      log('Connect to %s:%d failed', address, port, hadError)
    }
    if (socket) {
      if (!socket.destroyed) socket.destroy()
      socket.removeAllListeners('drain').removeAllListeners('data')
    }
  })

  socket.on('error', errIgnored => { })
  socket.on('close', hadError => {
    removeElement(sockets, socket)
    if (proxy) {
      if (!proxy.destroyed) proxy.destroy()
      proxy.removeAllListeners('drain').removeAllListeners('data')
    }
  })
})

server.on('error', function (e) {
  log('SERVER ERROR: %j', e)
  if (e.code === 'EADDRINUSE') {
    log('Address in use, retrying in 10 seconds...')
    setTimeout(function () {
      log('Reconnecting to %s:%s', HOST, PORT)
      server.close()
      server.listen(PORT, HOST)
    }, 10000)
  }
})
server.listen(PORT, HOST)

process.on('exit', (code) => {
  log(`Sockets: ${sockets.length}, Proxies: ${proxies.length}`)
  proxies.forEach(proxy => {
    if (proxy && !proxy.destroyed) proxy.destroy()
  })
  sockets.forEach(socket => {
    if (socket && !socket.destroyed) socket.destroy()
  })
})

process.on('SIGINT', () => {
  process.exit()
})
