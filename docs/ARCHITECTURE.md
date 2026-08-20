# Architecture

`node-tunnel` connects a local client to a private target through a public relay.

```text
Client <──> Relay <──> Agent <──> Target
```

The client and agent both make outbound connections to the relay. The relay does
not connect directly to the target.

## Connections

The relay exposes a single TCP port for both control and tunnel data.

Each client and agent keeps one long-lived control connection to the relay.
Control connections are used for registration, tunnel requests, keepalive, and
ticket exchange.

Each tunnel uses two additional data connections:

```text
Client ──data──> Relay <──data── Agent ──> Target
```

When a client requests a tunnel:

1. The relay creates a random, short-lived ticket.
2. The ticket is sent to the client and agent over their control connections.
3. Both peers open a data connection to the relay using that ticket.
4. The relay validates and pairs the two connections.
5. Application bytes are then forwarded in both directions.

Tickets are single-use, expire automatically, and are bound to the current
client and agent sessions.

## TLS

Client and agent connections can use TLS.

The recommended deployment terminates TLS at HAProxy:

```text
Client ─TLS─> HAProxy ─TCP─> Relay
Agent  ─TLS─> HAProxy ─TCP─> Relay
```

HAProxy listens on the public TLS port and forwards node-tunnel traffic to the
relay on localhost.

TLS protects traffic between each peer and the public endpoint. It is not
end-to-end encryption between the client and agent.

See [SECURITY.md](SECURITY.md) for the trust model and security limitations.

## Main components

* **Relay** — registers routes, creates tunnel tickets, pairs data connections,
  and forwards traffic.
* **Agent** — registers a route and connects tunnel traffic to the private
  target.
* **Client** — exposes a local listener and requests tunnels through the relay.
* **Peer session** — manages control connections, framing, keepalive, and
  reconnects.
* **Data transport** — manages tunnel tickets, data connection matching, and
  tunnel lifecycle.
* **Byte channel** — provides transport-independent byte forwarding and
  backpressure handling.

Control and data use separate connections but share the same relay listener.
