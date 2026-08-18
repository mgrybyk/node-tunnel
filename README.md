## node-tunnel

> Node.js TCP port-forwarding implementation

Allows you to open to forward any custom port (rdp, ssh, proxies, whatever) from machine in some private network (with no public ip) to another machine anywhere else through some server with public ip.

![](https://github.com/mgrybyk/node-tunnel/blob/images-only/imgs/client-server-agent.png?raw=true)

1. Have Node.js 24 LTS or newer and npm.
2. Clone the repository.
3. Run `npm ci`.

**WARN: data is NOT encrypted at the moment, except service messages!**

### tests

Run the automated unit and end-to-end suite with:

```sh
npm test
npm run test:coverage
```

Run all syntax, lint, and formatting checks with `npm run check`. CI runs those
checks and the coverage-gated suite on Ubuntu and Windows.

The end-to-end test starts the real server, two agents, and six clients on
loopback ports. It runs 72 tunnel connections across three traffic waves, with
24 connections active in parallel per wave, and verifies binary responses byte
for byte. No external services are required.

Coverage includes the spawned server, agent, and client processes and enforces
minimum statement, line, function, and branch thresholds.


### server

install server on machine with public ip
create your own configuration in `.env` file, example:
```
N_T_SERVER_PORT=32121
N_T_SERVER_PORTS_FROM=32131
N_T_SERVER_PORTS_TO=32141
```
NOTE: ports specified should be accessible from internet

Start it with `npm run start:server`. The agent and client equivalents are
`npm run start:agent` and `npm run start:client`. Each command loads `.env` by
default; pass a different file after `--`, for example
`npm run start:server -- production.env`.

### agent

install agent on machine you want to connect to
create your own configuration in `.env` file, example:
```
N_T_SERVER_HOST=server-with-public-ip
N_T_SERVER_PORT=32121

N_T_AGENT_NAME=test-rdp
N_T_AGENT_DATA_HOST=localhost
N_T_AGENT_DATA_PORT=3389
```
or
```
N_T_SERVER_HOST=server-with-public-ip
N_T_SERVER_PORT=32121

N_T_AGENT_NAME=test-ssh
N_T_AGENT_DATA_HOST=some-machine
N_T_AGENT_DATA_PORT=22
```
Agent names select routes; they are not separate security credentials. Access
is controlled by the shared `N_T_CRYPT_KEY`, so every peer using that key must
be trusted to access every configured target.

### client

install client on your local machine
create your own configuration in `.env` file, example:
```
N_T_SERVER_HOST=server-with-public-ip
N_T_SERVER_PORT=32121

N_T_CLIENT_NAME=test-rdp
N_T_CLIENT_PORT=1111
```
or
```
N_T_SERVER_HOST=server-with-public-ip
N_T_SERVER_PORT=32121

N_T_CLIENT_NAME=test-ssh
N_T_CLIENT_PORT=1112
```


Finally, to open rdp/ssh connection to machine where agent is installed, connect to localhost:1111 / localhost:1112 with your rdp/ssh client correspondingly


*Client port (`N_T_CLIENT_PORT`) should not be accessible from outside because everyone will access data port opened by agent! 
If you still want/need it - feel free.*


### set service messages crypt key (not data!)

```
# exactly 32 UTF-8 bytes
N_T_CRYPT_KEY=:AKJSF-238fh;LASJFBH:3rf0=;hn:EW
```

`N_T_CRYPT_KEY` must be the same for the server, all agents, and all clients.
Message nonces are generated automatically; there is no IV setting.

### protocol compatibility

The server, agents, and clients must use the same protocol version. A mismatched
new client or agent logs the version error and exits. Legacy unframed peers are
closed after the handshake timeout and cannot connect to this release.

Optional reliability settings are:

```sh
N_T_RECONNECT_DELAY_MS=5000
N_T_RECONNECT_MAX_DELAY_MS=30000
N_T_RECONNECT_JITTER_PERCENT=20
N_T_HANDSHAKE_TIMEOUT_MS=10000
N_T_CONTROL_IDLE_TIMEOUT_MS=45000
N_T_SHUTDOWN_TIMEOUT_MS=5000
```

Reconnect delays use exponential backoff capped by
`N_T_RECONNECT_MAX_DELAY_MS`; jitter reduces synchronized reconnect storms.
Every established control and tunnel socket enables kernel TCP keepalive after
30 seconds of inactivity. Further probe timing and failure detection are
controlled by the operating system.
On `SIGINT` or `SIGTERM`, each process stops accepting new work and gives active
streams up to `N_T_SHUTDOWN_TIMEOUT_MS` to finish before forcing them closed.

### JavaScript API

The entry points are safe to import and expose lifecycle factories:

```js
const { createServer } = require('node-tunnel')

const server = createServer(options)
await server.start()
await server.close()
```

`node-tunnel/agent` exports `createAgent`, and `node-tunnel/client` exports
`createClient`. Configuration objects can be built from the environment with
the helpers exported by `node-tunnel/config`.


### one more img example :)

![](https://github.com/mgrybyk/node-tunnel/blob/images-only/imgs/port-forwarding.png?raw=true)

---

**NOTE**: 

you can combine as you want server, agent, client instances. Example: you can have server and client on same machine with public ip.


*Client port (`N_T_CLIENT_PORT`) should not be accessible from outside because everyone will access data port opened by agent! 
If you still want/need it - feel free.*

---

## FAQ

**Q**: I have public IP according to my provider config, but agent can't connect to server.

**A**: Multiple issues possible, like: firewalls, your host is connected to router and no virtual server is configured for server ports, etc.

**Q**: I have multiple messages on client/agent side "Connection to server established."

**A**: Ensure every process uses the same `N_T_CRYPT_KEY` and protocol version.

## security

The remaining known security limitations are tracked in [SECURITY.md](SECURITY.md).

## release checklist

Before a release, run `npm ci`, `npm run check`, `npm run test:coverage`, and
`npm pack --dry-run`; then update `CHANGELOG.md` and the package version. Bump
`PROTOCOL_VERSION` only when server-agent-client communication is no longer
wire-compatible, such as changing required messages, framing, or handshake
semantics. Internal refactors and configuration-only changes do not require a
protocol bump.
