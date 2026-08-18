# Repository guide

## Scope

`node-tunnel` is a small TCP port-forwarding prototype. It exposes a service that
lives behind NAT by connecting an agent and one or more clients through a public
server. Keep the control-plane protocol and the raw data plane separate when
reasoning about changes.

There is no build step, CLI wrapper, or application framework. Each top-level
entry point is a long-running Node.js process.

## File map

- `server.js`: public control server, dynamic data-port allocation, connection
  matching, and bidirectional socket piping.
- `agent.js`: maintains an outbound control connection to the public server and
  opens one data connection per client request. Each data connection is piped to
  `N_T_AGENT_DATA_HOST:N_T_AGENT_DATA_PORT`.
- `client.js`: listens on `N_T_CLIENT_PORT`, maintains an outbound control
  connection, and opens one server data connection per accepted local socket.
- `utils.js`: loads dotenv, owns logging helpers, validates role names, and
  implements control/handshake encryption.
- `.env-example`: all supported environment variables and development defaults.
- `test/local-remote.js`: manual smoke harness. It combines a mock agent-side
  echo service with a periodic connection to the client-side listener; it is not
  an automated test suite.
- `test/crypto.test.js`: control-message encryption regression test.
- `test/e2e.test.js`: multi-process E2E and load test using the real entry
  points, two in-process target services, two agents, and six clients.
- `config.js`: currently empty and unused.
- `README.md`: user-facing setup, deployment, and security warning.

## Intended connection flow

1. `server.js` listens on `N_T_SERVER_PORT` for long-lived agent/client control
   sockets.
2. Agent and client register an encrypted `{type, name, uuid?}` message. Control
   messages are newline-framed so multiple messages can safely share a TCP
   packet. Matching is based on the configured name.
3. The server assigns the agent one port from the inclusive
   `N_T_SERVER_PORTS_FROM..N_T_SERVER_PORTS_TO` pool and starts a dedicated TCP
   server on it.
4. The assigned port and UUID are sent over the control sockets. The client can
   now accept connections on `N_T_CLIENT_PORT`.
5. For each accepted local connection, the client opens a data socket to the
   assigned public port and sends an encrypted client/UUID handshake. The server
   notifies the agent over its control socket.
6. The agent opens a matching data socket, connects to its configured target,
   and sends an encrypted agent/UUID handshake.
7. The public server pairs the queued client and agent sockets. From that point,
   application bytes are piped unchanged in both directions. Payload data is not
   encrypted by this project.

Data sockets begin with one framed encrypted handshake. A first-message decoder
preserves any raw payload bytes coalesced after that frame, after which the
socket switches to the unframed data plane.

## Configuration and invocation

Every entry point imports `utils.js` before reading environment variables, so
dotenv loading happens as a side effect. With no argument it reads `.env`; the
first positional argument selects another dotenv file.

The supported runtime baseline is Node.js 24 or newer.

Typical development invocation is:

```sh
cp .env-example .env
npm ci
node server.js .env
node agent.js .env
node client.js .env
node test/local-remote.js .env
```

Run the four Node processes in separate terminals. The example assigns the
control port `1337`, agent data-port pool `3005..3009`, client listener `9999`,
and mock target `8888`.

The automated suite uses Node's built-in test runner through `npm test`. There is
currently no lint configuration, CI workflow, or coverage configuration. Before
behavior changes, at minimum run:

```sh
npm test
node --check server.js
node --check agent.js
node --check client.js
node --check utils.js
node --check test/local-remote.js
```

The E2E test reserves ephemeral loopback ports, spawns the actual entry points,
and cleans up every child process and socket. Each run creates 72 tunnel
connections over three waves, moves about 166 MB in both directions, and covers
single-write, fixed-chunk, and irregular rapid-write patterns. It also sends an
immediate banner from each target to exercise server-first protocols and
half-closed request streams.

## Current baseline and change hazards

- Control messages use a versioned ChaCha20-Poly1305 envelope containing a fresh
  nonce, authentication tag, and ciphertext. `N_T_CRYPT_IV` is retained as
  authenticated context, so it must still match across server, agents, and
  clients. This envelope is not compatible with the earlier untagged format.
- The README warning is literal: tunneled application payloads are plaintext
  between agent/client and the public server.
- `client.js` calls `listen(port)` without a host, so the local forwarding port
  may bind to non-loopback interfaces. Do not assume it is localhost-only.
- Names plus a shared secret are the effective authorization mechanism. There is
  no per-agent/client identity or access-control layer.
- Server state is held in the module-level `connections`, `pipes`, and `ports`
  objects/array. Disconnect and reconnection changes must preserve port release,
  paired-socket cleanup, and the single-agent-per-name rule.
- Several reconnect timers and shutdown paths keep processes alive. Automated
  tests will need explicit process/socket teardown and bounded timeouts.
- `package-lock.json` uses lockfile version 1. Expect a lockfile rewrite when the
  npm/dependency baseline is modernized.

Do not silently fix these constraints while doing unrelated work. Capture their
behavior in tests first, then make intentional compatibility or security choices.
