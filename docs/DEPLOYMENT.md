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

Peers reconnect with capped exponential backoff and jitter. With the defaults,
the first four-second delay varies from 3.6 to 4.4 seconds and grows to a
30-second base. Set `N_T_RECONNECT_JITTER_PERCENT=0` only when deterministic
timing is required.

`N_T_HANDSHAKE_TIMEOUT_MS` is a fixed deadline for control registration and
tunnel readiness. Traffic does not extend it. Registered peers send periodic
pings; a missing pong for `N_T_HEARTBEAT_TIMEOUT_MS` causes a reconnect. Active
data streams have no application-level idle timeout.

When an agent disconnects, its clients remain registered but reject new local
connections until an agent with the same route returns. Pending setups and the
disconnected agent's streams close. On `SIGINT` or `SIGTERM`, processes stop
accepting work, allow streams to drain for `N_T_SHUTDOWN_TIMEOUT_MS`, and then
close remaining sockets.

Established sockets enable TCP keepalive after 30 seconds of inactivity. The
operating system controls later probes.

## Diagnosing connection stalls

Temporarily enable diagnostics on the affected peer and, when possible, on all
three processes:

```dotenv
N_T_LOG_DEBUG=true
N_T_LOG_ERROR=true
```

Restart after changing these values. Logs cover connection setup, registration,
readiness, timeouts, reconnects, pairing, and socket-close byte totals. They do
not include payloads, keys, or raw tunnel tickets.

A hashed `tunnelRef` identifies one tunnel across processes. On the relay, use
`data-accepted`, `waiting-for-peer`, `paired-ready-queued`, and
`pending-cancelled` events to find the setup phase that failed. Return both
logging settings to `false` after collecting the reproduction.

The sample HAProxy configuration limits each source IP to 32 simultaneous
connections and 32 new connections per 10 seconds. Users behind one proxy or
NAT share those limits. Each peer holds one control connection and opens one
additional data connection per active tunnel, so check HAProxy rejection logs
when failures correlate with load.
