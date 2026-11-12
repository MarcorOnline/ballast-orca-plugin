// The Codex source: rebuilds what reaches Codex's context in a folder, like claude.ts does for
// Claude Code, and says what each command would write to `<folder>/.codex/config.toml`.
//
// Every key below was checked on developers.openai.com/codex (config reference, advanced config,
// MCP, skills, AGENTS.md, plugins; see the README for the pages). Reads copy out names, booleans
// and structure only: the TOML tables hold env values, headers and tokens, and none of them is
// ever kept.
import * as path from 'node:path'
import type {
  ActionInfo,
  Item,
  ItemActions,
  ItemState,
  Level,
  Mutation,
  Note,
  ProfileInfo,
  ScanResult,
  WriteTarget
} from '../model.ts'
import { parse } from '../vendor/smol-toml/index.mjs'
import { scanSkillRoot, type SkillFile } from './components.ts'
import { exists, isDir, isRecord, listDirs, readText } from './fsx.ts'
import { ancestors, isInside, samePath } from './paths.ts'
import { totalsOf } from './claude.ts'
import { estimateTokens } from './tokens.ts'

export interface CodexScanInput {
  folder: string
  profile: ProfileInfo
  homeDir: string
  platform: NodeJS.Platform
  now?: number
}

/** AGENTS.md is read up to this many bytes in total (`project_doc_max_bytes`, default 32 KiB). */
export const DEFAULT_DOC_MAX_BYTES = 32 * 1024

interface SkillRule {
  name?: string
  path?: string
  enabled: boolean
}

interface CodexLayer {
  level: Level
  file: string
  exists: boolean
  broken: boolean
  plugins: Record<string, boolean>
  pluginDefault?: boolean
  /** plugin key -> server name -> enabled. */
  pluginServers: Record<string, Record<string, boolean>>
  /** Servers this layer mentions; `enabled` only when the layer says so. */
  servers: Record<string, { enabled?: boolean }>
  skillRules: SkillRule[]
  bundledSkills?: boolean
  /** `[projects.'<path>'] trust_level`, in the user layer. */
  trust: Record<string, string>
  docMaxBytes?: number
  docFallback: string[]
  rootMarkers?: string[]
}

