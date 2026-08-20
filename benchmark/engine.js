'use strict'

const { fork, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const componentChildPath = path.join(__dirname, 'component-child.js')
const loadChildPath = path.join(__dirname, 'traffic-load-child.js')
const targetChildPath = path.join(__dirname, 'traffic-target-child.js')
const host = '127.0.0.1'
const benchmarkKey = 'benchmark-key-0123456789abcdefgh'
const resultSchemaVersion = 2
const defaultStartupTimeoutMs = 30_000

const PRESETS = Object.freeze({
  tiny: scenario({
    id: 'tiny',
    routes: 1,
    clientsPerRoute: 1,
    warmupMs: 100,
    durationMs: 1_000,
    frameIntervalMs: 20,
    framePayloadBytes: [128, 1024, 4096],
    inFlightFrames: 2
  }),
  default: scenario({
    id: 'default',
    routes: 3,
    clientsPerRoute: 4,
    warmupMs: 3_000,
    durationMs: 60_000,
    frameIntervalMs: 5,
    framePayloadBytes: [256, 1024, 4096, 16 * 1024, 64 * 1024],
    inFlightFrames: 8
  }),
  resilience: scenario({
    id: 'resilience',
    routes: 3,
    clientsPerRoute: 4,
    warmupMs: 3_000,
    durationMs: 60_000,
    frameIntervalMs: 5,
    framePayloadBytes: [256, 1024, 4096, 16 * 1024, 64 * 1024],
    inFlightFrames: 8,
    fault: { type: 'relay-restart', atMs: 30_000, downtimeMs: 2_000 }
  })
})

const METRIC_DEFINITIONS = Object.freeze({
  sessionCompletionRatio: { unit: 'ratio', better: 'higher' },
  frameCompletionRatio: { unit: 'ratio', better: 'higher' },
  clientToAgentMiBs: { unit: 'MiB/s', better: 'higher' },
  agentToClientMiBs: { unit: 'MiB/s', better: 'higher' },
  completedFramesPerSecond: { unit: 'frames/s', better: 'higher' },
  rttP50Ms: { unit: 'ms', better: 'lower' },
  rttP95Ms: { unit: 'ms', better: 'lower' },
  rttP99Ms: { unit: 'ms', better: 'lower' },
  rttMaxMs: { unit: 'ms', better: 'lower' },
  disconnects: { unit: 'count', better: 'lower' },
  incompleteFrames: { unit: 'count', better: 'lower' },
  integrityErrors: { unit: 'count', better: 'lower' },
  channelCpuMillisPerGiB: { unit: 'ms/GiB', better: 'lower' },
  serverPeakRssMiB: { unit: 'MiB', better: 'lower' },
  agentsPeakRssMiB: { unit: 'MiB', better: 'lower' },
  clientsPeakRssMiB: { unit: 'MiB', better: 'lower' },
  recoveryMs: { unit: 'ms', better: 'lower', scenarios: ['resilience'] }
})

async function runBenchmark(options = {}) {
  const config = normalizeOptions(options)
  const report = createReport(config)
  let topology
  let failure

  try {
    topology = await startTopology(config)
    const runAt = Date.now() + 300
    const measurementStart = runAt + config.scenario.warmupMs
    const runConfig = {
      runAt,
      warmupMs: config.scenario.warmupMs,
      durationMs: config.scenario.durationMs,
      drainTimeoutMs: Math.min(5_000, config.startupTimeoutMs)
    }

    if (!config.quiet) printScenarioStart(config.scenario)
    const loadResultsPromise = Promise.all(topology.loadWorkers.map(worker => worker.request('run', runConfig)))
    await waitUntil(measurementStart)
    await Promise.all(topology.targetWorkers.map(worker => worker.request('reset-stats')))
    await topology.captureMeasurementBaselines()

    const faultPromise = config.scenario.fault
      ? executeFault(topology, measurementStart, config.scenario.fault, config)
      : Promise.resolve(null)
    const [loadResults, resilience] = await Promise.all([loadResultsPromise, faultPromise])
    const [targetStats, components] = await Promise.all([
      Promise.all(topology.targetWorkers.map(worker => worker.request('stats'))),
      topology.collectComponentMetrics()
    ])

    Object.assign(report, buildResult(config, loadResults, targetStats, components, resilience))
    const validationErrors = validateResult(report)
    if (validationErrors.length > 0) {
      throw new Error(`benchmark quality validation failed: ${validationErrors.join('; ')}`)
    }
  } catch (error) {
    failure = error
    report.status = 'failed'
    report.failure = { error: serializeError(error), diagnostics: topology ? await topology.diagnostics() : null }
  } finally {
    if (topology) {
      try {
        await topology.close()
      } catch (error) {
        if (!failure) {
          failure = error
          report.status = 'failed'
          report.failure = { error: serializeError(error), diagnostics: null }
        } else {
          report.failure.cleanupError = serializeError(error)
        }
      }
    }
    report.finishedAt = new Date().toISOString()
    writeReport(config, report)
  }

  if (failure) {
    failure.report = report
    failure.reportPath = config.outputPath
    throw failure
  }
  return report
}

function scenario(value) {
  return Object.freeze({ reconnectIntervalMs: 100, ...value, fault: value.fault || null })
}

function normalizeOptions(options) {
  const preset = options.preset || 'tiny'
  const base = PRESETS[preset]
  if (!base) throw new Error(`unknown benchmark preset: ${preset}`)
  const value = { ...base, ...(options.scenarioOverrides || {}) }
  if (base.fault || options.scenarioOverrides?.fault) {
    value.fault = { ...(base.fault || {}), ...(options.scenarioOverrides?.fault || {}) }
  }
  const normalizedScenario = {
    id: String(value.id || preset),
    routes: positiveInteger(value.routes, 'scenario routes'),
    clientsPerRoute: positiveInteger(value.clientsPerRoute, 'scenario clientsPerRoute'),
    warmupMs: nonNegativeInteger(value.warmupMs, 'scenario warmupMs'),
    durationMs: positiveInteger(value.durationMs, 'scenario durationMs'),
    frameIntervalMs: positiveInteger(value.frameIntervalMs, 'scenario frameIntervalMs'),
    framePayloadBytes: validateFrameSizes(value.framePayloadBytes),
    inFlightFrames: positiveInteger(value.inFlightFrames, 'scenario inFlightFrames'),
    reconnectIntervalMs: positiveInteger(value.reconnectIntervalMs, 'scenario reconnectIntervalMs'),
    fault: validateFault(value.fault, value.durationMs)
  }
  return {
    preset,
    scenario: normalizedScenario,
    scenarioFingerprint: fingerprintScenario(normalizedScenario),
    implementation: String(options.implementation || 'tcp-single-port'),
    startupTimeoutMs: positiveInteger(options.startupTimeoutMs || defaultStartupTimeoutMs, 'startup timeout'),
    outputPath: options.outputPath === false ? null : path.resolve(options.outputPath || defaultOutputPath(preset)),
    quiet: Boolean(options.quiet)
  }
}

function validateFrameSizes(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('scenario framePayloadBytes must not be empty')
  return values.map(value => positiveInteger(value, 'frame payload bytes'))
}

function validateFault(value, durationMs) {
  if (!value) return null
  if (value.type !== 'relay-restart') throw new Error(`unsupported benchmark fault: ${value.type}`)
  const fault = {
    type: value.type,
    atMs: positiveInteger(value.atMs, 'fault atMs'),
    downtimeMs: positiveInteger(value.downtimeMs, 'fault downtimeMs')
  }
  if (fault.atMs + fault.downtimeMs >= durationMs) throw new Error('fault must leave time for recovery')
  return fault
}

function fingerprintScenario(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

function createReport(config) {
  return {
    schemaVersion: resultSchemaVersion,
    benchmark: 'sustained-channel-quality',
    status: 'passed',
    implementation: config.implementation,
    createdAt: new Date().toISOString(),
    scenario: {
      preset: config.preset,
      fingerprint: config.scenarioFingerprint,
      ...config.scenario,
      expectedSessions: config.scenario.routes * config.scenario.clientsPerRoute
    },
    metricDefinitions: METRIC_DEFINITIONS,
    git: getGitMetadata(),
    runtime: {
      node: process.version,
      execPath: process.execPath,
      execArgv: process.execArgv,
      platform: process.platform,
      arch: process.arch
    },
    system: {
      osType: os.type(),
      osRelease: os.release(),
      cpuModel: os.cpus()[0]?.model || 'unknown',
      logicalCores: os.cpus().length,
      totalMemoryBytes: os.totalmem()
    }
  }
}

async function startTopology(config) {
  const reservations = []
  const excludedPorts = new Set()
  const components = []
  const archivedMeasurements = []
  let server
  let serverRestart = 0

  try {
    const serviceReservation = await reservePort(excludedPorts)
    reservations.push(serviceReservation)
    excludedPorts.add(serviceReservation.port)

    const targetReservations = []
    for (let index = 0; index < config.scenario.routes; index++) {
      const item = await reservePort(excludedPorts)
      reservations.push(item)
      targetReservations.push(item)
      excludedPorts.add(item.port)
    }
    const clientReservations = []
    const clientCount = config.scenario.routes * config.scenario.clientsPerRoute
    for (let index = 0; index < clientCount; index++) {
      const item = await reservePort(excludedPorts)
      reservations.push(item)
      clientReservations.push(item)
      excludedPorts.add(item.port)
    }
    await Promise.all(reservations.map(item => closeServer(item.server)))

    const targetWorkers = await Promise.all(
      targetReservations.map((item, routeIndex) =>
        startManagedChild({
          label: `target-${routeIndex + 1}`,
          category: 'targetWorkers',
          script: targetChildPath,
          config: { host, port: item.port },
          ready: state => state.started,
          timeout: config.startupTimeoutMs
        })
      )
    )
    components.push(...targetWorkers)

    const serverConfig = {
      servicePort: serviceReservation.port,
      handshakeTimeout: 10_000,
      controlIdleTimeout: Math.max(120_000, config.scenario.warmupMs + config.scenario.durationMs + 60_000),
      shutdownTimeout: 2_000
    }
    server = await startApplicationComponent('server', 'server', serverConfig, state => state.started, config)
    components.push(server)

    const common = {
      serverHost: host,
      serverPort: serviceReservation.port,
      reconnectDelay: 100,
      reconnectMaxDelay: 500,
      reconnectJitterPercent: 0,
      handshakeTimeout: 10_000,
      shutdownTimeout: 2_000
    }
    const agents = await Promise.all(
      targetReservations.map((item, routeIndex) =>
        startApplicationComponent(
          `agent-${routeIndex + 1}`,
          'agent',
          { ...common, name: routeName(routeIndex), targetHost: host, targetPort: item.port },
          state => state.connected && state.ready,
          config
        )
      )
    )
    components.push(...agents)

    const clients = []
    const clientPortsByRoute = []
    for (let routeIndex = 0; routeIndex < config.scenario.routes; routeIndex++) {
      const routePorts = []
      for (let clientIndex = 0; clientIndex < config.scenario.clientsPerRoute; clientIndex++) {
        const reservation = clientReservations[routeIndex * config.scenario.clientsPerRoute + clientIndex]
        routePorts.push(reservation.port)
        clients.push(
          await startApplicationComponent(
            `client-${routeIndex + 1}-${clientIndex + 1}`,
            'client',
            { ...common, name: routeName(routeIndex), localPort: reservation.port },
            state => state.connected && state.ready,
            config
          )
        )
      }
      clientPortsByRoute.push(routePorts)
    }
    components.push(...clients)

    const loadWorkers = await Promise.all(
      clientPortsByRoute.map((ports, routeIndex) =>
        startManagedChild({
          label: `load-${routeIndex + 1}`,
          category: 'loadWorkers',
          script: loadChildPath,
          config: {
            host,
            routeIndex,
            sessions: ports.map((localPort, clientIndex) => ({
              id: `client-${routeIndex + 1}-${clientIndex + 1}`,
              clientIndex,
              localPort
            })),
            frameIntervalMs: config.scenario.frameIntervalMs,
            framePayloadBytes: config.scenario.framePayloadBytes,
            inFlightFrames: config.scenario.inFlightFrames,
            reconnectIntervalMs: config.scenario.reconnectIntervalMs
          },
          ready: state => state.readySessions === state.expectedSessions,
          timeout: config.startupTimeoutMs
        })
      )
    )
    components.push(...loadWorkers)

    return {
      loadWorkers,
      targetWorkers,
      async captureMeasurementBaselines() {
        await Promise.all(
          components
            .filter(component => !component.closed)
            .map(async component => {
              component.baseline = await component.request('metrics')
            })
        )
      },
      async restartServer(downtimeMs) {
        const faultStartedAt = Date.now()
        archivedMeasurements.push(componentMeasurement(server, await server.request('metrics')))
        await server.close(true)
        await waitFor(
          async () => {
            const states = await Promise.all(loadWorkers.map(worker => worker.request('state')))
            return states.some(state => state.readySessions < state.expectedSessions)
          },
          Math.min(5_000, config.startupTimeoutMs),
          'traffic sessions did not observe the relay outage'
        )
        await delay(downtimeMs)
        serverRestart++
        server = await startApplicationComponent(
          `server-restart-${serverRestart}`,
          'server',
          serverConfig,
          state => state.started,
          config
        )
        server.baseline = zeroMetrics()
        components.push(server)
        await waitFor(
          async () => {
            const states = await Promise.all(loadWorkers.map(worker => worker.request('state')))
            return states.every(state => state.readySessions === state.expectedSessions)
          },
          config.startupTimeoutMs,
          'traffic sessions did not recover after the relay restart'
        )
        return {
          type: 'relay-restart',
          plannedDowntimeMs: downtimeMs,
          recovered: true,
          recoveryMs: Date.now() - faultStartedAt
        }
      },
      async collectComponentMetrics() {
        const measurements = [...archivedMeasurements]
        for (const component of components) {
          if (!component.closed) measurements.push(componentMeasurement(component, await component.request('metrics')))
        }
        return summarizeComponentMeasurements(measurements)
      },
      async diagnostics() {
        const entries = await Promise.all(
          components.map(async component => {
            if (component.closed) return [component.label, { closed: true, logs: component.logs() }]
            try {
              return [component.label, { state: await component.request('state'), logs: component.logs() }]
            } catch (error) {
              return [component.label, { error: serializeError(error), logs: component.logs() }]
            }
          })
        )
        return Object.fromEntries(entries)
      },
      async close() {
        await Promise.allSettled(components.toReversed().map(component => component.close(true)))
      }
    }
  } catch (error) {
    await Promise.allSettled(reservations.map(item => closeServer(item.server)))
    await Promise.allSettled(components.toReversed().map(component => component.close(true)))
    throw error
  }
}

function startApplicationComponent(label, role, componentConfig, ready, config) {
  return startManagedChild({
    label,
    category: role === 'server' ? 'server' : `${role}s`,
    script: componentChildPath,
    args: [role],
    config: componentConfig,
    ready,
    timeout: config.startupTimeoutMs,
    env: { N_T_CRYPT_KEY: benchmarkKey, N_T_LOG_DEBUG: 'false', N_T_LOG_ERROR: 'true' }
  })
}

async function startManagedChild({ label, category, script, args = [], config, ready, timeout, env = {} }) {
  const child = fork(script, args, {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  const logBuffer = { stdout: '', stderr: '' }
  const pending = new Map()
  let nextRequestId = 1
  let fatalError
  let closed = false
  let closePromise

  child.stdout.on('data', data => {
    logBuffer.stdout = `${logBuffer.stdout}${data}`.slice(-12_000)
  })
  child.stderr.on('data', data => {
    logBuffer.stderr = `${logBuffer.stderr}${data}`.slice(-12_000)
  })
  child.on('message', message => {
    if (message?.type === 'response') {
      const request = pending.get(message.requestId)
      if (request) {
        pending.delete(message.requestId)
        request.resolve(message.value)
      }
    } else if (message?.type === 'fatal') {
      fatalError = deserializeError(message.error, `${label} failed`)
      for (const request of pending.values()) request.reject(fatalError)
      pending.clear()
    }
  })
  child.once('exit', (code, signal) => {
    closed = true
    const error = new Error(`${label} exited (code=${code}, signal=${signal})\n${formatLogs(logBuffer)}`)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  })

  const component = {
    label,
    category,
    baseline: zeroMetrics(),
    get closed() {
      return closed
    },
    request(type, value) {
      if (fatalError) return Promise.reject(fatalError)
      if (!child.connected) return Promise.reject(new Error(`${label} is disconnected`))
      const requestId = nextRequestId++
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        child.send({ type, requestId, config: value })
      })
    },
    close(force = false) {
      if (closePromise) return closePromise
      if (closed || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
      closePromise = new Promise(resolve => {
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
        child.once('exit', () => {
          clearTimeout(killTimer)
          closed = true
          resolve()
        })
        child.send({ type: 'close', force })
      })
      return closePromise
    },
    logs() {
      return { ...logBuffer }
    }
  }

  child.send({ type: 'start', config })
  try {
    await waitFor(
      async () => {
        if (fatalError) throw fatalError
        return ready(await component.request('state'))
      },
      timeout,
      `${label} did not become ready`,
      logBuffer
    )
    return component
  } catch (error) {
    await component.close(true)
    throw error
  }
}

async function executeFault(topology, measurementStart, fault, config) {
  await waitUntil(measurementStart + fault.atMs)
  if (!config.quiet) console.log(`Injecting ${fault.type} outage for ${fault.downtimeMs} ms`)
  return topology.restartServer(fault.downtimeMs)
}

function buildResult(config, loadResults, targetStats, components, resilience) {
  const durationSeconds = config.scenario.durationMs / 1000
  const aggregate = aggregateTraffic(loadResults)
  const totalWireBytes = aggregate.bytesClientToAgent + aggregate.bytesAgentToClient
  const channelCpuMillis = ['server', 'agents', 'clients'].reduce(
    (sum, category) => sum + components[category].cpuUserMillis + components[category].cpuSystemMillis,
    0
  )
  const latency = summarize(aggregate.latenciesMs)
  const metrics = {
    sessionCompletionRatio: ratio(aggregate.readySessions, aggregate.expectedSessions),
    frameCompletionRatio: ratio(aggregate.framesCompleted, aggregate.framesSent),
    clientToAgentMiBs: bytesPerSecondToMiBs(aggregate.bytesClientToAgent, durationSeconds),
    agentToClientMiBs: bytesPerSecondToMiBs(aggregate.bytesAgentToClient, durationSeconds),
    completedFramesPerSecond: aggregate.framesCompleted / durationSeconds,
    rttP50Ms: latency?.p50 ?? null,
    rttP95Ms: latency?.p95 ?? null,
    rttP99Ms: latency?.p99 ?? null,
    rttMaxMs: latency?.max ?? null,
    disconnects: aggregate.disconnects,
    incompleteFrames: aggregate.incompleteFrames,
    integrityErrors: aggregate.integrityErrors,
    channelCpuMillisPerGiB: totalWireBytes > 0 ? channelCpuMillis / (totalWireBytes / 1024 ** 3) : null,
    serverPeakRssMiB: components.server.peakRssBytes / 1024 ** 2,
    agentsPeakRssMiB: components.agents.peakRssBytes / 1024 ** 2,
    clientsPeakRssMiB: components.clients.peakRssBytes / 1024 ** 2,
    recoveryMs: resilience?.recoveryMs ?? null
  }
  return {
    metrics,
    summary: {
      durationMs: config.scenario.durationMs,
      expectedSessions: aggregate.expectedSessions,
      readySessionsAtEnd: aggregate.readySessions,
      framesSent: aggregate.framesSent,
      framesCompleted: aggregate.framesCompleted,
      bytesClientToAgent: aggregate.bytesClientToAgent,
      bytesAgentToClient: aggregate.bytesAgentToClient,
      disconnects: aggregate.disconnects,
      reconnections: aggregate.reconnections,
      incompleteFrames: aggregate.incompleteFrames,
      integrityErrors: aggregate.integrityErrors,
      socketErrors: aggregate.socketErrors,
      latencyMs: latency
    },
    routes: loadResults.map(result => buildRouteResult(result, durationSeconds)),
    targets: targetStats,
    components,
    resilience
  }
}

function aggregateTraffic(results) {
  const aggregate = {
    expectedSessions: 0,
    readySessions: 0,
    framesSent: 0,
    framesCompleted: 0,
    bytesClientToAgent: 0,
    bytesAgentToClient: 0,
    disconnects: 0,
    reconnections: 0,
    incompleteFrames: 0,
    integrityErrors: 0,
    socketErrors: 0,
    latenciesMs: []
  }
  for (const result of results) {
    for (const key of Object.keys(aggregate)) {
      if (key !== 'latenciesMs') aggregate[key] += result[key] || 0
    }
    aggregate.latenciesMs.push(...result.latenciesMs)
  }
  return aggregate
}

function buildRouteResult(result, durationSeconds) {
  return {
    route: routeName(result.routeIndex),
    expectedSessions: result.expectedSessions,
    readySessionsAtEnd: result.readySessions,
    framesSent: result.framesSent,
    framesCompleted: result.framesCompleted,
    frameCompletionRatio: ratio(result.framesCompleted, result.framesSent),
    clientToAgentMiBs: bytesPerSecondToMiBs(result.bytesClientToAgent, durationSeconds),
    agentToClientMiBs: bytesPerSecondToMiBs(result.bytesAgentToClient, durationSeconds),
    disconnects: result.disconnects,
    reconnections: result.reconnections,
    incompleteFrames: result.incompleteFrames,
    integrityErrors: result.integrityErrors,
    socketErrors: result.socketErrors,
    latencyMs: summarize(result.latenciesMs),
    sessions: result.sessions.map(session => ({ ...session, latenciesMs: summarize(session.latenciesMs) }))
  }
}

function validateResult(report) {
  const errors = []
  if (report.summary.readySessionsAtEnd !== report.summary.expectedSessions)
    errors.push('not all sessions were ready at end')
  if (report.summary.framesSent === 0 || report.summary.framesCompleted === 0)
    errors.push('no measured frames completed')
  if (report.summary.integrityErrors !== 0) errors.push('payload integrity errors occurred')
  if (report.scenario.fault) {
    if (!report.resilience?.recovered) errors.push('sessions did not recover from the injected outage')
  } else {
    if (report.summary.disconnects !== 0) errors.push('unexpected session disconnects occurred')
    if (report.summary.incompleteFrames !== 0) errors.push('measured frames did not complete')
    if (report.summary.socketErrors !== 0) errors.push('unexpected socket errors occurred')
  }
  return errors
}

function componentMeasurement(component, finalMetrics) {
  const baseline = component.baseline || zeroMetrics()
  return {
    label: component.label,
    category: component.category,
    cpuUserMicros: Math.max(0, finalMetrics.cpuUserMicros - baseline.cpuUserMicros),
    cpuSystemMicros: Math.max(0, finalMetrics.cpuSystemMicros - baseline.cpuSystemMicros),
    rssBytesAfter: finalMetrics.rssBytes,
    peakRssBytes: finalMetrics.peakRssBytes
  }
}

function summarizeComponentMeasurements(values) {
  const categories = ['server', 'agents', 'clients', 'loadWorkers', 'targetWorkers']
  return Object.fromEntries(
    categories.map(category => {
      const entries = values.filter(value => value.category === category)
      const peakRssBytes =
        category === 'server'
          ? Math.max(0, ...entries.map(entry => entry.peakRssBytes))
          : entries.reduce((sum, entry) => sum + entry.peakRssBytes, 0)
      return [
        category,
        {
          processes: entries.length,
          cpuUserMillis: entries.reduce((sum, entry) => sum + entry.cpuUserMicros, 0) / 1000,
          cpuSystemMillis: entries.reduce((sum, entry) => sum + entry.cpuSystemMicros, 0) / 1000,
          peakRssBytes,
          entries
        }
      ]
    })
  )
}

function zeroMetrics() {
  return { cpuUserMicros: 0, cpuSystemMicros: 0, rssBytes: 0, peakRssBytes: 0 }
}

function summarize(values) {
  if (!values || values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return {
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1)
  }
}

function percentile(sorted, quantile) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0
}
function bytesPerSecondToMiBs(bytes, seconds) {
  return bytes / 1024 / 1024 / seconds
}
function routeName(routeIndex) {
  return `benchmark-route-${routeIndex + 1}`
}

function printScenarioStart(value) {
  const sessions = value.routes * value.clientsPerRoute
  console.log(
    `Running ${value.id}: ${value.routes} routes, ${sessions} simultaneous sessions, ` +
      `${(value.durationMs / 1000).toFixed(1)} measured seconds`
  )
}

function printReportSummary(report) {
  if (!report.metrics) return
  console.log(
    `Sessions ${report.summary.readySessionsAtEnd}/${report.summary.expectedSessions}, ` +
      `${report.metrics.clientToAgentMiBs.toFixed(2)} MiB/s client→agent, ` +
      `${report.metrics.agentToClientMiBs.toFixed(2)} MiB/s agent→client, ` +
      `RTT p50=${report.metrics.rttP50Ms.toFixed(2)} ms p95=${report.metrics.rttP95Ms.toFixed(2)} ms ` +
      `p99=${report.metrics.rttP99Ms.toFixed(2)} ms`
  )
  if (report.resilience) console.log(`Relay outage recovery: ${report.resilience.recoveryMs} ms`)
}

function writeReport(config, report) {
  if (report.status === 'passed' && !config.quiet) printReportSummary(report)
  if (!config.outputPath) return
  fs.mkdirSync(path.dirname(config.outputPath), { recursive: true })
  fs.writeFileSync(config.outputPath, `${JSON.stringify(report, null, 2)}\n`)
  if (!config.quiet)
    console.log(`${report.status === 'passed' ? 'JSON result' : 'Partial failure JSON'}: ${config.outputPath}`)
}

function defaultOutputPath(preset) {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  return path.join(projectRoot, 'benchmark-results', `${preset}-${process.version}-${timestamp}.json`)
}

function getGitMetadata() {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' })
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' })
  return {
    revision: revision.status === 0 ? revision.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null
  }
}

async function reservePort(excludedPorts) {
  while (true) {
    const server = net.createServer()
    await listen(server, 0)
    const port = server.address().port
    if (!excludedPorts.has(port)) return { server, port }
    await closeServer(server)
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onListening = () => finish(resolve)
    const onError = error => finish(() => reject(error))
    const finish = callback => {
      server.off('listening', onListening)
      server.off('error', onError)
      callback()
    }
    server.once('listening', onListening)
    server.once('error', onError)
    server.listen(port, host)
  })
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve()
  return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
}

async function waitFor(check, timeout, message, logs) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(20)
  }
  throw new Error(`${message} after ${timeout} ms${logs ? `\n${formatLogs(logs)}` : ''}`)
}

function waitUntil(timestamp) {
  return delay(Math.max(0, timestamp - Date.now()))
}
function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function formatLogs(logs) {
  return `stdout:\n${logs.stdout || '(empty)'}\nstderr:\n${logs.stderr || '(empty)'}`
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    code: error?.code || null,
    stack: error?.stack || null
  }
}

function deserializeError(value, fallback) {
  const error = new Error(value?.message || fallback)
  error.name = value?.name || 'Error'
  if (value?.code) error.code = value.code
  if (value?.stack) error.stack = value.stack
  return error
}

module.exports = {
  METRIC_DEFINITIONS,
  PRESETS,
  fingerprintScenario,
  normalizeOptions,
  runBenchmark,
  summarize
}
