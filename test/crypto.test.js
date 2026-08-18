'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

process.env.N_T_CRYPT_KEY = '0123456789abcdef0123456789abcdef'

const { crypt } = require('../utils')

test('an encrypted control message decrypts to its original value', () => {
  const message = JSON.stringify({
    type: 'agent',
    name: 'crypto-round-trip',
    value: '数据 survives the tunnel'
  })

  const encrypted = crypt.encrypt(message)

  assert.equal(typeof encrypted, 'string')
  assert.notEqual(encrypted, message)
  assert.equal(crypt.decrypt(encrypted), message)
})

test('encryption uses a fresh nonce and rejects modified ciphertext', () => {
  const first = crypt.encrypt('same message')
  const second = crypt.encrypt('same message')
  const modified = Buffer.from(first, 'base64')
  modified[modified.length - 1] ^= 1

  assert.notEqual(first, second)
  assert.equal(crypt.decrypt(modified.toString('base64')), null)
})
