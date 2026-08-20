'use strict'

const path = require('node:path')
const { PRESETS, runBenchmark } = require('./engine')

if (require.main === module) main()

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options) await runBenchmark(options)
  } catch (error) {
    console.error(error.stack || error.message || error)
    process.exitCode = 1
  }
}

function parseArguments(args) {
  const options = {}
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--help' || argument === '-h') {
      printHelp()
      return null
    }
    const value = args[++index]
    if (value === undefined) throw new Error(`missing value after ${argument}`)
    if (argument === '--preset') options.preset = value
    else if (argument === '--implementation') options.implementation = value
    else if (argument === '--output') options.outputPath = path.resolve(value)
    else if (argument === '--startup-timeout-ms') options.startupTimeoutMs = Number(value)
    else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

function printHelp() {
  console.log(`node-tunnel sustained channel benchmark

Defaults to the small "tiny" correctness preset.

Options:
  --preset <${Object.keys(PRESETS).join('|')}>
  --implementation <label>
  --output <json-path>
  --startup-timeout-ms <milliseconds>

Examples:
  npm run benchmark
  npm run benchmark -- --preset default
  npm run benchmark -- --preset resilience
`)
}

module.exports = { parseArguments }
