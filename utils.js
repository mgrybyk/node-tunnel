'use strict'

let dotEnvConfig = {}
if (process.argv[2]) {
  dotEnvConfig.path = process.argv[2]
}
require('dotenv').config(dotEnvConfig)

const logDebug = process.env.N_T_LOG_DEBUG === 'true'
const logError = process.env.N_T_LOG_ERROR === 'true'

const types = {
  AGENT: 'agent',
  CLIENT: 'client'
}
module.exports.types = types

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

module.exports.tryParseJSON = function (json, reviver) {
  try {
    return JSON.parse(json, reviver)
  } catch (error) {
    log.err('JSON', json)
    return error
  }
}

module.exports.verifyDataJson = dataJson => {
  if (dataJson.type !== types.CLIENT && dataJson.type !== types.AGENT) {
    log.err('invalid type: ' + dataJson.type)
    return false
  }

  return true
}

const crypto = require('crypto')
const cryptKey = process.env.N_T_CRYPT_KEY || 'sASLNFpn7&3HLKASJFH#asD^*T3r32fASKJ#%@#'
if (!process.env.N_T_CRYPT_KEY) console.log('WARNING: default CRYPT KEY is used!!!')
const cryptAlg = 'aes128'

module.exports.crypt = {
  cipher: () => {
    let cipher = crypto.createCipher(cryptAlg, cryptKey)
    cipher.on('error', err => log.err('ENC', err.message))
    return cipher
  },
  decipher: () => {
    let decipher = crypto.createDecipher(cryptAlg, cryptKey)
    decipher.on('error', err => log.err('DEC', err.message))
    return decipher
  },
  encrypt (str) {
    let cipher = this.cipher()
    try {
      return (cipher.update(str, 'utf8', 'hex') + cipher.final('hex'))
    } catch (e) {
      return null
    }
  },
  decrypt (str) {
    let decipher = this.decipher()
    try {
      return (decipher.update(str, 'hex', 'utf8') + decipher.final('utf8'))
    } catch (e) {
      return null
    }
  }
}

module.exports.log = log
