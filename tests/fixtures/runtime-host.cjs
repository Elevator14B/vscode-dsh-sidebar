'use strict'
const { fork } = require('node:child_process')
const path = require('node:path')
const guardian = fork(path.resolve(__dirname, '../../dist/runtime-guardian.js'), [], {
  detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
})
process.send({ type: 'guardian', pid: guardian.pid })
let ownership
guardian.on('message', (message, handle) => {
  if (message.type === 'ownership') {
    ownership = handle
    handle.on('connection', socket => {
      socket.on('error', () => { socket.destroy() })
      socket.end(JSON.stringify(message.identity) + '\n')
    })
  }
  if (process.connected) process.send(message)
})
guardian.on('exit', (code, signal) => {
  ownership?.close()
  if (process.connected) process.send({ type: 'guardian-exit', code, signal }, () => { process.disconnect() })
})
process.on('message', message => { if (guardian.connected) guardian.send(message) })
process.on('disconnect', () => { if (guardian.connected) guardian.disconnect() })
