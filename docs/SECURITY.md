# Security

This project is still a prototype. Use TLS and appropriate network hardening
when exposing it to untrusted networks.

## Current limitations

- TLS protects traffic between peers and the public relay endpoint. With the
  recommended HAProxy setup, TLS terminates at HAProxy, so this is not
  end-to-end encryption between client and agent.
- TLS is optional. Without it, control and tunnel traffic is plaintext.
- All peers share one global control key. There is no per-peer identity, key
  revocation, or online key rotation.
- Matching names are routing identifiers, not authorization boundaries. A peer
  with the shared key can access any configured route.
- Tunnel data connections use short-lived, single-use server-issued tickets.
  Control registration does not have additional replay protection beyond the
  shared-key trust model.

## Deferred

- Denial-of-service protection is basic. HAProxy can apply connection and rate
  limits, while node-tunnel bounds pending tickets and times out unused
  connections.

This document is not a security audit or guarantee.