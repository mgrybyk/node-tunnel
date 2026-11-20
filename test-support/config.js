'use strict'

const requiredEnv = Object.freeze({
  N_T_CRYPT_KEY: '0123456789abcdef0123456789abcdef',
  N_T_RELAY_HOST: '127.0.0.1',
  N_T_RELAY_BIND_HOST: '127.0.0.1',
  N_T_RELAY_PORT: '1337',
  N_T_ROUTE_ID: 'test-route',
  N_T_AGENT_DATA_HOST: '127.0.0.1',
  N_T_AGENT_DATA_PORTS: '8888',
  N_T_CLIENT_BIND_HOST: '127.0.0.1',
  N_T_CLIENT_PORTS: '8000'
})

module.exports = { requiredEnv }
