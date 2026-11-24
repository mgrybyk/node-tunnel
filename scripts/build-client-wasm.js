'use strict'

const { spawnSync } = require('node:child_process')
const { copyFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const crate = join(root, 'rust')
const target = 'wasm32-unknown-unknown'
const targetDir = join(crate, 'target')

const result = spawnSync('cargo', ['build', '--locked', '--release', '--target', target, '--target-dir', targetDir], {
  cwd: crate,
  stdio: 'inherit'
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

copyFileSync(join(targetDir, target, 'release', 'node_tunnel_client.wasm'), join(crate, 'client.wasm'))
