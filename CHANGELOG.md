# Changelog

## 0.2.0

### Breaking changes

- Upgraded the wire protocol to version 4. Servers, agents, and clients must be
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

- Reworked almost the entire project: networking reliability, lifecycle handling, configuration, tests, CI, dependencies, and documentation.
- Introduced protocol version 3 with one shared relay TCP port and expiring,
  single-use tunnel tickets; older servers, agents, and clients are incompatible.
