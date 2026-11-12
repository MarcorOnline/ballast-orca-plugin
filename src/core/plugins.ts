// Installed Claude Code plugins in a config dir and what each one brings: skills, agents,
// commands and MCP servers, read from its manifest, its marketplace entry and its default folders.
import * as path from 'node:path'
import { type Component, readMarkdownComponents, scanSkillRoot, type SkillFile } from './components.ts'
import { asString, isDir, isRecord, listDirs, readJsonObject } from './fsx.ts'
import { isInside, samePath } from './paths.ts'
import { type ServerConfig, serverConfigs } from './state.ts'

export interface PluginInfo {
  /** `name@marketplace`, the `enabledPlugins` key. */
  key: string
  name: string
  marketplace: string
  installed: boolean
  root?: string
  defaultEnabled: boolean
  skills: SkillFile[]
  agents: Component[]
  commands: Component[]
  servers: ServerConfig[]
}

export function splitKey(key: string): { name: string; marketplace: string } {
  const at = key.lastIndexOf('@')
  return at > 0
    ? { name: key.slice(0, at), marketplace: key.slice(at + 1) }
    : { name: key, marketplace: '' }
}

type Json = Record<string, unknown>

/** Plugin paths start with `./`; anything that leaves the plugin root is ignored, as Claude Code does. */
function within(root: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || rel.trim() === '') return null
  const full = path.resolve(root, rel)
  return isInside(full, root) ? full : null
}

function pathList(root: string, value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return list.map((v) => within(root, v)).filter((v): v is string => v !== null)
}

async function marketplaceEntries(
  configDir: string,
  known: Json | null,
  cache: Map<string, Json[]>,
  marketplace: string
): Promise<Json[]> {
  const cached = cache.get(marketplace)
  if (cached) return cached
  const candidates: string[] = []
  const record = known && isRecord(known[marketplace]) ? known[marketplace] : null
  const location = record ? asString(record.installLocation) : undefined
  if (location) candidates.push(location)
  candidates.push(path.join(configDir, 'plugins', 'marketplaces', marketplace))
  let entries: Json[] = []
  for (const dir of candidates) {
    const read = await readJsonObject(path.join(dir, '.claude-plugin', 'marketplace.json'))
    if (read.value && Array.isArray(read.value.plugins)) {
      entries = read.value.plugins.filter(isRecord)
      break
    }
  }
  cache.set(marketplace, entries)
  return entries
}

async function serversOf(root: string, manifest: Json | null, entry: Json | null) {
  const byName = new Map<string, ServerConfig>()
  const addMap = (map: unknown) => {
    for (const s of serverConfigs(map)) byName.set(s.name, s)
  }
  const addFile = async (file: string) => {
    const read = await readJsonObject(file)
    if (!read.value) return
    addMap(isRecord(read.value.mcpServers) ? read.value.mcpServers : read.value)
  }
  await addFile(path.join(root, '.mcp.json'))
  for (const source of [manifest?.mcpServers, entry?.mcpServers]) {
    const list = Array.isArray(source) ? source : source === undefined ? [] : [source]
    for (const item of list) {
      if (typeof item === 'string') {
        const file = within(root, item)
        if (file && file.toLowerCase().endsWith('.json')) await addFile(file)
      } else if (isRecord(item)) {
        addMap(item)
      }
    }
  }
  return [...byName.values()]
}

