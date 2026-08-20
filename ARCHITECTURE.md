# Architecture

`node-tunnel` has three long-running applications and two independent wire
paths. The public factories remain `createServer`, `createAgent`, and
`createClient`; imports have no side effects, and each instance starts and
stops through `start()` and `close()`.

## Responsibilities

```text
server.js
  shared-listener classification, route registry, and open decisions
        |
        `-- tcp-data-transport.js
              ticket lifecycle, data matching, bridging, and cleanup

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
does not pair raw data sockets, and peer applications do not own the control
socket reconnect implementation.

## Current connection flow

1. Every relay connection starts on the one configured TCP port with an
   encrypted, newline-framed preface identifying it as `control` or `data`.
2. An agent and one or more clients register a route name on long-lived control
   connections.
3. For each accepted local client socket, the client requests a tunnel over its
   control session. The server creates a random ticket bound to that client,
   the current agent session, and the route, then sends it to both peers.
4. Client and agent open independent TCP data connections to the shared relay
   port. The agent also connects to its private target. Each data preface carries
   its role and the same ticket.
5. The TCP data transport validates both roles, consumes the ticket once, and
   wraps both data sockets as byte channels. Tickets expire, pending tickets are
   bounded, duplicate roles and replay are rejected, and payload coalesced with
   either preface is retained.
6. The channel bridge transfers raw application bytes in both directions. When
   both channels are TCP, it keeps Node's native `pipe()` fast path while the
   surrounding contract expresses chunk reads, backpressured writes,
   write-side close, abort, and closure for a later non-TCP adapter.

Control and data remain separate TCP connections but share one listener. The
protocol-v3 change removes the server data-port range; it does not add payload
encryption. SSH, TLS, or another end-to-end encrypted protocol remains required
for confidential payloads.

## Lifecycle ownership

- `peer-session.js` creates a fresh TCP socket and frame decoder for each
  reconnect, applies capped jittered backoff, sends keepalive pings, and stops
  reconnecting after close or a fatal protocol error.
- `tcp-data-transport.js` owns ticket creation/expiry, unmatched and paired data
  sockets, handshake timeouts, replay rejection, and bridge cleanup.
- Agent and client adapters track their target/local sockets and allow active
  channels to drain until the configured shutdown deadline.
- The server stops listeners first, drains bounded active data sockets, and
  then closes control sockets.

## Next transport change

The byte-channel and session boundaries are now ready for a Node 26 QUIC spike.
That stage must first validate the exact experimental runtime API, mandatory TLS
configuration, stream reset/backpressure behavior, and clean shutdown. A QUIC
adapter must not make a Node `Duplex` object the transport-neutral API.
