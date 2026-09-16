/**
 * DSH Sidebar — extension host.
 *
 * Owns the sidebar webview shell and the small native command surface:
 * opening files, opening HEAD↔working-tree diffs, resolving VS Code drag
 * payloads into workspace-relative `@path#Lx-Ly` references, and relaying
 * messages between the webview iframe and the injected bridge script.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import { DshRuntime } from './runtime'
import { archiveSession, moveSessionBefore, planMove, planStep } from './session-actions'
import { SessionsProvider, type SessionNode } from './session-panel'
import { summarizeStartupError } from './startup-error'

/** One decoded VS Code drag source (frozen contract v2). */
export interface DragEntry {
  readonly uri?: string
  readonly text?: string
  /** Raw 'vscode-editor-data' JSON, forwarded verbatim by the bridge. */
  readonly editorData?: string
}

/** Decoded 'resolveReferences' request payload (frozen contract v2). */
export interface DropPayload {
  readonly entries?: readonly DragEntry[]
  /**
   * The bridge's hint that an editor selection is a plausible drag source. The
   * v2 resolver does not consult it: ranges are recovered from remembered
   * selections and the active document instead (the bridge still uses the flag
   * for its own text-fallback decision).
   */
  readonly useActiveEditor?: boolean
  readonly dropPoint?: { readonly x: number; readonly y: number }
}

/** Payload of the bridge's 'writeClipboard' request: the text to copy. */
interface ClipboardPayload {
  readonly text?: string
}

/** One 1-based, inclusive line range inside a document. */
export interface LineRange {
  readonly startLine: number
  readonly endLine: number
}

interface ResolvedReference {
  readonly path: string
  readonly mention: string
  readonly label: string
  readonly appearance: 'file'
}

interface BridgeEnvelope {
  readonly source?: string
  readonly type?: string
  readonly requestType?: string
  readonly requestId?: string
  readonly href?: string
  readonly path?: string
  readonly line?: number
  readonly oldText?: string | null
  readonly newText?: string | null
  readonly types?: readonly string[]
  readonly entryCount?: number
  readonly mayReference?: boolean
  readonly count?: number
  readonly text?: string
  readonly payload?: DropPayload & ClipboardPayload
  /** 'reference-result' outcome reported by the bridge (contract v2). */
  readonly outcome?: string
  /** Machine reason for an empty refs list or a failed reference result. */
  readonly reason?: string
  readonly attempts?: number
  readonly mentions?: readonly string[]
  readonly workspaceId?: string
  readonly sessionIds?: readonly string[]
  readonly archivedSessionIds?: readonly string[]
  readonly sessionId?: string
  readonly message?: string
  readonly url?: string
  /** Requested browser for `open-url`: 'internal' (default) or 'external'. */
  readonly target?: string
  /** Requested editor column for `open-file`: 'beside' opens in the side group. */
  readonly column?: string
}

function firstWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders
  if (folders === undefined || folders.length === 0) return undefined
  const configured = vscode.workspace.getConfiguration('dsh.embed').get<string>('workspaceFolder', '').trim()
  if (configured !== '') {
    return folders.find(folder => path.resolve(folder.uri.fsPath) === path.resolve(configured)) ?? folders[0]
  }
  return folders[0]
}

/** Map the active VS Code theme to the DSH boot preference. */
function themeFor(): 'light' | 'dark' {
  const kind = vscode.window.activeColorTheme.kind
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark'
}

/** Durable JSONL trace plus a loopback control/status server for agent diagnosis. */
class Telemetry {
  private readonly dir = path.join(homedir(), '.dsh', 'vscode-embed')
  private readonly logPath = path.join(this.dir, 'telemetry.jsonl')
  private readonly statePath = path.join(this.dir, 'current.json')
  private readonly events: Array<{ time: string; event: string; data?: Record<string, unknown> }> = []
  private readonly state: Record<string, unknown> = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    logPath: this.logPath,
  }
  private server: ReturnType<typeof createServer> | undefined

  /**
   * @param output - Shared VSCode output channel mirrored by telemetry lines.
   * @param onRestart - Invoked by `POST /restart` from a local diagnostic client.
   */
  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly onRestart: () => void,
  ) {
    try {
      mkdirSync(this.dir, { recursive: true })
      this.server = createServer((req, res) => { void this.handle(req, res) })
      this.server.on('error', error => { this.output.appendLine(`[telemetry] server error: ${String(error)}`) })
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server?.address()
        if (address !== null && typeof address === 'object') this.state.httpPort = address.port
        this.persist()
      })
    } catch (error) {
      this.output.appendLine(`[telemetry] disabled: ${String(error)}`)
    }
  }

  /** Append one structured event and mirror it into the VSCode output channel. */
  log(event: string, data?: Record<string, unknown>): void {
    if (event === 'shell.shell-heartbeat') {
      this.state.lastHeartbeatAt = new Date().toISOString()
      return
    }
    const row = { time: new Date().toISOString(), event, ...(data === undefined ? {} : { data }) }
    this.events.push(row)
    if (this.events.length > 200) this.events.shift()
    this.state.lastEvent = row
    try {
      appendFileSync(this.logPath, `${JSON.stringify(row)}\n`, 'utf8')
    } catch (_error) {
      /* disk telemetry failure must not break runtime startup */
    }
    this.output.appendLine(`[telemetry] ${event} ${data === undefined ? '' : JSON.stringify(data)}`)
  }

  /** Update one stable state field shown by `/status`. */
  set(key: string, value: unknown): void {
    this.state[key] = value
    this.persist()
  }

  /** Close the control server and clear this process's current.json. */
  dispose(): void {
    try {
      this.server?.close()
    } catch (_error) {
      /* already closed */
    }
    try {
      const current = JSON.parse(readFileSync(this.statePath, 'utf8')) as { pid?: number }
      if (current.pid === process.pid) rmSync(this.statePath, { force: true })
    } catch (_error) {
      /* no current state or another window already replaced it */
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8')
    } catch (_error) {
      /* state file is advisory */
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/ping') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('pong')
      return
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(this.state, null, 2))
      return
    }
    if (req.method === 'GET' && url.pathname === '/logs') {
      const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('tail') ?? '200') || 200))
      let lines: string[] = []
      try {
        lines = readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean).slice(-limit)
      } catch (_error) {
        /* no log yet */
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
      res.end(lines.length === 0 ? '' : `${lines.join('\n')}\n`)
      return
    }
    if (req.method === 'POST' && url.pathname === '/restart') {
      this.log('telemetry.restart')
      this.onRestart()
      res.writeHead(202, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('restarting')
      return
    }
    if (req.method === 'POST' && url.pathname === '/reload') {
      this.log('telemetry.reload-window')
      void vscode.commands.executeCommand('workbench.action.reloadWindow')
      res.writeHead(202, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('reloading')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}

/** One decoded VS Code drag source. */
interface DragTarget {
  readonly uri: vscode.Uri
  readonly startLine?: number
  readonly endLine?: number
}

function selectionFromFragment(fragment: string): { startLine?: number; endLine?: number } {
  const match = /^L?(\d+)(?:,\d+)?(?:-L?(\d+)(?:,\d+)?)?$/u.exec(fragment)
  if (match === null) return {}
  const startLine = Number(match[1])
  const endLine = match[2] === undefined ? startLine : Number(match[2])
  return { startLine, endLine }
}

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1)
  return trimmed
}

function resolveFileUri(raw: string): vscode.Uri | undefined {
  const text = stripSurroundingQuotes(raw)
  if (text.startsWith('~')) {
    const expanded = path.join(homedir(), text.slice(1))
    return vscode.Uri.file(expanded)
  }
  try {
    const parsed = vscode.Uri.parse(text, true)
    if (parsed.scheme === 'file') return parsed
    // Remote-SSH drags carry `vscode-remote://<authority>/<abs>` (and legacy
    // `vscode-remote-resource`/`vscode-file` forms) instead of file: URIs.
    // The path is already the Host-absolute path; open it as a file URI.
    if (parsed.scheme.startsWith('vscode-') && parsed.path !== '' && path.isAbsolute(parsed.path)) {
      return vscode.Uri.file(parsed.path)
    }
  } catch (_error) {
    /* fall through to path resolution */
  }
  const folder = firstWorkspaceFolder()
  if (path.isAbsolute(text)) return vscode.Uri.file(text)
  if (folder !== undefined) return vscode.Uri.joinPath(folder.uri, text)
  return undefined
}

function toPosix(value: string): string {
  return value.replace(/\\/gu, '/')
}

function relativeLabel(uri: vscode.Uri): string {
  const relative = toPosix(vscode.workspace.asRelativePath(uri, false))
  return relative === '' ? toPosix(uri.fsPath) : relative
}

function formatMention(relative: string, startLine?: number, endLine?: number): string {
  const location = startLine === undefined
    ? ''
    : `#L${String(startLine)}${endLine !== undefined && endLine > startLine ? `-L${String(endLine)}` : ''}`
  const base = /[\s"#]/u.test(relative) ? `@"${relative.replaceAll('"', '')}"` : `@${relative}`
  return base + location
}

function formatLabel(relative: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined) return relative
  return `${relative}:${String(startLine)}${endLine !== undefined && endLine > startLine ? `-${String(endLine)}` : ''}`
}

