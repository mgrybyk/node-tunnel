# node-tunnel: Pre-QUIC Refactor, Benchmarking, and QUIC Migration Plan

> Implementation brief for Codex in VS Code

```text
Current target architecture:
  client  ->  public relay server  ->  agent  ->  private TCP service

Immediate goal:
  benchmark current TCP
  -> refactor API/architecture without degrading performance
  -> simplify TCP to one public server port if practical
  -> benchmark again
  -> migrate transport to QUIC
  -> benchmark again
```

> Prepared from the current public repository state and prior architecture discussion. 20 Aug 2026.

# 1. Purpose

This document is an execution brief, not a speculative redesign. Codex should work through it in stages, keep the project runnable after every stage, and ask focused interactive questions only at explicit decision gates.

The primary objective is to make the current TCP implementation structurally compatible with a future QUIC transport without prematurely introducing QUIC-specific abstractions or browser-specific complexity.

- Measure the current implementation before changing it.
- Create a reusable benchmark/load harness whose correctness can be exercised by a small automated test, while real performance runs remain manual.
- Refactor transport/lifecycle boundaries while preserving TCP behavior.
- Prefer a one-public-port TCP design before QUIC if it can be implemented cleanly and without multiplexing all payloads over one TCP connection.
- Measure again after the TCP refactor.
- Introduce QUIC as a transport replacement, not as a permanent second/legacy mode.
- Measure QUIC using the same workload and result format.
- Keep the existing Node.js 24 support through the TCP stages. The later QUIC
  implementation targets Node.js 26 only and must pin the exact tested minimum
  minor version and document the required `--experimental-quic` runtime flag.
- Do not implement browser support in this work. Keep future browser usage possible where it costs little, but do not optimize around a hypothetical use case.

# 2. Current repository facts Codex should verify locally

Before editing, Codex must inspect the local checkout and confirm these points. The public repository currently shows the following:

| Area | Current behavior / implication |
| --- | --- |
| Processes | server.js, agent.js, client.js; each exposes createServer/createAgent/createClient with start()/close(). |
| Node support | package.json currently declares Node >=24. |
| Public TCP topology | Server has one control port plus a configured data-port range. |
| Agent | Receives a dataPort from the server control connection, then opens a new TCP data connection per tunnel. |
| Client | Exposes a local TCP listener and opens data connections to the relay for accepted local sockets. |
| Server | Allocates per-route data ports and pairs client/agent data sockets. |
| Wire protocol | PROTOCOL_VERSION is explicit; role types are agent/client; NO_PORTS is a protocol error. |
| Existing tests | Node test runner + c8. E2E already transfers a large amount of data, but is a correctness/reliability test rather than a controlled benchmark. |
| Security | Application payload currently passes through the relay without tunnel-level encryption; protocols such as SSH/TLS provide end-to-end encryption. |

Codex should treat the local repository as authoritative. If the local checkout differs from these facts, stop at the first decision gate and summarize the discrepancy before applying this plan.

# 3. Non-goals and constraints

- Do not keep both old TCP and new QUIC implementations as permanent user-facing modes.
- Do not introduce WebSocket fallback, HTTP tunneling, browser SSH, browser extensions, or a browser client in this task.
- Do not remove the client/server/agent logical roles merely for symmetry. Their trust boundaries remain useful.
- Do not move tunnel ingress to public per-service ports on the VPS.
- Do not create timing-sensitive performance assertions in normal CI.
- Do not call a change a performance improvement unless the benchmark demonstrates it.
- Do not claim TCP and QUIC have the same transport semantics. The pre-QUIC abstraction must tolerate that TCP uses separate connections where QUIC will eventually use streams.
- Do not convert the whole project to TypeScript/ESM or add a framework unless there is a concrete requirement and the user explicitly agrees at a decision gate.

# 4. Desired end-state architecture

The intended architectural progression is:

```text
Stage A - current TCP

client control -------\
client data sockets ---> relay server ---> agent data sockets
agent control --------/     control port + data-port range


Stage B - refactored TCP, preferred

client control -------\
client data sockets ---> ONE relay TCP listener/port ---> agent data sockets
agent control --------/

Each TCP connection starts with a small connection preface/handshake.
Payload sockets become raw byte pipes after pairing.


Stage C - QUIC

client == one QUIC connection ==> relay ==> one QUIC connection == agent
             control + multiple independent QUIC streams
```

Stage B deliberately does not multiplex all tunnel payloads over a single TCP connection. Doing so would introduce TCP head-of-line blocking across otherwise independent tunnels and would create a custom framing/flow-control layer that QUIC later makes unnecessary.

# 5. Public API direction

Preserve the high-level factories unless there is a strong reason not to. The useful refactor is to separate route/session semantics from the concrete TCP socket topology.

```text
createServer(options)
createAgent(options)
createClient(options)

lifecycle:
  await instance.start()
  await instance.close()

future-compatible internal shape:
  control/session connection
  open tunnel/data stream
  accept tunnel/data stream
  close/drain/reconnect
```

A native client may continue to expose a local TCP listener. Internally, however, local-listener handling should become an adapter over a lower-level 'open tunnel stream' operation rather than being inseparable from the transport.

Do not force a browser-compatible Web Streams API now, and do not make Node
`Duplex` the transport-neutral contract. Node TCP sockets are `Duplex` streams,
but Node 26 QUIC streams use async iteration for reads and a separate writer API.
Use a small capability boundary that expresses chunk reads, backpressured writes,
write-side close, abort/reset, and closure; adapt both transports to it.

# 6. Codex interaction contract

Codex should work autonomously between these gates and ask only compact questions that materially affect architecture.

| Gate | When to ask | Question / output expected |
| --- | --- | --- |
| G0 | After repository inspection | Report observed architecture, test commands, Node versions available, and any mismatch with this brief. Ask only if mismatch changes the plan. |
| G1 | Before benchmark implementation if workload choices are ambiguous | Propose concrete default workload(s), metrics, and runner shape. Ask for approval only if the choice materially affects later comparability. |
| G2 | Before public/internal API reshaping | Show proposed module boundaries and exported API changes in a compact diff-like outline. |
| G3 | Before removing data-port range | Explain exact single-port TCP handshake/pairing design, failure modes, and compatibility impact. |
| G4 | Before QUIC implementation | Probe the exact Node 26 runtime and current official experimental API. Show the required flag, minimum minor version, TLS configuration, stream API adapter, and a go/no-go recommendation before replacing TCP. |
| G5 | After each benchmarked stage | Show comparable measurements and call out regressions/noise. Do not rationalize regressions without evidence. |

# 7. Stage 0 - establish a clean baseline

