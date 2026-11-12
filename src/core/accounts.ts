// Orca's account list: which Claude and Codex accounts exist and which one is active. The worker
// asks the Orca CLI (`orca account list --json`) and copies out only ids, e-mails, workspace
// labels and the claude home; the rest of that JSON (rate limits, auth details) is dropped here.
// When the CLI does not answer, profile.ts falls back to the disk.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isRecord } from './fsx.ts'

export interface OrcaAccounts {
  claude: {
    accounts: { id: string; email?: string; home: string }[]
    activeAccountId?: string
    systemDefaultHome?: string
    systemDefaultEmail?: string
  }
  codex: {
    accounts: { id: string; email?: string; workspaceLabel?: string }[]
    activeAccountId?: string
    systemDefault?: { email?: string; workspaceLabel?: string }
  }
}

function s(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** Reads the CLI's JSON (the whole `{ ok, result }` answer or just `result`); null when it is not one. */
export function parseAccountList(json: unknown): OrcaAccounts | null {
  const root = isRecord(json) && isRecord(json.result) ? json.result : json
  if (!isRecord(root) || (!isRecord(root.claude) && !isRecord(root.codex))) return null
  const out: OrcaAccounts = { claude: { accounts: [] }, codex: { accounts: [] } }
  if (isRecord(root.claude)) {
    for (const a of Array.isArray(root.claude.accounts) ? root.claude.accounts : []) {
      if (!isRecord(a)) continue
      const id = s(a.id)
      const home = s(a.home)
      if (id && home) out.claude.accounts.push({ id, home, ...(s(a.email) ? { email: s(a.email) } : {}) })
    }
    out.claude.activeAccountId = s(root.claude.activeAccountId)
    out.claude.systemDefaultHome = s(root.claude.systemDefaultHome)
    out.claude.systemDefaultEmail = s(root.claude.systemDefaultEmail)
  }
  if (isRecord(root.codex)) {
    for (const a of Array.isArray(root.codex.accounts) ? root.codex.accounts : []) {
      if (!isRecord(a)) continue
      const id = s(a.id)
      if (id) out.codex.accounts.push({ id, ...(s(a.email) ? { email: s(a.email) } : {}), ...(s(a.workspaceLabel) ? { workspaceLabel: s(a.workspaceLabel) } : {}) })
    }
    out.codex.activeAccountId = s(root.codex.activeAccountId)
    if (isRecord(root.codex.systemDefault)) {
      out.codex.systemDefault = { email: s(root.codex.systemDefault.email), workspaceLabel: s(root.codex.systemDefault.workspaceLabel) }
    }
  }
  return out
}

/** Runs a command and returns its stdout; rejects on a non-zero exit, a missing command or a timeout. */
export type Runner = (file: string, args: string[], timeoutMs: number) => Promise<string>

/**
 * The environment a CLI child gets. Orca runs plugin workers as Electron-as-Node, and a child that
 * inherits ELECTRON_RUN_AS_NODE (the Orca CLI is an Electron binary) would read its arguments as
 * a script path; so that variable is dropped.
 */
export function childEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir()
): NodeJS.ProcessEnv {
  const out = { ...env }
  delete out.ELECTRON_RUN_AS_NODE
  // The worker's environment is trimmed; the CLI finds Orca's runtime through these on Windows.
  if (platform === 'win32') {
    out.USERPROFILE ??= home
    out.APPDATA ??= path.join(home, 'AppData', 'Roaming')
    out.LOCALAPPDATA ??= path.join(home, 'AppData', 'Local')
  }
  return out
}

export const execRunner: Runner = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: childEnv(), cwd: os.homedir() }, (error, stdout, stderr) => {
      // The CLI says why it failed on stderr (or in a JSON error on stdout); keep a short note of it.
      if (error) reject(Object.assign(error, { note: String(stderr || stdout).replace(/s+/g, ' ').slice(0, 200) }))
      else resolve(stdout)
    })
  })

/**
 * Where the Orca CLI may be, best first: `ORCA_CLI_COMMAND` when the worker sees it; otherwise the
 * CLI that ships beside the running app (the worker is started by Orca, so `execPath` is the app:
 * `<app>/resources/bin/orca`), and `orca` on the PATH last. A bare `orca` can resolve to the app
 * itself, because Windows looks in the current folder first.
 */
export function cliCandidates(opts: { command?: string; execPath: string; platform: NodeJS.Platform }): string[] {
  if (opts.command) return [opts.command]
  const dir = path.dirname(opts.execPath)
  const shipped =
    opts.platform === 'win32'
      ? path.join(dir, 'resources', 'bin', 'orca.exe')
      : opts.platform === 'darwin'
        ? path.join(path.dirname(dir), 'Resources', 'bin', 'orca')
        : path.join(dir, 'resources', 'bin', 'orca')
  return [shipped, 'orca']
}

export interface AccountSourceOptions {
  run?: Runner
  /** `ORCA_CLI_COMMAND` as the worker sees it; `orca` on the PATH when absent. */
  command?: string
  timeoutMs?: number
  ttlMs?: number
  now?: () => number
  /** Told why a command failed (its error code or message, never its output). */
  log?: (message: string) => void
}

/** A cached reader of the account list: null when the CLI is missing or answers badly. */
export function createAccountSource(options: AccountSourceOptions = {}): () => Promise<OrcaAccounts | null> {
  const run = options.run ?? execRunner
  const candidates = cliCandidates({ command: options.command, execPath: process.execPath, platform: process.platform }).filter(
    // A derived path that is not there is skipped; a bare name is left to the PATH.
    (c) => !path.isAbsolute(c) || options.command !== undefined || existsSync(c)
  )
  const timeoutMs = options.timeoutMs ?? 6000
  const ttl = options.ttlMs ?? 5 * 60 * 1000
  const now = options.now ?? Date.now
  let cached: { at: number; value: OrcaAccounts | null } | null = null
  let inflight: Promise<OrcaAccounts | null> | null = null

  async function fetchOnce(): Promise<OrcaAccounts | null> {
    for (const command of candidates) {
      try {
        const text = await run(command, ['account', 'list', '--json'], timeoutMs)
        const parsed = parseAccountList(JSON.parse(text))
        if (parsed) return parsed
      } catch (error) {
        // Try the next name, then give up: the disk fallback takes over.
        const e = error as { code?: unknown; message?: unknown; note?: unknown }
        options.log?.(`orca account list failed (${command}): ${String(e.code ?? e.message).slice(0, 100)} ${String(e.note ?? '')}`)
      }
    }
    return null
  }

  return async () => {
    const t = now()
    // A failure is cached for a minute only, so a CLI that starts later is picked up soon.
    if (cached && t - cached.at < (cached.value ? ttl : 60_000)) return cached.value
    inflight ??= fetchOnce().finally(() => {
      inflight = null
    })
    const value = await inflight
    cached = { at: now(), value }
    return value
  }
}
