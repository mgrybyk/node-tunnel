'use strict'

let dotEnvConfig = {}
if (process.argv[2]) {
  dotEnvConfig.path = process.argv[2]
}
require('dotenv').config(dotEnvConfig)

const logDebug = process.env.N_T_LOG_DEBUG === 'true'
const logError = process.env.N_T_LOG_ERROR === 'true'

module.exports.removeElement = function (array, element) {
  let idx = array.indexOf(element)
  if (idx >= 0) {
    array.splice(idx, 1)
  }
}

let log = {
  info (...args) { console.log('INFO:', ...args) },
  debug () {},
  err () {}
}

if (logDebug) {
  log.debug = (...args) => console.log(...args)
}
if (logError) {
  log.err = (...args) => console.error('ERR:', ...args)
}

module.exports.log = log
