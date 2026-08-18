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
  if (!dataJson || typeof dataJson !== 'object' ||
      (dataJson.type !== types.CLIENT && dataJson.type !== types.AGENT)) {
    log.err('invalid message type')
    return false
  }

  return true
}

if (!process.env.N_T_CRYPT_KEY) {
  console.log('WARNING: default CRYPT KEY is used!!!')
}

const crypto = require('crypto')
const cryptKey = Buffer.from((process.env.N_T_CRYPT_KEY || 'b70231120900saamkb83gsc150f162fd').slice(0, 32))
const cryptContext = Buffer.from(process.env.N_T_CRYPT_IV || 'e7c3df588cc0')
const cryptAlg = 'chacha20-poly1305'
const cryptVersion = 1
const ivLength = 12
const authTagLength = 16

let crypt = {
  encrypt (str) {
    try {
      const iv = crypto.randomBytes(ivLength)
      const cipher = crypto.createCipheriv(cryptAlg, cryptKey, iv, { authTagLength })
      cipher.setAAD(cryptContext)

      const encrypted = Buffer.concat([
        cipher.update(str, 'utf8'),
        cipher.final()
      ])

      return Buffer.concat([
        Buffer.from([cryptVersion]),
        iv,
        cipher.getAuthTag(),
        encrypted
      ]).toString('base64')
    } catch (e) {
      log.err('ENC', e.message)
      return null
    }
  },
  decrypt (str) {
    try {
      const payload = Buffer.from(str, 'base64')
      const encryptedOffset = 1 + ivLength + authTagLength

      if (payload.length < encryptedOffset || payload[0] !== cryptVersion) return null

      const iv = payload.subarray(1, 1 + ivLength)
      const authTag = payload.subarray(1 + ivLength, encryptedOffset)
      const encrypted = payload.subarray(encryptedOffset)
      const decipher = crypto.createDecipheriv(cryptAlg, cryptKey, iv, { authTagLength })

      decipher.setAAD(cryptContext)
      decipher.setAuthTag(authTag)

      return Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]).toString('utf8')
    } catch (e) {
      log.err('DEC', e.message)
      return null
    }
  }
}
module.exports.crypt = crypt

const messageDelimiter = 0x0a
const maxMessageLength = 1024 * 1024

module.exports.writeMessage = function (socket, message) {
  if (!socket || socket.destroyed) return false

  const encrypted = crypt.encrypt(message)
  if (encrypted === null) return false

  return socket.write(encrypted + '\n')
}

module.exports.createMessageDecoder = function (onMessage, onInvalid) {
  let pending = Buffer.alloc(0)
  let stopped = false

  return function decodeMessages (data) {
    if (stopped) return
    pending = Buffer.concat([pending, data])

    let delimiterIndex
    while ((delimiterIndex = pending.indexOf(messageDelimiter)) >= 0) {
      const encrypted = pending.subarray(0, delimiterIndex).toString('ascii')
      pending = pending.subarray(delimiterIndex + 1)

      const message = crypt.decrypt(encrypted)
      if (message === null) return invalid()
      onMessage(message)
    }

    if (pending.length > maxMessageLength) invalid()
  }

  function invalid () {
    stopped = true
    pending = Buffer.alloc(0)
    if (onInvalid) onInvalid()
  }
}

module.exports.createFirstMessageDecoder = function (onMessage, onInvalid) {
  let pending = Buffer.alloc(0)
  let completed = false

  return function decodeFirstMessage (data) {
    if (completed) return
    pending = Buffer.concat([pending, data])

    const delimiterIndex = pending.indexOf(messageDelimiter)
    if (delimiterIndex < 0) {
      if (pending.length > maxMessageLength) invalid()
      return
    }

    completed = true
    const encrypted = pending.subarray(0, delimiterIndex).toString('ascii')
    const remainder = pending.subarray(delimiterIndex + 1)
    pending = Buffer.alloc(0)

    const message = crypt.decrypt(encrypted)
    if (message === null) {
      if (onInvalid) onInvalid()
      return
    }

    onMessage(message, remainder)
  }

  function invalid () {
    completed = true
    pending = Buffer.alloc(0)
    if (onInvalid) onInvalid()
  }
}

module.exports.log = log
