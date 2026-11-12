// What the worker's handlers do, without Orca: find the focused folder and the agent profile,
// scan, plan and apply. Tests drive it with fixture folders; the worker wires it to Orca's host.
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { agentsPresent, KNOWN_AGENTS } from '../model.ts'
import type {
  AgentId,
  ApplyResult,
  BatchItemResult,
  BatchResult,
  BatchWrite,
  Item,
  Mutation,
  Note,
  PlanResult,
  ProfileInfo,
  ScanResult,
  WorkspaceChoice,
  WriteTarget
} from '../model.ts'
import type { EditInput, ScanInput } from '../protocol.ts'
import type { OrcaAccounts } from './accounts.ts'
import { scanClaude, totalsOf } from './claude.ts'
import { scanCodex } from './codex.ts'
import { checkCodexTarget, checkTarget, codexTargetFile, hashText, planBatchFile, planCodexFile, planFile, targetFile, writeAtomic } from './edits.ts'
import {
  type AgentRef,
  type FocusContext,
  type LaunchRecord,
  matchesWorkspace,
  type Memory,
  rememberChoice,
  resolveWorkspace,
  type WorkspaceRecord
} from './focus.ts'
import { readText } from './fsx.ts'
import type { MemoryStore } from './memory-store.ts'
import { pathKey } from './paths.ts'
import { defaultOrcaDataDir, type HostEnv, resolveProfile } from './profile.ts'
import { managedSettingsFile } from './settings.ts'
import { stateFilePath } from './state.ts'
import { scanTranscripts } from './transcripts.ts'

export { agentsPresent } from '../model.ts'
export { matchWorkspace, type WorkspaceRecord } from './focus.ts'

export function hostEnvFromProcess(): HostEnv {
  const homeDir = os.homedir()
  const platform = process.platform
  return {
    homeDir,
    platform,
    orcaDataDir: defaultOrcaDataDir(homeDir, platform, process.env),
    envConfigDir: process.env.CLAUDE_CONFIG_DIR || undefined,
    envCodexHome: process.env.CODEX_HOME || undefined,
    managedSettingsFile: managedSettingsFile(platform)
  }
}

/** Where "first seen" times live in plugin storage, per profile and folder. */
export function seenKey(configDir: string, folder: string): string {
  return `seen:${pathKey(configDir)}|${pathKey(folder)}`
}

export interface Store {
  get(key: string): Promise<unknown>
  set(key: string, value: Record<string, number>): Promise<void>
}

export interface ServiceDeps {
  env: HostEnv
  store: Store
  /** What the worker remembers about terminals, agents and launches. */
  memory: MemoryStore
  listWorkspaces: () => Promise<WorkspaceRecord[]>
  /** Orca's account list (the CLI, cached); null when it is not available. */
  accounts?: () => Promise<OrcaAccounts | null>
  now?: () => number
}

export interface Arrivals {
  names: string[]
  firstSeen: Record<string, number>
}

/**
 * The agent the panel shows: the person's last pick when that agent is still present, else the
 * one with the most recent activity. Null when no supported agent is in the workspace.
 */
export function pickAgent(agents: AgentRef[], preferred?: AgentId | null): AgentId | null {
  if (preferred && agentsPresent(agents).includes(preferred)) return preferred
  let best: { at: number; id: AgentId } | null = null
  for (const a of agents) {
    const id = a.agent ? KNOWN_AGENTS[a.agent] : undefined
    if (id && (!best || a.stateStartedAt > best.at)) best = { at: a.stateStartedAt, id }
  }
  return best?.id ?? null
}

/** The home the newest launch in this workspace carried for this agent, or null. */
export function launchHomeFor(memory: Memory, workspace: WorkspaceRecord, agent: AgentId): string | null {
  const mine = memory.launches
    .filter((l: LaunchRecord) => matchesWorkspace(l.workspaceId, workspace) && KNOWN_AGENTS[l.agent] === agent)
    .sort((a, b) => b.at - a.at)
  for (const l of mine) {
    const home = agent === 'claude-code' ? l.claudeConfigDir : l.codexHome
    if (home) return home
  }
  return null
}

