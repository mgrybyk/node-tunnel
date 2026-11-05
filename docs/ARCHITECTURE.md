# Architecture

`node-tunnel` connects a local client to a private target through a public
relay. The client and agent make outbound connections; the relay never connects
to the target.

```text
Client <──> Relay <──> Agent <──> Target
```

## Connection flow

The relay uses one TCP port for control and tunnel data. Every client and agent
keeps one control connection for registration, tunnel requests, heartbeats, and
ticket exchange. Each active tunnel adds two data connections:

```text
Client ──data──> Relay <──data── Agent ──> Target
```

When a client requests a tunnel:

1. The relay creates a short-lived ticket and sends it to both peers.
2. Each peer opens a data connection using that ticket.
3. The relay validates and pairs the connections.
4. Both peers receive a readiness acknowledgement.
5. Application bytes flow in both directions.

Tickets are random, single-use, expiring, and bound to the current client and
agent sessions.

## Components

- **Relay** registers routes, issues tickets, and pairs data connections.
- **Agent** connects tunnel traffic to the private target.
- **Client** exposes a local listener and requests tunnels.
- **Peer session** owns control framing, heartbeats, and reconnects.
- **Data transport** owns ticket matching and tunnel lifecycle.
- **Data readiness** validates setup and replaces setup listeners with the
  socket bridge after relay acknowledgement.
- **Socket bridge** pipes TCP/TLS bytes while preserving backpressure,
  handshake remainders, and half-closes.

Each relay route has one agent and a map of clients. Replacing a control session
cancels its pending tickets; established streams survive session replacement.
An agent disconnect closes its active streams and marks clients unready. Those
clients stay registered and become ready when a replacement agent arrives.

Applications capture their control key and logging settings at creation. Module
imports do not read environment-dependent settings. Both frame decoders use one
parser that scans chunks once and copies fragmented frames only when complete.

## TLS boundary

The recommended deployment terminates TLS at HAProxy:

```text
Client ─TLS─> HAProxy ─TCP─> Relay
Agent  ─TLS─> HAProxy ─TCP─> Relay
```

This protects peer-to-proxy traffic but is not end-to-end encryption. See
[Security](SECURITY.md) and [Deployment](DEPLOYMENT.md).
