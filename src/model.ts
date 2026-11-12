// The data model the worker sends and the panel draws. Plain JSON, no Node imports: both sides
// include it. Every item carries the agent it belongs to (Claude Code or Codex), and every agent's
// scanner returns the same shape.

export type AgentId = 'claude-code' | 'codex'

/** The agents Ballast reads, by the name Orca gives them in `agents.list`. */
export const KNOWN_AGENTS: Record<string, AgentId> = { claude: 'claude-code', codex: 'codex' }

/** The supported agents among `agents.list` entries, Claude Code first. Shared by worker and panel. */
export function agentsPresent(agents: { agent: string | null }[]): AgentId[] {
  const found = new Set(agents.map((a) => (a.agent ? KNOWN_AGENTS[a.agent] : undefined)))
  return (['claude-code', 'codex'] as const).filter((id) => found.has(id))
}

export type ItemKind = 'plugin' | 'skill' | 'mcp' | 'connector' | 'memory'
export const ITEM_KINDS: readonly ItemKind[] = ['plugin', 'skill', 'mcp', 'connector', 'memory']

/**
 * Where something comes from or which layer decides its state. `state` is the user state file
 * (`.claude.json`, written by `/mcp`), `session` is what a transcript showed, `default` means no
 * layer says anything.
 */
export type Level =
  | 'managed'
  | 'user'
  | 'project'
  | 'local'
  | 'plugin'
  | 'state'
  | 'session'
  | 'default'
  | 'builtin'

/**
 * `shared` is `.claude/settings.json` (Claude Code) or `.codex/config.toml` (Codex), committed;
 * `personal` is `.claude/settings.local.json`. Codex has no personal project file.
 */
export type WriteTarget = 'shared' | 'personal'
export const WRITE_TARGETS: readonly WriteTarget[] = ['shared', 'personal']

export type Op = 'enable' | 'block' | 'reset'
export const OPS: readonly Op[] = ['enable', 'block', 'reset']

/** `on-demand` loads only when Claude touches a file there; `pending` waits for approval. */
export type ItemState = 'on' | 'off' | 'on-demand' | 'pending' | 'not-installed'

/** A message code the panel translates; args fill its placeholders. Never carries secrets. */
export interface Note {
  code: NoteCode
  args?: Record<string, string>
}

export type NoteCode =
  | 'notInstalled'
  | 'pluginSkillNoOverride'
  | 'pluginServerToolsOnly'
  | 'pluginOff'
  | 'deniedElsewhere'
  | 'managedDecides'
  | 'disabledByMcpToggle'
  | 'rejectedElsewhere'
  | 'sharedApprovalNeedsTrust'
  | 'pendingApproval'
  | 'connectorsOffElsewhere'
  | 'connectorManageOnline'
  | 'tokensUnknown'
  | 'onDemand'
  | 'managedMemory'
  | 'excludedElsewhere'
  | 'autoMemoryOffElsewhere'
  | 'modelInvocationOff'
  | 'alreadyThisWay'
  | 'denyRuleRemovesTools'
  | 'needsAuth'
  | 'failed'
  | 'newArrival'
  | 'noEntryInFile'
  | 'bundledSkill'
  | 'allowlistBlocks'
  | 'unmatchedDeny'
  | 'readError'
  | 'noTranscripts'
  | 'userTargetRefused'
  | 'notInProject'
  | 'denyBlocksPluginServer'
  | 'fileChanged'
  | 'undoGone'
  | 'projectNotTrusted'
  | 'noPersonalFile'
  | 'codexPluginSkillNoOverride'
  | 'tomlUnsupported'
  | 'noSwitchInCodex'
  | 'beyondDocLimit'
  | 'docTruncated'

/** A JSON change to a Claude Code settings file. Values are names only, never secrets. */
export type JsonMutation =
  | { type: 'set'; path: string[]; value: boolean | string }
  | { type: 'unset'; path: string[] }
  | { type: 'arrayAdd'; path: string[]; value: string | { serverName: string } }
  | { type: 'arrayRemove'; path: string[]; value: string | { serverName: string } }

/** A change to a Codex `config.toml`: booleans and names only. */
export type TomlMutation =
  /** `key = value` in the table `[table...]` (e.g. `enabled` in `[plugins."a@b"]`). */
  | { type: 'tomlSet'; table: string[]; key: string; value: boolean }
  | { type: 'tomlUnset'; table: string[]; key: string }
  /** The `[[skills.config]]` entry that selects a skill by name. */
  | { type: 'skillRuleSet'; name: string; enabled: boolean }
  | { type: 'skillRuleRemove'; name: string }

export type Mutation = JsonMutation | TomlMutation

export interface ActionInfo {
  allowed: boolean
  /** Why it is not allowed, or what to keep in mind when it is. */
  notes: Note[]
  /** Readable form of the change, e.g. `enabledPlugins["figma@acme"] = true`. */
  mechanism?: string
  mutations?: Mutation[]
}

