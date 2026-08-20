# Architecture

`node-tunnel` has three long-running applications and two independent wire
paths. The public factories remain `createServer`, `createAgent`, and
`createClient`; imports have no side effects, and each instance starts and
stops through `start()` and `close()`.

## Responsibilities

```text
server.js
  route registry and control-message decisions
        |
        `-- tcp-data-transport.js
              data-port allocation, data handshake, matching, and cleanup

agent.js / client.js
  target/local-listener adapters and tunnel-open decisions
        |
        +-- peer-session.js
        |     control connection, framing, keepalive, and reconnect lifecycle
        |
        `-- byte-channel.js
              chunk I/O, backpressured writes, half-close, abort, and closure
```

The TCP transport is intentionally behind these responsibilities. Route logic
does not allocate ports or pair raw data sockets, and peer applications do not
own the control socket reconnect implementation.

## Current connection flow

1. An agent and one or more clients register a route name over encrypted,
   newline-framed control sockets.
2. The server asks the TCP data transport to open the route. That transport
   allocates one data port and owns its listener.
3. A local client connection opens a data socket and sends its encrypted data
   preface. If no agent-side socket is waiting, the transport asks the server
   router to notify the registered agent.
4. The agent opens a data socket, connects to its private target, and sends its
   encrypted data preface.
5. The TCP transport matches the sockets and wraps each endpoint as a byte
   channel. Any payload coalesced with a preface is retained and delivered
   before later payload chunks.
6. The channel bridge transfers raw application bytes in both directions. When
   both channels are TCP, it keeps Node's native `pipe()` fast path while the
   surrounding contract expresses chunk reads, backpressured writes,
   write-side close, abort, and closure for a later non-TCP adapter.

Control and data remain separate connections. This refactor does not change
the wire protocol, data-port deployment, configuration, or payload security.

## Lifecycle ownership

- `peer-session.js` creates a fresh TCP socket and frame decoder for each
  reconnect, applies capped jittered backoff, sends keepalive pings, and stops
  reconnecting after close or a fatal protocol error.
- `tcp-data-transport.js` owns all route listeners, unmatched and paired data
  sockets, port release, handshake timeouts, and bridge cleanup.
- Agent and client adapters track their target/local sockets and allow active
  channels to drain until the configured shutdown deadline.
- The server stops listeners first, drains bounded active data sockets, and
  then closes control sockets.

## Next transport change

The next TCP stage can replace the per-route transport with one shared TCP
listener without moving routing decisions back into `server.js`. That change
will require an authenticated route/tunnel ticket and a protocol-version bump.
The byte-channel contract can later receive a QUIC adapter without making a
Node `Duplex` object the transport-neutral API.
