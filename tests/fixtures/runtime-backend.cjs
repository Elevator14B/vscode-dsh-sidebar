#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const http = require('node:http')
const { spawn } = require('node:child_process')
if (process.env.FIXTURE_PID_PATH) fs.appendFileSync(process.env.FIXTURE_PID_PATH, JSON.stringify({ pid: process.pid }) + '\n')
if (process.env.FIXTURE_IGNORE_TERM === '1') process.on('SIGTERM', () => {})
if (process.env.FIXTURE_MODE === 'never-ready') {
  setInterval(() => {}, 1000)
} else {
  const server = http.createServer((req, res) => {
    if (process.env.FIXTURE_MODE === 'auth-hang') return
    const cookie = `fixture=session-${process.pid}`
    if (req.url.includes('token=fixture-token')) {
      if (process.env.FIXTURE_MODE !== 'missing-cookie') res.setHeader('set-cookie', cookie + '; HttpOnly')
    } else if (req.headers.cookie !== cookie) {
      res.writeHead(401)
      res.end('stale or missing backend cookie')
      return
    }
    res.setHeader('x-fixture-pid', String(process.pid))
    res.end('fixture')
  })
  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/?token=fixture-token`
    // Deliberately split the token to exercise stream framing.
    process.stdout.write(url.slice(0, -4))
    setTimeout(() => { process.stdout.write(url.slice(-4) + '\n') }, 20)
    if (process.env.FIXTURE_LOCK) {
      const child = spawn('flock', ['-F', process.env.FIXTURE_LOCK, process.execPath, '-e', 'setInterval(()=>{},1000)'], {
        detached: process.env.FIXTURE_MODE !== 'crash-with-child', stdio: 'ignore',
      })
      fs.appendFileSync(process.env.FIXTURE_PID_PATH, JSON.stringify({ pid: child.pid, descendant: true }) + '\n')
      child.unref()
      if (process.env.FIXTURE_MODE === 'crash-with-child') setTimeout(() => { process.exit(1) }, 50)
    }
  })
}
