// Which workspace has the focus, and which folder is it? Orca's `workspace.readContext` gives a
// name, a branch and terminal ids, never a path or a workspace id, and many workspaces share a
// name and a branch. So Ballast resolves the folder from what Orca does report with an id:
//
//   1. terminals: `agent.status.changed` and the agent hooks carry `terminalId` + `workspaceId`;
//      the worker remembers them, and `readContext.terminals[].id` is the same identifier
//      (checked live on Orca 1.4.255);
//   2. agents: native chat agents have no terminal, but `agents.list[].stateStartedAt` equals the
//      `mainAgent.stateStartedAt` of the event that carried their `workspaceId`;
//   3. a name and branch that fit exactly one workspace;
//   4. otherwise the answer is "ambiguous" and the person picks one of the candidates.
//
// Pure functions over plain data, so tests need no Orca. Only ids, titles and timestamps are
// ever remembered.
import { pathKey } from './paths.ts'

export interface WorkspaceRecord {
  id: string
  kind: string
  name: string
  path: string
  branch: string | null
  hostId: string | null
}

/** What `workspace.readContext` says about the focused workspace. */
export interface FocusContext {
  displayName: string
  branch: string
  terminals: { id: string; title?: string }[]
}

/** One entry of `agents.list`. */
export interface AgentRef {
  terminalId: string | null
  title: string | null
  agent: string | null
  stateStartedAt: number
}

/** An `agent.status.changed` event, reduced to what matching needs. */
export interface AgentObservation {
  workspaceId: string
  stateStartedAt: number
  title?: string
  at: number
}

export interface TerminalLink {
  id: string
  workspaceId: string
  at: number
}

/** A profile an agent launch carried (only the two home variables are ever kept). */
export interface LaunchRecord {
  workspaceId: string
  terminalId?: string
  /** The Orca agent id, e.g. `claude` or `codex`. */
  agent: string
  claudeConfigDir?: string
  codexHome?: string
  at: number
}

/** Everything the worker remembers between runs. */
export interface Memory {
  v: 1
  terminals: TerminalLink[]
  observations: AgentObservation[]
  launches: LaunchRecord[]
}

export const LIMITS = { terminals: 500, observations: 300, launches: 200, candidates: 50 } as const