function referenceFromTarget(target: DragTarget): ResolvedReference {
  const relative = relativeLabel(target.uri)
  return {
    path: target.uri.fsPath,
    mention: formatMention(relative, target.startLine, target.endLine),
    label: formatLabel(relative, target.startLine, target.endLine),
    appearance: 'file',
  }
}

function activeEditorTarget(): DragTarget | undefined {
  const editor = vscode.window.activeTextEditor
  if (editor === undefined || editor.document.uri.scheme !== 'file') return undefined
  const selection = editor.selection
  const startLine = selection.start.line + 1
  const endLine = selection.end.character === 0 && selection.end.line > selection.start.line
    ? selection.end.line
    : selection.end.line + 1
  if (selection.isEmpty) return { uri: editor.document.uri }
  return {
    uri: editor.document.uri,
    startLine,
    endLine: Math.max(startLine, endLine),
  }
}

/**
 * The active editor's live selection when it owns the dropped uri. A resource
 * drag (an editor tab or an Explorer row) is the only drag VS Code delivers to
 * a webview: dragging the editor's own selection is an internal editor gesture
 * (dnd.ts / DragAndDropCommand) that never sets dataTransfer, and workbench
 * drags disable pointer events over webview iframes. So when the user drags
 * the tab of the file they just selected text in, that live selection is the
 * closest workable stand-in for the gesture they meant.
 */
function activeEditorSelectionTarget(uri: vscode.Uri): DragTarget | undefined {
  const editor = vscode.window.activeTextEditor
  if (editor === undefined || editor.document.uri.scheme !== 'file') return undefined
  if (editor.selection.isEmpty) return undefined
  if (editor.document.uri.fsPath !== uri.fsPath) return undefined
  const target = activeEditorTarget()
  if (target === undefined || target.startLine === undefined) return undefined
  return { uri, startLine: target.startLine, endLine: target.endLine }
}