async function describe(
  key: string,
  root: string | undefined,
  entry: Json | null
): Promise<PluginInfo> {
  const { name, marketplace } = splitKey(key)
  const info: PluginInfo = {
    key,
    name,
    marketplace,
    installed: root !== undefined,
    defaultEnabled: true,
    skills: [],
    agents: [],
    commands: [],
    servers: []
  }
  if (!root || !(await isDir(root))) {
    info.installed = false
    return info
  }
  info.root = root
  const manifest = (await readJsonObject(path.join(root, '.claude-plugin', 'plugin.json'))).value
  for (const source of [manifest, entry]) {
    if (source && typeof source.defaultEnabled === 'boolean') info.defaultEnabled = source.defaultEnabled
  }

  // Skills add to the default `skills/` scan, except that a marketplace entry acting as the
  // manifest (no plugin.json, or a source at the marketplace root) that lists skills replaces it.
  const entrySource = entry?.source
  const entryIsRoot = !manifest || entrySource === './' || entrySource === '.'
  const skillRoots = [
    ...(entry?.skills !== undefined && entryIsRoot ? [] : [path.join(root, 'skills')]),
    ...pathList(root, manifest?.skills),
    ...pathList(root, entry?.skills)
  ]
  const seen = new Set<string>()
  for (const dir of skillRoots) {
    for (const skill of await scanSkillRoot(dir)) {
      if (seen.has(skill.dir)) continue
      seen.add(skill.dir)
      info.skills.push(skill)
    }
  }

  // Agents and commands: a declared list replaces the default folder.
  const agentPaths = pathList(root, manifest?.agents ?? entry?.agents)
  info.agents = await readMarkdownComponents(
    agentPaths.length ? agentPaths : [path.join(root, 'agents')]
  )
  const commandsDecl = manifest?.commands ?? entry?.commands
  if (isRecord(commandsDecl)) {
    info.commands = Object.keys(commandsDecl).map((n) => ({ name: n, tokens: Math.ceil(n.length / 4) }))
  } else {
    const commandPaths = pathList(root, commandsDecl)
    info.commands = await readMarkdownComponents(
      commandPaths.length ? commandPaths : [path.join(root, 'commands')]
    )
  }
  info.servers = await serversOf(root, manifest, entry)
  return info
}

interface InstallRecord {
  scope?: string
  installPath?: string
  projectPath?: string
}

function installRecords(value: unknown): InstallRecord[] {
  const list = Array.isArray(value) ? value : [value]
  return list.filter(isRecord).map((r) => ({
    scope: asString(r.scope),
    installPath: asString(r.installPath),
    projectPath: asString(r.projectPath)
  }))
}

/**
 * Every plugin the config dir knows for this folder: installed ones, synced ones and any key a
 * settings layer names (shown as not installed when missing).
 */
export async function discoverPlugins(
  configDir: string,
  folder: string,
  namedKeys: Iterable<string>
): Promise<PluginInfo[]> {
  const pluginsDir = path.join(configDir, 'plugins')
  const installed = (await readJsonObject(path.join(pluginsDir, 'installed_plugins.json'))).value
  const known = (await readJsonObject(path.join(pluginsDir, 'known_marketplaces.json'))).value
  const cache = new Map<string, Json[]>()
  const roots = new Map<string, string | undefined>()

  const table = installed && isRecord(installed.plugins) ? installed.plugins : {}
  for (const [key, value] of Object.entries(table)) {
    // Project- and local-scope installs count only in their own project.
    const record = installRecords(value).find(
      (r) => !r.projectPath || r.scope === 'user' || samePath(r.projectPath, folder)
    )
    if (record?.installPath) roots.set(key, record.installPath)
  }

  // Plugins synced from claude.ai load as `<name>@synced`.
  const syncedRoot = path.join(pluginsDir, 'synced')
  for (const group of await listDirs(syncedRoot)) {
    for (const dir of await listDirs(path.join(syncedRoot, group))) {
      const root = path.join(syncedRoot, group, dir)
      const manifest = (await readJsonObject(path.join(root, '.claude-plugin', 'plugin.json'))).value
      const name = asString(manifest?.name) ?? dir
      if (!roots.has(`${name}@synced`)) roots.set(`${name}@synced`, root)
    }
  }

  for (const key of namedKeys) if (!roots.has(key)) roots.set(key, undefined)

  const out: PluginInfo[] = []
  for (const [key, root] of roots) {
    const { name, marketplace } = splitKey(key)
    const entries =
      marketplace && marketplace !== 'synced'
        ? await marketplaceEntries(configDir, known, cache, marketplace)
        : []
    const entry = entries.find((e) => e.name === name) ?? null
    out.push(await describe(key, root, entry))
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}
