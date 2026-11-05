# Benchmarking

The benchmark measures sustained tunnel traffic and recovery under concurrent,
interactive-shaped load. Every frame crosses the real client, relay, agent, and
echo target and is verified byte-for-byte. It does not emulate SSH, RDP, packet
loss, or Internet conditions.

## Presets

| Preset       | Topology                                              | Purpose                               |
| ------------ | ----------------------------------------------------- | ------------------------------------- |
| `tiny`       | 1 route, 1 client, 1 measured second                  | Fast correctness check used by tests. |
| `default`    | 3 agents, 4 clients each, 60 measured seconds         | Sustained 12-session comparison.      |
| `resilience` | `default` plus a 2-second relay restart at 30 seconds | Disconnect and recovery measurement.  |

Each default or resilience session sends a deterministic frame every five
milliseconds, cycling through 256 B, 1 KiB, 4 KiB, 16 KiB, and 64 KiB payloads.
An eight-frame in-flight limit bounds memory. When scheduling keeps up, the
scenario offers roughly 40 MiB/s in each direction and moves about 4.7 GiB in
one measured minute.

## Running

The default command uses the safe `tiny` preset:

```sh
npm run benchmark
```

Run sustained and outage scenarios explicitly:

```sh
npm run benchmark -- --preset default --implementation tcp-single-port
npm run benchmark -- --preset resilience --implementation tcp-single-port
```

Available options:

```text
--preset <tiny|default|resilience>
--implementation <label>
--output <json-path>
--startup-timeout-ms <milliseconds>
```

Use an implementation label that identifies the code or runtime under test,
such as `tcp-before-refactor` or `tcp-node-26`.

## What runs

Relay, agents, and clients use separate child processes, as they do in a normal
deployment. One load worker per route generates and verifies traffic; one target
worker returns it. The parent coordinates timing, faults, and results only.

CPU and memory are reported separately for tunnel processes, load workers, and
target workers. This helps identify when traffic generation—not the tunnel—is
the bottleneck.

The resilience preset stops the relay for two seconds and restarts it on the
same port. Existing streams should disconnect; logical load sessions reconnect
through normal recovery paths and resume verified traffic. This approximates a
relay or path outage, not packet loss, interface changes, or connection
migration.

## Results and comparison

Reports go to the ignored `benchmark-results/` directory unless `--output` is
provided. They contain environment and Git metadata, the complete scenario and
fingerprint, comparable metrics and definitions, per-route/session results,
process resource use, and failure diagnostics.

Compare a saved baseline with a candidate:

```sh
npm run benchmark:compare -- \
  benchmark-results/tcp-node24-default.json \
  benchmark-results/tcp-node26-default.json
```

Reports must be passed schema-v2 runs with matching scenario fingerprints and
metric definitions. The comparator shows values, percentage changes, metric
direction, and environment warnings. Direction does not establish statistical
significance.

For useful comparisons:

- keep the machine, power mode, background load, scenario, and runtime flags
  consistent;
- save complete JSON reports;
- treat integrity errors or unrecovered sessions as failures; and
- repeat close results because local scheduling noise can dominate small
  latency changes.

Loopback results measure implementation overhead and recovery logic. They do
not predict behavior under Internet latency, loss, filtering, or VPS limits.
