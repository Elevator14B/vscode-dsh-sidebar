/** Process cleanup for private POSIX process groups and observed Linux descendants. */
import { readdirSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { STOP_GRACE_MS } from './runtime-protocol'

interface Identity { pid: number; parent: number; group: number; start: string; state: string }

function processes(): Identity[] {
  const result: Identity[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue
    try {
      const text = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
      result.push({ pid: Number(entry), parent: Number(fields[1]), group: Number(fields[2]), start: fields[19], state: fields[0] })
    } catch (error) {
      // Processes may exit between enumeration and stat; other users may hide stat.
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  return result
}

function send(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** Tracks identity as well as PID so an observed exited descendant is never killed after PID reuse. */
export class ProcessTree {
  private readonly known = new Map<number, string>()
  private groupPresent = true
  constructor(private readonly root: number) {
    if (process.platform === 'linux') {
      const entry = processes().find(p => p.pid === root)
      if (entry !== undefined) this.known.set(root, entry.start)
    }
  }

  /** Observe descendants while their parent relationships are still present. */
  sample(): number[] {
    if (process.platform !== 'linux') {
      try { process.kill(-this.root, 0); return [this.root] } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return []
        throw error
      }
    }
    const all = processes()
    const owned = new Set<number>()
    const root = all.find(p => p.pid === this.root)
    // A private group survives its leader. Once observed empty (or the leader
    // PID reused), never adopt a later group with that numeric ID.
    if (!all.some(p => p.group === this.root) || root !== undefined && this.known.get(root.pid) !== root.start) this.groupPresent = false
    for (const p of all) {
      if (this.known.get(p.pid) === p.start || this.groupPresent && p.group === this.root) owned.add(p.pid)
    }
    for (let changed = true; changed;) {
      changed = false
      for (const p of all) if (owned.has(p.parent) && !owned.has(p.pid)) { owned.add(p.pid); changed = true }
    }
    const live = all.filter(p => owned.has(p.pid) && p.state !== 'Z' && p.state !== 'X')
    for (const p of live) this.known.set(p.pid, p.start)
    return live.map(p => p.pid)
  }

  /** Stop admission at the caller before invoking; resolves only after observed processes exit. */
  async stop(): Promise<void> {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        execFile('taskkill', ['/pid', String(this.root), '/T', '/F'], { windowsHide: true }, error => {
          if (error === null) { resolve(); return }
          try { process.kill(this.root, 0); reject(error) } catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === 'ESRCH') resolve()
            else reject(probe)
          }
        })
      })
      return
    }
    let live = this.sample()
    if (live.length === 0) return
    const signalled = new Set<number>()
    if (process.platform === 'linux') {
      if (live.includes(this.root)) { send(this.root, 'SIGTERM'); signalled.add(this.root) }
    } else send(-this.root, 'SIGTERM')
    const deadline = Date.now() + STOP_GRACE_MS
    while ((live = this.sample()).length > 0) {
      if (process.platform === 'linux' && !live.includes(this.root)) {
        for (const pid of live) if (!signalled.has(pid)) { send(pid, 'SIGTERM'); signalled.add(pid) }
      }
      if (Date.now() >= deadline) {
        send(-this.root, 'SIGKILL')
        if (process.platform === 'linux') for (const pid of live) send(pid, 'SIGKILL')
      }
      // Keep ownership while an uninterruptible process still exists. The UI has
      // its own deadline; returning early here would let a new writer start.
      await delay(50)
    }
  }
}
