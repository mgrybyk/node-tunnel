'use strict'

require('dotenv').config()
const disableLogging = process.env.N_T_DISABLE_LOGGING === 'true'

module.exports.tryParseJSON = function (json, reviver) {
  try {
    return JSON.parse(json, reviver)
  } catch (error) {
    console.log('JSON', json)
    return error
  }
}

module.exports.removeElement = function (array, element) {
  let idx = array.indexOf(element)
  if (idx >= 0) {
    array.splice(idx, 1)
  }
}

if (disableLogging) {
  module.exports.log = function () { }
} else {
  module.exports.log = function (...args) {
    console.log(...args)
  }
}
