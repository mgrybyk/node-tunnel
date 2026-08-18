# node-tunnel

A lightweight TCP tunnel for exposing a service behind NAT through a public
relay server. It can forward SSH, RDP, proxies, and other TCP protocols.

![Client, server, and agent topology](https://raw.githubusercontent.com/mgrybyk/node-tunnel/refs/heads/images-only/imgs/client-server-agent.png)

> [!WARNING]
> Tunnel payloads are plaintext between the client, public server, and agent.
> Control and data-handshake messages are authenticated and encrypted. Use SSH,
> TLS, or another end-to-end encrypted protocol for sensitive traffic.

## Requirements

- Node.js 24 LTS or newer
- npm

```sh
git clone https://github.com/mgrybyk/node-tunnel.git
cd node-tunnel
npm ci
```

## Configuration

Each process loads `.env` by default. Start from [.env-example](.env-example)
and use the same 32-byte `N_T_CRYPT_KEY` on the server, agents, and clients.
Generate a private key; do not reuse the example below in a real deployment.

### Server

Run this on a host with a public IP:

```dotenv
N_T_CRYPT_KEY=0123456789abcdef0123456789abcdef
N_T_SERVER_PORT=32121
N_T_SERVER_PORTS_FROM=32131
N_T_SERVER_PORTS_TO=32141
```

The control port and the complete data-port range must accept connections from
the agent and clients.

### Agent

Run this near the private service:

```dotenv
N_T_CRYPT_KEY=0123456789abcdef0123456789abcdef
N_T_SERVER_HOST=server.example.com
N_T_SERVER_PORT=32121

N_T_AGENT_NAME=my-ssh
N_T_AGENT_DATA_HOST=localhost
N_T_AGENT_DATA_PORT=22
```

`N_T_AGENT_DATA_HOST` may name another machine reachable from the agent.

### Client

Run this where the user connects:

```dotenv
N_T_CRYPT_KEY=0123456789abcdef0123456789abcdef
N_T_SERVER_HOST=server.example.com
N_T_SERVER_PORT=32121

N_T_CLIENT_NAME=my-ssh
N_T_CLIENT_PORT=1112
```

The client and agent names must match. Connect the application to
`localhost:1112`.

The client listener does not explicitly bind to loopback and may be reachable
through other interfaces. Use host firewall rules to prevent unwanted access.

Names select routes; they are not independent credentials. Anyone with the
shared key must be trusted to access every configured target.

## Running

Start each role in a separate terminal or on its respective host:

```sh
npm run start:server
npm run start:agent
npm run start:client
```

To load another file, pass it after `--`:

```sh
npm run start:server -- production.env
```

## Reliability settings

```dotenv
N_T_RECONNECT_DELAY_MS=5000
N_T_RECONNECT_MAX_DELAY_MS=30000
N_T_RECONNECT_JITTER_PERCENT=20
N_T_HANDSHAKE_TIMEOUT_MS=10000
N_T_CONTROL_IDLE_TIMEOUT_MS=45000
N_T_SHUTDOWN_TIMEOUT_MS=5000
```

Reconnects use capped exponential backoff with jitter. Established control and
tunnel sockets enable TCP keepalive after 30 seconds of inactivity; the OS
controls later probes. On `SIGINT` or `SIGTERM`, processes stop accepting work,
allow active streams a bounded drain period, and then close remaining sockets.

## Protocol compatibility

Server, agents, and clients must use the same protocol version. A mismatched
agent or client logs an error and exits. Legacy unframed peers are closed after
the handshake timeout.

## Tests

```sh
npm run check
npm test
npm run test:coverage
```

The E2E test starts a real server, two agents, and six clients. It verifies 72
binary streams over three traffic waves, with 24 streams active in parallel per
wave and roughly 158 MiB transferred. Coverage includes spawned processes and
is enforced per runtime file. CI runs the same checks on Ubuntu and Windows.

## JavaScript API

Entry points are safe to import and expose lifecycle factories:

```js
const { createServer } = require('node-tunnel')

const server = createServer(options)
await server.start()
await server.close()
```

`node-tunnel/agent` exports `createAgent`, `node-tunnel/client` exports
`createClient`, and `node-tunnel/config` exports the environment-backed config
builders.

## Security

See [SECURITY.md](SECURITY.md) for the current trust model and known
limitations.

## Release checklist

Run `npm ci`, `npm run check`, `npm run test:coverage`, and
`npm pack --dry-run`; then update `CHANGELOG.md` and the package version. Bump
`PROTOCOL_VERSION` only for wire-incompatible changes.
