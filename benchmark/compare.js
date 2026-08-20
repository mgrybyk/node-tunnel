'use strict'

const fs = require('node:fs')
const path = require('node:path')

if (require.main === module) main(process.argv.slice(2))

function main(args) {
  try {
    if (args.length !== 2) throw new Error('usage: npm run benchmark:compare -- <baseline.json> <candidate.json>')
    const [baselinePath, candidatePath] = args.map(value => path.resolve(value))
    const comparison = compareReports(loadReport(baselinePath), loadReport(candidatePath), {
      baselinePath,
      candidatePath
    })
    console.log(formatComparison(comparison))
  } catch (error) {
    console.error(error.message || error)
    process.exitCode = 1
  }
}

function loadReport(filePath) {
  let value
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`could not read benchmark JSON ${filePath}: ${error.message}`, { cause: error })
  }
  validateReport(value, filePath)
  return value
}

function validateReport(report, label) {
  if (!report || typeof report !== 'object') throw new Error(`${label} is not a benchmark object`)
  if (report.schemaVersion !== 2) throw new Error(`${label} uses unsupported benchmark schema ${report.schemaVersion}`)
  if (report.benchmark !== 'sustained-channel-quality') {
    throw new Error(`${label} is not a sustained-channel-quality benchmark`)
  }
  if (report.status !== 'passed') throw new Error(`${label} did not pass (status=${report.status || 'missing'})`)
  if (!report.scenario?.fingerprint) throw new Error(`${label} has no scenario fingerprint`)
  if (!report.metrics || !report.metricDefinitions) throw new Error(`${label} has no comparison metrics`)
}

function compareReports(baseline, candidate, paths = {}) {
  validateReport(baseline, paths.baselinePath || 'baseline')
  validateReport(candidate, paths.candidatePath || 'candidate')
  if (baseline.schemaVersion !== candidate.schemaVersion) throw new Error('benchmark schema versions differ')
  if (baseline.benchmark !== candidate.benchmark) throw new Error('benchmark types differ')
  if (baseline.scenario.fingerprint !== candidate.scenario.fingerprint) {
    throw new Error(
      `scenario fingerprints differ (${baseline.scenario.fingerprint} vs ${candidate.scenario.fingerprint})`
    )
  }

  const baselineKeys = Object.keys(baseline.metrics).sort()
  const candidateKeys = Object.keys(candidate.metrics).sort()
  if (JSON.stringify(baselineKeys) !== JSON.stringify(candidateKeys)) throw new Error('benchmark metric sets differ')

  const rows = baselineKeys.map(key => {
    const baselineDefinition = baseline.metricDefinitions[key]
    const candidateDefinition = candidate.metricDefinitions[key]
    if (!baselineDefinition || !candidateDefinition) throw new Error(`metric definition is missing for ${key}`)
    if (
      baselineDefinition.unit !== candidateDefinition.unit ||
      baselineDefinition.better !== candidateDefinition.better
    ) {
      throw new Error(`metric definition differs for ${key}`)
    }
    if (!['higher', 'lower'].includes(baselineDefinition.better)) {
      throw new Error(`metric ${key} has invalid comparison direction ${baselineDefinition.better}`)
    }
    return compareMetric(
      key,
      baseline.metrics[key],
      candidate.metrics[key],
      baselineDefinition.unit,
      baselineDefinition.better
    )
  })

  return {
    schemaVersion: baseline.schemaVersion,
    benchmark: baseline.benchmark,
    scenario: {
      preset: baseline.scenario.preset,
      fingerprint: baseline.scenario.fingerprint,
      expectedSessions: baseline.scenario.expectedSessions,
      durationMs: baseline.scenario.durationMs
    },
    baseline: reportIdentity(baseline, paths.baselinePath),
    candidate: reportIdentity(candidate, paths.candidatePath),
    warnings: compatibilityWarnings(baseline, candidate),
    rows,
    totals: {
      better: rows.filter(row => row.outcome === 'better').length,
      worse: rows.filter(row => row.outcome === 'worse').length,
      unchanged: rows.filter(row => row.outcome === 'unchanged').length,
      unavailable: rows.filter(row => row.outcome === 'unavailable').length
    }
  }
}

function compareMetric(key, baselineValue, candidateValue, unit, better) {
  if (baselineValue === null && candidateValue === null) {
    return { key, unit, better, baseline: null, candidate: null, delta: null, percent: null, outcome: 'unavailable' }
  }
  if (!Number.isFinite(baselineValue) || !Number.isFinite(candidateValue)) {
    throw new Error(`metric ${key} must contain finite numbers in both reports, or null in both`)
  }
  const delta = candidateValue - baselineValue
  const percent = baselineValue === 0 ? null : (delta / Math.abs(baselineValue)) * 100
  let outcome = 'unchanged'
  if (delta !== 0) {
    outcome = better === 'higher' ? (delta > 0 ? 'better' : 'worse') : delta < 0 ? 'better' : 'worse'
  }
  return { key, unit, better, baseline: baselineValue, candidate: candidateValue, delta, percent, outcome }
}

