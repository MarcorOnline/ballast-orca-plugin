// Ballast's worker: every file read and write happens here, behind the panel's requests. It also
// follows the focused workspace so it can watch that folder's Claude Code transcripts and warn
// when a server or connector reaches a running session for the first time.
//
// To know which folder the focused workspace is, it listens to what Orca reports together with a
// workspace id (agent status events, and two agent hooks) and remembers ids only. The hooks only
// observe: they return `next(event)` at once and never change the event.
import { watch, type FSWatcher } from 'node:fs'
import * as path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { createAccountSource } from './core/accounts.ts'
import {
  knows,
  launchRecord,
  type Memory,
  rememberLaunch,
  rememberObservation,
  rememberTerminal
} from './core/focus.ts'
import { createMemoryStore } from './core/memory-store.ts'
import { createService, hostEnvFromProcess, type WorkspaceRecord } from './core/service.ts'
import { projectDirFor } from './core/transcripts.ts'
import { pathKey } from './core/paths.ts'
import { formatTokens, s, setLocale, systemLocale, t } from './strings.ts'
import type { AgentHint, ScanInput, WorkspaceHint } from './protocol.ts'
import './protocol.ts'

const STATUS_ID = 'ballast-total'

let watcher: FSWatcher | null = null
let flushMemory: (() => Promise<void>) | null = null