export type ItemActions = Record<Op, ActionInfo>

export interface Item {
  /** Stable within one scan: `kind:scope:name`. */
  id: string
  agent: AgentId
  kind: ItemKind
  name: string
  /** Where it comes from; `plugin` names the plugin when `level` is `plugin`. */
  origin: { level: Level; plugin?: string; path?: string }
  state: ItemState
  /** The layer that decides the state, and the file and key that say so. */
  decidedBy: { level: Level; file?: string; key?: string }
  /** Estimated tokens in context now (0 when off). */
  tokens: number
  /** Estimated tokens it would bring when on; equals `tokens` when on. */
  tokensIfOn: number
  /** How the estimate was made. */
  basis: 'description' | 'file' | 'tools' | 'components' | 'unknown'
  /** False for items whose tokens a parent already counts or that load on demand. */
  countsInTotal: boolean
  /** The plugin id for a plugin's skill or server. */
  parent?: string
  toolCount?: number
  lastSeenAt?: number
  /** First seen by Ballast recently, from a transcript. */
  isNew?: boolean
  notes: Note[]
  actions: Record<WriteTarget, ItemActions>
}

/**
 * Why this profile is in use: `chosen` (a write request names the home; a scan never does); `launch` (the home a recent agent launch in
 * this workspace carried); `orca-active` (Orca's active account for the agent); `env` (the
 * worker's own CLAUDE_CONFIG_DIR / CODEX_HOME); `default` (~/.claude or ~/.codex).
 */
export type ProfileSource = 'chosen' | 'launch' | 'orca-active' | 'env' | 'default'

export interface ProfileInfo {
  agent: AgentId
  /** The agent's home: CLAUDE_CONFIG_DIR for Claude Code, CODEX_HOME for Codex. */
  configDir: string
  source: ProfileSource
  /** Account e-mail, when known. */
  account?: string
  /** Orca's managed account id when the profile is one of Orca's. */
  orcaAccountId?: string
  exists: boolean
}

/** A workspace that fits the focused one by name and branch; the person picks among these. */
export interface WorkspaceChoice {
  id: string
  name: string
  path: string
  branch: string | null
}

/**
 * How the folder was found: `terminal` (a terminal id of the focused workspace is known),
 * `agent` (an agent's start time matched an event), `name` (one workspace has that name and
 * branch), `ambiguous` (several do: pick one) or `none` (no focused workspace).
 */
export type FolderSource = 'terminal' | 'agent' | 'name' | 'ambiguous' | 'none'

export interface Totals {
  tokens: number
  byKind: Record<ItemKind, number>
  /** Ids of the heaviest items that count, heaviest first. */
  heaviest: string[]
}

export interface SessionsInfo {
  dir: string
  count: number
  /** Recent sessions from the Claude desktop app, left out of the weights. */
  skippedDesktop?: number
  latestAt?: number
}

export interface ScanResult {
  agent: AgentId
  folder: string
  folderSource: FolderSource
  /** The focused workspace's name, when it could not be matched to one folder. */
  workspaceHint?: string
  profile: ProfileInfo
  /** The supported agents running in the focused workspace; the panel draws its switch from it. */
  agentsPresent: AgentId[]
  /** Only when `folderSource` is `ambiguous`: the workspaces with that name and branch. */
  candidates: WorkspaceChoice[]
  /** Codex only: false when the folder is not trusted, so Codex ignores its `.codex/config.toml`. */
  projectTrusted?: boolean
  items: Item[]
  totals: Totals
  sessions: SessionsInfo
  warnings: Note[]
  /** The two files the commands write to, relative to the folder (`personal` is empty for Codex). */
  targets: Record<WriteTarget, { file: string; exists: boolean }>
  scannedAt: number
}

export interface PlanResult {
  ok: boolean
  error?: Note
  file?: string
  relFile?: string
  created?: boolean
  /** Unified diff of the file with every value outside the touched keys shown as "…". */
  diff?: string
  mechanism?: string
  /** Fingerprint of the file the plan was made from; apply refuses if the file changed. */
  baseHash?: string
  notes?: Note[]
}

export interface ApplyResult {
  ok: boolean
  error?: Note
  file?: string
}

/** One item of a batch: written (`ok`), or why not. */
export interface BatchItemResult {
  itemId: string
  ok: boolean
  error?: Note
}

/** One file a batch wrote, once, with the redacted diff and the id `ballast.undo` takes. */
export interface BatchWrite {
  file: string
  relFile: string
  diff: string
  undoId: string
  /** How many items this write carries. */
  count: number
}

export interface BatchResult {
  results: BatchItemResult[]
  writes: BatchWrite[]
}

export interface ArrivalEvent {
  folder: string
  names: string[]
}
