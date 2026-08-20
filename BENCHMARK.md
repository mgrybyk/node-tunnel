# Benchmarking

The benchmark measures sustained tunnel-channel quality under simultaneous,
interactive/proxy-shaped traffic. It is not a collection of isolated transport
microbenchmarks and it does not attempt to implement the SSH or RDP protocols.

Every payload frame travels through the real server, client, and agent and is
verified byte-for-byte after the agent-side target returns it.

## Scenarios

There are exactly three presets:

| Preset | Topology and duration | Purpose |
| --- | --- | --- |
| `tiny` | One route, one client, one measured second | Fast correctness check used during development and automated tests. |
| `default` | Three agents, four clients per agent, 12 simultaneous sessions for 60 measured seconds | Main sustained channel-quality comparison. |
| `resilience` | The default scenario plus a two-second relay restart at 30 seconds | Measures disconnects, reconnection, recovery time, and post-outage traffic. |

The default and resilience topology is:

```text
client-1-1 ─┐
client-1-2 ─┼─ server ─ agent-1 ─ target-1
client-1-3 ─┤
client-1-4 ─┘

client-2-1 ─┐
client-2-2 ─┼─ server ─ agent-2 ─ target-2
client-2-3 ─┤
client-2-4 ─┘

client-3-1 ─┐
client-3-2 ─┼─ server ─ agent-3 ─ target-3
client-3-3 ─┤
client-3-4 ─┘
```

All 12 client sessions remain open and active simultaneously. Each sends one
deterministic frame every five milliseconds, cycling through 256 B, 1 KiB,
4 KiB, 16 KiB, and 64 KiB payloads with a bounded eight-frame in-flight window.
The returned frames provide exact integrity checks and round-trip latency.
If scheduling and backpressure keep up, this offers roughly 40 MiB/s in each
direction and moves about 4.7 GiB through the channel during the measured minute.

## Running

The safe default is the tiny correctness run:

```sh
npm run benchmark
```

Run the main one-minute scenario manually:

```sh
npm run benchmark -- --preset default
```

Run the outage/recovery scenario manually:

```sh
npm run benchmark -- --preset resilience
```

Useful output options are intentionally limited:

```text
--preset <tiny|default|resilience>
--implementation <label>
--output <json-path>
--startup-timeout-ms <milliseconds>
```

Use `--implementation` for a meaningful transport or code label, for example
`tcp-before-refactor`, `tcp-node-26`, or `quic-node-26`.

## Traffic-process isolation

The relay server, every agent, and every client run in separate child processes,
matching their normal independent event loops. Payload work is also kept out of
the benchmark orchestrator:

- one load worker per route drives and verifies its four client sessions;
- one target worker per route returns agent-side traffic;
- the parent process only coordinates timing, faults, and result aggregation.

Load and target worker CPU/RSS are reported separately from server, agent, and
client resource use. This makes it visible if the traffic generator, rather
than the tunnel, becomes the limiting component.

## Resilience semantics

The resilience preset deliberately stops the relay, leaves it unavailable for
two seconds, and restarts it on the same ports. Existing TCP data sessions are
expected to disconnect. The logical load sessions reconnect through the normal
client and agent recovery paths and continue sending validated frames.

This is a deterministic relay/path-outage approximation. It is not packet-loss
emulation and does not claim to reproduce an operating-system network-interface
change or QUIC connection migration. Those require privileged network tooling
or a substantially more complex transport proxy.

## JSON results and later comparison

Reports are written under the ignored `benchmark-results/` directory unless an
explicit `--output` is supplied. Preserve any baseline that you intend to use
for comparisons.

Each report contains:

- runtime, platform, Git revision, dirty state, and implementation label;
- the complete scenario plus a scenario fingerprint;
- a flat `metrics` object intended for side-by-side comparison;
- `metricDefinitions` with units and whether higher or lower is better;
- aggregate, per-route, and per-session traffic and latency results;
- separate server, agent, client, load-worker, and target-worker CPU/RSS;
- outage and recovery data for the resilience scenario;
- diagnostics and partial results when a run fails.

Compare two saved reports with the older/baseline file first and the new
candidate second:

```sh
npm run benchmark:compare -- \
  benchmark-results/tcp-node24-default.json \
  benchmark-results/tcp-node26-default.json
```

The comparator requires passed schema-v2 sustained-channel reports with the
same scenario fingerprint and metric definitions. It prints baseline and
candidate values, percentage change, and `better`, `worse`, `unchanged`, or
`unavailable` according to each metric's direction metadata. Differences in
machine, OS, runtime flags, or dirty Git state are shown as warnings. Direction
does not imply statistical significance, so repeat runs when changes are small.

## Comparison discipline

- Keep the machine, power mode, background load, scenario fingerprint, and
  runtime flags consistent.
- Save the complete JSON rather than only copying the printed summary.
- Treat any integrity error or unrecovered session as a failed run.
- Compare several runs when differences are small; local scheduling noise can
  dominate sub-millisecond latency changes.
- Loopback measures implementation overhead and recovery logic. It does not
  establish behavior under real Internet RTT, loss, UDP filtering, or VPS
  resource limits.
