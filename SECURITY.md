# Security status

This project is still a prototype and should not be exposed to untrusted
networks without additional protection.

## Accepted design tradeoffs

- Tunnel payload data is plaintext between each peer and the public server. The
  control channel is authenticated and encrypted, but the application stream is
  not. Use an end-to-end encrypted application protocol such as SSH or HTTPS
  when confidentiality is required. Reversible byte masking is intentionally
  not used because it would add payload-path work without providing meaningful
  security.
- Every server, agent, and client shares one global control key. There is no
  per-peer identity, key revocation, or online key rotation mechanism. This is
  acceptable only when every peer belongs to the same trust domain; changing
  the key requires a coordinated restart.
- Matching names select routes and are not separate authorization credentials.
  Any peer with the shared key must be trusted to access every configured
  target.
- The client listener does not bind explicitly to loopback. Host firewall rules
  are currently required to prevent unintended remote access.
- Data connections require a random server-issued tunnel ticket delivered over
  the authenticated control channels. Tickets are bound to the current route
  sessions, expire, and are consumed after one client/agent pair, so replaying a
  consumed data preface is rejected. Control registration frames still lack a
  monotonic counter or equivalent replay protection; within the shared-key
  trust model, a captured registration could still interfere with a peer.

## Deferred issues

- The public relay listener does not yet have comprehensive connection or rate
  limits. Unclassified sockets and tunnel tickets are timed out, and pending
  tickets are globally bounded, but this is not complete denial-of-service
  hardening.

Do not treat this document as a security guarantee or completed audit.
