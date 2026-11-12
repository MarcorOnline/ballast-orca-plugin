// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type {
  AgentId,
  ApplyResult,
  ArrivalEvent,
  BatchResult,
  FolderSource,
  Op,
  PlanResult,
  ScanResult,
  WriteTarget
} from './model'

/** What the panel knows about the focused workspace (`workspace.readContext`). */
export interface WorkspaceHint {
  displayName: string
  branch: string
  /** The focused workspace's terminals; their ids are the same ones agent events carry. */
  terminals: { id: string; title?: string }[]
}

/** One entry of `agents.list` (focused workspace only). */
export interface AgentHint {
  terminalId: string | null
  title: string | null
  agent: string | null
  stateStartedAt: number
}

export interface ScanInput {
  /** `workspace.readContext`; null or absent when no workspace has the focus. */
  workspace?: WorkspaceHint | null
  /** `agents.list`: how chat agents, which have no terminal, are tied to a workspace. */
  agents?: AgentHint[]
  /** A workspace the person picked among the candidates; remembered for this focus. */
  choose?: string | null
  /** The agent the person picked with the switch; used when it is present, else the most recent one. */
  agent?: AgentId | null
  /** Orca's UI language (BCP-47): the worker has no API for it, so the panel passes it along. */
  locale?: string
}

export interface EditInput {
  folder: string
  agent: AgentId
  /** The agent's home (CLAUDE_CONFIG_DIR or CODEX_HOME). */
  configDir: string
  itemId: string
  op: Op
  target: WriteTarget
}

export interface ResolvedEvent {
  folder: string
  source: FolderSource
}

declare module 'orca' {
  interface PluginRequests {
    /** Rebuilds the context chain for the focused workspace's folder. */
    'ballast.scan': { input: ScanInput; output: ScanResult }
    /** Shows the change a command would make, without writing. */
    'ballast.plan': { input: EditInput; output: PlanResult }
    /** Writes the change the person confirmed; refuses if the file changed since the plan. */
    'ballast.apply': { input: EditInput & { baseHash: string }; output: ApplyResult }
    /** Writes many items at once, one write per target file; refusals are reported per item. */
    'ballast.applyBatch': { input: { items: EditInput[] }; output: BatchResult }
    /** Puts back what a batch's write replaced, if the file is still as that write left it. */
    'ballast.undo': { input: { undoId: string }; output: ApplyResult }
  }
  interface PluginPanelEvents {
    /** MCP servers or connectors that showed up in a running session for the first time. */
    'ballast.arrivals': ArrivalEvent
    /** The worker learned which folder the focused workspace is: the panel scans again. */
    'ballast.resolved': ResolvedEvent
  }
}
