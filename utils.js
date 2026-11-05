'use strict'

const crypto = require('node:crypto')
const { PROTOCOL_VERSION } = require('./protocol')

// Bounds each encrypted/base64 frame, excluding its newline and raw tunnel bytes.
const MAX_CONTROL_FRAME_BYTES = 4 * 1024

function tryParseJSON(json) {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function createMessaging(config = {}) {
  const key = config.cryptKey ?? process.env.N_T_CRYPT_KEY
  if (typeof key !== 'string' || Buffer.byteLength(key) !== 32) {
    throw new Error('N_T_CRYPT_KEY must contain exactly 32 UTF-8 bytes')
  }
  const cryptKey = Buffer.from(key)
  const log = {
    info: (...args) => console.log('INFO:', ...args),
    debug: (config.logDebug ?? process.env.N_T_LOG_DEBUG === 'true') ? (...args) => console.log(...args) : undefined,
    err:
      (config.logError ?? process.env.N_T_LOG_ERROR === 'true') ? (...args) => console.error('ERR:', ...args) : () => {}
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

  function writeMessage(socket, message) {
    if (!socket || socket.destroyed || socket.writableEnded) return false
    const encrypted = crypt.encrypt(message)
    if (encrypted === null) return false
    // A false write() result means queued with backpressure, not a failed send.
    socket.write(`${encrypted}\n`)
    return true
  }

  function sendJson(socket, message) {
    return writeMessage(socket, JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...message }))
  }

  function createDecoder(onMessage, onInvalid, firstOnly) {
    let fragments = []
    let length = 0
    let stopped = false

    return function decode(data) {
      if (stopped) return
      let offset = 0
      while (offset < data.length) {
        const delimiter = data.indexOf(0x0a, offset)
        const end = delimiter < 0 ? data.length : delimiter
        const fragment = data.subarray(offset, end)
        length += fragment.length
        if (length > MAX_CONTROL_FRAME_BYTES) return invalid()

        if (delimiter < 0) {
          fragments.push(fragment)
          return
        }
        const frame = fragments.length ? Buffer.concat([...fragments, fragment], length) : fragment
        fragments = []
        length = 0
        const message = crypt.decrypt(frame.toString('ascii'))
        if (message === null) return invalid()
        offset = delimiter + 1
        if (firstOnly) {
          stopped = true
          onMessage(message, data.subarray(offset))
          return
        }
        onMessage(message)
      }
    }

    function invalid() {
      stopped = true
      fragments = []
      length = 0
      onInvalid?.()
    }
  }

  return {
    log,
    crypt,
    writeMessage,
    sendJson,
    createMessageDecoder: (onMessage, onInvalid) => createDecoder(onMessage, onInvalid, false),
    createFirstMessageDecoder: (onMessage, onInvalid) => createDecoder(onMessage, onInvalid, true)
  }
}

module.exports = { MAX_CONTROL_FRAME_BYTES, createMessaging, tryParseJSON }
