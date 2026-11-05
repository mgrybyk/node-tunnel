# Changelog

## Unreleased

### Changed

- Require a configured 32-byte control key; remove the built-in fallback key.
  Explicitly requested environment files must exist. An absent implicit `.env`
  remains optional when configuration is supplied through the environment.
- Capture encryption and logging settings per application at factory creation,
  allowing independent keys and diagnostics in one process without import-order
  dependence. API options accept `cryptKey`, `logDebug`, and `logError`.
- Keep client control connections registered while their agent is offline, and
  update readiness when the agent returns instead of reconnecting every client.
- Share frame parsing and copy fragmented frames once instead of repeatedly
  copying and scanning their accumulated contents. Wire encoding is unchanged.
- Share data-setup cleanup, remove the redundant target-connect deadline and
  duplicate cancellations, and use boolean heartbeat messages.
- Await listener closure during shutdown instead of delaying an event-loop turn.

### Fixed

- Reject invalid route names, peer identifiers, and non-boolean data readiness
  before they can advance connection setup.
- Reject agent startup while shutdown is already in progress.

## 0.7.0

### Breaking changes

- Upgraded the wire protocol to version 7. Relay, agent, and client must be
  upgraded together; peers using earlier protocol versions are rejected.

### Fixed

- Keep rejected relay sockets tracked and bounded by the handshake deadline
  until they close, including during forced shutdown.
- Enforce control-frame size limits consistently across complete and fragmented
  frames without counting raw tunnel payload bytes.
- Share concurrent relay/client startup attempts and wait for startup during
  shutdown, while allowing retries after startup failures.
- Reconnect registered control sessions when relay pongs stop arriving, and
  close idle relay control sockets when their configured timeout expires.
- Treat backpressured control writes as successfully queued messages instead
  of cancelling valid tunnel requests.
- Destroy unpaired local/data sockets after setup failures so half-open peers
  cannot keep failed tunnels alive.
- Include the relay connection helper in the published package.

### Changed

- Replace the unused generic byte-channel implementation with a native socket
  bridge for TCP and TLS, preserving backpressure and half-close behavior.
- Share agent/client data-readiness handling and use one relay pairing deadline
  per pending ticket.
- Simplify relay routes to one agent and a client map, and remove unused utility
  exports, tunnel metadata, and socket properties.

### Added

- Opt-in socket diagnostics with timestamps, connection phases, TLS metadata,
  byte totals at socket close, and setup timeout reasons.
- Configurable peer heartbeat intervals and pong deadlines.

## 0.6.0

### Changed

- Control sessions now become connected only after the relay confirms
  registration, rather than immediately after TCP or TLS setup.
- Control and data readiness use fixed application-level deadlines so proxy
  traffic cannot keep stalled handshakes alive indefinitely.
- Both data peers now wait for relay readiness before forwarding application
  bytes. This updates the wire protocol to version 6.

## 0.5.0

### Breaking changes

- `server` renamed to `relay`

### Added

- Added TLS support for agents and clients connecting through an HAProxy TLS
  endpoint. See [Deployment](docs/DEPLOYMENT.md).

## 0.2.0

### Breaking changes

- Upgraded the wire protocol to version 4. Relays, agents, and clients must be
  upgraded together; peers of protocol versions below 4 are not compatible.
- Replaced the per-agent public data-port range with one shared TCP relay port.
  `N_T_SERVER_PORTS_FROM` and `N_T_SERVER_PORTS_TO` were removed; deployments
  now expose only `N_T_SERVER_PORT`.

### Added

- Added expiring, single-use tunnel tickets that bind client and agent data
  connections before the relay pairs them on the shared port.
- Added byte-channel, peer-session, and TCP data-transport abstractions in
  preparation for alternative transports.

### Changed

- Refactored server, agent, and client networking responsibilities while
  retaining the existing `createServer`, `createAgent`, and `createClient`
  lifecycle APIs.
- Strengthened tunnel cleanup across ticket expiry, cancellation, reconnects,
  agent-session replacement, and shutdown.
- Expanded architecture, benchmark, deployment, and security documentation for
  the single-port design.

### Fixed

- Preserved payload bytes received with, or immediately after, a data
  connection preface while the matching tunnel peer is still connecting.
- Rejected duplicate and replayed data-ticket connections.

## 0.1.0

- Reworked networking reliability, lifecycle handling, configuration, tests,
  CI, dependencies, and documentation.
- Introduced protocol version 3 with one shared relay TCP port and expiring,
  single-use tunnel tickets; older servers, agents, and clients are incompatible.