export function targetsFromPayload(payload: BridgeEnvelope['payload']): ResolvedReference[] {
  const targets: DragTarget[] = []
  if (payload?.useActiveEditor === true) {
    const active = activeEditorTarget()
    if (active !== undefined) targets.push(active)
  }
  for (const entry of payload?.entries ?? []) {
    if (typeof entry.uri === 'string') {
      const parsed = resolveFileUri(entry.uri)
      if (parsed === undefined) continue
      const selection = selectionFromFragment(parsed.fragment)
      targets.push({ uri: parsed.with({ fragment: '' }), ...selection })
      continue
    }
    if (typeof entry.text === 'string') {
      const parsed = resolveFileUri(entry.text)
      if (parsed !== undefined) targets.push({ uri: parsed.with({ fragment: '' }) })
    }
  }
  const seen = new Set<string>()
  const refs: ResolvedReference[] = []
  for (const target of targets) {
    const ref = referenceFromTarget(target)
    const key = `${ref.path}|${String(target.startLine ?? '')}|${String(target.endLine ?? '')}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}

/** One editor selection remembered for drag recovery, keyed by document URI. */
interface RememberedSelection extends LineRange {
  readonly key: string
  readonly text: string
}

/** How many distinct documents keep a remembered selection. */
const REMEMBERED_SELECTION_LIMIT = 64
/** The bridge drops longer text entries, so remembering them buys nothing. */
const DRAG_TEXT_LIMIT = 20_000

const rememberedSelections = new Map<string, RememberedSelection>()

/** Normalize line endings so a CRLF drag still matches an LF selection. */
function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, '\n')
}

/** Comparable form of dragged/selected text: line endings normalized, then trimmed. */
function normalizedDragText(value: string): string {
  return normalizeLineEndings(value).trim()
}

/**
 * Remember the last non-empty selection of one document so a later drop can
 * recover its exact range from plain text alone - the editor that is active
 * when the bridge resolves a payload is not necessarily the drag source.
 * @param uri - Document URI (or its string form) that owns the selection.
 * @param startLine - 1-based first line of the selection.
 * @param endLine - 1-based last line of the selection.
 * @param text - Exact selected text, as reported by document.getText(selection).
 */
export function rememberSelection(uri: string | vscode.Uri, startLine: number, endLine: number, text: string): void {
  const key = typeof uri === 'string' ? uri : uri.toString()
  const trimmed = text.trim()
  if (key === '' || trimmed === '' || trimmed.length > DRAG_TEXT_LIMIT) return
  const start = Number.isFinite(startLine) ? Math.max(1, Math.floor(startLine)) : 1
  const end = Number.isFinite(endLine) ? Math.max(start, Math.floor(endLine)) : start
  // Delete + set keeps Map insertion order equal to recency, so the bounded
  // eviction below always drops the least recently remembered document.
  rememberedSelections.delete(key)
  rememberedSelections.set(key, { key, startLine: start, endLine: end, text })
  while (rememberedSelections.size > REMEMBERED_SELECTION_LIMIT) {
    const oldest = rememberedSelections.keys().next()
    if (oldest.done === true) break
    rememberedSelections.delete(oldest.value)
  }
}

/** The most recently remembered selection whose text matches the dropped text. */
function rememberedSelectionFor(text: string): RememberedSelection | undefined {
  const needle = normalizedDragText(text)
  if (needle === '') return undefined
  let match: RememberedSelection | undefined
  for (const entry of rememberedSelections.values()) {
    if (normalizedDragText(entry.text) === needle) match = entry
  }
  return match
}

/** One 'vscode-editor-data' JSON value; the exact shape varies by VS Code version. */
interface EditorDataShape {
  readonly resource?: unknown
  readonly selections?: unknown
  readonly fsPath?: unknown
  readonly path?: unknown
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Document URI named by one 'vscode-editor-data' payload. */
function editorDataUri(data: EditorDataShape): vscode.Uri | undefined {
  const resource = data.resource
  if (typeof resource === 'string') return resolveFileUri(resource)
  if (typeof resource === 'object' && resource !== null) {
    const record = resource as Record<string, unknown>
    // 'external' is a real URI; 'path' may be a Windows '/c:/...' form, so it
    // is the last of the three candidates.
    const raw = stringField(record.fsPath) ?? stringField(record.external) ?? stringField(record.path)
    if (raw !== undefined) return resolveFileUri(raw)
  }
  const fallback = stringField(data.fsPath) ?? stringField(data.path)
  return fallback === undefined ? undefined : resolveFileUri(fallback)
}

/** Line range carried by one selections[] item (VS Code names vary). */
function editorDataSelectionLines(selection: unknown): LineRange | undefined {
  if (typeof selection !== 'object' || selection === null) return undefined
  const record = selection as Record<string, unknown>
  const start = record.startLineNumber ?? record.startLine
  const end = record.endLineNumber ?? record.endLine ?? start
  if (typeof start !== 'number' || !Number.isFinite(start)) return undefined
  const startLine = Math.max(1, Math.floor(start))
  const endLine = typeof end === 'number' && Number.isFinite(end) ? Math.max(startLine, Math.floor(end)) : startLine
  return { startLine, endLine }
}

/**
 * Convert the 'vscode-editor-data' JSON VS Code attaches to editor drags into a
 * drag target. Multi-cursor drags collapse to the union of all selections so no
 * dragged line is lost; a payload without selections is a whole-file drag.
 */
function editorDataTarget(raw: string): DragTarget | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (_error) {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const data = parsed as EditorDataShape
  const uri = editorDataUri(data)
  if (uri === undefined) return undefined
  let startLine: number | undefined
  let endLine: number | undefined
  for (const selection of Array.isArray(data.selections) ? data.selections : []) {
    const lines = editorDataSelectionLines(selection)
    if (lines === undefined) continue
    startLine = startLine === undefined ? lines.startLine : Math.min(startLine, lines.startLine)
    endLine = endLine === undefined ? lines.endLine : Math.max(endLine, lines.endLine)
  }
  if (startLine === undefined || endLine === undefined) return { uri: uri.with({ fragment: '' }) }
  return { uri: uri.with({ fragment: '' }), startLine, endLine }
}

/** Map a verbatim match of a needle inside a document to a 1-based line range. */
function lineRangeOfTextMatch(document: vscode.TextDocument, needle: string): LineRange | undefined {
  const haystack = normalizeLineEndings(document.getText())
  const index = haystack.indexOf(needle)
  if (index < 0) return undefined
  const startLine = haystack.slice(0, index).split('\n').length
  const match = haystack.slice(index, index + needle.length)
  const newlines = match.split('\n').length - 1
  // A trailing newline means the match ended at the start of a line that is not
  // part of it - the same rule the selection reference uses.
  const endLine = match.endsWith('\n') && newlines > 0 ? startLine + newlines - 1 : startLine + newlines
  return { startLine, endLine: Math.max(startLine, endLine) }
}

/** The active editor's document match for one dropped plain-text entry. */
function activeDocumentTextTarget(text: string): DragTarget | undefined {
  const editor = vscode.window.activeTextEditor
  if (editor === undefined || editor.document.uri.scheme !== 'file') return undefined
  const candidates = Array.from(new Set([normalizeLineEndings(text), normalizedDragText(text)]))
  for (const candidate of candidates) {
    if (candidate.trim() === '') continue
    const lines = lineRangeOfTextMatch(editor.document, candidate)
    if (lines !== undefined) return { uri: editor.document.uri.with({ fragment: '' }), ...lines }
  }
  return undefined
}

/** A dropped plain-text entry that names a file rather than a code excerpt. */
function looksLikeFilePath(text: string): boolean {
  const value = text.trim()
  if (value === '' || /[\r\n]/u.test(value) || value.length > 4096) return false
  if (/^(~?[./\\]|[A-Za-z]:[\\/])/u.test(value)) return true
  return value.includes('/') || value.includes('\\')
}

/**
 * True when one text entry is just a resource label: an Explorer or editor-tab
 * drag puts the dragged file's label on text/plain instead of code. Such an
 * entry must not match a remembered selection or the active document, because
 * the bare uri already names the file and a label that happens to appear in the
 * open editor (an import path, a string literal) would add a spurious second
 * reference. The trimmed text is compared against every uri entry's href, path,
 * basename, and workspace-relative path.
 * @param entry - The text entry being resolved.
 * @param entries - All entries of the same payload.
 */
export function isResourceLabelText(entry: DragEntry, entries: readonly DragEntry[]): boolean {
  const text = typeof entry.text === 'string' ? entry.text.trim() : ''
  if (text === '') return false
  for (const candidate of entries) {
    if (typeof candidate.uri !== 'string' || candidate.uri.trim() === '') continue
    const parsed = resolveFileUri(candidate.uri)
    if (parsed === undefined) continue
    const forms = [
      candidate.uri.trim(),
      parsed.toString(),
      parsed.fsPath,
      parsed.path,
      path.basename(parsed.fsPath),
      path.basename(parsed.path),
      relativeLabel(parsed),
    ]
    for (const form of forms) {
      if (form !== '' && form === text) return true
    }
  }
  return false
}

/** Dedupe key for one resolved target: same file plus same line range. */
function targetKey(target: DragTarget): string {
  return [target.uri.fsPath, String(target.startLine ?? ''), String(target.endLine ?? '')].join('|')
}

/** Why a drag payload produced no reference; the host forwards this to the bridge. */
type DropReason = 'empty-payload' | 'unresolved-text' | 'unresolved-drop'

/** Result of one drag resolution: references plus the reason the list is empty. */
interface DropResolution {
  readonly refs: ResolvedReference[]
  readonly reason?: DropReason
}

/**
 * Resolve one drag payload with the frozen contract-v2 priority list:
 * editorData, then a uri with a #Lx-Ly fragment, then plain text matching a
 * remembered selection, then plain text found verbatim in the active document,
 * then a bare uri (the active editor's live selection when that file is the
 * active editor and the selection is non-empty, otherwise the whole file), then
 * path-looking text. Each entry is consumed by the first stage that matches it
 * and refs are deduplicated.
 */
export function resolveDropTargetsDetailed(payload?: DropPayload): DropResolution {
  const entries: readonly DragEntry[] = Array.isArray(payload?.entries) ? payload.entries : []
  const consumed = entries.map(() => false)
  const targets: DragTarget[] = []
  const seen = new Set<string>()
  const add = (target: DragTarget | undefined): void => {
    if (target === undefined) return
    const key = targetKey(target)
    if (seen.has(key)) return
    seen.add(key)
    targets.push(target)
  }
  // 1. The exact editor drag data, when VS Code attached it, beats everything.
  entries.forEach((entry, index) => {
    if (typeof entry.editorData !== 'string') return
    const target = editorDataTarget(entry.editorData)
    if (target === undefined) return
    consumed[index] = true
    add(target)
  })
  // 2. A uri line that already carries a #Lx-Ly fragment is exact.
  entries.forEach((entry, index) => {
    if (consumed[index] === true || typeof entry.uri !== 'string') return
    const parsed = resolveFileUri(entry.uri)
    if (parsed === undefined) return
    const selection = selectionFromFragment(parsed.fragment)
    if (selection.startLine === undefined || selection.endLine === undefined) return
    consumed[index] = true
    add({ uri: parsed.with({ fragment: '' }), ...selection })
  })
  // 3. Plain text equal (after trim) to a remembered selection recovers its range.
  entries.forEach((entry, index) => {
    if (consumed[index] === true || typeof entry.text !== 'string') return
    if (isResourceLabelText(entry, entries)) return
    const remembered = rememberedSelectionFor(entry.text)
    if (remembered === undefined) return
    const parsed = resolveFileUri(remembered.key)
    if (parsed === undefined) return
    consumed[index] = true
    add({ uri: parsed.with({ fragment: '' }), startLine: remembered.startLine, endLine: remembered.endLine })
  })
  // 4. Otherwise search the active document for the dropped text verbatim.
  entries.forEach((entry, index) => {
    if (consumed[index] === true || typeof entry.text !== 'string') return
    if (isResourceLabelText(entry, entries)) return
    const target = activeDocumentTextTarget(entry.text)
    if (target === undefined) return
    consumed[index] = true
    add(target)
  })
  // 5. A uri without a usable fragment names a whole file - unless it is the
  // active editor and that editor has a live selection, which is the only
  // workable stand-in for the editor's own (webview-invisible) drag gesture.
  entries.forEach((entry, index) => {
    if (consumed[index] === true || typeof entry.uri !== 'string') return
    const parsed = resolveFileUri(entry.uri)
    if (parsed === undefined) return
    consumed[index] = true
    const target = parsed.with({ fragment: '' })
    add(activeEditorSelectionTarget(target) ?? { uri: target })
  })
  // 6. Plain text that names a path is a whole-file reference too. A resource
  // label whose own uri entry is already in the payload adds nothing here: the
  // uri stage referenced that file (with the live selection when there is one),
  // so resolving the label again would produce a second chip for one drag.
  entries.forEach((entry, index) => {
    if (consumed[index] === true || typeof entry.text !== 'string') return
    if (isResourceLabelText(entry, entries)) return
    if (!looksLikeFilePath(entry.text)) return
    const parsed = resolveFileUri(entry.text)
    if (parsed === undefined) return
    consumed[index] = true
    add({ uri: parsed.with({ fragment: '' }) })
  })
  const refs = targets.map(referenceFromTarget)
  if (refs.length > 0) return { refs }
  const hasText = entries.some(entry => typeof entry.text === 'string')
  return { refs, reason: entries.length === 0 ? 'empty-payload' : hasText ? 'unresolved-text' : 'unresolved-drop' }
}

/**
 * Resolve one drag payload into exact @path#Lx-Ly references (contract v2).
 * @param payload - Decoded resolveReferences request payload.
 * @returns Deduplicated references; empty when nothing could be resolved.
 */
export function resolveDropTargets(payload?: DropPayload): ResolvedReference[] {
  return resolveDropTargetsDetailed(payload).refs
}

/**
 * Open one file in the editor, landing on a line when the caller named one.
 * @param raw - absolute or workspace-relative path from the page.
 * @param line - optional 1-based line to reveal; clamped to the document.
 */
async function openFilePath(raw: string, line?: number, column?: string): Promise<void> {
  const uri = resolveFileUri(raw)
  if (uri === undefined) {
    void vscode.window.showWarningMessage(`DSH Sidebar: cannot resolve path ${raw}`)
    return
  }
  const document = await vscode.workspace.openTextDocument(uri)
  const options: vscode.TextDocumentShowOptions = { preview: true, preserveFocus: false }
  // The delivery card's own split button asked for the side group; everything
  // else takes the active one, where the user is already reading.
  if (column === 'beside') options.viewColumn = vscode.ViewColumn.Beside
  if (typeof line === 'number' && Number.isFinite(line) && line > 0) {
    const target = Math.min(Math.floor(line) - 1, Math.max(0, document.lineCount - 1))
    options.selection = new vscode.Range(target, 0, target, 0)
  }
  await vscode.window.showTextDocument(document, options)
}

/**
 * Select one workspace file in the Explorer, the VS Code counterpart of the
 * web card's "reveal in the file manager" action. The page runs on the side
 * that owns the files, so the reveal happens in this window's own tree.
 * @param raw - absolute or workspace-relative path from the page.
 */
async function revealFilePath(raw: string): Promise<void> {
  const uri = resolveFileUri(raw)
  if (uri === undefined) {
    void vscode.window.showWarningMessage(`DSH Sidebar: cannot resolve path ${raw}`)
    return
  }
  await vscode.commands.executeCommand('revealInExplorer', uri)
}

/**
 * Open one link from the page. The internal Simple Browser is the default; a
 * link's context menu asks for the desktop browser instead, which is the only
 * target that brings the user's own sign-in state. `mailto:` has no in-page
 * browser at all, so it always leaves VS Code.
 * @param raw - absolute http(s) or mailto URL from the page.
 * @param target - requested browser: internal (default) or external.
 */
async function openUrlEmbedded(raw: string, target?: string): Promise<void> {
  const url = vscode.Uri.parse(raw, true)
  if (url.scheme !== 'http' && url.scheme !== 'https' && url.scheme !== 'mailto') return
  if (target === 'external' || url.scheme === 'mailto') {
    await vscode.env.openExternal(url)
    return
  }
  // Simple Browser is bundled with the desktop client (not the remote server),
  // so a getCommands probe on a remote extension host never sees it — always
  // try the command and fall back only when it actually throws.
  try {
    await vscode.commands.executeCommand('simpleBrowser.show', url.toString(true))
    return
  } catch (_error) {
    await vscode.commands.executeCommand('vscode.open', url)
  }
}

function execFileText(file: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, [...args], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(error === null ? stdout : '')
    })
  })
}

/** Nearest ancestor containing a `.git` directory or worktree pointer. */
function gitRootOf(absPath: string): string | undefined {
  let dir = path.dirname(absPath)
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

async function gitHeadContent(absPath: string): Promise<string> {
  const repoRoot = gitRootOf(absPath)
  const fallbackFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absPath)) ?? firstWorkspaceFolder()
  const roots = Array.from(new Set(
    [repoRoot, fallbackFolder?.uri.fsPath].filter((value): value is string => value !== undefined),
  ))
  for (const root of roots) {
    const relative = path.relative(root, absPath)
    if (relative === '' || relative.startsWith('..')) continue
    // The nearest repository wins: a workspace may be a plain folder whose
    // subdirectories are separate git worktrees.
    return execFileText('git', ['show', `HEAD:${toPosix(relative)}`], root)
  }
  return ''
}

/** Serves immutable HEAD content for the left side of a `vscode.diff`. */
class GitHeadContentProvider implements vscode.TextDocumentContentProvider {
  private readonly change = new vscode.EventEmitter<vscode.Uri>()
  /** Native diff reload hook (currently only the user's own save needs it). */
  readonly onDidChange = this.change.event

  /** @inheritdoc */
  provideTextDocumentContent(uri: vscode.Uri): Thenable<string> {
    const encoded = uri.query === '' ? uri.path.replace(/^\//u, '') : uri.query
    const absPath = Buffer.from(encoded, 'base64url').toString('utf8')
    return gitHeadContent(absPath)
  }
}

function gitUri(absPath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: 'dsh-git',
    path: '/',
    query: Buffer.from(absPath, 'utf8').toString('base64url'),
  })
}

/** One-shot inline before/after texts for the tool-call change diff. */
const inlineDiffCache = new Map<string, string>()
let inlineDiffSeq = 0

function inlineDiffUri(text: string): vscode.Uri {
  inlineDiffSeq += 1
  const id = String(inlineDiffSeq)
  inlineDiffCache.set(id, text)
  return vscode.Uri.from({ scheme: 'dsh-inline', path: '/', query: id })
}

/** Serves the before/after virtual documents of one tool-call change. */
class InlineDiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly change = new vscode.EventEmitter<vscode.Uri>()
  /** Diff documents are immutable; the emitter is kept for API shape only. */
  readonly onDidChange = this.change.event

  /** @inheritdoc */
  provideTextDocumentContent(uri: vscode.Uri): string {
    return inlineDiffCache.get(uri.query) ?? ''
  }
}

async function openDiffPath(raw: string, oldText?: string | null, newText?: string | null): Promise<void> {
  const uri = resolveFileUri(raw)
  if (uri === undefined) {
    void vscode.window.showWarningMessage(`DSH Sidebar: cannot resolve path ${raw}`)
    return
  }
  const relative = relativeLabel(uri)
  if (typeof oldText === 'string' || typeof newText === 'string') {
    // The tool's own change (old_string → new_string), independent of git.
    const left = inlineDiffUri(oldText ?? '')
    const right = inlineDiffUri(newText ?? '')
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${relative} (edit change)`,
      { preview: true },
    )
    return
  }
  const left = gitUri(uri.fsPath)
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    uri,
    `${relative} (HEAD ↔ working tree)`,
    { preview: true },
  )
}

