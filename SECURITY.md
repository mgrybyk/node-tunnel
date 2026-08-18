# Security status

This project is still a prototype and should not be exposed to untrusted
networks without additional protection. The items below are deliberately
deferred; they were not addressed by the reliability and test work.

## Deferred issues

- Tunnel payload data is plaintext between each peer and the public server. The
  control channel is authenticated and encrypted, but the application stream is
  not.
- Every server, agent, and client shares one global control key. There is no
  per-peer identity, key revocation, or key rotation mechanism.
- Matching names are effectively authorization tokens. A client that knows an
  agent name and the shared key can access that agent's configured target.
- The client listener does not bind explicitly to loopback. Host firewall rules
  are currently required to prevent unintended remote access.
- Public control and data listeners do not yet have comprehensive connection,
  rate, or memory limits for denial-of-service resistance.

Do not treat this document as a security guarantee or completed audit.
