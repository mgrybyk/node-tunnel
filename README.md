<div align="center">

# node-tunnel

**Reach private TCP services through your own public relay.**

[![CI](https://github.com/mgrybyk/node-tunnel/actions/workflows/ci.yml/badge.svg)](https://github.com/mgrybyk/node-tunnel/actions/workflows/ci.yml)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-7c3aed.svg)](LICENSE)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime_dependencies-0-06b6d4.svg)](package.json)

</div>

`node-tunnel` is a small, self-hosted reverse TCP tunnel. Run a server on a
public host, an agent beside the private service, and a client wherever you
want to use it. SSH, RDP, databases, HTTP, and other TCP protocols all work
through the same three-process setup.

- **Self-hosted** — the relay runs on infrastructure you control.
- **NAT-friendly** — the agent and client connect out to the public server.
- **Dependency-free at runtime** — built entirely on Node.js core modules.
- **Resilient** — reconnect backoff, TCP keepalive, and graceful shutdown are
  built in.

## How it works

Here is the common SSH setup: device 1 is private, the relay is in the cloud,
and port `8000` on device 2 becomes a route to port `22` on device 1.

```mermaid
flowchart LR
    user["You on device 2<br/>ssh user@localhost -p 8000"]
    client["Client<br/>localhost:8000"]
    server(("Server<br/>public cloud"))
    agent["Agent<br/>device 1"]
    ssh["SSH service<br/>localhost:22"]

    user --> client
    client <--> server
    server <--> agent
    agent --> ssh
```

The public server pairs the client and agent sockets and relays the bytes. It
does not need a direct connection to device 1; the agent opens that side of the
route from inside the private network.

> [!WARNING]
> Tunnel payloads pass through the public server as plaintext. Control and
> data-handshake messages are authenticated and encrypted, but application
> traffic is not. Use an end-to-end encrypted protocol such as SSH or TLS for
> sensitive traffic. See [Security](#security) for the complete trust model.

## Quick start: tunnel SSH

You need Node.js 24 or newer on all three hosts. Clone and install the project
on each one:

```sh
git clone https://github.com/mgrybyk/node-tunnel.git
cd node-tunnel
npm ci
```

Generate a private 32-character key once, then use the result in every config:

```sh
openssl rand -hex 16
```

### 1. Start the server in the cloud

Create `server.env` on the public host:

```dotenv
N_T_CRYPT_KEY=<same-32-character-key>
N_T_SERVER_PORT=32121
N_T_SERVER_PORTS_FROM=32131
N_T_SERVER_PORTS_TO=32141
```

Allow inbound TCP traffic to the control port (`32121`) and the full data-port
range (`32131–32141`), then start the relay:

```sh
npm run start:server -- server.env
```

### 2. Start the agent on device 1

Create `agent.env` beside the private SSH service:

```dotenv
N_T_CRYPT_KEY=<same-32-character-key>
N_T_SERVER_HOST=relay.example.com
N_T_SERVER_PORT=32121

N_T_AGENT_NAME=my-ssh
N_T_AGENT_DATA_HOST=localhost
N_T_AGENT_DATA_PORT=22
```

```sh
npm run start:agent -- agent.env
```

The target can also be another host reachable from device 1; set
`N_T_AGENT_DATA_HOST` accordingly.

### 3. Start the client on device 2

Create `client.env` where you want the local SSH entry point:

```dotenv
N_T_CRYPT_KEY=<same-32-character-key>
N_T_SERVER_HOST=relay.example.com
N_T_SERVER_PORT=32121

N_T_CLIENT_NAME=my-ssh
N_T_CLIENT_PORT=8000
```

```sh
npm run start:client -- client.env
```

The client and agent names must match. Now connect on device 2:

```sh
ssh user@localhost -p 8000
```

If your SSH config names that local endpoint `server`, the equivalent command
is `ssh server -p 8000`.

The same pattern works for any TCP service: change the agent target port, the
client's local port, and the route name.

## Deployment notes

- One server can host multiple named routes. Each route uses one port from the
  server's data-port range and accepts one agent plus multiple clients.
- Route names select a target; they are not credentials. Anyone with the shared
  key belongs to the same trust domain and must be trusted with every route.
- The client listener does not explicitly bind to loopback. Use host firewall
  rules to prevent unwanted access to `N_T_CLIENT_PORT` from other machines.
- Server, agent, and client must use the same protocol version. Incompatible
  peers log an error and exit.

<details>
<summary><strong>Reliability and lifecycle settings</strong></summary>

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

</details>

## JavaScript API

Imports have no side effects. Each entry point exposes a lifecycle factory:

```js
const { createServer } = require('node-tunnel')

const server = createServer(options)
await server.start()
await server.close()
```

| Entry point | Export |
| --- | --- |
| `node-tunnel` | `createServer` |
| `node-tunnel/agent` | `createAgent` |
| `node-tunnel/client` | `createClient` |
| `node-tunnel/config` | Environment-backed config builders |

## Security

This project is still a prototype and should not be exposed to untrusted
networks without additional protection. [SECURITY.md](SECURITY.md) documents
the plaintext payload path, shared-key trust domain, replay limitation, client
listener exposure, and deferred denial-of-service hardening.

## Development

```sh
npm run check
npm test
npm run test:coverage
```

The end-to-end suite starts a real server, two agents, and six clients. It
exercises 72 binary streams over three traffic waves, with 24 streams active in
parallel per wave and roughly 158 MiB transferred. CI runs checks and coverage
on Ubuntu and Windows.

For a release, also run `npm pack --dry-run`, update `CHANGELOG.md`, and bump
`PROTOCOL_VERSION` only when messages, framing, handshakes, or other wire
semantics become incompatible.