function reportIdentity(report, filePath) {
  return {
    file: filePath ? path.basename(filePath) : null,
    implementation: report.implementation,
    node: report.runtime?.node,
    platform: report.runtime?.platform,
    arch: report.runtime?.arch,
    cpuModel: report.system?.cpuModel,
    logicalCores: report.system?.logicalCores,
    gitRevision: report.git?.revision,
    gitDirty: report.git?.dirty,
    createdAt: report.createdAt
  }
}

function compatibilityWarnings(baseline, candidate) {
  const warnings = []
  const comparisons = [
    ['platform', baseline.runtime?.platform, candidate.runtime?.platform],
    ['architecture', baseline.runtime?.arch, candidate.runtime?.arch],
    ['CPU model', baseline.system?.cpuModel, candidate.system?.cpuModel],
    ['logical core count', baseline.system?.logicalCores, candidate.system?.logicalCores],
    ['OS release', baseline.system?.osRelease, candidate.system?.osRelease],
    [
      'runtime flags',
      JSON.stringify(baseline.runtime?.execArgv || []),
      JSON.stringify(candidate.runtime?.execArgv || [])
    ]
  ]
  for (const [name, left, right] of comparisons) {
    if (left !== right) warnings.push(`${name} differs (${left ?? 'missing'} vs ${right ?? 'missing'})`)
  }
  if (baseline.git?.dirty) warnings.push('baseline Git worktree was dirty')
  if (candidate.git?.dirty) warnings.push('candidate Git worktree was dirty')
  return warnings
}

function formatComparison(comparison) {
  const lines = [
    'Benchmark comparison',
    `Scenario: ${comparison.scenario.preset} (${comparison.scenario.fingerprint}), ` +
      `${comparison.scenario.expectedSessions} sessions, ${(comparison.scenario.durationMs / 1000).toFixed(1)} s`,
    `Baseline:  ${formatIdentity(comparison.baseline)}`,
    `Candidate: ${formatIdentity(comparison.candidate)}`,
    ''
  ]

  if (comparison.warnings.length > 0) {
    lines.push('Warnings:')
    for (const warning of comparison.warnings) lines.push(`- ${warning}`)
    lines.push('')
  }

  const headings = ['Metric', 'Baseline', 'Candidate', 'Change', 'Direction']
  const tableRows = comparison.rows.map(row => [
    `${row.key} (${row.unit})`,
    formatValue(row.baseline, row.unit),
    formatValue(row.candidate, row.unit),
    formatChange(row),
    row.outcome
  ])
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...tableRows.map(row => String(row[index]).length))
  )
  lines.push(formatTableRow(headings, widths))
  lines.push(widths.map(width => '-'.repeat(width)).join('-+-'))
  for (const row of tableRows) lines.push(formatTableRow(row, widths))
  lines.push('')
  lines.push(
    `Direction totals: ${comparison.totals.better} better, ${comparison.totals.worse} worse, ` +
      `${comparison.totals.unchanged} unchanged, ${comparison.totals.unavailable} unavailable.`
  )
  lines.push('Better/worse follows metric direction only; it does not establish statistical significance.')
  return lines.join('\n')
}

function formatIdentity(value) {
  const file = value.file ? `${value.file} | ` : ''
  const revision = value.gitRevision ? value.gitRevision.slice(0, 12) : 'unknown revision'
  return `${file}${value.implementation} | ${value.node} | ${revision}${value.gitDirty ? ' (dirty)' : ''}`
}

function formatValue(value, unit) {
  if (value === null) return 'n/a'
  if (unit === 'count') return String(value)
  if (unit === 'ratio') return value.toFixed(6)
  if (unit === 'ms') return value.toFixed(3)
  return value.toFixed(2)
}

function formatChange(row) {
  if (row.outcome === 'unavailable') return 'n/a'
  if (row.delta === 0) return '0.00%'
  if (row.percent === null) {
    return `${row.delta > 0 ? '+' : ''}${formatValue(row.delta, row.unit)} (base 0)`
  }
  return `${row.percent > 0 ? '+' : ''}${row.percent.toFixed(2)}%`
}

function formatTableRow(values, widths) {
  return values.map((value, index) => String(value).padEnd(widths[index])).join(' | ')
}

module.exports = {
  compareMetric,
  compareReports,
  formatComparison,
  loadReport,
  validateReport
}
