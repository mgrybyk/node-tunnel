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
- Authenticated control and data messages do not have replay protection. An
  attacker who captures a valid encrypted handshake may replay it without
  knowing the shared key. A future protocol version can address this with
  server-issued, single-use stream tickets; this is intentionally deferred
  because it changes the connection flow and wire protocol.

## Deferred issues

- Public control and data listeners do not yet have comprehensive connection,
  rate, or memory limits for denial-of-service resistance.

Do not treat this document as a security guarantee or completed audit.
