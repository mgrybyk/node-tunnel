'use strict'

const crypto = require('node:crypto')
const { PROTOCOL_VERSION, TYPES } = require('./protocol')
const { readInteger, readPort } = require('./config')

const logDebug = process.env.N_T_LOG_DEBUG === 'true'
const logError = process.env.N_T_LOG_ERROR === 'true'

module.exports.types = TYPES
module.exports.protocolVersion = PROTOCOL_VERSION

module.exports.removeElement = (array, element) => {
  const idx = array.indexOf(element)
  if (idx >= 0) {
    array.splice(idx, 1)
  }
}

const log = {
  info(...args) {
    console.log('INFO:', ...args)
  },
  debug() {},
  err() {}
}

if (logDebug) {
  log.debug = (...args) => console.log(...args)
}
if (logError) {
  log.err = (...args) => console.error('ERR:', ...args)
}

module.exports.tryParseJSON = (json, reviver) => {
  try {
    return JSON.parse(json, reviver)
  } catch (_error) {
    log.err('JSON', json)
    return null
  }
}

module.exports.verifyDataJson = dataJson => {
  if (!dataJson || typeof dataJson !== 'object' || (dataJson.type !== TYPES.CLIENT && dataJson.type !== TYPES.AGENT)) {
    log.err('invalid message type')
    return false
  }

  return true
}

module.exports.readInteger = readInteger
module.exports.readPort = readPort

if (!process.env.N_T_CRYPT_KEY) {
  console.log('WARNING: default CRYPT KEY is used!!!')
}

const cryptKey = Buffer.from(process.env.N_T_CRYPT_KEY || 'b70231120900saamkb83gsc150f162fd')
if (cryptKey.length !== 32) {
  throw new Error('N_T_CRYPT_KEY must contain exactly 32 UTF-8 bytes')
}
const cryptContext = Buffer.from('node-tunnel-control')
const cryptAlg = 'chacha20-poly1305'
const cryptVersion = 1
const ivLength = 12
const authTagLength = 16

const crypt = {
  encrypt(str) {
    try {
      const iv = crypto.randomBytes(ivLength)
      const cipher = crypto.createCipheriv(cryptAlg, cryptKey, iv, { authTagLength })
      cipher.setAAD(cryptContext)

      const encrypted = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()])

      return Buffer.concat([Buffer.from([cryptVersion]), iv, cipher.getAuthTag(), encrypted]).toString('base64')
    } catch (e) {
      log.err('ENC', e.message)
      return null
    }
  },
  decrypt(str) {
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

      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    } catch (e) {
      log.err('DEC', e.message)
      return null
    }
  }
}
module.exports.crypt = crypt

const messageDelimiter = 0x0a
const maxMessageLength = 1024 * 1024

module.exports.writeMessage = (socket, message) => {
  if (!socket || socket.destroyed) return false

  const encrypted = crypt.encrypt(message)
  if (encrypted === null) return false

  return socket.write(`${encrypted}\n`)
}

module.exports.createMessageDecoder = (onMessage, onInvalid) => {
  let pending = Buffer.alloc(0)
  let stopped = false

  return function decodeMessages(data) {
    if (stopped) return
    pending = Buffer.concat([pending, data])

    let delimiterIndex = pending.indexOf(messageDelimiter)
    while (delimiterIndex >= 0) {
      const encrypted = pending.subarray(0, delimiterIndex).toString('ascii')
      pending = pending.subarray(delimiterIndex + 1)

      const message = crypt.decrypt(encrypted)
      if (message === null) return invalid()
      onMessage(message)
      delimiterIndex = pending.indexOf(messageDelimiter)
    }

    if (pending.length > maxMessageLength) invalid()
  }

  function invalid() {
    stopped = true
    pending = Buffer.alloc(0)
    if (onInvalid) onInvalid()
  }
}

module.exports.createFirstMessageDecoder = (onMessage, onInvalid) => {
  let pending = Buffer.alloc(0)
  let completed = false

  return function decodeFirstMessage(data) {
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

  function invalid() {
    completed = true
    pending = Buffer.alloc(0)
    if (onInvalid) onInvalid()
  }
}

module.exports.log = log