function emptyLayer(level: Level, file: string): CodexLayer {
  return { level, file, exists: false, broken: false, plugins: {}, pluginServers: {}, servers: {}, skillRules: [], trust: {}, docFallback: [] }
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Copies the few keys that decide what reaches the context; everything else is dropped here. */
export function pickCodexConfig(raw: Record<string, unknown>, layer: CodexLayer): void {
  if (isRecord(raw.plugins)) {
    for (const [key, value] of Object.entries(raw.plugins)) {
      if (!isRecord(value)) continue
      if (key === '_default') {
        layer.pluginDefault = bool(value.enabled)
        continue
      }
      const enabled = bool(value.enabled)
      if (enabled !== undefined) layer.plugins[key] = enabled
      if (isRecord(value.mcp_servers)) {
        for (const [server, cfg] of Object.entries(value.mcp_servers)) {
          const on = isRecord(cfg) ? bool(cfg.enabled) : undefined
          if (on !== undefined) (layer.pluginServers[key] ??= {})[server] = on
        }
      }
    }
  }
  if (isRecord(raw.mcp_servers)) {
    for (const [name, cfg] of Object.entries(raw.mcp_servers)) {
      const enabled = isRecord(cfg) ? bool(cfg.enabled) : undefined
      layer.servers[name] = enabled === undefined ? {} : { enabled }
    }
  }
  if (isRecord(raw.skills)) {
    if (Array.isArray(raw.skills.config)) {
      for (const entry of raw.skills.config) {
        if (!isRecord(entry)) continue
        const enabled = bool(entry.enabled)
        const name = typeof entry.name === 'string' ? entry.name : undefined
        const p = typeof entry.path === 'string' ? entry.path : undefined
        if (enabled !== undefined && (name || p)) layer.skillRules.push({ ...(name ? { name } : {}), ...(p ? { path: p } : {}), enabled })
      }
    }
    if (isRecord(raw.skills.bundled)) layer.bundledSkills = bool(raw.skills.bundled.enabled)
  }
  if (isRecord(raw.projects)) {
    for (const [key, value] of Object.entries(raw.projects)) {
      if (isRecord(value) && typeof value.trust_level === 'string') layer.trust[key] = value.trust_level
    }
  }
  if (typeof raw.project_doc_max_bytes === 'number') layer.docMaxBytes = raw.project_doc_max_bytes
  layer.docFallback = strings(raw.project_doc_fallback_filenames)
  if (Array.isArray(raw.project_root_markers)) layer.rootMarkers = strings(raw.project_root_markers)
}

export async function readCodexLayer(level: Level, file: string): Promise<CodexLayer> {
  const layer = emptyLayer(level, file)
  const text = await readText(file)
  if (text === null) {
    layer.exists = await exists(file)
    return layer
  }
  layer.exists = true
  try {
    pickCodexConfig(parse(text) as Record<string, unknown>, layer)
  } catch {
    layer.broken = true
  }
  return layer
}

// ---------------------------------------------------------------- trust and project root

function stripVerbatim(p: string): string {
  return p.replace(/^\\\\\?\\/, '')
}

/** `trusted`, `untrusted` or undefined for the nearest folder (this one, then its parents) the user config names. */
export function trustFor(trust: Record<string, string>, folder: string, platform?: NodeJS.Platform): string | undefined {
  for (const dir of ancestors(folder)) {
    for (const [key, level] of Object.entries(trust)) {
      if (samePath(stripVerbatim(key), dir, platform)) return level
    }
  }
  return undefined
}

/** The project root: the nearest folder at or above `folder` holding one of the markers. */
export async function projectRoot(folder: string, markers: string[]): Promise<string> {
  if (markers.length === 0) return path.resolve(folder)
  for (const dir of ancestors(folder)) {
    for (const m of markers) if (await exists(path.join(dir, m))) return dir
  }
  return path.resolve(folder)
}

/** Folders from the project root down to `folder`. */
function chain(root: string, folder: string): string[] {
  return ancestors(folder).filter((d) => isInside(d, root)).reverse()
}

// ---------------------------------------------------------------- helpers

function note(code: Note['code'], args?: Record<string, string>): Note {
  return args ? { code, args } : { code }
}

function denied(notes: Note[]): ActionInfo {
  return { allowed: false, notes }
}

function describe(mutations: Mutation[]): string {
  return mutations
    .map((m) => {
      if (m.type === 'tomlSet') return `[${m.table.join('.')}] ${m.key} = ${m.value}`
      if (m.type === 'tomlUnset') return `− [${m.table.join('.')}] ${m.key}`
      if (m.type === 'skillRuleSet') return `[[skills.config]] name = ${JSON.stringify(m.name)}, enabled = ${m.enabled}`
      if (m.type === 'skillRuleRemove') return `− [[skills.config]] name = ${JSON.stringify(m.name)}`
      return ''
    })
    .join('\n')
}

function allowed(mutations: Mutation[], notes: Note[] = []): ActionInfo {
  return { allowed: true, notes, mutations, mechanism: describe(mutations) }
}

function noPersonal(): ItemActions {
  const why = [note('noPersonalFile')]
  return { enable: denied(why), block: denied(why), reset: denied(why) }
}

function allDenied(notes: Note[]): Item['actions'] {
  const a = (): ItemActions => ({ enable: denied(notes), block: denied(notes), reset: denied(notes) })
  return { shared: a(), personal: a() }
}

interface Ctx {
  input: CodexScanInput
  /** User layer first, then the project layers root-to-folder (only when the project is trusted). */
  layers: CodexLayer[]
  /** The folder's own `.codex/config.toml`, whatever its trust: the one the commands write. */
  own: CodexLayer
  trusted: boolean
  items: Item[]
  warnings: Note[]
  pluginState: Map<string, { on: boolean; decidedBy: Item['decidedBy'] }>
}

/** The last layer that says something, with its value. */
function decideLast<T>(ctx: Ctx, get: (l: CodexLayer) => T | undefined): { layer: CodexLayer; value: T } | null {
  let found: { layer: CodexLayer; value: T } | null = null
  for (const layer of ctx.layers) {
    const value = get(layer)
    if (value !== undefined) found = { layer, value }
  }
  return found
}

function byDecision(d: { layer: CodexLayer } | null, key: string): Item['decidedBy'] {
  return d ? { level: d.layer.level, file: d.layer.file, key } : { level: 'default' }
}

/** enable / block / reset of an `enabled` flag in one table of the folder's config. */
function flagActions(ctx: Ctx, table: string[], extra: Note[] = []): Item['actions'] {
  const own = lookup(ctx.own, table)
  const trustNote = ctx.trusted ? [] : [note('projectNotTrusted')]
  const set = (value: boolean): ActionInfo =>
    own === value ? denied([note('alreadyThisWay')]) : allowed([{ type: 'tomlSet', table, key: 'enabled', value }], [...extra, ...trustNote])
  return {
    shared: {
      enable: set(true),
      block: set(false),
      reset: own === undefined ? denied([note('noEntryInFile')]) : allowed([{ type: 'tomlUnset', table, key: 'enabled' }], trustNote)
    },
    personal: noPersonal()
  }
}

/** What a layer says for a table path: `plugins.<key>`, `plugins.<key>.mcp_servers.<s>` or `mcp_servers.<s>`. */
function lookup(layer: CodexLayer, table: string[]): boolean | undefined {
  if (table[0] === 'plugins' && table.length === 2) return layer.plugins[table[1]]
  if (table[0] === 'plugins' && table.length === 4) return layer.pluginServers[table[1]]?.[table[3]]
  if (table[0] === 'mcp_servers') return layer.servers[table[1]]?.enabled
  return undefined
}

// ---------------------------------------------------------------- plugins

interface CodexPlugin {
  key: string
  name: string
  installed: boolean
  root?: string
  skills: SkillFile[]
  servers: string[]
}

async function readPluginFiles(root: string): Promise<{ skills: SkillFile[]; servers: string[] }> {
  let manifest: Record<string, unknown> = {}
  for (const rel of ['plugin.json', path.join('.codex-plugin', 'plugin.json')]) {
    const text = await readText(path.join(root, rel), 1024 * 1024)
    if (text === null) continue
    try {
      const value = JSON.parse(text) as unknown
      if (isRecord(value)) {
        manifest = value
        break
      }
    } catch {
      // A broken manifest still leaves the default folders to read.
    }
  }
  const skillsDir = typeof manifest.skills === 'string' ? manifest.skills : './skills/'
  const skills = await scanSkillRoot(path.resolve(root, skillsDir))
  const serversRel = typeof manifest.mcpServers === 'string' ? manifest.mcpServers : './.mcp.json'
  const servers: string[] = []
  const mcpText = (await readText(path.resolve(root, serversRel), 1024 * 1024)) ?? (await readText(path.join(root, 'mcp.json'), 1024 * 1024))
  if (mcpText !== null) {
    try {
      const value = JSON.parse(mcpText) as unknown
      if (isRecord(value) && isRecord(value.mcpServers)) servers.push(...Object.keys(value.mcpServers))
    } catch {
      // Unreadable server list: the plugin row still shows.
    }
  }
  return { skills, servers }
}

async function discoverPlugins(ctx: Ctx): Promise<CodexPlugin[]> {
  const home = ctx.input.profile.configDir
  const byKey = new Map<string, CodexPlugin>()
  // Installed copies: `<home>/plugins/cache/<marketplace>/<plugin>/<version>/` (plugins docs).
  const cache = path.join(home, 'plugins', 'cache')
  for (const market of await listDirs(cache)) {
    for (const name of await listDirs(path.join(cache, market))) {
      const versions = await listDirs(path.join(cache, market, name))
      if (versions.length === 0) continue
      const root = path.join(cache, market, name, versions[versions.length - 1])
      const files = await readPluginFiles(root)
      byKey.set(`${name}@${market}`, { key: `${name}@${market}`, name, installed: true, root, ...files })
    }
  }
  // Personal marketplace plugins sit directly in `<home>/plugins/<name>/`.
  for (const name of await listDirs(path.join(home, 'plugins'))) {
    if (name === 'cache') continue
    const root = path.join(home, 'plugins', name)
    const files = await readPluginFiles(root)
    const key = [...byKey.keys()].some((k) => k.startsWith(`${name}@`)) ? null : `${name}@local`
    if (key && !byKey.has(key)) byKey.set(key, { key, name, installed: true, root, ...files })
  }
  // Plugins the config names but nothing installed.
  for (const layer of ctx.layers) {
    for (const key of Object.keys(layer.plugins)) {
      if (!byKey.has(key)) byKey.set(key, { key, name: key.split('@')[0], installed: false, skills: [], servers: [] })
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
}

function pluginItems(ctx: Ctx, plugins: CodexPlugin[]) {
  for (const p of plugins) {
    const decision = decideLast(ctx, (l) => l.plugins[p.key])
    const fallback = decideLast(ctx, (l) => l.pluginDefault)
    // Not named in any config: an installed plugin is on unless `plugins._default.enabled` says no.
    const wanted = decision ? decision.value : fallback ? fallback.value : true
    const decidedBy = decision ? byDecision(decision, `plugins."${p.key}".enabled`) : fallback ? byDecision(fallback, 'plugins._default.enabled') : { level: 'default' as const }
    const on = wanted && p.installed
    ctx.pluginState.set(p.key, { on, decidedBy })
    const weight = p.skills.reduce((n, s) => n + s.tokens, 0)
    const state: ItemState = wanted && !p.installed ? 'not-installed' : on ? 'on' : 'off'
    const notes: Note[] = []
    if (!p.installed) notes.push(note('notInstalled'))
    if (!ctx.trusted && ctx.own.plugins[p.key] !== undefined) notes.push(note('projectNotTrusted'))
    ctx.items.push({
      id: `plugin:${p.key}`,
      agent: 'codex',
      kind: 'plugin',
      name: p.key,
      origin: { level: 'plugin', plugin: p.key },
      state,
      decidedBy,
      tokens: on ? weight : 0,
      tokensIfOn: weight,
      basis: 'components',
      countsInTotal: true,
      notes,
      actions: flagActions(ctx, ['plugins', p.key])
    })
  }
}

// ---------------------------------------------------------------- skills

function ruleFor(rules: SkillRule[], skill: { name: string; file: string }, platform?: NodeJS.Platform): SkillRule | undefined {
  let hit: SkillRule | undefined
  for (const r of rules) {
    if ((r.name !== undefined && r.name === skill.name) || (r.path !== undefined && samePath(r.path, skill.file, platform))) hit = r
  }
  return hit
}

async function modelInvocable(dir: string): Promise<boolean> {
  const yaml = await readText(path.join(dir, 'agents', 'openai.yaml'), 256 * 1024)
  return !(yaml !== null && /^\s*allow_implicit_invocation:\s*false\b/m.test(yaml))
}

async function skillItem(ctx: Ctx, skill: SkillFile, origin: Item['origin'], scope: string, parent?: CodexPlugin): Promise<Item> {
  const notes: Note[] = []
  let state: ItemState = 'on'
  let decidedBy: Item['decidedBy'] = { level: origin.level === 'plugin' ? 'plugin' : 'default' }
  const invocable = skill.modelInvocable && (await modelInvocable(skill.dir))
  if (!invocable) notes.push(note('modelInvocationOff'))
  const file = path.join(skill.dir, 'SKILL.md')
  let actions: Item['actions']
  if (parent) {
    const ps = ctx.pluginState.get(parent.key)
    if (ps) decidedBy = ps.decidedBy
    actions = allDenied([note('codexPluginSkillNoOverride', { plugin: parent.key })])
  } else {
    // Rules from every layer, in order: the last matching one wins (skills docs).
    const rules = ctx.layers.flatMap((l) => l.skillRules.map((r) => ({ r, l })))
    let hit: { r: SkillRule; l: CodexLayer } | undefined
    for (const x of rules) if (ruleFor([x.r], { name: skill.name, file }, ctx.input.platform)) hit = x
    if (hit) {
      decidedBy = { level: hit.l.level, file: hit.l.file, key: hit.r.name ? `skills.config[name="${skill.name}"].enabled` : 'skills.config[path].enabled' }
      if (!hit.r.enabled) state = 'off'
    }
    if (origin.level === 'builtin') {
      const bundled = decideLast(ctx, (l) => l.bundledSkills)
      if (bundled && !bundled.value && !hit) {
        state = 'off'
        decidedBy = byDecision(bundled, 'skills.bundled.enabled')
      }
    }
    const own = ruleFor(ctx.own.skillRules, { name: skill.name, file }, ctx.input.platform)
    const trustNote = ctx.trusted ? [] : [note('projectNotTrusted')]
    const set = (enabled: boolean): ActionInfo =>
      own?.name === skill.name && own.enabled === enabled
        ? denied([note('alreadyThisWay')])
        : allowed([{ type: 'skillRuleSet', name: skill.name, enabled }], trustNote)
    actions = {
      shared: {
        enable: set(true),
        block: set(false),
        reset: own?.name === skill.name ? allowed([{ type: 'skillRuleRemove', name: skill.name }], trustNote) : denied([note('noEntryInFile')])
      },
      personal: noPersonal()
    }
  }
  return {
    id: `skill:${parent ? parent.key : scope}:${skill.name}`,
    agent: 'codex',
    kind: 'skill',
    name: skill.name,
    origin,
    state,
    decidedBy,
    tokens: state === 'on' && invocable ? skill.tokens : 0,
    tokensIfOn: invocable ? skill.tokens : 0,
    basis: 'description',
    countsInTotal: !parent,
    ...(parent ? { parent: `plugin:${parent.key}` } : {}),
    notes,
    actions
  }
}

async function skillItems(ctx: Ctx, plugins: CodexPlugin[], root: string) {
  const { configDir } = ctx.input.profile
  const seen = new Set<string>()
  const add = async (skills: SkillFile[], origin: Item['origin'], scope: string) => {
    for (const s of skills) {
      const key = path.resolve(s.dir).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      ctx.items.push(await skillItem(ctx, s, origin, scope))
    }
  }
  await add(await scanSkillRoot(path.join(configDir, 'skills')), { level: 'user' }, 'user')
  // System skills (skill-creator, skill-installer…) are bundled with Codex under `skills/.system`.
  await add(await scanSkillRoot(path.join(configDir, 'skills', '.system')), { level: 'builtin' }, 'system')
  await add(await scanSkillRoot(path.join(ctx.input.homeDir, '.agents', 'skills')), { level: 'user' }, 'user')
  // Repo skills: `.agents/skills` in every folder from the working folder up to the project root.
  for (const dir of ancestors(ctx.input.folder).filter((d) => isInside(d, root))) {
    await add(await scanSkillRoot(path.join(dir, '.agents', 'skills')), { level: 'project' }, 'project')
  }
  if (ctx.input.platform !== 'win32') await add(await scanSkillRoot('/etc/codex/skills'), { level: 'managed' }, 'admin')
  for (const p of plugins) {
    if (!ctx.pluginState.get(p.key)?.on) continue
    for (const s of p.skills) ctx.items.push(await skillItem(ctx, s, { level: 'plugin', plugin: p.key }, 'plugin', p))
  }
}

// ---------------------------------------------------------------- MCP servers

function serverItems(ctx: Ctx, plugins: CodexPlugin[]) {
  const names = new Set<string>()
  for (const layer of ctx.layers) for (const n of Object.keys(layer.servers)) names.add(n)
  // A server only the folder's untrusted file mentions is still shown, as off.
  for (const n of Object.keys(ctx.own.servers)) names.add(n)
  for (const name of [...names].sort()) {
    const decision = decideLast(ctx, (l) => l.servers[name]?.enabled)
    const state: ItemState = decision && !decision.value ? 'off' : 'on'
    const definedIn = ctx.layers.find((l) => name in l.servers) ?? ctx.own
    const notes: Note[] = [note('tokensUnknown')]
    if (!ctx.trusted && ctx.own.servers[name]) notes.push(note('projectNotTrusted'))
    ctx.items.push({
      id: `mcp:${definedIn.level}:${name}`,
      agent: 'codex',
      kind: 'mcp',
      name,
      origin: { level: definedIn.level },
      state,
      decidedBy: byDecision(decision, `mcp_servers.${name}.enabled`),
      tokens: 0,
      tokensIfOn: 0,
      basis: 'unknown',
      countsInTotal: true,
      notes,
      actions: flagActions(ctx, ['mcp_servers', name])
    })
  }
  for (const p of plugins) {
    for (const server of p.servers) {
      const ps = ctx.pluginState.get(p.key)
      const decision = decideLast(ctx, (l) => l.pluginServers[p.key]?.[server])
      const pluginOff = !ps?.on
      const state: ItemState = pluginOff || (decision && !decision.value) ? 'off' : 'on'
      const notes: Note[] = [note('tokensUnknown')]
      if (pluginOff) notes.push(note('pluginOff', { plugin: p.key }))
      ctx.items.push({
        id: `mcp:${p.key}:${server}`,
        agent: 'codex',
        kind: 'mcp',
        name: `plugin:${p.name}:${server}`,
        origin: { level: 'plugin', plugin: p.key },
        state,
        decidedBy: pluginOff ? (ps?.decidedBy ?? { level: 'default' }) : byDecision(decision, `plugins."${p.key}".mcp_servers.${server}.enabled`),
        tokens: 0,
        tokensIfOn: 0,
        basis: 'unknown',
        countsInTotal: false,
        parent: `plugin:${p.key}`,
        notes,
        actions: pluginOff ? allDenied([note('pluginOff', { plugin: p.key })]) : flagActions(ctx, ['plugins', p.key, 'mcp_servers', server])
      })
    }
  }
}

// ---------------------------------------------------------------- memory (AGENTS.md)

async function firstNonEmpty(dir: string, names: string[]): Promise<{ file: string; text: string } | null> {
  for (const n of names) {
    const file = path.join(dir, n)
    const text = await readText(file, 4 * 1024 * 1024)
    if (text !== null && text.trim() !== '') return { file, text }
  }
  return null
}

async function memoryItems(ctx: Ctx, root: string) {
  const { folder, profile } = ctx.input
  const limit = decideLast(ctx, (l) => l.docMaxBytes)?.value ?? DEFAULT_DOC_MAX_BYTES
  const fallback = decideLast(ctx, (l) => (l.docFallback.length > 0 ? l.docFallback : undefined))?.value ?? []
  const why = [note('noSwitchInCodex')]
  const push = (file: string, scope: Level, state: ItemState, tokens: number, extra: Note[] = [], full = tokens) => {
    const name = isInside(file, root) ? path.relative(folder, file).replace(/\\/g, '/') : isInside(file, profile.configDir) ? '~codex/' + path.relative(profile.configDir, file).replace(/\\/g, '/') : file.replace(/\\/g, '/')
    ctx.items.push({
      id: `memory:${file}`,
      agent: 'codex',
      kind: 'memory',
      name,
      origin: { level: scope, path: file },
      state,
      decidedBy: { level: 'default' },
      tokens: state === 'on' ? tokens : 0,
      tokensIfOn: full,
      basis: 'file',
      countsInTotal: true,
      notes: extra,
      actions: allDenied(why)
    })
  }
  // Global: AGENTS.override.md if it exists, otherwise AGENTS.md; the first non-empty file only.
  const global = await firstNonEmpty(profile.configDir, ['AGENTS.override.md', 'AGENTS.md'])
  if (global) push(global.file, 'user', 'on', estimateTokens(global.text))
  // Project: root down to the folder, at most one file per folder, up to `project_doc_max_bytes`.
  let used = 0
  for (const dir of chain(root, folder)) {
    const doc = await firstNonEmpty(dir, ['AGENTS.override.md', 'AGENTS.md', ...fallback])
    if (!doc) continue
    const bytes = Buffer.byteLength(doc.text, 'utf8')
    const room = Math.max(0, limit - used)
    if (room === 0) {
      push(doc.file, 'project', 'off', estimateTokens(doc.text), [note('beyondDocLimit', { bytes: String(limit) })])
      continue
    }
    const included = bytes <= room ? doc.text : Buffer.from(doc.text, 'utf8').subarray(0, room).toString('utf8')
    used += Math.min(bytes, room)
    push(doc.file, 'project', 'on', estimateTokens(included), bytes > room ? [note('docTruncated', { bytes: String(limit) })] : [], estimateTokens(doc.text))
  }
}

// ---------------------------------------------------------------- sessions

/** Reads up to `max` characters of the first line of a file. */
async function firstLine(file: string, max = 1024 * 1024): Promise<string | null> {
  const { promises: fs } = await import('node:fs')
  let handle: import('node:fs/promises').FileHandle | undefined
  try {
    handle = await fs.open(file, 'r')
    const buf = Buffer.alloc(max)
    const { bytesRead } = await handle.read(buf, 0, max, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const nl = text.indexOf('\n')
    return nl < 0 ? text : text.slice(0, nl)
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

/** Sessions of this folder: `<home>/sessions/**\/rollout-*.jsonl` whose first record names it as `cwd`. */
export async function scanCodexSessions(home: string, folder: string, platform?: NodeJS.Platform): Promise<{ dir: string; count: number; latestAt?: number }> {
  const dir = path.join(home, 'sessions')
  const files: string[] = []
  const walk = async (d: string, depth: number) => {
    if (depth > 4) return
    const { promises: fs } = await import('node:fs')
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(d, e.name), depth + 1)
      else if (/^rollout-.*\.jsonl$/.test(e.name)) files.push(path.join(d, e.name))
    }
  }
  await walk(dir, 0)
  // File names start with the timestamp, so the sort is chronological; read the newest 300.
  files.sort()
  let count = 0
  let latestAt: number | undefined
  const { promises: fs } = await import('node:fs')
  for (const file of files.slice(-300)) {
    const line = await firstLine(file)
    if (!line) continue
    let cwd: unknown
    try {
      const record = JSON.parse(line) as { payload?: { cwd?: unknown } }
      cwd = record.payload?.cwd
    } catch {
      continue
    }
    if (typeof cwd !== 'string' || !samePath(stripVerbatim(cwd), folder, platform)) continue
    count++
    const stat = await fs.stat(file).catch(() => null)
    if (stat && (latestAt === undefined || stat.mtimeMs > latestAt)) latestAt = stat.mtimeMs
  }
  return { dir, count, ...(latestAt !== undefined ? { latestAt } : {}) }
}

// ---------------------------------------------------------------- entry point

export async function scanCodex(input: CodexScanInput): Promise<Omit<ScanResult, 'folderSource' | 'agentsPresent' | 'candidates'>> {
  const { folder, profile } = input
  const user = await readCodexLayer('user', path.join(profile.configDir, 'config.toml'))
  const markers = user.rootMarkers ?? ['.git']
  const root = await projectRoot(folder, markers)
  const projectLayers: CodexLayer[] = []
  for (const dir of chain(root, folder)) {
    projectLayers.push(await readCodexLayer('project', path.join(dir, '.codex', 'config.toml')))
  }
  const own = projectLayers[projectLayers.length - 1] ?? emptyLayer('project', path.join(folder, '.codex', 'config.toml'))
  // Project layers load only for a trusted project (config docs).
  const trusted = trustFor(user.trust, folder, input.platform) === 'trusted'
  const ctx: Ctx = {
    input,
    layers: [user, ...(trusted ? projectLayers : [])],
    own,
    trusted,
    items: [],
    warnings: [],
    pluginState: new Map()
  }
  for (const layer of [user, ...projectLayers]) if (layer.broken) ctx.warnings.push(note('readError', { file: layer.file }))
  if (!trusted && projectLayers.some((l) => l.exists)) ctx.warnings.push(note('projectNotTrusted'))
  if (!(await isDir(profile.configDir))) ctx.warnings.push(note('readError', { file: profile.configDir }))

  const plugins = await discoverPlugins(ctx)
  pluginItems(ctx, plugins)
  await skillItems(ctx, plugins, root)
  serverItems(ctx, plugins)
  await memoryItems(ctx, root)

  const sessions = await scanCodexSessions(profile.configDir, folder, input.platform)
  if (sessions.count === 0) ctx.warnings.push(note('noTranscripts'))
  return {
    agent: 'codex',
    folder,
    profile,
    projectTrusted: trusted,
    items: ctx.items,
    totals: totalsOf(ctx.items),
    sessions: { dir: sessions.dir, count: sessions.count, ...(sessions.latestAt ? { latestAt: sessions.latestAt } : {}) },
    warnings: ctx.warnings,
    targets: {
      shared: { file: '.codex/config.toml', exists: own.exists },
      personal: { file: '', exists: false }
    },
    scannedAt: input.now ?? Date.now()
  }
}
