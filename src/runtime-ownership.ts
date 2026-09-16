/** Kernel-owned workspace exclusion, released only after the guardian's children exit. */
import { createHash } from 'node:crypto'
import { userInfo } from 'node:os'
import { createServer, connect, type Server } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { OWNER_WAIT_MS } from './runtime-protocol'

const PROTOCOL = 'dsh-sidebar-owner-v1'

export interface Owner {
  protocol: typeof PROTOCOL
  key: string
  hostPid: number
}

/** The listener exposes identity only; it accepts no stop or other control commands. */
export async function claimWorkspace(cwd: string, signal: AbortSignal): Promise<{ server: Server; identity: Owner }> {
  const key = createHash('sha256').update(`${userInfo().username}\0${cwd}`).digest('hex')
  const identity: Owner = { protocol: PROTOCOL, key, hostPid: process.ppid }
  const deadline = Date.now() + OWNER_WAIT_MS
  for (let slot = 0; slot < 8; slot += 1) {
    const hash = createHash('sha256').update(`${key}:${slot}`).digest().readUInt32BE(0)
    const port = 44000 + hash % 16000
    for (;;) {
      signal.throwIfAborted()
      const server = createServer(socket => {
        socket.on('error', () => { socket.destroy() })
        socket.end(JSON.stringify(identity) + '\n')
        socket.setTimeout(1000, () => { socket.destroy() })
      })
      const bound = await new Promise<boolean>((resolve, reject) => {
        server.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') resolve(false)
          else reject(error)
        })
        server.listen(port, '127.0.0.1', () => { resolve(true) })
      })
      if (bound) return { server, identity }
      const owner = await inspectOwner(port)
      if (owner === 'gone') {
        if (Date.now() >= deadline) throw new Error('DSH workspace ownership changed repeatedly; retry startup.')
        await delay(50, undefined, { signal })
        continue
      }
      // An unknown listener might be a wedged guardian. Never skip it and create
      // a second writer; a successful identity exchange is required to skip a hash collision.
      if (owner === undefined) throw new Error(`Cannot verify DSH workspace owner on port ${port}. Retry after the previous runtime exits.`)
      if (owner.key !== key) break
      if (Date.now() >= deadline) {
        throw new Error(`This workspace is still owned by DSH Sidebar in Extension Host ${owner.hostPid}. Close that window or stop its runtime before retrying.`)
      }
      await delay(100, undefined, { signal })
    }
  }
  throw new Error('No free DSH workspace ownership endpoint; all candidates belong to other workspaces.')
}

function inspectOwner(port: number): Promise<Owner | 'gone' | undefined> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1')
    let data = ''
    const finish = (owner?: Owner | 'gone'): void => { socket.destroy(); resolve(owner) }
    socket.setTimeout(1000, () => { finish() })
    socket.on('error', (error: NodeJS.ErrnoException) => { finish(error.code === 'ECONNREFUSED' ? 'gone' : undefined) })
    socket.on('data', chunk => {
      data += chunk.toString()
      if (data.length > 4096) { finish(); return }
      if (!data.includes('\n')) return
      try {
        const owner = JSON.parse(data) as Partial<Owner>
        finish(owner.protocol === PROTOCOL && typeof owner.key === 'string' && Number.isSafeInteger(owner.hostPid) ? owner as Owner : undefined)
      } catch { finish() /* A non-guardian listener is not a valid owner. */ }
    })
    socket.on('end', () => { finish() })
  })
}
