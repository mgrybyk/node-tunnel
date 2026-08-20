'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseArguments } = require('../benchmark/runner')
const {
  METRIC_DEFINITIONS,
  PRESETS,
  fingerprintScenario,
  normalizeOptions,
  runBenchmark,
  summarize
} = require('../benchmark/engine')

test('benchmark exposes only the fixed tiny, default, and resilience scenarios', () => {
  assert.deepEqual(Object.keys(PRESETS), ['tiny', 'default', 'resilience'])
  assert.equal(PRESETS.tiny.routes, 1)
  assert.equal(PRESETS.tiny.clientsPerRoute, 1)
  assert.equal(PRESETS.default.routes, 3)
  assert.equal(PRESETS.default.clientsPerRoute, 4)
  assert.equal(PRESETS.default.durationMs, 60_000)
  assert.deepEqual(PRESETS.resilience.fault, { type: 'relay-restart', atMs: 30_000, downtimeMs: 2_000 })
})

test('benchmark schema provides stable fingerprints and comparison directions', () => {
  const first = normalizeOptions({ preset: 'default', outputPath: false })
  const second = normalizeOptions({ preset: 'default', outputPath: false })
  const changed = normalizeOptions({
    preset: 'default',
    scenarioOverrides: { durationMs: 1_000 },
    outputPath: false
  })

  assert.equal(first.scenarioFingerprint, second.scenarioFingerprint)
  assert.notEqual(first.scenarioFingerprint, changed.scenarioFingerprint)
  assert.equal(first.scenarioFingerprint, fingerprintScenario(first.scenario))
  assert.equal(METRIC_DEFINITIONS.rttP95Ms.better, 'lower')
  assert.equal(METRIC_DEFINITIONS.clientToAgentMiBs.better, 'higher')
})

test('benchmark CLI accepts only scenario-level options', () => {
  assert.deepEqual(parseArguments(['--preset', 'default', '--implementation', 'tcp-node-26']), {
    preset: 'default',
    implementation: 'tcp-node-26'
  })
  assert.throws(() => parseArguments(['--mode', 'echo']), /unknown argument/)
})

test('benchmark latency summary includes comparison percentiles', () => {
  assert.deepEqual(summarize([4, 1, 3, 2]), { min: 1, p50: 2, p95: 4, p99: 4, max: 4 })
})

test('tiny benchmark validates a sustained real tunnel session', { timeout: 30_000 }, async () => {
  const report = await runBenchmark({
    preset: 'tiny',
    implementation: 'tcp-benchmark-smoke',
    outputPath: false,
    quiet: true
  })

  assert.equal(report.schemaVersion, 2)
  assert.equal(report.status, 'passed')
  assert.equal(report.scenario.expectedSessions, 1)
  assert.equal(report.summary.readySessionsAtEnd, 1)
  assert.equal(report.metrics.sessionCompletionRatio, 1)
  assert.equal(report.metrics.frameCompletionRatio, 1)
  assert.equal(report.summary.integrityErrors, 0)
  assert.equal(report.summary.disconnects, 0)
  assert.ok(report.summary.framesCompleted > 0)
  assert.ok(Number.isFinite(report.metrics.rttP99Ms))
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.components).map(([category, value]) => [category, value.processes])),
    { relay: 1, agents: 1, clients: 1, loadWorkers: 1, targetWorkers: 1 }
  )
})

test('short resilience benchmark reconnects after a relay outage', { timeout: 30_000 }, async () => {
  const report = await runBenchmark({
    preset: 'resilience',
    scenarioOverrides: {
      routes: 1,
      clientsPerRoute: 1,
      warmupMs: 100,
      durationMs: 2_500,
      frameIntervalMs: 20,
      fault: { atMs: 600, downtimeMs: 200 }
    },
    outputPath: false,
    quiet: true
  })

  assert.equal(report.status, 'passed')
  assert.equal(report.resilience.recovered, true)
  assert.ok(report.resilience.recoveryMs >= 200)
  assert.equal(report.summary.readySessionsAtEnd, 1)
  assert.ok(report.summary.disconnects >= 1)
  assert.ok(report.summary.reconnections >= 1)
  assert.equal(report.summary.integrityErrors, 0)
  assert.equal(report.components.relay.processes, 2)
})
