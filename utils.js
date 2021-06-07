'use strict'

let dotEnvConfig = {}
if (process.argv[2]) {
  dotEnvConfig.path = process.argv[2] || '.env'
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

if (!process.env.N_T_CRYPT_KEY) {
  console.log('WARNING: default CRYPT KEY is used!!!')
}

const crypto = require('crypto')
const cryptKey = (process.env.N_T_CRYPT_KEY || 'b70231120900saamkb83gsc150f162fd').toString('hex').slice(0, 32)
const cryptIv = (process.env.N_T_CRYPT_IV || 'e7c3df588cc0').toString('hex').slice(0, 12);
const cryptAlg = 'chacha20-poly1305'
const authTagLength = 16

let crypt = {
  cipher: () => {
    let cipher = crypto.createCipheriv(cryptAlg, cryptKey, cryptIv, { authTagLength })
    cipher.on('error', err => log.err('ENC', err.message))
    return cipher
  },
  decipher: () => { 
    let decipher = crypto.createDecipheriv(cryptAlg, cryptKey, cryptIv, { authTagLength })
    decipher.on('error', err => log.err('DEC', err.message))
    return decipher
  },
  encrypt (str) {
    let cipher = this.cipher()
    try {
      return (cipher.update(str, 'utf8', 'base64') + cipher.final('base64'))
    } catch (e) {
      return null
    }
  },
  decrypt (str) {
    let decipher = this.decipher()
    try {
      return (decipher.update(str, 'base64', 'utf8') + decipher.final('utf8'))
    } catch (e) {
      return null
    }
  }
}
module.exports.crypt = crypt

module.exports.log = log