export function emptyMemory(): Memory {
  return { v: 1, terminals: [], observations: [], launches: [] }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** Reads what storage returned, dropping anything that is not the expected shape. */
export function normalizeMemory(raw: unknown): Memory {
  const out = emptyMemory()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  const r = raw as Record<string, unknown>
  for (const t of Array.isArray(r.terminals) ? r.terminals : []) {
    const o = t as Record<string, unknown>
    if (str(o?.id) && str(o?.workspaceId) && typeof o.at === 'number') {
      out.terminals.push({ id: o.id as string, workspaceId: o.workspaceId as string, at: o.at })
    }
  }
  for (const t of Array.isArray(r.observations) ? r.observations : []) {
    const o = t as Record<string, unknown>
    if (str(o?.workspaceId) && typeof o.stateStartedAt === 'number' && typeof o.at === 'number') {
      const title = str(o.title)
      out.observations.push({
        workspaceId: o.workspaceId as string,
        stateStartedAt: o.stateStartedAt,
        ...(title ? { title } : {}),
        at: o.at
      })
    }
  }
  for (const t of Array.isArray(r.launches) ? r.launches : []) {
    const o = t as Record<string, unknown>
    if (str(o?.workspaceId) && str(o?.agent) && typeof o.at === 'number') {
      const terminalId = str(o.terminalId)
      const claudeConfigDir = str(o.claudeConfigDir)
      const codexHome = str(o.codexHome)
      out.launches.push({
        workspaceId: o.workspaceId as string,
        agent: o.agent as string,
        ...(terminalId ? { terminalId } : {}),
        ...(claudeConfigDir ? { claudeConfigDir } : {}),
        ...(codexHome ? { codexHome } : {}),
        at: o.at
      })
    }
  }
  return capMemory(out)
}

function newest<T extends { at: number }>(list: T[], limit: number): T[] {
  return list.length <= limit ? list : [...list].sort((a, b) => b.at - a.at).slice(0, limit)
}

export function capMemory(m: Memory): Memory {
  return {
    v: 1,
    terminals: newest(m.terminals, LIMITS.terminals),
    observations: newest(m.observations, LIMITS.observations),
    launches: newest(m.launches, LIMITS.launches)
  }
}

/** Remembers that a terminal belongs to a workspace; the oldest entries fall out past the limit. */
export function rememberTerminal(m: Memory, id: string, workspaceId: string, at: number): Memory {
  const rest = m.terminals.filter((t) => t.id !== id)
  return capMemory({ ...m, terminals: [...rest, { id, workspaceId, at }] })
}

export function rememberObservation(m: Memory, obs: AgentObservation): Memory {
  const rest = m.observations.filter(
    (o) => !(o.stateStartedAt === obs.stateStartedAt && o.workspaceId === obs.workspaceId && o.title === obs.title)
  )
  return capMemory({ ...m, observations: [...rest, obs] })
}

export function rememberLaunch(m: Memory, launch: LaunchRecord): Memory {
  return capMemory({ ...m, launches: [...m.launches, launch] })
}

/** True when remembering this would change nothing, so a busy agent does not rewrite storage. */
export function knows(m: Memory, kind: 'terminal' | 'observation', a: string, b: string | number, title?: string): boolean {
  if (kind === 'terminal') return m.terminals.some((t) => t.id === a && t.workspaceId === b)
  return m.observations.some((o) => o.workspaceId === a && o.stateStartedAt === b && o.title === title)
}

// ------------------------------------------------------------------ resolution

export type FocusSource = 'terminal' | 'agent' | 'name'

export type Resolution =
  | { status: 'resolved'; source: FocusSource; workspace: WorkspaceRecord }
  /** `candidates`: workspaces with the focused workspace's name and branch (at most LIMITS.candidates). */
  | { status: 'ambiguous'; candidates: WorkspaceRecord[] }
  | { status: 'none' }

function baseName(p: string): string {
  const parts = p.replace(/\\/g, '/').replace(/\/$/, '').split('/')
  return parts[parts.length - 1] ?? p
}

function branchName(b: string | null | undefined): string {
  return (b ?? '').replace(/^refs\/heads\//, '')
}

/** Workspaces with the context's name (or folder name) and, when it has one, its branch. */
export function candidatesFor(hint: Pick<FocusContext, 'displayName' | 'branch'>, list: WorkspaceRecord[]): WorkspaceRecord[] {
  const byName = list.filter((w) => w.name === hint.displayName || baseName(w.path) === hint.displayName)
  const pool = hint.branch ? byName.filter((w) => branchName(w.branch) === branchName(hint.branch)) : byName
  const unique = new Map(pool.map((w) => [pathKey(w.path), w]))
  return [...unique.values()]
}

/**
 * The workspace `workspace.readContext` describes, found in `workspace.list`, when exactly one
 * fits by name and branch. Returns null rather than guess.
 */
export function matchWorkspace(hint: Pick<FocusContext, 'displayName' | 'branch'>, list: WorkspaceRecord[]): WorkspaceRecord | null {
  const found = candidatesFor(hint, list)
  return found.length === 1 ? found[0] : null
}

/**
 * Events name a workspace as `<repoId>::<path>`, while `workspace.list` (Orca 1.4.255) gives it an
 * id such as `identity:wt2:local:<uuid>`. An event id fits a listed workspace when the ids are
 * equal or the path after `::` is the workspace's path.
 */
export function matchesWorkspace(id: string, w: Pick<WorkspaceRecord, 'id' | 'path'>): boolean {
  if (id === w.id) return true
  const i = id.indexOf('::')
  return i >= 0 && pathKey(id.slice(i + 2)) === pathKey(w.path)
}

export function findWorkspace(list: WorkspaceRecord[], id: string): WorkspaceRecord | undefined {
  return list.find((w) => w.id === id) ?? list.find((w) => matchesWorkspace(id, w))
}

/** The one workspace every id names (as listed), or null when they disagree or there are none. */
function agreed(ids: string[], list: WorkspaceRecord[]): WorkspaceRecord | null {
  const found = ids.map((id) => findWorkspace(list, id)?.id ?? id)
  const set = new Set(found)
  return set.size === 1 ? (list.find((w) => w.id === found[0]) ?? null) : null
}

/** Workspace ids the context's terminals are known to belong to. */
export function terminalWorkspaces(ctx: FocusContext, m: Memory): string[] {
  const known = new Map(m.terminals.map((t) => [t.id, t.workspaceId]))
  return ctx.terminals.flatMap((t) => (known.has(t.id) ? [known.get(t.id) as string] : []))
}

/**
 * Workspace ids the listed agents are known to belong to: an agent matches an observation when
 * `stateStartedAt` is exactly equal and, when both sides have a title, the titles are equal. An
 * agent with several matching observations takes the newest.
 */
export function agentWorkspaces(agents: AgentRef[], m: Memory): string[] {
  const out: string[] = []
  for (const a of agents) {
    const hits = m.observations
      .filter((o) => o.stateStartedAt === a.stateStartedAt && (!o.title || !a.title || o.title === a.title))
      .sort((x, y) => y.at - x.at)
    if (hits.length > 0) out.push(hits[0].workspaceId)
  }
  return out
}

export function resolveWorkspace(
  ctx: FocusContext | null | undefined,
  agents: AgentRef[],
  list: WorkspaceRecord[],
  m: Memory
): Resolution {
  if (!ctx) return { status: 'none' }
  const byTerminal = agreed(terminalWorkspaces(ctx, m), list)
  if (byTerminal) return { status: 'resolved', source: 'terminal', workspace: byTerminal }

  const byAgent = agreed(agentWorkspaces(agents, m), list)
  if (byAgent) return { status: 'resolved', source: 'agent', workspace: byAgent }

  const candidates = candidatesFor(ctx, list)
  if (candidates.length === 1) return { status: 'resolved', source: 'name', workspace: candidates[0] }
  return { status: 'ambiguous', candidates: candidates.slice(0, LIMITS.candidates) }
}

/**
 * Remembers the person's pick for this focus: the terminals, and the agents listed right now
 * (as observations, which hold while an agent's state does not change; the next event of that
 * agent carries the workspace id itself).
 */
export function rememberChoice(m: Memory, ctx: FocusContext, agents: AgentRef[], workspaceId: string, at: number): Memory {
  let next = m
  for (const t of ctx.terminals) next = rememberTerminal(next, t.id, workspaceId, at)
  for (const a of agents) {
    next = rememberObservation(next, { workspaceId, stateStartedAt: a.stateStartedAt, ...(a.title ? { title: a.title } : {}), at })
  }
  return next
}

/** A stable text for "did the resolution change", used to announce only new resolutions. */
export function resolutionKey(r: Resolution): string {
  if (r.status === 'resolved') return `${r.source}:${r.workspace.id}`
  return r.status
}

// ------------------------------------------------------------------ what hooks and events teach

/**
 * The profile an `agent.launch.before` event carried. Only `CLAUDE_CONFIG_DIR` and `CODEX_HOME`
 * are ever copied out of `env`: every other key and value is dropped here, unread. Null when the
 * launch has no workspace or carries neither variable.
 */
export function launchRecord(
  e: { agent: string; workspaceId: string | null; terminalId?: string; env: Record<string, string> },
  at: number
): LaunchRecord | null {
  if (!e.workspaceId) return null
  const claude = e.env?.CLAUDE_CONFIG_DIR
  const codex = e.env?.CODEX_HOME
  const claudeConfigDir = typeof claude === 'string' && claude !== '' && claude.length < 1024 ? claude : undefined
  const codexHome = typeof codex === 'string' && codex !== '' && codex.length < 1024 ? codex : undefined
  if (!claudeConfigDir && !codexHome) return null
  return {
    workspaceId: e.workspaceId,
    agent: e.agent,
    ...(e.terminalId ? { terminalId: e.terminalId } : {}),
    ...(claudeConfigDir ? { claudeConfigDir } : {}),
    ...(codexHome ? { codexHome } : {}),
    at
  }
}
