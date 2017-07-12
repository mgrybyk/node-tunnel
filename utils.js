'use strict'

let dotEnvConfig = {}
if (process.argv[2]) {
  dotEnvConfig.path = process.argv[2]
}
require('dotenv').config(dotEnvConfig)
const through2 = require('through2')

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
const cryptAlg = 'aes-256-cbc'

let crypt = {
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
  },
  encryptBuf (buffer) {
    let cipher = this.cipher()
    try {
      return Buffer.concat([cipher.update(buffer), cipher.final()])
    } catch (e) {
      // console.log('buf enc', buffer.toString())
      return buffer
    }
  },
  decryptBuf (buffer) {
    let decipher = this.decipher()
    try {
      return Buffer.concat([decipher.update(buffer), decipher.final()])
    } catch (e) {
      // console.log('buf dec failed!', buffer.toString(), this.decrypt(buffer.toString()))
      return buffer
    }
  }
}
module.exports.crypt = crypt

module.exports.log = log

function transform (shiftValue) {
  return function (chunk, enc, callback) {
    // Encryption won't work this way because
    // data after encrpytion or decryption is corrupted
    if (shiftValue > 0) {
      bufShift(chunk, shiftValue)
      // chunk = crypt.encryptBuf(chunk)
    } else {
      // chunk = crypt.decryptBuf(chunk)
      bufShift(chunk, shiftValue)
    }

    this.push(chunk)
    return callback()
  }
}

function bufShift (chunk, shiftValue) {
  for (let i = 0; i < chunk.length; i++) {
    chunk[i] = chunk[i] + shiftValue
  }
}

module.exports.bufShift = (shiftConstant) => {
  return through2(transform(shiftConstant))
}
