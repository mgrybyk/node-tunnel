# Deployment

Relay, agent, and client must use the same protocol version. Upgrade them
together; incompatible peers log an error and exit.

Expose the relay TCP port to agents and clients. Keep the client bound to
`127.0.0.1` unless other hosts should reach its local port.

## TLS with HAProxy

The recommended public deployment terminates TLS at HAProxy and keeps the relay
bound to localhost:

```text
Client ─TLS─> HAProxy ─TCP─> Relay
Agent  ─TLS─> HAProxy ─TCP─> Relay
```

Set `N_T_USE_TLS=true` on every agent and client. Configure certificates for
the relay domain and start with the provided [HAProxy example](haproxy.cfg).
Set `N_T_RELAY_BIND_HOST=127.0.0.1` when HAProxy and the relay share a host.

TLS protects each peer's connection to HAProxy. It is not end-to-end encryption
between client and agent; see [Security](SECURITY.md).

## Reliability

Peers detect broken connections and reconnect automatically. If an agent goes
offline, its streams close and clients reject new connections until it returns.
The defaults suit most deployments; see [Configuration](CONFIGURATION.md) for
timeout and reconnect settings.

## Diagnosing connection stalls

Temporarily enable diagnostics on the affected peer and, when possible, on all
three processes:

```dotenv
N_T_LOG_DEBUG=true
N_T_LOG_ERROR=true
```

Restart after changing these values. Logs cover setup, reconnects, pairing, and
timeouts without including payloads, keys, or raw tickets. A hashed `tunnelRef`
identifies the same tunnel across processes. Disable both settings afterward.

The sample HAProxy configuration applies per-IP connection limits. Users behind
one proxy or NAT share those limits, so check HAProxy rejection logs when
failures correlate with load.