1. Run npm ci (or the repository's normal install command).

2. Run npm run check, npm test, and npm run test:coverage.

3. Record Node version, OS, CPU model, logical core count, and relevant runtime flags.

4. Inspect server.js, client.js, agent.js, protocol.js, config.js, lifecycle.js, utils.js, test/, and test-support/.

5. Write a short architecture note in the working branch describing current control/data connection flow and which code owns port allocation/pairing.

6. Do not refactor yet.

Acceptance: all existing tests pass before benchmark work starts.

# 8. Stage 1 - build the benchmark/load harness first

The benchmark must be code, not a shell one-liner. It needs a small deterministic automated test that proves the harness works, plus a manual runner for meaningful measurements.

## 8.1 Separate correctness from performance

| Part | Purpose | CI behavior |
| --- | --- | --- |
| Benchmark engine | Reusable workload generator, byte accounting, concurrency control, timing, result aggregation. | Unit-tested with tiny data. |
| Smoke/perf-harness test | Prove spawned topology completes, bytes match, concurrency path works, and metrics are finite. | Runs in normal test suite; no speed threshold. |
| Manual benchmark runner | Runs larger workloads and emits comparable results. | Not run by normal npm test; invoked explicitly. |

## 8.2 Recommended local benchmark topology

```text
benchmark parent process
  |- relay server child
  |- 3 agent children, one per named route
  |- 12 client children, 4 per route
  |- 3 agent-side target workers
  `- 3 client-side load/verification workers

All local/loopback for repeatability.
Use real node-tunnel code paths and real sockets.
Keep payload generation and verification out of the orchestrator so its event
loop cannot become the channel bottleneck. Observe CPU and memory separately for
tunnel components and traffic workers.
```

The local benchmark is primarily a regression and implementation-comparison tool. It does not model hotel Wi-Fi, Internet RTT, loss, or VPS CPU limits. Later, the same workload format can be used manually across real hosts if desired.

## 8.3 Scenarios

| Preset | Purpose | Definition |
| --- | --- | --- |
| Tiny | Automated correctness and developer smoke test. | One route, one client, one measured second. |
| Default | Primary sustained channel-quality comparison. | Three routes, four simultaneous long-lived clients per route, 60 measured seconds. |
| Resilience | Deterministic reconnect/recovery comparison. | Default topology plus one two-second relay restart at the midpoint. |

Sessions continuously exchange deterministic, mixed-size framed data through
the real tunnel. Responses are verified byte-for-byte and provide round-trip
latency. Preserve the default and resilience definitions across later stages;
the scenario fingerprint must change if any definition changes.

## 8.4 Metrics

- Client-to-agent and agent-to-client bytes and MiB/s.
- Completed frames/second and frame completion ratio.
- Round-trip latency min/p50/p95/p99/max.
- Session completion, disconnect, reconnect, incomplete-frame, socket-error,
  and integrity-error counts.
- Recovery time for the resilience scenario.
- CPU and peak RSS grouped into server, agents, clients, load workers, and target workers.
- Node version and benchmark configuration embedded in every result.
- Result schema version, scenario fingerprint, exact Git revision and dirty
  state, runtime flags, and explicit timing boundaries.

## 8.5 Output format

Emit human-readable console output and machine-readable JSON from the same run.

```text
benchmark-results/
  default-v24.x-<timestamp>.json
  resilience-v24.x-<timestamp>.json

Example fields:
{
  "implementation": "tcp-baseline",
  "runtime": { "node": "24.x", "platform": "..." },
  "scenario": { "preset": "default", "fingerprint": "..." },
  "metrics": { "clientToAgentMiBs": ..., "rttP95Ms": ... },
  "metricDefinitions": { "rttP95Ms": { "unit": "ms", "better": "lower" } }
}
```

## 8.6 Automated benchmark-harness test

Use the tiny preset and assert correctness only: deterministic payload
validation, finite metrics, clean shutdown, and no leaked sockets/processes. A
shortened resilience test must prove relay restart and logical-session recovery.

Explicitly forbidden: assertions such as 'must exceed 100 MiB/s' or 'must finish within 200 ms' in normal unit/CI tests.

## 8.7 Stage 1 deliverable

- A reusable benchmark engine/module.
- A manual npm script such as npm run benchmark (exact naming can follow repository conventions).
- A small two-file comparator that rejects incompatible scenarios and uses the
  report's metric direction metadata for deltas.
- A tiny automated test for the benchmark harness.
- A dedicated benchmark guide, linked from README, explaining how to run a
  baseline consistently.
- Exactly tiny, default, and resilience presets; avoid a general-purpose
  workload framework.
- One manually produced default baseline result on the user's machine, generated
  by the user after Codex finishes and verifies the tiny run.
- Generated raw result files are ignored; the harness, schema, documentation,
  and a small example may be committed.

# 9. Stage 2 - refactor TCP around transport-neutral responsibilities

This stage should preserve externally observable tunnel behavior. The objective is to stop higher-level route logic from depending directly on the current data-port allocation scheme.

## 9.1 Suggested responsibility split

| Responsibility | Should know about |
| --- | --- |
| Lifecycle/reconnect | Endpoint/session state, backoff, graceful close; not route-specific port allocation. |
| Protocol/control | Versioning, endpoint role, route name, tunnel/open IDs, errors. |
| Transport adapter | How a control connection or data stream is physically opened/accepted. |
| Server router | Authenticated endpoint/route registry and pairing/routing of tunnel streams. |
| Client local listener adapter | Accept local net.Socket, request/open tunnel stream, pipe bytes. |
| Agent target connector | Accept tunnel stream, net.connect(target), pipe bytes. |

Exact filenames are intentionally not mandated. Codex should propose the minimum restructuring that makes these responsibilities explicit without creating a large abstraction hierarchy.

## 9.2 Important API seam: open/accept tunnel stream

```text
Conceptual only:

client/session:
  openTunnel(route) -> duplex byte stream

server/router:
  route/open request -> corresponding agent stream

agent/session:
  onTunnel(stream, metadata) -> connect target and pipe
```

For TCP this 'stream' may still wrap an entire TCP socket. For QUIC it will later
wrap a QUIC stream. The compatibility seam is the byte-stream capability contract,
not a shared concrete stream class.

## 9.3 Tests required before behavior changes

- Existing tests remain green.
- Add focused tests around route registration, open request, pairing, half-close, abort/error propagation, and graceful shutdown through the new seam.
- Keep protocol-version tests explicit.
- Ensure no import side effects are introduced.
- Run the Stage 1 benchmark after the pure refactor and save results as a distinct implementation label.

If performance changes materially after this pure refactor, investigate before proceeding to single-port TCP. Refactoring should not silently trade away throughput or latency.

# 10. Stage 3 - remove the TCP server data-port range

This is possible without QUIC and without multiplexing all payload traffic over one TCP connection. Treat it as an explicit product decision after Stage 2: implement it when one-port TCP is valuable as a stable deployable result or while QUIC remains experimental; it is not a mandatory technical prerequisite for QUIC. The recommended design is one TCP listening port with a short first-message discriminator on every accepted connection.

## 10.1 Proposed single-port TCP connection model

```text
All outbound connections target relay.example.com:<serverPort>

Connection 1:
  preface { kind: "control", role: "agent", name: "my-ssh", ... }
  -> remains framed control connection

Connection 2:
  preface { kind: "control", role: "client", name: "my-ssh", ... }
  -> remains framed control connection

When a local client socket arrives:
  client asks server to open tunnel, receives/uses tunnelId
  client opens NEW TCP connection to same <serverPort>
  preface { kind: "data", role: "client", tunnelId: "..." }
  -> after pairing, socket becomes raw payload

Server tells agent to open tunnelId:
  agent opens NEW TCP connection to same <serverPort>
  preface { kind: "data", role: "agent", tunnelId: "..." }
  -> after pairing, socket becomes raw payload

Server pairs the two data sockets by tunnelId and pipes them.
```

## 10.2 Why this is preferred over one multiplexed TCP connection

- Removes N_T_SERVER_PORTS_FROM / N_T_SERVER_PORTS_TO and the public firewall port range.
- Keeps one public relay TCP port.
- Preserves independent TCP congestion/retransmission behavior per tunnel.
- Avoids custom multiplexing, per-stream flow control, and cross-tunnel TCP head-of-line blocking.
- Makes the external deployment shape much closer to future QUIC: one relay endpoint.
- Keeps the QUIC migration conceptually simple: replace per-data TCP connections with QUIC streams later.

## 10.3 Protocol/security details Codex must handle

- Use a server-issued, unguessable, single-use tunnel ticket, not route name or
  independently generated peer UUIDs, to pair data sockets. Bind it to the route
  and current client/agent sessions, expire it, consume it once, and reject replay.
- Authenticate/validate the data-connection preface using the project's existing trust model; do not make the single port an unauthenticated socket-pairing oracle.
- Bound pending/unpaired data sockets with handshake timeouts and cleanup.
- Prevent tunnelId reuse/replay where practical within the existing protocol model.
- Define behavior when only one side arrives, one side disconnects early, or the agent disappears.
- Switch from framed handshake bytes to raw payload only after the preface is fully consumed; do not leak handshake bytes into application traffic.
- Preserve bytes coalesced with both data prefaces and initial control frames;
  hand control-frame remainders to the continuing framed decoder.
- Preserve half-close behavior and allowHalfOpen semantics where currently intentional.
- Remove NO_PORTS and port-range config only when no longer reachable/needed.
- Bump PROTOCOL_VERSION because this changes wire semantics.

## 10.4 Compatibility

Backward wire compatibility is not required unless the user explicitly asks for rolling upgrades. The project already requires matching protocol versions, so a clean protocol bump is preferable to carrying legacy routing branches.

## 10.5 Benchmark checkpoint

Run the same default and resilience scenarios used for the baseline. Compare
sustained directional throughput, frame rate, RTT percentiles, CPU/RSS,
disconnects, integrity, and recovery. The single-port design should not
materially reduce sustained channel quality.

# 11. Stage 4 - QUIC migration

Only start this after the TCP architecture is clean and benchmarked. QUIC should replace the TCP tunnel transport rather than coexist indefinitely as a selectable legacy/new mode.

## 11.1 Node 26 experimental-runtime decision

Stable Node 24 does not expose the current `node:quic` API. The QUIC stage targets
Node 26 only. As of this plan's validation, the API requires
`--experimental-quic` and is early-development functionality; `engines: >=26`
alone is therefore not a sufficient deployment contract.

1. Create a minimal QUIC capability probe: load API, create endpoint/session, establish loopback connection, open one bidirectional stream, exchange bytes, close cleanly.

2. Run it under the exact Node 26 minor version proposed as the minimum.

3. Record required runtime flags and stability caveats.

4. Verify CLI scripts, library-consumer instructions, TLS setup, stream resets,
   flow control, and clean shutdown with the required experimental flag.

5. Ask at Gate G4 before changing the engines field or removing TCP. Consider
   Node 26 LTS status and API stability as part of that go/no-go decision.

## 11.2 Intended QUIC topology

```text
client:
  one long-lived QUIC connection to server
    - control channel / control stream(s)
    - one bidirectional QUIC stream per tunnel

agent:
  one long-lived QUIC connection to server
    - control channel / control stream(s)
    - one bidirectional QUIC stream per tunnel

server:
  UDP endpoint, intended deployment eventually UDP/443
  authenticate/register endpoint sessions
  accept a client-initiated tunnel stream
  open the corresponding stream on the registered agent session
  retain the internal cross-session pair mapping and relay bytes
```

## 11.3 Preserve the logical API seam

Client local-listener and agent target-connector code should not need a conceptual rewrite. They should still receive/open the internal tunnel byte-stream capability. The adapters underneath bridge either TCP sockets or the Node 26 QUIC async-iterator/writer API.

## 11.4 QUIC-specific concerns to test

- Concurrent streams: loss on one stream must not cause transport-level
  head-of-line blocking in another, while recognizing that all streams still
  share connection-level congestion control, flow control, and a failure domain.
- Connection/session shutdown with active streams.
- Stream reset/abort propagation to local TCP sockets.
- Peer reconnect and what happens to pre-existing streams.
- Flow control/backpressure between Node TCP sockets and QUIC stream APIs.
- Keepalive/idle timeout behavior appropriate for a long-lived tunnel session.
- Large transfer correctness and sustained throughput.
- Many-short-stream setup cost.
- Memory growth with high stream concurrency.
- Stream-credit exhaustion and bounded pending opens.
- A dedicated/classified control stream that cannot be starved by payload flow.
- Mandatory TLS 1.3 certificate/key, SNI/hostname validation, CA or pinning
  configuration, certificate rotation, and the relationship to shared-key peer
  authentication. Do not disable certificate verification.
- Disable or reject 0-RTT tunnel opens initially because early data is replayable.
- UDP-blocked-network behavior. A QUIC-only release has no connectivity on such
  networks, so that availability tradeoff must be accepted before TCP removal.

## 11.5 What not to preserve from TCP

- Do not preserve a concept of server data ports.
- Do not open a new QUIC connection per tunnel.
- Do not expose TCP-style tickets merely to pair QUIC streams when the relay can
  accept a client stream and directly open its agent-side counterpart. The relay
  must still keep an internal mapping because stream IDs are local to each QUIC
  session.
- Do not retain TCP-specific keepalive semantics if QUIC has different session/idle mechanisms.
- Do not keep a compatibility transport switch unless temporarily needed on the development branch; remove it before the final migration is considered complete.

# 12. Performance comparison protocol

Measurements are useful only if the comparison procedure is disciplined. Codex should provide the commands and result format; the user will run the meaningful measurements manually.

| Run | Implementation | Node | Purpose |
| --- | --- | --- | --- |
| P0 | Current TCP baseline | 24 current project default | Establish reference before refactor. |
| P1 | Refactored TCP before single-port behavior change | Same Node/version as P0 | Detect abstraction/refactor regression. |
| P2 | Single-port TCP | Same Node/version as P0 | Measure effect of removing port-range topology. |
| P3 | QUIC | 26, and 24 only if supported cleanly | Compare final transport. |

## 12.1 Measurement discipline

- Use the same machine, power mode, Node binary, benchmark config, and background-load conditions for P0/P1/P2.
- Warm up once; then run each workload multiple times (recommended 5) and compare medians rather than a single best run.
- Store every raw run, not only summaries.
- For QUIC Node 26 vs TCP Node 24, clearly separate transport effect from runtime-version effect. Benchmark TCP under Node 26 as a required control.
- State that QUIC performs mandatory encryption on both relay hops while the TCP
  baseline payload is plaintext, so CPU/throughput differences are not a pure
  congestion-protocol comparison.
- Treat loopback as a regression/overhead benchmark only. Claims about RTT,
  packet loss, stream head-of-line behavior, or UDP reachability require a
  documented remote or emulated-network profile.
- Do not interpret small differences within normal run-to-run variance as improvements.
- When a regression appears, rerun the same commit/config before changing code.

## 12.2 Strongly recommended comparison matrix

```text
TCP baseline       Node 24
TCP refactored     Node 24
TCP single-port    Node 24

TCP single-port    Node 26   <- runtime control
QUIC               Node 26   <- transport comparison

```

# 13. Suggested commit/stage boundaries

1. benchmark: add reusable benchmark engine + tiny harness test + manual runner

2. refactor: isolate tunnel-stream/session responsibilities without wire change

3. test: strengthen stream/pairing/lifecycle tests around the new seam

4. protocol: move TCP control/data connections onto one server port

5. docs/config: remove data-port range and update deployment/security docs

6. benchmark: record/compare post-refactor TCP procedure (results need not be committed unless desired)

7. quic: add a minimal Node 26 experimental transport spike behind the temporary
   development comparison boundary

8. decision: compare behavior, reachability, security, runtime stability, and
   performance; only then approve final migration

9. quic: after approval, remove obsolete TCP tunnel transport, bump the protocol
   version again, and remove TCP-only configuration

10. docs: final deployment, Node version/flag, TLS, diagnostics, and benchmark instructions

Codex should keep commits buildable/testable where practical and avoid combining benchmark creation, architecture refactor, protocol rewrite, and QUIC migration into one unreviewable change.

# 14. Acceptance criteria by stage

| Stage | Done when |
| --- | --- |
| 0 Baseline | All existing checks/tests pass and current architecture is documented. |
| 1 Benchmark | Tiny automated harness test passes; manual runner completes deterministic workloads and emits JSON + readable metrics. |
| 2 Refactor | External behavior and wire protocol unchanged; tests pass; benchmark shows no unexplained material regression. |
| 3 Single-port TCP | Only one relay TCP port is required; data-port range config/code is gone; pairing/security/lifecycle tests pass; protocol version bumped; benchmark repeated. |
| 4 QUIC spike | Node 26 capability probe and temporary comparison transport work with the pinned runtime/flag; mandatory TLS and cross-session routing are tested; benchmark repeated. |
| 4 QUIC migration | Go/no-go criteria pass; QUIC wire semantics receive another protocol bump; no legacy TCP user-facing mode remains; all correctness/reliability tests are adapted. |
| Node compatibility | TCP stages retain Node 24 support; a final QUIC release uses the pinned Node 26 minimum and required experimental flag. |

# 15. Review questions Codex should surface instead of guessing

- Generated benchmark result JSON files are ignored by default; commit only a
  deliberately curated example or summary.
- Is preserving the current public JavaScript exports a hard compatibility requirement, or can a major-version-style API cleanup occur before QUIC?
- Should the single-port TCP protocol support a rolling mixed-version deployment? Default assumption: no.
- Should the client local listener explicitly bind to loopback as part of this refactor? The current README warns that it does not explicitly do so; changing this is security-relevant and should be intentional.
- Should tunnel payload encryption/authentication be revisited during QUIC migration, or remain a separate security project? Do not silently conflate QUIC hop encryption with end-to-end client-to-agent payload encryption.
- Is QUIC-only reachability acceptable on networks that block UDP, or must TCP
  remain until a separate fallback strategy is approved?

# 16. Things to watch for during implementation

- A transport abstraction can become over-engineered quickly. Prefer two or three concrete seams over a deep class hierarchy.
- Do not make every raw byte go through JSON/control framing. Control messages and payload streams should remain separate concepts.
- On single-port TCP, the initial data-connection preface must be bounded and parsed exactly once before raw piping begins.
- Make pending tunnel/open state bounded and aggressively cleaned up on timeout/disconnect.
- Preserve backpressure. Avoid manual 'data' event forwarding if stream.pipe()/pipeline() or equivalent can safely carry it.
- Do not assume `pipe()` is available on QUIC. Its adapter must bridge async
  iteration and writer backpressure without unbounded buffering.
- Preserve half-close semantics intentionally; SSH and other long-lived protocols can expose subtle close-direction bugs.
- Benchmark parent/child lifecycle itself: a successful benchmark must leave no child process, listener, or socket behind.
- Performance code must not contaminate production hot paths with expensive instrumentation unless explicitly enabled.

# 17. First instruction to give Codex

Use the following as the starting instruction alongside this document:

```text
Read this implementation brief and the repository's AGENTS.md first.

Do not start by refactoring.

1. Inspect the repository and verify the stated current architecture.
2. Run the existing checks/tests.
3. Report only material discrepancies or decisions needed at Gate G0.
4. Then implement Stage 1: the reusable benchmark/load harness plus its tiny
   correctness test and manual runner.
5. Stop after Stage 1 and show me:
   - files changed
   - benchmark architecture
   - exact manual commands
   - sample tiny-run output
   - any limitations/noise sources
6. Do not begin the TCP architecture refactor until I explicitly continue.

When a design choice is not material, choose the simplest option and proceed.
When it changes public API, wire protocol, security boundary, or benchmark
comparability, ask one focused question before committing to it.
```

# 18. Source/context notes

Repository state referenced while preparing this brief: github.com/mgrybyk/node-tunnel (main branch as viewed 19 Aug 2026). The repository README describes the three-process topology, Node >=24, a control port plus data-port range, matching protocol versions, and the existing large E2E transfer. The current agent implementation receives a server data port over control and opens a separate TCP data socket; protocol.js currently includes a NO_PORTS error tied to that design.

For the QUIC stage, Codex must verify the then-current official Node.js documentation and actual local Node 24/26 binaries rather than relying on this document for experimental API details.