export function createService(deps: ServiceDeps) {
  const now = () => (deps.now ? deps.now() : Date.now())
  const accounts = async () => (deps.accounts ? await deps.accounts().catch(() => null) : null)

  /**
   * Records server names a transcript shows for the first time. The first look at a folder sets
   * a quiet baseline; after that, every unseen name is an arrival.
   */
  async function recordSeen(configDir: string, folder: string): Promise<Arrivals> {
    const key = seenKey(configDir, folder)
    const stored = await deps.store.get(key)
    const firstSeen: Record<string, number> =
      stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...(stored as Record<string, number>) } : {}
    const baseline = Object.keys(firstSeen).length === 0
    const scan = await scanTranscripts(configDir, folder)
    const names: string[] = []
    for (const s of scan.servers) {
      if (s.name in firstSeen) continue
      firstSeen[s.name] = baseline ? 0 : now()
      if (!baseline) names.push(s.name)
    }
    if (baseline && scan.servers.length === 0) return { names, firstSeen }
    await deps.store.set(key, firstSeen)
    return { names, firstSeen }
  }

  async function workspaces(): Promise<WorkspaceRecord[]> {
    try {
      return await deps.listWorkspaces()
    } catch {
      return []
    }
  }

  function focusOf(input: ScanInput): FocusContext | null {
    const w = input.workspace
    return w ? { displayName: w.displayName, branch: w.branch, terminals: w.terminals ?? [] } : null
  }

  async function scanAgent(agent: AgentId, folder: string, profile: ProfileInfo, firstSeen?: Record<string, number>) {
    if (agent === 'codex') {
      return scanCodex({ folder, profile, homeDir: deps.env.homeDir, platform: deps.env.platform, now: now() })
    }
    return scanClaude({
      folder,
      profile,
      homeDir: deps.env.homeDir,
      platform: deps.env.platform,
      managedSettingsFile: deps.env.managedSettingsFile,
      firstSeen,
      now: now()
    })
  }

  /**
   * Resolves the focused workspace (see focus.ts), then the agent and its profile, then scans.
   * `input.choose` first remembers the person's pick among the candidates.
   */
  async function scan(input: ScanInput): Promise<ScanResult> {
    const ctx = focusOf(input)
    const agents: AgentRef[] = input.agents ?? []
    // Nothing supported is running here: no profile, no scan.
    const present = agentsPresent(agents)
    const agent = pickAgent(agents, input.agent)
    if (!agent) return { ...emptyScan(NO_PROFILE, []), ...(ctx ? { workspaceHint: ctx.displayName } : {}) }

    const list = await workspaces()
    if (ctx && input.choose && list.some((w) => w.id === input.choose)) {
      const id = input.choose
      await deps.memory.update((m) => rememberChoice(m, ctx, agents, id, now()))
    }
    const memory = await deps.memory.get()
    const resolution = resolveWorkspace(ctx, agents, list, memory)

    const acc = await accounts()
    const resolved = resolution.status === 'resolved' ? resolution.workspace : null
    const profile = await resolveProfile(deps.env, {
      agent,
      launchHome: resolved ? launchHomeFor(memory, resolved, agent) : null,
      accounts: acc
    })

    if (resolution.status !== 'resolved') {
      const candidates: WorkspaceChoice[] =
        resolution.status === 'ambiguous'
          ? resolution.candidates.map((w) => ({ id: w.id, name: w.name, path: w.path, branch: w.branch }))
          : []
      return {
        ...emptyScan(profile, candidates),
        agentsPresent: present,
        folderSource: resolution.status === 'ambiguous' ? 'ambiguous' : 'none',
        ...(ctx ? { workspaceHint: ctx.displayName } : {})
      }
    }
    const folder = resolution.workspace.path
    const firstSeen = agent === 'claude-code' ? (await recordSeen(profile.configDir, folder)).firstSeen : undefined
    const result = await scanAgent(agent, folder, profile, firstSeen)
    return { ...result, folderSource: resolution.source, agentsPresent: present, candidates: [] }
  }

  async function findItem(input: EditInput): Promise<{ item: Item; profile: ProfileInfo } | null> {
    const profile = await resolveProfile(deps.env, { agent: input.agent, chosen: input.configDir })
    const result = await scanAgent(input.agent, input.folder, profile)
    const item = result.items.find((i) => i.id === input.itemId)
    return item ? { item, profile } : null
  }

  /**
   * The file a write goes to for this agent and target, or the note refusing it. The only place
   * that decides which file may be written: the folder's own project file, never a user-level one.
   */
  async function guardFor(
    agent: AgentId,
    folder: string,
    target: WriteTarget,
    profile: ProfileInfo
  ): Promise<{ file: string; relFile: string } | { error: Note }> {
    if (agent === 'codex') {
      const file = codexTargetFile(folder)
      const orca = deps.env.orcaDataDir
      const refused = await checkCodexTarget(file, folder, {
        codexHome: profile.configDir,
        homeDir: deps.env.homeDir,
        orcaHomes: orca ? [path.join(orca, 'codex-accounts'), path.join(orca, 'codex-runtime-home')] : []
      })
      return refused ? { error: refused } : { file, relFile: '.codex/config.toml' }
    }
    const file = targetFile(folder, target)
    const refused = await checkTarget(file, folder, {
      configDir: profile.configDir,
      homeDir: deps.env.homeDir,
      stateFile: stateFilePath(profile.configDir, deps.env.homeDir),
      managedFile: deps.env.managedSettingsFile
    })
    if (refused) return { error: refused }
    return { file, relFile: targetFile('.', target).replace(/\\/g, '/').replace(/^\.\//, '') }
  }

  async function prepare(input: EditInput) {
    const found = await findItem(input)
    if (!found) return { error: { code: 'notInProject' as const } }
    const action = found.item.actions[input.target][input.op]
    if (!action.allowed || !action.mutations) {
      return { error: action.notes[0] ?? { code: 'alreadyThisWay' as const } }
    }
    const guard = await guardFor(input.agent, input.folder, input.target, found.profile)
    if ('error' in guard) return { error: guard.error }
    const planned =
      input.agent === 'codex'
        ? await planCodexFile(input.folder, action.mutations)
        : await planFile(input.folder, input.target, action.mutations)
    if ('error' in planned) return { error: planned.error }
    return { planned, action, relFile: guard.relFile }
  }

  async function plan(input: EditInput): Promise<PlanResult> {
    const ready = await prepare(input)
    if ('error' in ready) return { ok: false, error: ready.error }
    const { planned, action, relFile } = ready
    return {
      ok: true,
      file: planned.file,
      relFile,
      created: planned.before === null,
      diff: planned.diff,
      mechanism: action.mechanism,
      baseHash: planned.baseHash,
      notes: action.notes
    }
  }

  async function apply(input: EditInput & { baseHash: string }): Promise<ApplyResult> {
    const ready = await prepare(input)
    if ('error' in ready) return { ok: false, error: ready.error }
    const current = await readText(ready.planned.file)
    if (hashText(current) !== input.baseHash) return { ok: false, error: { code: 'fileChanged' } }
    await writeAtomic(ready.planned.file, ready.planned.after)
    return { ok: true, file: ready.planned.file }
  }

  /** What each recent batch write replaced, in worker memory only (never in storage). Newest last. */
  const undos: { undoId: string; file: string; before: string | null; afterHash: string }[] = []
  const UNDO_LIMIT = 10

  /**
   * Writes many items at once. Each (agent, home, folder) is scanned once; the items aimed at the
   * same file are applied in order to the same text and written once, atomically. An item that is
   * not allowed, cannot apply or is refused is reported and skipped; the others stay written.
   */
  async function applyBatch(input: { items: EditInput[] }): Promise<BatchResult> {
    const results = new Map<string, BatchItemResult>()
    const fail = (itemId: string, error: Note) => void results.set(itemId, { itemId, ok: false, error })
    const scans = new Map<string, Promise<{ items: Item[]; profile: ProfileInfo }>>()
    const scanOnce = (i: EditInput) => {
      const key = `${i.agent}|${pathKey(i.configDir)}|${pathKey(i.folder)}`
      let p = scans.get(key)
      if (!p) {
        p = resolveProfile(deps.env, { agent: i.agent, chosen: i.configDir }).then(async (profile) => ({
          items: (await scanAgent(i.agent, i.folder, profile)).items,
          profile
        }))
        scans.set(key, p)
      }
      return p
    }

    type Group = {
      kind: 'claude' | 'codex'
      folder: string
      file: string
      relFile: string
      items: { id: string; mutations: Mutation[] }[]
    }
    const groups = new Map<string, Group>()
    for (const i of input.items) {
      if (results.has(i.itemId)) continue
      const { items, profile } = await scanOnce(i)
      const item = items.find((x) => x.id === i.itemId)
      if (!item) {
        fail(i.itemId, { code: 'notInProject' })
        continue
      }
      const action = item.actions[i.target][i.op]
      if (!action.allowed || !action.mutations) {
        fail(i.itemId, action.notes[0] ?? { code: 'alreadyThisWay' })
        continue
      }
      const guard = await guardFor(i.agent, i.folder, i.target, profile)
      if ('error' in guard) {
        fail(i.itemId, guard.error)
        continue
      }
      const key = pathKey(guard.file)
      const group = groups.get(key) ?? { kind: i.agent === 'codex' ? 'codex' : 'claude', folder: i.folder, ...guard, items: [] }
      group.items.push({ id: i.itemId, mutations: action.mutations })
      groups.set(key, group)
    }

    const writes: BatchWrite[] = []
    for (const g of groups.values()) {
      const { planned, results: per } = await planBatchFile(g.kind, g.folder, g.file, g.items)
      for (const r of per) results.set(r.id, r.error ? { itemId: r.id, ok: false, error: r.error } : { itemId: r.id, ok: true })
      if (!planned) continue
      try {
        await writeAtomic(planned.file, planned.after)
      } catch {
        for (const r of per) if (!r.error) fail(r.id, { code: 'readError', args: { file: planned.file } })
        continue
      }
      const undoId = randomUUID()
      undos.push({ undoId, file: planned.file, before: planned.before, afterHash: hashText(planned.after) })
      while (undos.length > UNDO_LIMIT) undos.shift()
      writes.push({ file: planned.file, relFile: g.relFile, diff: planned.diff, undoId, count: per.filter((r) => !r.error).length })
    }
    return { results: input.items.map((i) => results.get(i.itemId) ?? { itemId: i.itemId, ok: false }), writes }
  }

  /** Puts back a batch write's file, only if it is still exactly as that write left it. */
  async function undo(input: { undoId: string }): Promise<ApplyResult> {
    const at = undos.findIndex((u) => u.undoId === input.undoId)
    if (at < 0) return { ok: false, error: { code: 'undoGone' } }
    const u = undos[at]
    if (hashText(await readText(u.file)) !== u.afterHash) return { ok: false, error: { code: 'fileChanged' } }
    if (u.before === null) await fs.rm(u.file, { force: true })
    else await writeAtomic(u.file, u.before)
    undos.splice(at, 1)
    return { ok: true, file: u.file }
  }

  return { scan, plan, apply, applyBatch, undo, recordSeen }
}

/** Stands in for the profile when no agent is present; the panel does not draw it. */
const NO_PROFILE: ProfileInfo = { agent: 'claude-code', configDir: '', source: 'default', exists: false }

export function emptyScan(profile: ProfileInfo, candidates: WorkspaceChoice[]): ScanResult {
  return {
    agent: profile.agent,
    folder: '',
    folderSource: 'none',
    profile,
    agentsPresent: [],
    candidates,
    items: [],
    totals: totalsOf([]),
    sessions: { dir: '', count: 0 },
    warnings: [],
    targets: {
      shared: { file: profile.agent === 'codex' ? '.codex/config.toml' : '.claude/settings.json', exists: false },
      personal: { file: profile.agent === 'codex' ? '' : '.claude/settings.local.json', exists: false }
    },
    scannedAt: Date.now()
  }
}
