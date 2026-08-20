# Repository guide

## Architecture

`node-tunnel` is a CommonJS TCP relay with three long-running processes:

- `server.js`: shared relay listener, route/session registry, and open requests.
- `agent.js`: connects a named route to a private target.
- `client.js`: exposes a local port for a named route.
- `config.js`, `lifecycle.js`, `protocol.js`, and `utils.js`: shared config,
  shutdown/reconnect behavior, wire constants, framing, and encryption.

The server, agent, and client expose `createServer`, `createAgent`, and
`createClient`. Imports have no side effects; instances start with `start()` and
stop with asynchronous `close()`.

Connection flow:

1. Agent and client register over encrypted, newline-framed control sockets on
   the shared relay port.
2. A local client connection requests a tunnel over its control session.
3. The server issues a random, expiring, single-use ticket to the matching
   client and agent sessions.
4. Client and agent open independent data connections to the same relay port;
   the agent also connects to its target.
5. The server validates and consumes the ticket, pairs both sockets, and then
   passes payload bytes through unchanged.

The first encrypted data-handshake decoder must preserve any payload bytes
received in the same TCP chunk.

## Development

- Node.js 24+, no build step, and no runtime dependencies.
- CLI processes load `.env` by default or the file in their first argument.
- Supported variables and defaults are in `example.env` and `config.js`.

Run before handing off changes:

```sh
npm run check
npm test
npm run test:coverage
```

Tests use `node:test`. The E2E suite starts the real server, two agents, six
clients, and parallel binary streams. CI runs checks and coverage on Ubuntu and
Windows.

## Important constraints

- Add a regression test before changing observable behavior.
- Payload data is plaintext. Do not add reversible masking; use SSH, TLS, or
  another end-to-end encrypted protocol when confidentiality matters.
- Control and data-handshake frames use ChaCha20-Poly1305 with a fresh nonce.
  `N_T_CRYPT_IV` does not exist.
- The shared key defines one trust domain. Names choose routes; they are not
  separate credentials. Known limitations are tracked in `SECURITY.md`.
- The client listener does not explicitly bind to loopback.
- Preserve server cleanup: expire/cancel pending tickets, remove empty groups,
  close paired and unmatched sockets, and allow only one agent per name.
- Reconnects must create fresh sockets and decoders. Backoff is exponential,
  capped, and jittered.
- Established sockets use TCP keepalive with a 30-second initial idle delay.
- `SIGINT` and `SIGTERM` stop listeners, allow bounded draining, then destroy
  remaining sockets.
- Increment `PROTOCOL_VERSION` only for wire-incompatible changes to messages,
  framing, handshakes, or semantics.
