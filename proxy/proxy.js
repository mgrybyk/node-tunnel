require('dotenv').config()
const net = require('net')
const socks = require('socks5')
const info = console.log.bind(console)

// Create server
// The server accepts SOCKS connections. This particular server acts as a proxy.
const HOST = process.env.N_T_PROXY_HOST || '127.0.0.1'
const PORT = process.env.N_T_PROXY_PORT || '8888'
const server = socks.createServer(function (socket, port, address, proxy_ready) {
  // Implement your own proxy here! Do encryption, tunnelling, whatever! Go flippin' mental!
  // I plan to tunnel everything including SSH over an HTTP tunnel. For now, though, here is the plain proxy:

  var proxy = net.createConnection({ port: port, host: address, localAddress: process.argv[2] || undefined }, proxy_ready)
  var localAddress, localPort
  proxy.on('connect', function () {
    info('%s:%d <== %s:%d ==> %s:%d', socket.remoteAddress, socket.remotePort,
      proxy.localAddress, proxy.localPort, proxy.remoteAddress, proxy.remotePort)
    localAddress = proxy.localAddress
    localPort = proxy.localPort
  })
  socket.on('drain', function () {
    if (proxy.isPaused()) proxy.resume()
  })
  proxy.on('data', function (d) {
    try {
      // console.log('receiving ' + d.length + ' bytes from proxy');
      if (!socket.write(d)) {
        proxy.pause()

        setTimeout(function () {
          if (!proxy.destroyed && proxy.isPaused()) proxy.resume()
        }, 100)
      }
    } catch (err) { }
  })
  proxy.on('drain', function () {
    if (socket.isPaused()) socket.resume()
  })
  socket.on('data', function (d) {
    // If the application tries to send data before the proxy is ready, then that is it's own problem.
    try {
      // console.log('sending ' + d.length + ' bytes to proxy');
      if (!proxy.write(d)) {
        socket.pause()

        setTimeout(function () {
          if (!socket.destroyed && socket.isPaused()) socket.resume()
        }, 100)
      }
    } catch (err) { }
  })

  proxy.on('error', err => { }) // console.log('Ignore proxy error');

  proxy.on('close', had_error => {
    try {
      if (localAddress && localPort) {
        console.log('The proxy %s:%d closed', localAddress, localPort)
      } else {
        console.error('Connect to %s:%d failed', address, port)
      }
      if (!socket.destroyed) socket.end()
    } catch (err) { }
  })

  socket.on('error', err => { }) // console.log('Ignore socket error');
  socket.on('close', function (had_error) {
    try {
      if (this.proxy !== undefined) {
        proxy.removeAllListeners('data')
        if (!proxy.destroyed) proxy.end()
      }
    } catch (err) { } // console.error('The socket %s:%d closed',socket.remoteAddress,socket.remotePort);
  }.bind(this))
}, process.env.N_T_PROXY_USER && process.env.N_T_PROXY_PASS && {
  username: process.env.N_T_PROXY_USER,
  password: process.env.N_T_PROXY_PASS
})

server.on('error', function (e) {
  console.error('SERVER ERROR: %j', e)
  if (e.code == 'EADDRINUSE') {
    console.log('Address in use, retrying in 10 seconds...')
    setTimeout(function () {
      console.log('Reconnecting to %s:%s', HOST, PORT)
      server.close()
      server.listen(PORT, HOST)
    }, 10000)
  }
})
server.listen(PORT, HOST)
