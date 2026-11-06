# Configuration

Pass an environment file after the command:

```sh
npm run relay -- relay.env
npm run agent -- agent.env
npm run client -- client.env
```

An explicitly named file must exist. Without a file argument, `.env` is loaded
when present; otherwise, values come from the process environment.

## Required setting

| Variable        | Used by | Description                                                        |
| --------------- | ------- | ------------------------------------------------------------------ |
| `N_T_CRYPT_KEY` | all     | Shared key containing exactly 32 UTF-8 bytes. There is no default. |

Generate a key with `openssl rand -hex 16`. All peers must use the same key.

## Relay and route settings

| Variable               | Used by       | Default     | Description                                                    |
| ---------------------- | ------------- | ----------- | -------------------------------------------------------------- |
| `N_T_RELAY_HOST`       | agent, client | `127.0.0.1` | Relay hostname or address.                                     |
| `N_T_RELAY_BIND_HOST`  | relay         | `0.0.0.0`   | Relay listen address. Use `127.0.0.1` behind a local proxy.    |
| `N_T_RELAY_PORT`       | all           | `1337`      | Relay listen or connection port.                               |
| `N_T_USE_TLS`          | agent, client | `false`     | Use TLS when connecting to the relay endpoint.                 |
| `N_T_AGENT_NAME`       | agent         | `dbg`       | Route name, at most 128 characters.                            |
| `N_T_AGENT_DATA_HOST`  | agent         | `localhost` | Target service hostname or address.                            |
| `N_T_AGENT_DATA_PORTS` | agent         | `8888`      | Target port, ordered list, or inclusive ranges.                |
| `N_T_CLIENT_NAME`      | client        | `dbg`       | Route name; must match the agent name.                         |
| `N_T_CLIENT_BIND_HOST` | client        | `127.0.0.1` | Local listen address. Use `0.0.0.0` only to serve other hosts. |
| `N_T_CLIENT_PORTS`     | client        | `8000`      | Local port, ordered list, or inclusive ranges.                 |

## Port lists and ranges

Use `N_T_AGENT_DATA_PORTS` and `N_T_CLIENT_PORTS` for a single TCP port or
multiple ports through one agent and one relay endpoint:

```sh
# Agent environment
N_T_AGENT_DATA_PORTS=8888,8800-8810,9000

# Client environment
N_T_CLIENT_PORTS=7777,5550-5560
```

Lists expand in the order written and map by position: `7777` forwards to
`8888`, and `5550-5560` forwards to `8800-8810`. The agent's `9000` is unused.
Ranges include both endpoints. Spaces around entries and hyphens are allowed.
Each client and agent may configure at most 32 ports after expanding ranges.
Ports must be between 1 and 65535; descending ranges, duplicate ports, and
overlapping ranges are rejected. For example, `8888,8800-8900` is invalid
because it includes `8888` twice.

A client can use only the first N agent ports. It cannot skip entries or
request arbitrary destination ports. Multiple clients can use the same agent
ports; mappings do not reserve them exclusively. All targets use
`N_T_AGENT_DATA_HOST`, and all client listeners use `N_T_CLIENT_BIND_HOST`.

If a client defines more ports than the agent, pairing fails with a fatal
configuration error. This is also checked when an agent reconnects or is
replaced. If the agent is offline, the client waits until it becomes available
before checking compatibility. If any client port cannot be bound, startup
fails and releases the listeners it already opened.

Use the plural variable names even for a single port, such as
`N_T_CLIENT_PORTS=8000`. This feature uses protocol version 9; update the relay,
agent, and client together.

## Reliability and logging

Most deployments can keep these defaults.

| Variable                       | Used by       | Default                      | Description                                                |
| ------------------------------ | ------------- | ---------------------------- | ---------------------------------------------------------- |
| `N_T_RECONNECT_DELAY_MS`       | agent, client | `4000`                       | Initial reconnect delay.                                   |
| `N_T_RECONNECT_MAX_DELAY_MS`   | agent, client | `30000` or the initial delay | Maximum exponential backoff before jitter.                 |
| `N_T_RECONNECT_JITTER_PERCENT` | agent, client | `10`                         | Random variation around reconnect delays; `0` disables it. |
| `N_T_HANDSHAKE_TIMEOUT_MS`     | all           | `5000`                       | Deadline for registration and tunnel setup.                |
| `N_T_CONTROL_IDLE_TIMEOUT_MS`  | relay         | `15000`                      | Close a control connection after this idle period.         |
| `N_T_HEARTBEAT_INTERVAL_MS`    | agent, client | `2000`                       | Time between control-connection pings.                     |
| `N_T_HEARTBEAT_TIMEOUT_MS`     | agent, client | `7000`                       | Time to wait for a pong before reconnecting.               |
| `N_T_SHUTDOWN_TIMEOUT_MS`      | all           | `2000`                       | Time allowed for active streams to drain.                  |
| `N_T_LOG_DEBUG`                | all           | `false`                      | Emit connection and tunnel trace events.                   |
| `N_T_LOG_ERROR`                | all           | `false`                      | Emit error logs.                                           |

Set the relay idle timeout above the peer heartbeat interval. Most deployments
should keep the defaults.

With the default heartbeat settings, peers typically detect a silently broken
control connection within 7–9 seconds, then wait for the configured reconnect
delay before trying again. Increase the pong timeout on paths that regularly
stall for more than 7 seconds. Explicit environment or API settings override
these defaults.

## JavaScript API

Imports have no side effects. Each entry point exports a lifecycle factory:

```js
const { createRelay } = require('node-tunnel')

const relay = createRelay(options)
await relay.start()
await relay.close()
```

| Entry point          | Export                                                |
| -------------------- | ----------------------------------------------------- |
| `node-tunnel`        | `createRelay`                                         |
| `node-tunnel/agent`  | `createAgent`                                         |
| `node-tunnel/client` | `createClient`                                        |
| `node-tunnel/config` | `getRelayConfig`, `getAgentConfig`, `getClientConfig` |

Config builders read the environment when called. Factories capture the
control key and logging settings when created. Supply `cryptKey`, `logDebug`,
or `logError` in the options to override their environment values. This allows
applications in one process to use independent keys and logging settings.

Supply an ordered `localPorts` array to `createClient` or an ordered
`targetPorts` array to `createAgent`, including for a single port (for example,
`localPorts: [8000]`). Config builders always return port arrays.
