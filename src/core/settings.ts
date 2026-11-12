// Reads the settings layers Claude Code merges for a folder and keeps only the keys that decide
// what reaches the context. Everything else in those files (env, hooks, headers, helpers) is
// dropped on read, so no later step can show it by mistake.
import * as path from 'node:path'
import { asString, asStringArray, isRecord, readJsonObject } from './fsx.ts'

export type SettingsLevel = 'managed' | 'user' | 'project' | 'local'

/** Highest precedence first, as Claude Code applies them (command-line flags aside). */
export const PRECEDENCE: readonly SettingsLevel[] = ['managed', 'local', 'project', 'user']

/**
 * An MCP allow or deny rule. `url` and `command` stay inside the worker for matching; the
 * model sent to the panel never includes them.
 */
export type McpRule =
  | { kind: 'name'; name: string }
  | { kind: 'url'; pattern: string }
  | { kind: 'command'; command: string[] }

export interface LayerSettings {
  enabledPlugins: Record<string, boolean>
  deniedMcpServers: McpRule[]
  allowedMcpServers?: McpRule[]
  enabledMcpjsonServers: string[]
  disabledMcpjsonServers: string[]
  enableAllProjectMcpServers?: boolean
  disableClaudeAiConnectors?: boolean
  skillOverrides: Record<string, string>
  claudeMdExcludes: string[]
  autoMemoryEnabled?: boolean
  autoMemoryDirectory?: string
  /** Only `mcp__` deny rules; the others do not change what the panel shows. */
  mcpDenyRules: string[]
}

export interface Layer {
  level: SettingsLevel
  file: string
  exists: boolean
  broken: boolean
  s: LayerSettings
}

export function emptySettings(): LayerSettings {
  return {
    enabledPlugins: {},
    deniedMcpServers: [],
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    skillOverrides: {},
    claudeMdExcludes: [],
    mcpDenyRules: []
  }
}

function rules(value: unknown): McpRule[] {
  if (!Array.isArray(value)) return []
  const out: McpRule[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    if (typeof entry.serverName === 'string') out.push({ kind: 'name', name: entry.serverName })
    else if (typeof entry.serverUrl === 'string') out.push({ kind: 'url', pattern: entry.serverUrl })
    else if (Array.isArray(entry.serverCommand))
      out.push({ kind: 'command', command: asStringArray(entry.serverCommand) })
  }
  return out
}

export function pickSettings(raw: Record<string, unknown> | null): LayerSettings {
  const s = emptySettings()
  if (!raw) return s
  if (isRecord(raw.enabledPlugins)) {
    for (const [key, value] of Object.entries(raw.enabledPlugins)) {
      if (typeof value === 'boolean') s.enabledPlugins[key] = value
    }
  }
  s.deniedMcpServers = rules(raw.deniedMcpServers)
  if (Array.isArray(raw.allowedMcpServers)) s.allowedMcpServers = rules(raw.allowedMcpServers)
  s.enabledMcpjsonServers = asStringArray(raw.enabledMcpjsonServers)
  s.disabledMcpjsonServers = asStringArray(raw.disabledMcpjsonServers)
  if (typeof raw.enableAllProjectMcpServers === 'boolean')
    s.enableAllProjectMcpServers = raw.enableAllProjectMcpServers
  if (typeof raw.disableClaudeAiConnectors === 'boolean')
    s.disableClaudeAiConnectors = raw.disableClaudeAiConnectors
  if (isRecord(raw.skillOverrides)) {
    for (const [key, value] of Object.entries(raw.skillOverrides)) {
      if (typeof value === 'string') s.skillOverrides[key] = value
    }
  }
  s.claudeMdExcludes = asStringArray(raw.claudeMdExcludes)
  if (typeof raw.autoMemoryEnabled === 'boolean') s.autoMemoryEnabled = raw.autoMemoryEnabled
  s.autoMemoryDirectory = asString(raw.autoMemoryDirectory)
  if (isRecord(raw.permissions)) {
    s.mcpDenyRules = asStringArray(raw.permissions.deny).filter((r) => r.startsWith('mcp__'))
  }
  return s
}

export async function readLayer(level: SettingsLevel, file: string): Promise<Layer> {
  const read = await readJsonObject(file)
  return { level, file, exists: read.exists, broken: read.broken, s: pickSettings(read.value) }
}

export function managedSettingsFile(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  return '/etc/claude-code/managed-settings.json'
}

export function projectSettingsFile(folder: string, local: boolean): string {
  return path.join(folder, '.claude', local ? 'settings.local.json' : 'settings.json')
}

export interface Layers {
  managed: Layer
  user: Layer
  project: Layer
  local: Layer
}

export async function readLayers(input: {
  configDir: string
  folder: string
  managedFile: string
}): Promise<Layers> {
  const [managed, user, project, local] = await Promise.all([
    readLayer('managed', input.managedFile),
    readLayer('user', path.join(input.configDir, 'settings.json')),
    readLayer('project', projectSettingsFile(input.folder, false)),
    readLayer('local', projectSettingsFile(input.folder, true))
  ])
  return { managed, user, project, local }
}

export function inPrecedence(layers: Layers): Layer[] {
  return PRECEDENCE.map((level) => layers[level])
}

/** The highest layer whose `get` returns a value, with that value. */
export function decide<T>(
  layers: Layers,
  get: (s: LayerSettings) => T | undefined
): { layer: Layer; value: T } | null {
  for (const layer of inPrecedence(layers)) {
    const value = get(layer.s)
    if (value !== undefined) return { layer, value }
  }
  return null
}
