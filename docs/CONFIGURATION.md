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
| `N_T_AGENT_DATA_PORT`  | agent         | `8888`      | Target service port.                                           |
| `N_T_CLIENT_NAME`      | client        | `dbg`       | Route name; must match the agent name.                         |
| `N_T_CLIENT_BIND_HOST` | client        | `127.0.0.1` | Local listen address. Use `0.0.0.0` only to serve other hosts. |
| `N_T_CLIENT_PORT`      | client        | `8000`      | Local listen port.                                             |

## Reliability and logging

Most deployments can keep these defaults.

| Variable                       | Used by       | Default                      | Description                                                |
| ------------------------------ | ------------- | ---------------------------- | ---------------------------------------------------------- |
| `N_T_RECONNECT_DELAY_MS`       | agent, client | `4000`                       | Initial reconnect delay.                                   |
| `N_T_RECONNECT_MAX_DELAY_MS`   | agent, client | `30000` or the initial delay | Maximum exponential backoff before jitter.                 |
| `N_T_RECONNECT_JITTER_PERCENT` | agent, client | `10`                         | Random variation around reconnect delays; `0` disables it. |
| `N_T_HANDSHAKE_TIMEOUT_MS`     | all           | `3000`                       | Deadline for registration and tunnel setup.                |
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
