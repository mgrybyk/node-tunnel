'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { compareMetric, compareReports, formatComparison, validateReport } = require('../benchmark/compare')

test('benchmark comparator follows higher/lower metric directions', () => {
  assert.equal(compareMetric('throughput', 100, 110, 'MiB/s', 'higher').outcome, 'better')
  assert.equal(compareMetric('latency', 10, 8, 'ms', 'lower').outcome, 'better')
  assert.equal(compareMetric('errors', 0, 1, 'count', 'lower').outcome, 'worse')
  assert.equal(compareMetric('errors', 0, 0, 'count', 'lower').outcome, 'unchanged')
  assert.equal(compareMetric('recovery', null, null, 'ms', 'lower').outcome, 'unavailable')
})

test('benchmark comparator produces deltas and compatibility warnings', () => {
  const baseline = createReport({ throughput: 100, latency: 10, errors: 0, recovery: null })
  baseline.git.dirty = true
  const candidate = createReport({ throughput: 110, latency: 8, errors: 1, recovery: null })
  candidate.runtime.node = 'v26.0.0'

  const comparison = compareReports(baseline, candidate, {
    baselinePath: '/tmp/baseline.json',
    candidatePath: '/tmp/candidate.json'
  })

  assert.equal(comparison.rows.find(row => row.key === 'throughput').percent, 10)
  assert.equal(comparison.rows.find(row => row.key === 'latency').percent, -20)
  assert.deepEqual(comparison.totals, { better: 2, worse: 1, unchanged: 0, unavailable: 1 })
  assert.deepEqual(comparison.warnings, ['baseline Git worktree was dirty'])
  assert.match(formatComparison(comparison), /baseline\.json.*candidate\.json/s)
  assert.match(formatComparison(comparison), /statistical significance/)
})

test('benchmark comparator rejects incompatible or failed reports', () => {
  const baseline = createReport({ throughput: 100, latency: 10, errors: 0, recovery: null })
  const candidate = createReport({ throughput: 100, latency: 10, errors: 0, recovery: null })

  candidate.scenario.fingerprint = 'different'
  assert.throws(() => compareReports(baseline, candidate), /scenario fingerprints differ/)

  baseline.status = 'failed'
  assert.throws(() => validateReport(baseline, 'baseline'), /did not pass/)

  baseline.schemaVersion = 1
  assert.throws(() => validateReport(baseline, 'baseline'), /unsupported benchmark schema/)
})

function createReport(metrics) {
  return {
    schemaVersion: 2,
    benchmark: 'sustained-channel-quality',
    status: 'passed',
    implementation: 'tcp-baseline',
    createdAt: '2026-08-20T00:00:00.000Z',
    scenario: {
      preset: 'default',
      fingerprint: 'scenario-fingerprint',
      expectedSessions: 12,
      durationMs: 60_000
    },
    metrics,
    metricDefinitions: {
      throughput: { unit: 'MiB/s', better: 'higher' },
      latency: { unit: 'ms', better: 'lower' },
      errors: { unit: 'count', better: 'lower' },
      recovery: { unit: 'ms', better: 'lower' }
    },
    runtime: { node: 'v24.19.0', platform: 'darwin', arch: 'arm64', execArgv: [] },
    system: { cpuModel: 'Test CPU', logicalCores: 8, osRelease: 'test-release' },
    git: { revision: '0123456789abcdef', dirty: false }
  }
}