export default function activate(orca: OrcaWorkerApi): void {
  setLocale(systemLocale())
  const env = hostEnvFromProcess()

  async function listWorkspaces(): Promise<WorkspaceRecord[]> {
    const answer = (await orca.host.call('workspace.list', {})) as { workspaces: WorkspaceRecord[] }
    return answer.workspaces
  }

  const memory = createMemoryStore({
    get: (key) => orca.storage.get(key),
    set: (key, value) => orca.storage.set(key, value as never)
  })
  flushMemory = () => memory.flush()

  const service = createService({
    env,
    store: {
      get: (key) => orca.storage.get(key),
      set: (key, value) => orca.storage.set(key, value)
    },
    memory,
    listWorkspaces,
    accounts: createAccountSource({ command: process.env.ORCA_CLI_COMMAND || undefined, log: (m) => orca.log(m) })
  })

  // ------------------------------------------------------------ what agents teach us
  let lastResolved = ''
  let refocusTimer: ReturnType<typeof setTimeout> | null = null

  /** Remembers `change` and, when it taught something new, looks again at the focus soon. */
  function learn(change: (m: Memory) => Memory, isNew: (m: Memory) => boolean): Promise<void> {
    return memory
      .get()
      .then((m) => {
        if (!isNew(m)) return
        return memory.update(change).then(() => scheduleRefocus())
      })
      .catch((e) => orca.log(`learn: ${String(e)}`))
  }

  function scheduleRefocus() {
    // A folder already known from an id stays right when an agent's state changes: only an
    // unresolved or name-matched focus can gain from a new link.
    if (lastResolved.startsWith('terminal:') || lastResolved.startsWith('agent:')) return
    if (refocusTimer) clearTimeout(refocusTimer)
    refocusTimer = setTimeout(() => void refocus(null).catch((e) => orca.log(`refocus: ${String(e)}`)), 600)
    refocusTimer.unref?.()
  }

  orca.events.on('agent.status.changed', async (e) => {
    if (!e.workspaceId) return
    const at = Date.now()
    const started = e.mainAgent?.stateStartedAt
    const workspaceId = e.workspaceId
    if (e.terminalId) {
      const terminalId = e.terminalId
      await learn((m) => rememberTerminal(m, terminalId, workspaceId, at), (m) => !knows(m, 'terminal', terminalId, workspaceId))
    }
    if (typeof started === 'number') {
      await learn(
        (m) => rememberObservation(m, { workspaceId, stateStartedAt: started, ...(e.title ? { title: e.title } : {}), at }),
        (m) => !knows(m, 'observation', workspaceId, started, e.title)
      )
    }
  })

  // Hooks: observe and pass. `next(event)` goes back before anything is awaited, and the event is
  // returned unchanged, so Ballast never slows an agent down or alters a launch.
  orca.hooks.on('agent.launch.before', (e, next) => {
    const at = Date.now()
    const record = launchRecord(e, at)
    if (e.terminalId && e.workspaceId) {
      const terminalId = e.terminalId
      const workspaceId = e.workspaceId
      void learn((m) => rememberTerminal(m, terminalId, workspaceId, at), (m) => !knows(m, 'terminal', terminalId, workspaceId))
    }
    if (record) void memory.update((m) => rememberLaunch(m, record))
    return next(e)
  })

  orca.hooks.on('agent.tool.after', (e, next) => {
    if (e.terminalId && e.workspaceId) {
      const terminalId = e.terminalId
      const workspaceId = e.workspaceId
      void learn((m) => rememberTerminal(m, terminalId, workspaceId, Date.now()), (m) => !knows(m, 'terminal', terminalId, workspaceId))
    }
    return next(e)
  })

  // ------------------------------------------------------------ transcript watcher
  let watching = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  async function checkArrivals(configDir: string, folder: string) {
    const { names } = await service.recordSeen(configDir, folder)
    if (names.length === 0) return
    orca.panels.post('ballast.arrivals', { folder, names })
    const body = t(s.notifyBody, { folder: path.basename(folder), names: names.join(', ') })
    void orca.host.call('notifications.show', { title: s.notifyTitle, body }).catch(() => undefined)
  }

  async function watchFolder(configDir: string, folder: string) {
    const dir = await projectDirFor(configDir, folder)
    const key = `${pathKey(configDir)}|${pathKey(dir)}`
    if (key === watching) return
    watcher?.close()
    watcher = null
    watching = key
    try {
      watcher = watch(dir, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void checkArrivals(configDir, folder).catch((e) => orca.log(String(e))), 1500)
        timer.unref()
      })
      // The watcher must never keep the worker (or a test run) alive on its own.
      watcher.unref()
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
        watching = ''
      })
    } catch {
      // No transcripts folder yet: the next scan tries again.
      watching = ''
    }
  }

  // ------------------------------------------------------------ status bar
  async function updateStatus(folder: string, tokens: number | null) {
    const text = tokens === null ? s.statusNone : t(s.statusText, { tokens: formatTokens(tokens) })
    const tooltip = folder ? t(s.statusTooltip, { folder }) : s.title
    await orca.host.call('statusBar.update', { id: STATUS_ID, text, tooltip }).catch(() => undefined)
  }

  async function currentAgents(): Promise<AgentHint[]> {
    try {
      const answer = (await orca.host.call('agents.list', {})) as { agents: AgentHint[] }
      return answer.agents
    } catch {
      return []
    }
  }

  /** The folder in a `source:folder` key, so a new source for the same folder is not news. */
  function folderPart(key: string): string {
    const i = key.indexOf(':')
    return i < 0 ? '' : key.slice(i + 1)
  }

  /** Scans the focus the worker sees and brings the status bar and the watcher along with it. */
  async function follow(input: ScanInput) {
    const result = await service.scan(input)
    const before = lastResolved
    lastResolved = result.folder ? `${result.folderSource}:${result.folder}` : result.folderSource
    if (!result.folder) {
      await updateStatus('', null)
      return
    }
    await updateStatus(result.folder, result.totals.tokens)
    await watchFolder(result.profile.configDir, result.folder)
    // A folder the panel may not have drawn yet: tell it, so it scans again.
    if (folderPart(before) !== result.folder) {
      orca.panels.post('ballast.resolved', { folder: result.folder, source: result.folderSource })
    }
  }

  async function refocus(hint: WorkspaceHint | null) {
    let workspace = hint
    if (!workspace) {
      const ctx = (await orca.host.call('workspace.readContext', {}).catch(() => null)) as {
        displayName: string
        branch: string
        terminals: { id: string; title?: string }[]
      } | null
      workspace = ctx ? { displayName: ctx.displayName, branch: ctx.branch, terminals: ctx.terminals } : null
    }
    await follow({ workspace, agents: await currentAgents() })
  }

  orca.events.on('workspace.changed', async ({ context }) => {
    const hint = context ? { displayName: context.displayName, branch: context.branch, terminals: context.terminals } : null
    await refocus(hint).catch((e) => orca.log(`follow: ${String(e)}`))
  })

  // ------------------------------------------------------------ panel requests
  orca.panels.handle('ballast.scan', async (input) => {
    if (input.locale) setLocale(input.locale)
    const result = await service.scan(input).catch((e) => {
      orca.log(`scan failed: ${String(e)}`)
      throw e
    })
    lastResolved = result.folder ? `${result.folderSource}:${result.folder}` : result.folderSource
    if (result.folder) {
      void watchFolder(result.profile.configDir, result.folder)
      void updateStatus(result.folder, result.totals.tokens)
    } else {
      void updateStatus('', null)
    }
    return result
  })

  orca.panels.handle('ballast.plan', (input) => service.plan(input))

  orca.panels.handle('ballast.applyBatch', async (input) => {
    const result = await service.applyBatch(input)
    for (const w of result.writes) orca.log(`wrote ${w.file} (${w.count} items)`)
    return result
  })

  orca.panels.handle('ballast.undo', async (input) => {
    const result = await service.undo(input)
    if (result.ok) orca.log(`undid ${result.file}`)
    return result
  })

  orca.panels.handle('ballast.apply', async (input) => {
    const result = await service.apply(input)
    if (result.ok) orca.log(`wrote ${result.file}`)
    return result
  })
}

export async function deactivate(): Promise<void> {
  watcher?.close()
  watcher = null
  await flushMemory?.().catch(() => undefined)
  flushMemory = null
}