function nonce(): string {
  return randomBytes(18).toString('base64')
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function shellHtml(webview: vscode.Webview, body: string, script: string): string {
  const scriptNonce = nonce()
  const csp = [
    "default-src 'none'",
    'frame-src http://127.0.0.1:* http://localhost:* https:',
    'connect-src http://127.0.0.1:* http://localhost:* https:',
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${scriptNonce}'`,
  ].join('; ')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; background: transparent; }
  iframe { display: block; width: 100%; height: 100%; border: 0; }
  .status { box-sizing: border-box; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; padding: 24px; font: 13px/1.5 var(--vscode-font-family, system-ui); color: var(--vscode-foreground); text-align: center; }
  .startup-error { display: block; overflow: auto; text-align: left; user-select: text; overflow-wrap: anywhere; }
  .startup-error h1 { font-size: 16px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  button { font: inherit; cursor: pointer; padding: 6px 10px; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
</style>
</head>
<body>
${body}
<script nonce="${scriptNonce}">
${script}
</script>
</body>
</html>`
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.searchParams.has('token')) url.searchParams.set('token', '<redacted>')
    return url.href
  } catch (_error) {
    return value
  }
}

/** Sidebar view provider: iframe shell plus iframe↔extension message relay. */
class DshWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private bridgeReady = false
  private pendingRefs: ResolvedReference[] = []
  private startupError: string | undefined

  /** Queue reference chips for the bridge; delivered when the iframe bridge reports ready. */
  pushRefs(refs: readonly ResolvedReference[]): void {
    this.pendingRefs.push(...refs)
    this.flushPendingRefs()
  }

  /** Called when the inner bridge reports ready — host→iframe channel is live. */
  markBridgeReady(): void {
    this.bridgeReady = true
    // The boot-time configure was posted before the iframe's bridge listener
    // existed; resend it now that the bridge answers.
    this.post({
      type: 'configure',
      theme: themeFor(),
      ...(this.folder === undefined ? {} : { cwd: this.folder.uri.fsPath, title: this.folder.name }),
    })
    this.flushPendingRefs()
  }

  /** Push a live theme change into the DSH page. */
  updateTheme(theme: 'light' | 'dark'): void {
    this.post({
      type: 'configure',
      theme,
      ...(this.folder === undefined ? {} : { cwd: this.folder.uri.fsPath, title: this.folder.name }),
    })
  }

  private flushPendingRefs(): void {
    if (!this.bridgeReady || this.view === undefined || this.pendingRefs.length === 0) return
    const refs = this.pendingRefs.splice(0)
    this.post({ type: 'insert-refs', refs })
  }

  /**
   * @param context - Extension context for resource roots.
   * @param runtime - Workspace runtime; undefined when no folder is open.
   * @param folder - Pinned workspace folder.
   * @param onBridgeMessage - Host-side message handler.
   * @param telemetry - Structured event sink.
   * @param output - This window's runtime log, opened by the error page.
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: DshRuntime | undefined,
    private readonly folder: vscode.WorkspaceFolder | undefined,
    private readonly onBridgeMessage: (message: BridgeEnvelope) => void,
    private readonly telemetry: (event: string, data?: Record<string, unknown>) => void,
    private readonly output: vscode.OutputChannel,
  ) {
    if (runtime !== undefined) {
      runtime.onDidChange(() => { this.reload() }, undefined, this.context.subscriptions)
    }
  }

  /** @inheritdoc */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    }
    this.telemetry('webview.resolve')
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (typeof message !== 'object' || message === null) return
      const action = message as BridgeEnvelope
      if (action.source === 'dsh-vscode-startup-error') {
        if (this.view !== view || this.startupError === undefined) return
        switch (action.type) {
          case 'copy-error':
            try {
              await vscode.env.clipboard.writeText(this.startupError)
              void vscode.window.showInformationMessage('DSH Sidebar: full error copied.')
            } catch (error) {
              this.output.appendLine(`[clipboard] ${String(error)}`)
              this.output.show(true)
              void vscode.window.showWarningMessage('DSH Sidebar: could not copy the error. Select it in the output log.')
            }
            break
          case 'open-log':
            this.output.show(true)
            break
          case 'retry':
            this.reload()
            break
        }
        return
      }
      this.onBridgeMessage(message as BridgeEnvelope)
    })
    this.reload()
  }

  /** Post one host message through the outer relay into the iframe. */
  post(message: unknown): void {
    if (this.view === undefined) return
    void this.view.webview.postMessage({ __dshHost: true, source: 'dsh-vscode-host', ...(message as Record<string, unknown>) })
  }

  private reload(): void {
    const view = this.view
    if (view === undefined) return
    this.startupError = undefined
    this.bridgeReady = false
    if (this.runtime === undefined || this.folder === undefined) {
      this.telemetry('webview.no-folder')
      view.webview.html = shellHtml(view.webview, '<div class="status">Open a workspace folder to start DSH Sidebar.</div>', '')
      return
    }
    view.webview.html = shellHtml(view.webview, '<div class="status">Starting DSH Sidebar…</div>', '')
    const folder = this.folder
    void this.runtime.getWebUrl().then(async (url) => {
      const proxy = new URL(url)
      const proxyPort = Number(proxy.port)
      view.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
      }
      // asExternalUri is what establishes (or reuses) the client-side port
      // forwarding tunnel; webview portMapping would intercept fetch but not
      // cross-origin iframe navigation.
      let embedded = url
      try {
        const external = await vscode.env.asExternalUri(vscode.Uri.parse(proxy.origin))
        if (external.authority !== '') {
          const forwarded = new URL(url)
          forwarded.protocol = external.scheme
          forwarded.host = external.authority
          embedded = forwarded.href
        }
      } catch (error) {
        this.telemetry('webview.external-uri-error', { message: String(error) })
      }
      this.telemetry('webview.origin', {
        proxy: redactUrl(url),
        embedded: redactUrl(embedded),
        mode: 'external-uri-forward',
        proxyPort,
      })
      if (this.view !== view) return
      const body = `<iframe id="frame" src="${escapeAttribute(embedded)}" allow="clipboard-read; clipboard-write"></iframe>`
      const script = `(() => {
  const vscode = acquireVsCodeApi();
  const post = (message) => vscode.postMessage(Object.assign({ source: 'dsh-vscode-shell' }, message));
  window.addEventListener('error', (event) => post({ type: 'shell-error', message: String(event.message || event.error || 'unknown') }));
  window.addEventListener('unhandledrejection', (event) => post({ type: 'shell-rejection', message: String(event.reason || 'unknown') }));
  const frame = document.getElementById('frame');
  let bridgeSeen = false;
  let retries = 0;
  const retryTimer = setInterval(() => {
    if (bridgeSeen) { clearInterval(retryTimer); return; }
    if (retries >= 3) { clearInterval(retryTimer); post({ type: 'shell-bridge-timeout' }); return; }
    retries += 1;
    post({ type: 'shell-retry', retries });
    if (frame && frame.src) frame.src = frame.src + (frame.src.indexOf('?') === -1 ? '?' : '&') + 'r=' + String(Date.now());
    const health = frame && frame.src ? new URL('/__dsh_vscode_health', frame.src).href : '';
    if (health) fetch(health, { mode: 'no-cors' }).then(() => post({ type: 'shell-health-ok' })).catch((error) => post({ type: 'shell-health-error', message: String(error) }));
  }, 8000);
  window.addEventListener('message', (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    if (event.data && event.data.source === 'dsh-vscode-bridge' && event.data.type === 'bridge-loaded') {
      if (!bridgeSeen) post({ type: 'shell-bridge-seen' });
      bridgeSeen = true;
    }
    vscode.postMessage(event.data);
  });
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.__dshHost !== true || !frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage(data, '*');
  });
  frame.addEventListener('load', () => post({ type: 'iframe-load', src: frame.src }));
  frame.addEventListener('error', () => post({ type: 'iframe-error', src: frame.src }));
  post({ type: 'shell-ready', src: frame.src });
  window.addEventListener('dragenter', (event) => post({ type: 'shell-drag-enter', types: Array.from((event.dataTransfer && event.dataTransfer.types) || []) }));
  window.addEventListener('drop', (event) => post({ type: 'shell-drop', types: Array.from((event.dataTransfer && event.dataTransfer.types) || []) }));
  setInterval(() => post({ type: 'shell-heartbeat', src: frame.src, text: document.body.innerText.slice(0, 400) }), 3000);
})();`
      view.webview.html = shellHtml(view.webview, body, script)
      this.telemetry('webview.html-set', { src: redactUrl(embedded) })
      this.post({ type: 'configure', cwd: folder.uri.fsPath, title: folder.name })
    }, (error: unknown) => {
      if (this.view !== view) return
      const message = error instanceof Error ? error.message : String(error)
      this.startupError = message
      this.telemetry('webview.start-failed', { message })
      const body = `<div class="status startup-error">
<h1>Failed to start DSH runtime</h1>
<p>${escapeAttribute(summarizeStartupError(message))}</p>
<p>The full error is available in the DSH Sidebar output log.</p>
<div class="actions"><button id="copy-error" type="button">Copy full error</button><button id="open-log" type="button">Open log</button><button id="retry" type="button">Retry</button></div>
</div>`
      const script = `(() => {
  const vscode = acquireVsCodeApi();
  for (const type of ['copy-error', 'open-log', 'retry']) {
    document.getElementById(type).addEventListener('click', () => vscode.postMessage({ source: 'dsh-vscode-startup-error', type }));
  }
})();`
      view.webview.html = shellHtml(view.webview, body, script)
    })
  }
}

let lastBridgeErrorKey = ''
let lastBridgeErrorAt = 0

/** Surface one bridge failure as a VS Code error with a Retry action. */
function showBridgeError(
  output: vscode.OutputChannel,
  message: string,
  retry?: unknown,
  respond?: (value: unknown) => void,
): void {
  const now = Date.now()
  if (message === lastBridgeErrorKey && now - lastBridgeErrorAt < 30_000) return
  lastBridgeErrorKey = message
  lastBridgeErrorAt = now
  void vscode.window.showErrorMessage(
    `DSH Sidebar: ${message}`,
    ...(retry === undefined ? [] : ['Retry']),
    'Show Logs',
  ).then(choice => {
    if (choice === 'Retry' && retry !== undefined) respond?.(retry)
    else if (choice === 'Show Logs') output.show()
  })
}

let lastReferenceWarningKey = ''
let lastReferenceWarningAt = 0

/** Human phrasing for the bridge's machine reason codes. */
function referenceReasonText(reason: string | undefined): string {
  switch (reason) {
    case 'no-session': return 'no session is open'
    case 'no-input': return 'the agent input is not available'
    case 'phase': return 'the agent input is busy'
    case 'draft-rev': return 'the draft changed while the reference was being inserted'
    case 'retries-exhausted': return 'the agent never became ready'
    default: return reason === undefined || reason === '' ? 'unknown reason' : reason
  }
}

/**
 * Surface one reference-insertion warning, deduplicated like showBridgeError so
 * the bridge's bounded retry loop cannot spam the notification area.
 */
function showReferenceWarning(message: string): void {
  const now = Date.now()
  if (message === lastReferenceWarningKey && now - lastReferenceWarningAt < 30_000) return
  lastReferenceWarningKey = message
  lastReferenceWarningAt = now
  void vscode.window.showWarningMessage('DSH Sidebar: ' + message)
}

/**
 * Reasons that describe a real chip-insertion failure worth interrupting the
 * user for. A drop that was never a reference (empty payload, unresolved text)
 * stays telemetry-only.
 */
function isReferenceFailureReason(reason: string | undefined): boolean {
  if (reason === undefined || reason === '') return false
  // Prefix reasons: no-binding (input facade is unbound) and no-scope (the
  // session has no scope, reported as 'no-scope: <sessionId>').
  if (reason.startsWith('no-binding') || reason.startsWith('no-scope')) return true
  return reason === 'no-session' || reason === 'no-input' || reason === 'no-service'
    || reason === 'phase' || reason === 'draft-rev' || reason === 'retries-exhausted'
}

/**
 * Handle the bridge's chip-insertion outcome (contract v2). The generic bridge
 * telemetry already records every outcome; only a real pending/failed insertion
 * gets one deduplicated warning because otherwise the drop looks like a no-op.
 */
function handleReferenceResult(message: BridgeEnvelope, output: vscode.OutputChannel): void {
  if (message.outcome !== 'pending' && message.outcome !== 'failed') return
  const detail = referenceReasonText(message.reason)
  output.appendLine('[bridge] reference ' + message.outcome + ': ' + detail)
  if (!isReferenceFailureReason(message.reason)) return
  showReferenceWarning(message.outcome === 'pending'
    ? 'the reference is waiting to be inserted (' + detail + ').'
    : 'the reference could not be inserted (' + detail + ').')
}

/**
 * Answer one 'writeClipboard' request. The page cannot reach the editor
 * clipboard, so the host performs the write and reports the outcome instead of
 * leaving the bridge's promise pending; nothing throws out of this function.
 */
async function writeClipboardRequest(message: BridgeEnvelope, respond: (value: unknown) => void): Promise<void> {
  const text = message.payload?.text
  let value: { readonly ok: boolean; readonly message?: string }
  if (typeof text !== 'string') {
    value = { ok: false, message: 'no text in the writeClipboard request' }
  } else {
    try {
      await vscode.env.clipboard.writeText(text)
      value = { ok: true }
    } catch (error) {
      value = { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
  try {
    respond({ type: 'response', requestId: message.requestId, value })
  } catch (_error) {
    /* the webview relay is gone; there is nothing left to answer */
  }
}

/** Workspace membership the page publishes for the folder this window pins. */
interface WorkspaceStateMessage {
  readonly workspaceId?: string
  readonly sessionIds: readonly string[]
  readonly archivedSessionIds?: readonly string[]
}

function handleBridgeMessage(
  message: BridgeEnvelope,
  folder: vscode.WorkspaceFolder | undefined,
  output: vscode.OutputChannel,
  respond: (value: unknown) => void,
  telemetry: (event: string, data?: Record<string, unknown>) => void,
  onShellReady: () => void,
  onWorkspaceState?: (state: WorkspaceStateMessage) => void,
  onSessionsDirty?: () => void,
): void {
  if (message.source === 'dsh-vscode-shell') {
    telemetry(`shell.${message.type ?? 'unknown'}`, {
      ...(message.types === undefined ? {} : { types: [...message.types] }),
    })
    if (message.type === 'shell-ready') onShellReady()
    return
  }
  if (message.source !== 'dsh-vscode-bridge' || typeof message.type !== 'string') return
  // Copied content is user data: for the two clipboard messages log only the
  // byte length, never the text itself. Other messages keep their short text.
  const clipboardText = message.type === 'copy-text'
    ? message.text
    : message.type === 'request' && message.requestType === 'writeClipboard'
      ? message.payload?.text
      : undefined
  const textTelemetry: Record<string, unknown> = typeof clipboardText === 'string'
    ? { textLength: Buffer.byteLength(clipboardText, 'utf8') }
    : typeof message.text === 'string'
      ? { text: message.text.slice(0, 80) }
      : {}
  telemetry(`bridge.${message.type}`, {
    ...(typeof message.path === 'string' ? { path: message.path } : {}),
    ...(typeof message.requestType === 'string' ? { requestType: message.requestType } : {}),
    ...(message.types === undefined ? {} : { types: [...message.types] }),
    ...(message.entryCount === undefined ? {} : { entryCount: message.entryCount }),
    ...(message.mayReference === undefined ? {} : { mayReference: message.mayReference }),
    ...(message.count === undefined ? {} : { count: message.count }),
    ...textTelemetry,
    ...(typeof message.url === 'string' ? { url: message.url.slice(0, 120) } : {}),
    ...(typeof message.message === 'string' ? { message: message.message.slice(0, 160) } : {}),
    ...(typeof message.outcome === 'string' ? { outcome: message.outcome } : {}),
    ...(typeof message.reason === 'string' ? { reason: message.reason } : {}),
    ...(message.attempts === undefined ? {} : { attempts: message.attempts }),
    ...(message.mentions === undefined ? {} : { mentions: [...message.mentions].slice(0, 8) }),
  })
  switch (message.type) {
    case 'bridge-loaded':
      output.appendLine('[bridge] loaded')
      onShellReady()
      return
    case 'open-file':
      if (typeof message.path === 'string') {
        void openFilePath(message.path, message.line, typeof message.column === 'string' ? message.column : undefined)
      }
      return
    case 'reveal-file':
      // The web card's "reveal in the file manager" action; the page's host has
      // no desktop, so the Explorer is the only target that exists here.
      if (typeof message.path === 'string') void revealFilePath(message.path)
      return
    case 'open-url':
      if (typeof message.url === 'string') {
        void openUrlEmbedded(message.url, typeof message.target === 'string' ? message.target : undefined)
      }
      return
    case 'copy-text':
      // The link menu's copy action: the webview clipboard is not reachable
      // from inside the app frame, so the host performs the write.
      if (typeof message.text === 'string') void vscode.env.clipboard.writeText(message.text)
      return
    case 'open-diff':
      if (typeof message.path === 'string') void openDiffPath(message.path, message.oldText, message.newText)
      return
    case 'request': {
      if (message.requestType === 'resolveReferences' && typeof message.requestId === 'string') {
        // The remembered-selection map and the editor-data payload are what
        // recover an exact #Lx-Ly range when VS Code hands over plain text.
        void Promise.resolve().then(() => {
          const resolution = resolveDropTargetsDetailed(message.payload)
          respond({
            type: 'response',
            requestId: message.requestId,
            value: {
              refs: resolution.refs,
              cwd: folder?.uri.fsPath ?? '',
              ...(resolution.reason === undefined ? {} : { reason: resolution.reason }),
            },
          })
        })
      }
      if (message.requestType === 'writeClipboard' && typeof message.requestId === 'string') {
        // The page cannot reach the editor clipboard itself; the bridge awaits
        // this response, so answer it even when the write fails.
        void writeClipboardRequest(message, respond)
      }
      return
    }
    case 'reference-result':
      // Contract v2: the bridge reports what happened to a queued chip, so a
      // failed/pending drop gets one warning instead of looking like a no-op.
      handleReferenceResult(message, output)
      return
    case 'drag-handled':
      // Resolution succeeded and the refs were queued; the real insertion
      // outcome arrives separately as 'reference-result', so this is a count
      // log, not an unhandled message.
      output.appendLine('[bridge] drag-handled count ' + String(message.count ?? 0))
      return
    case 'workspace-state':
      if (Array.isArray(message.sessionIds)) {
        onWorkspaceState?.({
          ...(typeof message.workspaceId === 'string' ? { workspaceId: message.workspaceId } : {}),
          sessionIds: message.sessionIds.filter((id): id is string => typeof id === 'string'),
          ...(Array.isArray(message.archivedSessionIds)
            ? { archivedSessionIds: message.archivedSessionIds.filter((id): id is string => typeof id === 'string') }
            : {}),
        })
      }
      return
    case 'sessions-dirty':
      // The page folded its own list pushes into one signal; the tree now reads
      // and repaints only for rows that actually changed.
      onSessionsDirty?.()
      return
    case 'scope-blocked':
      // The page refused to touch a Session outside the pinned folder; without
      // this the click would look like it did nothing.
      showBridgeError(
        output,
        typeof message.message === 'string'
          ? message.message
          : 'this session is outside the folder this window is pinned to',
      )
      return
    case 'workspace-error': {
      const detail = typeof message.message === 'string' ? message.message : 'unknown error'
      const target = typeof message.path === 'string' ? ` ${message.path}` : ''
      showBridgeError(output, `cannot open workspace${target}: ${detail}`, { type: 'retry-workspace' }, respond)
      return
    }
    case 'new-session-error':
      showBridgeError(
        output,
        `could not start a session: ${typeof message.message === 'string' ? message.message : 'unknown error'}`,
        { type: 'new-session' },
        respond,
      )
      return
    case 'open-session-error':
      showBridgeError(
        output,
        `could not open session ${typeof message.sessionId === 'string' ? message.sessionId : ''}: ${typeof message.message === 'string' ? message.message : 'unknown error'}`,
      )
      return
    default:
      output.appendLine(`[bridge] unhandled message ${message.type}`)
  }
}

/** One folding range as accepted by codeBlockRangeFor (VS Code's 0-based shape). */
export interface FoldingRangeLike {
  readonly start: number
  readonly end: number
}

/**
 * Pick the innermost folding range that contains a line.
 * @param foldingRanges - Folds from vscode.executeFoldingRangeProvider (0-based).
 * @param line - 0-based cursor line.
 * @returns 1-based inclusive range of the innermost fold, or undefined when no fold contains the line.
 */
export function codeBlockRangeFor(foldingRanges: readonly FoldingRangeLike[], line: number): LineRange | undefined {
  if (!Number.isFinite(line)) return undefined
  const cursor = Math.floor(line)
  let best: FoldingRangeLike | undefined
  for (const range of foldingRanges) {
    if (typeof range.start !== 'number' || typeof range.end !== 'number') continue
    if (range.start > cursor || range.end < cursor) continue
    if (best === undefined) {
      best = range
      continue
    }
    const span = range.end - range.start
    const bestSpan = best.end - best.start
    if (span < bestSpan || (span === bestSpan && range.start > best.start)) best = range
  }
  if (best === undefined) return undefined
  return { startLine: Math.min(best.start, best.end) + 1, endLine: Math.max(best.start, best.end) + 1 }
}

/** Net unclosed '(' and '[' on one line, ignoring quoted text and line comments. */
function unclosedDepthDelta(line: string): number {
  let delta = 0
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i)
    if (quote !== '') {
      if (char === '\\') i += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"' || char === '\`') {
      quote = char
      continue
    }
    if (char === '/' && line.charAt(i + 1) === '/') break
    if (char === '(' || char === '[') delta += 1
    else if (char === ')' || char === ']') delta -= 1
  }
  return delta
}

/** Unclosed '(' and '[' depth at the start of every line (never below zero). */
function continuationDepths(lines: readonly string[]): number[] {
  const depths: number[] = []
  let depth = 0
  for (const line of lines) {
    depths.push(depth)
    depth = Math.max(0, depth + unclosedDepthDelta(line))
  }
  return depths
}

/** Leading whitespace width of one source line (a tab counts as one column). */
function indentationOf(text: string): number {
  const match = /^[ \t]*/u.exec(text)
  return match === null ? 0 : match[0].length
}

/**
 * Cheap "this line opens a nested block" test for the indentation fallback.
 * Suffix-based on purpose: it only has to recognize headers such as
 * "function f() {", "if (x) {", "def f():", "items = [", "foo(", or a trailing
 * backslash continuation.
 */
function opensBlock(text: string): boolean {
  const trimmed = text.trimEnd()
  if (trimmed === '') return false
  return /[([{]$/u.test(trimmed) || /:$/u.test(trimmed) || /=>$/u.test(trimmed) || /\\$/u.test(trimmed)
}

/**
 * Indentation-based fallback used when no folding or symbol provider answers.
 * @param lines - Document text split on line breaks (index 0 is the first line).
 * @param line - 0-based cursor line.
 * @returns 1-based inclusive range of the innermost enclosing indentation block;
 *   undefined when lines is empty or line is outside the document. The returned
 *   range always contains the cursor line. A block runs from its header through
 *   the more-indented lines plus a lone closing delimiter, so a Python block
 *   stops before the next top-level statement while a brace block keeps its
 *   closing brace. Inside an unclosed '(' or '[' the whole call, list, or array
 *   literal is returned.
 */
export function indentBlockRange(lines: readonly string[], line: number): LineRange | undefined {
  if (lines.length === 0 || !Number.isFinite(line)) return undefined
  const cursor = Math.floor(line)
  if (cursor < 0 || cursor >= lines.length) return undefined
  const textOf = (index: number): string => lines[index] ?? ''
  const isBlank = (index: number): boolean => textOf(index).trim() === ''
  // Inside an unclosed '(' or '[' the whole call, list, or array literal is the
  // enclosing block, even when its lines share one indent (which the pure
  // indentation rule below cannot recognize).
  const depths = continuationDepths(lines)
  if ((depths[cursor] ?? 0) > 0) {
    let statementStart = cursor
    while (statementStart > 0 && (depths[statementStart] ?? 0) > 0) statementStart -= 1
    let statementEnd = lines.length - 1
    for (let i = cursor + 1; i < lines.length; i++) {
      if ((depths[i] ?? 0) === 0) {
        statementEnd = i - 1
        break
      }
    }
    return { startLine: statementStart + 1, endLine: statementEnd + 1 }
  }
  // Anchor on the nearest non-blank line at or above the cursor, then below.
  let anchor = -1
  for (let i = cursor; i >= 0 && anchor === -1; i--) {
    if (!isBlank(i)) anchor = i
  }
  for (let i = cursor + 1; i < lines.length && anchor === -1; i++) {
    if (!isBlank(i)) anchor = i
  }
  if (anchor === -1) return { startLine: 1, endLine: lines.length }
  let base = indentationOf(textOf(anchor))
  let header = anchor
  // A line that opens a construct (a header or a continuation such as "foo(")
  // starts the block itself; otherwise climb to the innermost enclosing header:
  // more-indented lines are body or continuation lines, while the first
  // less-indented block opener is the header.
  if (!opensBlock(textOf(header))) {
    for (;;) {
      let previous = -1
      for (let i = header - 1; i >= 0 && previous === -1; i--) {
        if (!isBlank(i)) previous = i
      }
      if (previous === -1) break
      const indent = indentationOf(textOf(previous))
      if (indent > base) {
        header = previous
        continue
      }
      if (opensBlock(textOf(previous))) {
        header = previous
        base = indent
      }
      break
    }
  }
  const start = Math.min(header, cursor)
  let end = Math.max(anchor, cursor, start)
  for (let i = end + 1; i < lines.length; i++) {
    if (isBlank(i)) continue
    const indent = indentationOf(textOf(i))
    if (indent > base) {
      end = i
      continue
    }
    // At the header indent only the construct's own closing delimiter belongs
    // to the block; a sibling statement (or the next Python statement) does not.
    if (indent === base && /^[)\]}]+[;,]?$/u.test(textOf(i).trim())) {
      end = i
      continue
    }
    break
  }
  return { startLine: start + 1, endLine: end + 1 }
}

/** Convert one VS Code range to a 1-based inclusive line range. */
function lineRangeOfRange(range: vscode.Range): LineRange {
  const startLine = range.start.line + 1
  const endLine = range.end.character === 0 && range.end.line > range.start.line ? range.end.line : range.end.line + 1
  return { startLine, endLine: Math.max(startLine, endLine) }
}

/** Flatten a document-symbol tree (or a flat symbol list) into its ranges. */
function collectSymbolRanges(
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  out: vscode.Range[],
): void {
  for (const symbol of symbols) {
    if ('range' in symbol) out.push(symbol.range)
    else if ('location' in symbol) out.push(symbol.location.range)
    if ('children' in symbol && Array.isArray(symbol.children)) collectSymbolRanges(symbol.children, out)
  }
}

/** Innermost document symbol containing a line (0-based), as a 1-based range. */
function symbolBlockRange(
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  line: number,
): LineRange | undefined {
  const ranges: vscode.Range[] = []
  collectSymbolRanges(symbols, ranges)
  let best: vscode.Range | undefined
  for (const range of ranges) {
    if (range.start.line > line || range.end.line < line) continue
    if (best === undefined) {
      best = range
      continue
    }
    const span = range.end.line - range.start.line
    const bestSpan = best.end.line - best.start.line
    if (span < bestSpan || (span === bestSpan && range.start.line > best.start.line)) best = range
  }
  return best === undefined ? undefined : lineRangeOfRange(best)
}

/**
 * Resolve the code block enclosing the cursor, in priority order: folding
 * ranges, document symbols, the indentation heuristic, then the whole file.
 * Both provider commands are guarded because a language may not implement them.
 */
async function codeBlockRangeAtCursor(editor: vscode.TextEditor): Promise<LineRange> {
  const cursor = editor.selection.active.line
  try {
    const folding = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
      'vscode.executeFoldingRangeProvider',
      editor.document.uri,
    )
    if (Array.isArray(folding)) {
      const range = codeBlockRangeFor(folding, cursor)
      if (range !== undefined) return range
    }
  } catch (_error) {
    /* no folding provider registered for this language */
  }
  try {
    const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
      'vscode.executeDocumentSymbolProvider',
      editor.document.uri,
    )
    if (Array.isArray(symbols)) {
      const range = symbolBlockRange(symbols, cursor)
      if (range !== undefined) return range
    }
  } catch (_error) {
    /* no document symbol provider registered for this language */
  }
  const indentation = indentBlockRange(editor.document.getText().split(/\r\n|\r|\n/u), cursor)
  if (indentation !== undefined) return indentation
  return { startLine: 1, endLine: Math.max(1, editor.document.lineCount) }
}

/** Mime type carrying one dragged Sessions row inside the native tree view. */
const SESSION_DRAG_MIME = 'application/vnd.code.tree.dsh.embed.sessions'

/**
 * Drag-to-reorder for the native Sessions tree: a dropped row takes the target
 * row's place, exactly like dragging a session in the web sidebar. The move is
 * written through the same Workspace RPC the web sidebar uses, so both surfaces
 * keep one manual order instead of forking into a native-only arrangement.
 */
class SessionOrderController implements vscode.TreeDragAndDropController<SessionNode> {
  readonly dragMimeTypes = [SESSION_DRAG_MIME]
  readonly dropMimeTypes = [SESSION_DRAG_MIME]

  /**
   * @param sessions - Rows and the order they are currently displayed in.
   * @param move - Writes one move through the backend.
   */
  constructor(
    private readonly sessions: SessionsProvider,
    private readonly move: (sessionId: string, beforeSessionId: string | undefined) => Promise<void>,
  ) {}

  /** @inheritdoc */
  handleDrag(source: readonly SessionNode[], dataTransfer: vscode.DataTransfer): void {
    const dragged = source[0]
    if (dragged === undefined) return
    dataTransfer.set(SESSION_DRAG_MIME, new vscode.DataTransferItem(dragged.sessionId))
  }

  /** @inheritdoc */
  async handleDrop(target: SessionNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const dragged = dataTransfer.get(SESSION_DRAG_MIME)?.value
    if (target === undefined || typeof dragged !== 'string') return
    const ids = this.sessions.displayedIds
    // Dropping on a row means "take that row's place", which is the only drop
    // position a VS Code tree reports — there is no above/below distinction.
    // A target the list no longer holds must not plan: a missing index would
    // clamp to the top and move the row there.
    const toIndex = ids.indexOf(target.sessionId)
    if (toIndex === -1) return
    const plan = planMove(ids, dragged, toIndex)
    if (plan === undefined) return
    await this.move(dragged, plan.beforeSessionId)
  }
}

let activeRuntime: DshRuntime | undefined

/** Activate the embedded web runtime and native command surface. */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('DSH Sidebar')
  const gitHeads = new GitHeadContentProvider()
  const inlineDiffs = new InlineDiffContentProvider()
  const folder = firstWorkspaceFolder()
  let runtime: DshRuntime | undefined
  const telemetry = new Telemetry(output, () => {
    output.appendLine('[runtime] telemetry-triggered restart')
    void runtime?.restart().catch(error => { output.appendLine(`[runtime] restart failed: ${String(error)}`) })
  })
  telemetry.set('workspace', folder?.uri.fsPath ?? null)
  telemetry.set('extensionVersion', String(context.extension.packageJSON.version ?? '0.0.0'))
  telemetry.log('extension.activate', {
    workspace: folder?.uri.fsPath ?? null,
    remoteName: vscode.env.remoteName ?? null,
    uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
    appName: vscode.env.appName,
    uriScheme: vscode.env.uriScheme,
  })
  runtime = folder === undefined
    ? undefined
    : new DshRuntime(
      context,
      folder,
      output,
      (event, data) => { telemetry.log(event, data) },
      themeFor,
    )
  activeRuntime = runtime
  if (runtime !== undefined) {
    // The open window is the trigger, not the first reveal of the view: the
    // pinned folder is already known here, and the backend takes seconds to
    // come up. A failure is not fatal — revealing the view retries through the
    // same promise and shows its own error page.
    void runtime.getWebUrl().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      output.appendLine(`[runtime] eager start failed: ${message}`)
      telemetry.log('runtime.eager-start-failed', { message })
    })
  }
  const sessions = folder === undefined || runtime === undefined
    ? undefined
    : new SessionsProvider(() => runtime.origin, (event, data) => { telemetry.log(event, data) })
  if (sessions !== undefined) sessions.start()

  /**
   * Run one Sessions-tree mutation against the live backend. Failures land in
   * the window and the output log instead of vanishing into a repainted tree.
   * @param label - Short action name used in the failure message.
   * @param run - The mutation, given the proxy origin and the pinned workspace.
   */
  const runSessionMutation = async (
    label: string,
    run: (origin: string, workspaceId: string | undefined) => Promise<void>,
  ): Promise<void> => {
    const origin = runtime?.origin
    if (origin === undefined) {
      void vscode.window.showWarningMessage('DSH Sidebar: the agent runtime is still starting.')
      return
    }
    try {
      await run(origin, sessions?.workspaceId)
      // The page republishes the workspace order after its own feed update; this
      // read keeps the tree honest when the webview is closed or lagging.
      void sessions?.refresh()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      telemetry.log('sessions.mutation-failed', { label, message: detail })
      output.appendLine(`[sessions] ${label} failed: ${detail}`)
      void vscode.window.showWarningMessage(`DSH Sidebar: ${label} failed: ${detail}`)
    }
  }

  /** Move one Session to a new place in the workspace's manual order. */
  const moveSession = async (sessionId: string, beforeSessionId: string | undefined): Promise<void> => {
    const workspaceId = sessions?.workspaceId
    if (workspaceId === undefined) return
    await runSessionMutation('reorder', async origin => {
      await moveSessionBefore(origin, workspaceId, sessionId, beforeSessionId)
      telemetry.log('sessions.move', { sessionId, before: beforeSessionId ?? null })
    })
  }

  let provider: DshWebviewProvider
  provider = new DshWebviewProvider(context, runtime, folder, message => {
    handleBridgeMessage(
      message,
      folder,
      output,
      value => { provider.post(value as Record<string, unknown>) },
      (event, data) => { telemetry.log(event, data) },
      () => { provider.markBridgeReady() },
      (state) => { sessions?.updateWorkspaceState(state) },
      () => { void sessions?.refresh() },
    )
  }, (event, data) => { telemetry.log(event, data) }, output)
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90)
  status.command = 'dsh.embed.focus'
  status.text = '$(hubot) DSH'
  status.name = 'DSH Sidebar'
  if (folder !== undefined) status.show()

  context.subscriptions.push(
    output,
    telemetry,
    { dispose: (): void => { void runtime?.dispose().catch(error => { console.error('DSH runtime cleanup failed', error) }) } },
    sessions ?? { dispose: (): void => {} },
    status,
    vscode.workspace.registerTextDocumentContentProvider('dsh-git', gitHeads),
    vscode.workspace.registerTextDocumentContentProvider('dsh-inline', inlineDiffs),
    vscode.window.onDidChangeActiveColorTheme(() => { provider.updateTheme(themeFor()) }),
    // Remember every non-empty file selection so a drop that only carries
    // text/plain can still recover the exact #Lx-Ly range.
    vscode.window.onDidChangeTextEditorSelection(event => {
      const document = event.textEditor.document
      if (document.uri.scheme !== 'file') return
      for (const selection of event.selections) {
        if (selection.isEmpty) continue
        const startLine = selection.start.line + 1
        const endLine = selection.end.character === 0 && selection.end.line > selection.start.line
          ? selection.end.line
          : selection.end.line + 1
        rememberSelection(document.uri.toString(), startLine, Math.max(startLine, endLine), document.getText(selection))
      }
    }),
    // The bridge only reports pushes from this page's own backend; another DSH
    // process writing the shared Session store is invisible until this read.
    vscode.window.onDidChangeWindowState(state => { if (state.focused) void sessions?.refresh() }),
    vscode.window.createTreeView('dsh.embed.sessions', {
      treeDataProvider: sessions ?? new SessionsProvider(() => undefined),
      ...(sessions === undefined ? {} : { dragAndDropController: new SessionOrderController(sessions, moveSession) }),
    }),
    vscode.window.registerWebviewViewProvider('dsh.embed.view', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dsh.embed.focus', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.dsh-embed')
      await vscode.commands.executeCommand('dsh.embed.view.focus')
    }),
    vscode.commands.registerCommand('dsh.embed.openSession', (sessionId: string) => {
      provider.post({ type: 'open-session', sessionId })
      telemetry.log('command.openSession', { sessionId })
      void vscode.commands.executeCommand('workbench.view.extension.dsh-embed')
      void vscode.commands.executeCommand('dsh.embed.view.focus')
    }),
    vscode.commands.registerCommand('dsh.embed.refreshSessions', async () => {
      await sessions?.refresh()
    }),
    vscode.commands.registerCommand('dsh.embed.moveSessionUp', async (node?: SessionNode) => {
      if (node === undefined) return
      const plan = planStep(sessions?.displayedIds ?? [], node.sessionId, -1)
      if (plan === undefined) return
      await moveSession(node.sessionId, plan.beforeSessionId)
    }),
    vscode.commands.registerCommand('dsh.embed.moveSessionDown', async (node?: SessionNode) => {
      if (node === undefined) return
      const plan = planStep(sessions?.displayedIds ?? [], node.sessionId, 1)
      if (plan === undefined) return
      await moveSession(node.sessionId, plan.beforeSessionId)
    }),
    vscode.commands.registerCommand('dsh.embed.archiveSession', async (node?: SessionNode) => {
      if (node === undefined) return
      await runSessionMutation('archive', async origin => {
        await archiveSession(origin, node.sessionId)
        telemetry.log('command.archiveSession', { sessionId: node.sessionId })
      })
    }),
    vscode.commands.registerCommand('dsh.embed.newSession', async () => {
      if (runtime === undefined || folder === undefined) {
        void vscode.window.showWarningMessage('DSH Sidebar: open a workspace folder first.')
        return
      }
      if (runtime.origin === undefined) {
        void vscode.window.showWarningMessage('DSH Sidebar: runtime is still starting.')
        return
      }
      // The bridge runs the real workspace New-Session flow in the page
      // (reuse a blank session or `sessions.create({ workspaceId })`), so the
      // new session is bound to the workspace and the page never lands in the
      // no-workspace state. Only the trigger crosses the host boundary.
      provider.post({ type: 'new-session' })
      telemetry.log('command.newSession')
      // The bridge acks once it opened the session; refresh on a short delay
      // anyway so the tree row appears even if the ack is missed.
      setTimeout(() => { void sessions?.refresh() }, 600)
      setTimeout(() => { void sessions?.refresh() }, 2200)
      void vscode.commands.executeCommand('workbench.view.extension.dsh-embed')
      void vscode.commands.executeCommand('dsh.embed.view.focus')
    }),
    vscode.commands.registerCommand('dsh.embed.restart', async () => {
      if (runtime === undefined) {
        void vscode.window.showWarningMessage('DSH Sidebar: open a workspace folder first.')
        return
      }
      telemetry.log('command.restart')
      output.appendLine('[runtime] restart requested')
      await runtime.restart()
      void vscode.window.showInformationMessage('DSH Sidebar: agent runtime restarted.')
    }),
    vscode.commands.registerCommand('dsh.embed.referenceSelection', () => {
      const editor = vscode.window.activeTextEditor
      if (editor === undefined || editor.document.uri.scheme !== 'file') {
        void vscode.window.showWarningMessage('DSH Sidebar: no file selection to reference.')
        return
      }
      const selection = editor.selection
      const startLine = selection.start.line + 1
      const endLine = selection.end.character === 0 && selection.end.line > selection.start.line
        ? selection.end.line
        : selection.end.line + 1
      provider.pushRefs([referenceFromTarget({
        uri: editor.document.uri,
        startLine,
        endLine: Math.max(startLine, endLine),
      })])
      telemetry.log('command.referenceSelection', { startLine, endLine })
      void vscode.commands.executeCommand('workbench.view.extension.dsh-embed')
      void vscode.commands.executeCommand('dsh.embed.view.focus')
    }),
    vscode.commands.registerCommand('dsh.embed.referenceBlock', async () => {
      const editor = vscode.window.activeTextEditor
      if (editor === undefined || editor.document.uri.scheme !== 'file') {
        void vscode.window.showWarningMessage('DSH Sidebar: open a file to reference its code block.')
        return
      }
      const range = await codeBlockRangeAtCursor(editor)
      provider.pushRefs([referenceFromTarget({ uri: editor.document.uri, ...range })])
      telemetry.log('command.referenceBlock', {
        path: editor.document.uri.fsPath,
        startLine: range.startLine,
        endLine: range.endLine,
      })
      void vscode.commands.executeCommand('workbench.view.extension.dsh-embed')
      void vscode.commands.executeCommand('dsh.embed.view.focus')
    }),
    vscode.commands.registerCommand('dsh.embed.referenceFile', (uri?: vscode.Uri) => {
      if (uri === undefined || uri.scheme !== 'file') {
        void vscode.window.showWarningMessage('DSH Sidebar: select a file in Explorer first.')
        return
      }
      provider.pushRefs([referenceFromTarget({ uri: uri.with({ fragment: '' }) })])
      telemetry.log('command.referenceFile', { path: uri.fsPath })
      void vscode.commands.executeCommand('workbench.view.extension.dsh-embed')
      void vscode.commands.executeCommand('dsh.embed.view.focus')
    }),
  )
}

/** Normal shutdown awaits cleanup; IPC EOF covers abrupt Extension Host death. */
export async function deactivate(): Promise<void> {
  const runtime = activeRuntime
  activeRuntime = undefined
  await runtime?.dispose()
}
