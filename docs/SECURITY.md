# Security

`node-tunnel` is still a prototype. Use TLS, restrict access to the relay, and
apply normal host and network hardening when using it outside a trusted network.

## Trust model and limitations

- All peers share one 32-byte control key. There is no per-peer identity, key
  revocation, or online rotation.
- Route names identify destinations; they do not authorize access. Any peer
  with the shared key can access any configured route.
- Control messages use authenticated encryption. Without TLS, tunnel payloads
  are plaintext.
- With the recommended HAProxy setup, TLS ends at HAProxy. Traffic is not
  end-to-end encrypted between client and agent.
- Tunnel data connections use short-lived, single-use tickets bound to current
  peer sessions. Control registration has no additional replay protection
  beyond the shared-key model.
- Denial-of-service protection is basic. The relay bounds pending tickets and
  times out unused connections; a proxy can add connection and rate limits.

See [Deployment](DEPLOYMENT.md) for the TLS topology and HAProxy example.

This document is not a security audit or guarantee.
