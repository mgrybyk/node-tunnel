# Changelog

Only user-visible changes are listed here.

## 0.8.0

### Breaking

- Wire protocol version 8 requires upgrading relay, agents, and clients
  together.
- `N_T_CRYPT_KEY` is required and must contain exactly 32 UTF-8 bytes.
- A named environment file must exist. The default `.env` remains optional.

### Configuration

- Forward multiple TCP ports with ordered lists and inclusive ranges in
  `N_T_CLIENT_PORTS` and `N_T_AGENT_DATA_PORTS`. Ports map by position; clients
  may use the first N agent ports. Each list supports up to 32 ports, with
  duplicate or overlapping ports rejected.
- The default heartbeat interval is 2 seconds and its timeout is 7 seconds.
- JavaScript applications can set `cryptKey`, `logDebug`, and `logError`
  independently.

### Reliability

- Silent control failures are usually detected within 7–9 seconds.
- Clients stay registered while their agent is offline. They become ready when
  it returns.

## 0.7.0

### Breaking

- Wire protocol version 7 requires upgrading relay, agents, and clients
  together.

### Reliability

- Peers reconnect when relay heartbeats stop.
- Stalled handshakes and incomplete tunnels close automatically.
- Backpressure no longer cancels valid tunnel requests.

### Diagnostics

- Optional socket diagnostics report connection phases, TLS details, timeouts,
  and byte totals.
- Heartbeat intervals and timeouts are configurable.

## 0.6.0

- Wire protocol version 6 requires upgrading all peers together.
- Connections become ready only after relay confirmation.
- Fixed setup deadlines prevent proxy traffic from keeping stalled handshakes
  alive.

## 0.5.0

- Renamed `server` to `relay`.
- Added TLS connections through HAProxy. See
  [Deployment](docs/DEPLOYMENT.md).

## 0.2.0

### Breaking

- Wire protocol version 4 requires upgrading all peers together.
- One relay port replaces the per-agent port range.

### Security and reliability

- Tunnel connections use expiring, single-use tickets.
- Duplicate and replayed tickets are rejected.
- Fixed data loss during tunnel setup.

## 0.1.0

- Introduced the shared-port reverse tunnel design.
