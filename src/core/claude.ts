// The Claude Code source: rebuilds what reaches Claude's context in a folder and, for every
// item, which layer decides it and what each command would write. Pure reads; the only writer
// is edits.ts, and only to the folder's own `.claude/settings*.json`.
import * as path from 'node:path'
import type {
  ActionInfo,
  Item,
  ItemActions,
  ItemKind,
  ItemState,
  Level,
  JsonMutation,
  Note,
  ProfileInfo,
  ScanResult,
  Totals,
  WriteTarget
} from '../model.ts'
import { ITEM_KINDS, WRITE_TARGETS } from '../model.ts'
import { scanSkillRoot, type SkillFile } from './components.ts'
import { exists, listDirs, readJsonObject } from './fsx.ts'
import { hasGlobSyntax, matchPathGlob, matchUrlPattern } from './glob.ts'
import { scanMemory, type MemoryFile } from './memory.ts'
import { isInside } from './paths.ts'
import { discoverPlugins, type PluginInfo } from './plugins.ts'
import {
  decide,
  inPrecedence,
  type Layer,
  type Layers,
  type McpRule,
  readLayers,
  type SettingsLevel
} from './settings.ts'
import { readUserState, type ServerConfig, serverConfigs, stateFilePath, type UserState } from './state.ts'
import { serverSegment, scanTranscripts, type SeenServer, type TranscriptScan } from './transcripts.ts'
import { estimateTokens } from './tokens.ts'

export interface ClaudeScanInput {
  folder: string
  profile: ProfileInfo
  homeDir: string
  platform: NodeJS.Platform
  managedSettingsFile: string
  /** Server name -> when Ballast first saw it; drives the "new" badge. */
  firstSeen?: Record<string, number>
  now?: number
}

const NEW_FOR_MS = 24 * 60 * 60 * 1000

const TARGET_LEVEL: Record<WriteTarget, SettingsLevel> = { shared: 'project', personal: 'local' }

/** Layers whose value beats the target's, highest first. */
function above(layers: Layers, target: WriteTarget): Layer[] {
  const all = inPrecedence(layers)
  return all.slice(0, all.findIndex((l) => l.level === TARGET_LEVEL[target]))
}

function note(code: Note['code'], args?: Record<string, string>): Note {
  return args ? { code, args } : { code }
}

function denied(notes: Note[]): ActionInfo {
  return { allowed: false, notes }
}

function quote(s: string): string {
  return JSON.stringify(s)
}

function describeMutations(mutations: JsonMutation[]): string {
  return mutations
    .map((m) => {
      const where = m.path.map((p, i) => (i === 0 ? p : `[${quote(p)}]`)).join('')
      const value = (v: unknown) => JSON.stringify(v)
      if (m.type === 'set') return `${where}: ${value(m.value)}`
      if (m.type === 'unset') return `− ${where}`
      if (m.type === 'arrayAdd') return `${m.path.join('.')} += ${value(m.value)}`
      return `${m.path.join('.')} −= ${value(m.value)}`
    })
    .join('\n')
}

function allowed(mutations: JsonMutation[], notes: Note[] = []): ActionInfo {
  return { allowed: true, notes, mutations, mechanism: describeMutations(mutations) }
}

function levelFor(layer: Layer): Level {
  return layer.level
}

function ruleMatches(rule: McpRule, server: { name: string; url?: string; command?: string[] }) {
  if (rule.kind === 'name') return rule.name === server.name
  if (rule.kind === 'url') return server.url !== undefined && matchUrlPattern(rule.pattern, server.url)
  return (
    server.command !== undefined &&
    rule.command.length === server.command.length &&
    rule.command.every((c, i) => c === server.command?.[i])
  )
}

interface Ctx {
  input: ClaudeScanInput
  layers: Layers
  state: UserState
  transcripts: TranscriptScan
  seenBySegment: Map<string, SeenServer>
  plugins: PluginInfo[]
  pluginState: Map<string, { on: boolean; decidedBy: Item['decidedBy'] }>
  items: Item[]
  warnings: Note[]
}

function emptyActions(): Record<WriteTarget, ItemActions> {
  const none = (): ItemActions => ({
    enable: denied([]),
    block: denied([]),
    reset: denied([])
  })
  return { shared: none(), personal: none() }
}

function forTargets(fn: (target: WriteTarget, layer: Layer) => ItemActions, layers: Layers) {
  const out = emptyActions()
  for (const target of WRITE_TARGETS) out[target] = fn(target, layers[TARGET_LEVEL[target]])
  return out
}

// ---------------------------------------------------------------- plugins

/** enable / block / reset for a key in an object map such as `enabledPlugins` or `skillOverrides`. */
function mapKeyActions(
  ctx: Ctx,
  mapName: 'enabledPlugins' | 'skillOverrides',
  key: string,
  on: boolean | string,
  off: boolean | string,
  extraNotes: Note[] = []
) {
  return forTargets((target, layer) => {
    const current =
      mapName === 'enabledPlugins' ? layer.s.enabledPlugins[key] : layer.s.skillOverrides[key]
    const higher = above(ctx.layers, target).find((l) =>
      mapName === 'enabledPlugins' ? key in l.s.enabledPlugins : key in l.s.skillOverrides
    )
    const blockedByHigher = higher
      ? [note(higher.level === 'managed' ? 'managedDecides' : 'deniedElsewhere', { level: higher.level })]
      : []
    const set = (value: boolean | string): ActionInfo => {
      if (higher) return denied(blockedByHigher)
      if (current === value) return denied([note('alreadyThisWay')])
      return allowed([{ type: 'set', path: [mapName, key], value }], extraNotes)
    }
    return {
      enable: set(on),
      block: set(off),
      reset:
        current === undefined
          ? denied([note('noEntryInFile')])
          : allowed([{ type: 'unset', path: [mapName, key] }])
    }
  }, ctx.layers)
}

function pluginItems(ctx: Ctx) {
  for (const p of ctx.plugins) {
    const decision = decide(ctx.layers, (s) => s.enabledPlugins[p.key])
    const wanted = decision ? decision.value : p.defaultEnabled
    const decidedBy: Item['decidedBy'] = decision
      ? { level: levelFor(decision.layer), file: decision.layer.file, key: `enabledPlugins["${p.key}"]` }
      : { level: 'default' }
    const on = wanted && p.installed
    ctx.pluginState.set(p.key, { on, decidedBy })

    const own = [...p.agents, ...p.commands].reduce((n, c) => n + c.tokens, 0)
    const skills = p.skills.filter((s) => s.modelInvocable).reduce((n, s) => n + s.tokens, 0)
    let servers = 0
    for (const s of p.servers) {
      const seen = ctx.seenBySegment.get(serverSegment(`plugin:${p.name}:${s.name}`))
      if (seen) servers += estimateTokens(seen.chars)
    }
    const weight = own + skills + servers
    const state: ItemState = wanted && !p.installed ? 'not-installed' : on ? 'on' : 'off'
    const notes: Note[] = []
    if (!p.installed) notes.push(note('notInstalled'))
    ctx.items.push({
      id: `plugin:${p.key}`,
      agent: 'claude-code',
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
      actions: mapKeyActions(ctx, 'enabledPlugins', p.key, true, false, notes)
    })
  }
}

// ---------------------------------------------------------------- skills

function skillItem(
  ctx: Ctx,
  skill: SkillFile,
  origin: Item['origin'],
  parent?: PluginInfo
): Item {
  const notes: Note[] = []
  let state: ItemState = 'on'
  let tokens = skill.modelInvocable ? skill.tokens : 0
  let decidedBy: Item['decidedBy'] = { level: origin.level === 'plugin' ? 'plugin' : 'default' }
  let actions: Item['actions']
  if (!skill.modelInvocable) notes.push(note('modelInvocationOff'))
  if (parent) {
    const ps = ctx.pluginState.get(parent.key)
    if (ps) decidedBy = ps.decidedBy
    const why = [note('pluginSkillNoOverride', { plugin: parent.key })]
    actions = { shared: { enable: denied(why), block: denied(why), reset: denied(why) }, personal: { enable: denied(why), block: denied(why), reset: denied(why) } }
  } else {
    const override = decide(ctx.layers, (s) => s.skillOverrides[skill.name])
    if (override) {
      decidedBy = {
        level: levelFor(override.layer),
        file: override.layer.file,
        key: `skillOverrides["${skill.name}"]`
      }
      if (override.value === 'off' || override.value === 'user-invocable-only') {
        state = 'off'
        tokens = 0
      } else if (override.value === 'name-only') {
        tokens = estimateTokens(skill.name)
      }
    }
    actions = mapKeyActions(ctx, 'skillOverrides', skill.name, 'on', 'off')
  }
  return {
    id: `skill:${parent ? parent.key : origin.level}:${skill.name}`,
    agent: 'claude-code',
    kind: 'skill',
    name: skill.name,
    origin,
    state,
    decidedBy,
    tokens: state === 'on' ? tokens : 0,
    tokensIfOn: skill.modelInvocable ? skill.tokens : 0,
    basis: 'description',
    countsInTotal: !parent,
    ...(parent ? { parent: `plugin:${parent.key}` } : {}),
    notes,
    actions
  }
}

async function skillItems(ctx: Ctx) {
  const { configDir } = ctx.input.profile
  const userRoot = path.join(configDir, 'skills')
  const user: SkillFile[] = []
  for (const name of await listDirs(userRoot)) {
    if (name === 'synced') continue
    user.push(...(await scanSkillRoot(path.join(userRoot, name))))
  }
  // Skills synced from claude.ai: skills/synced/<account>/<skill>/SKILL.md.
  for (const group of await listDirs(path.join(userRoot, 'synced'))) {
    user.push(...(await scanSkillRoot(path.join(userRoot, 'synced', group))))
  }
  for (const s of user) ctx.items.push(skillItem(ctx, s, { level: 'user', path: s.dir }))

  for (const s of await scanSkillRoot(path.join(ctx.input.folder, '.claude', 'skills'))) {
    ctx.items.push(skillItem(ctx, s, { level: 'project', path: s.dir }))
  }

  for (const p of ctx.plugins) {
    if (!ctx.pluginState.get(p.key)?.on) continue
    for (const s of p.skills) {
      ctx.items.push(skillItem(ctx, s, { level: 'plugin', plugin: p.key }, p))
    }
  }
}

// ---------------------------------------------------------------- MCP servers and connectors

type ServerOrigin = 'user' | 'local' | 'project' | 'plugin' | 'session'

interface ServerRef {
  name: string
  segment: string
  origin: ServerOrigin
  config?: ServerConfig
  plugin?: PluginInfo
  seen?: SeenServer
  connector: boolean
}

function denyWildcard(segment: string): string {
  return `mcp__${segment}__*`
}

function mcpRuleCovers(rule: string, segment: string): boolean {
  if (rule === 'mcp__*') return true
  if (rule === `mcp__${segment}` || rule === `mcp__${segment}__*`) return true
  return false
}

function serverDecision(ctx: Ctx, ref: ServerRef): {
  state: ItemState
  decidedBy: Item['decidedBy']
  notes: Note[]
} {
  const notes: Note[] = []
  const subject = { name: ref.name, url: ref.config?.url, command: ref.config?.command }

  if (ref.plugin) {
    const ps = ctx.pluginState.get(ref.plugin.key)
    if (!ps?.on) {
      return { state: 'off', decidedBy: ps?.decidedBy ?? { level: 'default' }, notes: [note('pluginOff', { plugin: ref.plugin.key })] }
    }
  }
  if (ref.connector) {
    const off = inPrecedence(ctx.layers).find((l) => l.s.disableClaudeAiConnectors === true)
    if (off) {
      return { state: 'off', decidedBy: { level: off.level, file: off.file, key: 'disableClaudeAiConnectors' }, notes: [note('connectorsOffElsewhere', { level: off.level })] }
    }
  }
  for (const layer of inPrecedence(ctx.layers)) {
    if (layer.s.deniedMcpServers.some((r) => ruleMatches(r, subject))) {
      return { state: 'off', decidedBy: { level: layer.level, file: layer.file, key: 'deniedMcpServers' }, notes }
    }
  }
  const allowLayer = inPrecedence(ctx.layers).find((l) => l.s.allowedMcpServers !== undefined)
  if (allowLayer && !(allowLayer.s.allowedMcpServers ?? []).some((r) => ruleMatches(r, subject))) {
    return { state: 'off', decidedBy: { level: allowLayer.level, file: allowLayer.file, key: 'allowedMcpServers' }, notes: [note('allowlistBlocks', { level: allowLayer.level })] }
  }
  if (ref.origin === 'project') {
    for (const layer of inPrecedence(ctx.layers)) {
      if (layer.s.disabledMcpjsonServers.includes(ref.name)) {
        return { state: 'off', decidedBy: { level: layer.level, file: layer.file, key: 'disabledMcpjsonServers' }, notes }
      }
    }
    const trusted = ctx.state.project.hasTrustDialogAccepted
    // In an untrusted folder the shared project file cannot approve its own servers.
    const honored = inPrecedence(ctx.layers).filter((l) => l.level !== 'project' || trusted)
    const all = honored.find((l) => l.s.enableAllProjectMcpServers !== undefined)
    const named = honored.find((l) => l.s.enabledMcpjsonServers.includes(ref.name))
    if (named) {
      return { state: 'on', decidedBy: { level: named.level, file: named.file, key: 'enabledMcpjsonServers' }, notes }
    }
    if (all?.s.enableAllProjectMcpServers) {
      return { state: 'on', decidedBy: { level: all.level, file: all.file, key: 'enableAllProjectMcpServers' }, notes }
    }
    if (!trusted && ctx.layers.project.s.enabledMcpjsonServers.includes(ref.name)) {
      notes.push(note('sharedApprovalNeedsTrust'))
    }
    notes.push(note('pendingApproval'))
    return { state: 'pending', decidedBy: { level: 'default' }, notes }
  }
  if (ctx.state.project.disabledMcpServers.includes(ref.name)) {
    return { state: 'off', decidedBy: { level: 'state', file: ctx.state.file, key: 'disabledMcpServers' }, notes: [note('disabledByMcpToggle')] }
  }
  for (const layer of inPrecedence(ctx.layers)) {
    if (layer.s.mcpDenyRules.some((r) => mcpRuleCovers(r, ref.segment))) {
      return { state: 'off', decidedBy: { level: layer.level, file: layer.file, key: 'permissions.deny' }, notes: [note('denyRuleRemovesTools')] }
    }
  }
  if (ref.plugin) return { state: 'on', decidedBy: ctx.pluginState.get(ref.plugin.key)?.decidedBy ?? { level: 'plugin' }, notes }
  if (ref.origin === 'session') return { state: 'on', decidedBy: { level: 'session' }, notes }
  return { state: 'on', decidedBy: { level: ref.origin === 'local' ? 'state' : ref.origin }, notes }
}

/** Entries Ballast may have written for this server in a layer, for enable and reset. */
function ownEntries(layer: Layer, ref: ServerRef): JsonMutation[] {
  const out: JsonMutation[] = []
  if (layer.s.deniedMcpServers.some((r) => r.kind === 'name' && r.name === ref.name)) {
    out.push({ type: 'arrayRemove', path: ['deniedMcpServers'], value: { serverName: ref.name } })
  }
  for (const rule of [denyWildcard(ref.segment), `mcp__${ref.segment}`]) {
    if (layer.s.mcpDenyRules.includes(rule)) out.push({ type: 'arrayRemove', path: ['permissions', 'deny'], value: rule })
  }
  if (ref.origin === 'project') {
    if (layer.s.disabledMcpjsonServers.includes(ref.name)) out.push({ type: 'arrayRemove', path: ['disabledMcpjsonServers'], value: ref.name })
    if (layer.s.enabledMcpjsonServers.includes(ref.name)) out.push({ type: 'arrayRemove', path: ['enabledMcpjsonServers'], value: ref.name })
  }
  return out
}

/** Why the server stays off whatever this file says. */
function blockedOutside(ctx: Ctx, ref: ServerRef, target: WriteTarget): Note | null {
  const mine = TARGET_LEVEL[target]
  const subject = { name: ref.name, url: ref.config?.url, command: ref.config?.command }
  if (ref.plugin && !ctx.pluginState.get(ref.plugin.key)?.on) return note('pluginOff', { plugin: ref.plugin.key })
  for (const layer of inPrecedence(ctx.layers)) {
    if (layer.level === mine) continue
    if (ref.connector && layer.s.disableClaudeAiConnectors) return note('connectorsOffElsewhere', { level: layer.level })
    if (layer.s.deniedMcpServers.some((r) => ruleMatches(r, subject))) return note('deniedElsewhere', { level: layer.level })
    if (ref.origin === 'project' && layer.s.disabledMcpjsonServers.includes(ref.name)) return note('rejectedElsewhere', { level: layer.level })
    if (layer.s.mcpDenyRules.some((r) => mcpRuleCovers(r, ref.segment))) return note('deniedElsewhere', { level: layer.level })
  }
  if (ref.origin !== 'project' && ctx.state.project.disabledMcpServers.includes(ref.name)) return note('disabledByMcpToggle')
  return null
}

function serverActions(ctx: Ctx, ref: ServerRef, state: ItemState) {
  return forTargets((target, layer) => {
    const mine = ownEntries(layer, ref)
    const outside = blockedOutside(ctx, ref, target)
    const notes: Note[] = []
    if (target === 'shared' && ref.origin === 'project' && !ctx.state.project.hasTrustDialogAccepted) {
      notes.push(note('sharedApprovalNeedsTrust'))
    }

    let block: ActionInfo
    if (ref.origin === 'project') {
      block = layer.s.disabledMcpjsonServers.includes(ref.name)
        ? denied([note('alreadyThisWay')])
        : allowed([
            { type: 'arrayAdd', path: ['disabledMcpjsonServers'], value: ref.name },
            ...mine.filter((m) => m.path[0] === 'enabledMcpjsonServers')
          ])
    } else if (ref.plugin) {
      block = layer.s.mcpDenyRules.includes(denyWildcard(ref.segment))
        ? denied([note('alreadyThisWay')])
        : allowed(
            [{ type: 'arrayAdd', path: ['permissions', 'deny'], value: denyWildcard(ref.segment) }],
            [note('pluginServerToolsOnly', { plugin: ref.plugin.key })]
          )
    } else {
      block = layer.s.deniedMcpServers.some((r) => r.kind === 'name' && r.name === ref.name)
        ? denied([note('alreadyThisWay')])
        : allowed([{ type: 'arrayAdd', path: ['deniedMcpServers'], value: { serverName: ref.name } }], ref.connector ? [note('connectorManageOnline')] : [])
    }

    let enable: ActionInfo
    if (outside) {
      enable = denied([outside])
    } else if (ref.origin === 'project') {
      const remove = mine.filter((m) => m.path[0] !== 'enabledMcpjsonServers')
      const add: JsonMutation[] = layer.s.enabledMcpjsonServers.includes(ref.name)
        ? []
        : [{ type: 'arrayAdd', path: ['enabledMcpjsonServers'], value: ref.name }]
      enable = remove.length + add.length === 0 ? denied([note('alreadyThisWay')]) : allowed([...remove, ...add], notes)
    } else {
      enable = mine.length === 0 ? denied([note(state === 'on' ? 'alreadyThisWay' : 'noEntryInFile')]) : allowed(mine)
    }

    return {
      enable,
      block,
      reset: mine.length === 0 ? denied([note('noEntryInFile')]) : allowed(mine)
    }
  }, ctx.layers)
}

function serverItem(ctx: Ctx, ref: ServerRef): Item {
  const { state, decidedBy, notes } = serverDecision(ctx, ref)
  const seen = ref.seen
  const tokensIfOn = seen ? estimateTokens(seen.chars) : 0
  if (!seen) notes.push(note('tokensUnknown'))
  else if (seen.status === 'needs-auth') notes.push(note('needsAuth'))
  else if (seen.status === 'failed') notes.push(note('failed'))
  if (ref.connector) notes.push(note('connectorManageOnline'))
  const firstSeen = ctx.input.firstSeen?.[ref.name]
  const now = ctx.input.now ?? Date.now()
  const item: Item = {
    id: `${ref.connector ? 'connector' : 'mcp'}:${ref.plugin ? ref.plugin.key : ref.origin}:${ref.name}`,
    agent: 'claude-code',
    kind: ref.connector ? 'connector' : 'mcp',
    name: ref.name,
    origin: ref.plugin
      ? { level: 'plugin', plugin: ref.plugin.key }
      : { level: ref.origin === 'local' ? 'state' : ref.origin === 'session' ? 'session' : ref.origin },
    state,
    decidedBy,
    tokens: state === 'on' ? tokensIfOn : 0,
    tokensIfOn,
    basis: seen ? 'tools' : 'unknown',
    countsInTotal: !ref.plugin,
    notes,
    actions: serverActions(ctx, ref, state)
  }
  if (ref.plugin) item.parent = `plugin:${ref.plugin.key}`
  if (seen) {
    item.toolCount = seen.toolCount
    item.lastSeenAt = seen.lastSeenAt
  }
  if (firstSeen && now - firstSeen < NEW_FOR_MS) {
    item.isNew = true
    notes.push(note('newArrival'))
  }
  return item
}

async function serverItems(ctx: Ctx) {
  const refs: ServerRef[] = []
  const used = new Set<string>()
  const add = (ref: Omit<ServerRef, 'seen' | 'segment' | 'connector'> & { segment?: string }) => {
    const segment = ref.segment ?? serverSegment(ref.name)
    const seen = ctx.seenBySegment.get(segment)
    if (seen) used.add(segment)
    refs.push({ ...ref, segment, seen, connector: false })
  }
  for (const config of ctx.state.mcpServers) add({ name: config.name, origin: 'user', config })
  for (const config of ctx.state.project.mcpServers) add({ name: config.name, origin: 'local', config })
  const mcpJson = await readJsonObject(path.join(ctx.input.folder, '.mcp.json'))
  if (mcpJson.broken) ctx.warnings.push(note('readError', { file: path.join(ctx.input.folder, '.mcp.json') }))
  const projectServers = serverConfigs(mcpJson.value?.mcpServers)
  for (const config of projectServers) add({ name: config.name, origin: 'project', config })
  for (const plugin of ctx.plugins) {
    for (const config of plugin.servers) {
      add({
        name: `plugin:${plugin.name}:${config.name}`,
        origin: 'plugin',
        config,
        plugin,
        segment: serverSegment(`plugin:${plugin.name}:${config.name}`)
      })
    }
  }
  // Servers only a transcript knows: claude.ai connectors and anything added outside these files.
  for (const seen of ctx.transcripts.servers) {
    if (used.has(seen.segment)) continue
    const plugin = seen.kind === 'plugin'
      ? ctx.plugins.find((p) => seen.segment.startsWith(serverSegment(`plugin:${p.name}:`)))
      : undefined
    refs.push({
      name: seen.name,
      segment: seen.segment,
      origin: plugin ? 'plugin' : 'session',
      plugin,
      seen,
      connector: seen.kind === 'connector'
    })
  }
  for (const ref of refs) ctx.items.push(serverItem(ctx, ref))

  // A serverName deny that almost matches an arrived connector does nothing: names match exactly.
  for (const layer of inPrecedence(ctx.layers)) {
    for (const rule of layer.s.deniedMcpServers) {
      if (rule.kind !== 'name') continue
      const near = ctx.transcripts.servers.find(
        (s) => s.name !== rule.name && s.name.toLowerCase().startsWith(rule.name.toLowerCase())
      )
      if (near && !ctx.transcripts.servers.some((s) => s.name === rule.name)) {
        ctx.warnings.push(note('unmatchedDeny', { rule: rule.name, level: layer.level, server: near.name }))
      }
    }
  }
}

// ---------------------------------------------------------------- memory

function excludePattern(file: string, folder: string): string | null {
  if (hasGlobSyntax(file)) return null
  if (isInside(file, folder)) {
    const rel = path.relative(folder, file).replace(/\\/g, '/')
    return `**/${path.basename(folder)}/${rel}`
  }
  return file.replace(/\\/g, '/')
}

function memoryItem(ctx: Ctx, m: MemoryFile): Item {
  const { platform, folder } = ctx.input
  const notes: Note[] = []
  let state: ItemState = m.onDemand ? 'on-demand' : 'on'
  let decidedBy: Item['decidedBy'] = { level: m.scope === 'managed' ? 'managed' : 'default' }
  let actions: Item['actions']

  if (m.onDemand) notes.push(note('onDemand'))
  if (m.scope === 'managed') {
    const why = [note('managedMemory')]
    actions = { shared: { enable: denied(why), block: denied(why), reset: denied(why) }, personal: { enable: denied(why), block: denied(why), reset: denied(why) } }
  } else if (m.autoMemory) {
    const decision = decide(ctx.layers, (s) => s.autoMemoryEnabled)
    if (decision) {
      decidedBy = { level: decision.layer.level, file: decision.layer.file, key: 'autoMemoryEnabled' }
      if (!decision.value) state = 'off'
    }
    actions = forTargets((target, layer) => {
      const higher = above(ctx.layers, target).find((l) => l.s.autoMemoryEnabled !== undefined)
      const set = (value: boolean): ActionInfo => {
        if (higher) return denied([note('autoMemoryOffElsewhere', { level: higher.level })])
        if (layer.s.autoMemoryEnabled === value) return denied([note('alreadyThisWay')])
        return allowed([{ type: 'set', path: ['autoMemoryEnabled'], value }])
      }
      return {
        enable: set(true),
        block: set(false),
        reset:
          layer.s.autoMemoryEnabled === undefined
            ? denied([note('noEntryInFile')])
            : allowed([{ type: 'unset', path: ['autoMemoryEnabled'] }])
      }
    }, ctx.layers)
  } else {
    const hit = inPrecedence(ctx.layers).find((l) =>
      l.s.claudeMdExcludes.some((p) => matchPathGlob(p, m.file, platform))
    )
    if (hit) {
      state = 'off'
      decidedBy = { level: hit.level, file: hit.file, key: 'claudeMdExcludes' }
    }
    const pattern = excludePattern(m.file, folder)
    actions = forTargets((_target, layer) => {
      const mine = layer.s.claudeMdExcludes.filter((p) => matchPathGlob(p, m.file, platform))
      const removeMine: JsonMutation[] = mine.map((p) => ({ type: 'arrayRemove', path: ['claudeMdExcludes'], value: p }))
      const elsewhere = inPrecedence(ctx.layers).find(
        (l) => l !== layer && l.s.claudeMdExcludes.some((p) => matchPathGlob(p, m.file, platform))
      )
      return {
        block:
          mine.length > 0
            ? denied([note('alreadyThisWay')])
            : pattern === null
              ? denied([note('readError', { file: m.file })])
              : allowed([{ type: 'arrayAdd', path: ['claudeMdExcludes'], value: pattern }]),
        enable: elsewhere
          ? denied([note('excludedElsewhere', { level: elsewhere.level })])
          : mine.length === 0
            ? denied([note('alreadyThisWay')])
            : allowed(removeMine),
        reset: mine.length === 0 ? denied([note('noEntryInFile')]) : allowed(removeMine)
      }
    }, ctx.layers)
  }
  const scopeLevel: Record<MemoryFile['scope'], Level> = {
    managed: 'managed',
    user: 'user',
    ancestor: 'project',
    project: 'project',
    local: 'local',
    subfolder: 'project',
    auto: 'user'
  }
  return {
    id: `memory:${m.file}`,
    agent: 'claude-code',
    kind: 'memory',
    name: m.autoMemory ? 'MEMORY.md (auto memory)' : displayMemoryName(m, ctx.input.folder, ctx.input.profile.configDir),
    origin: { level: scopeLevel[m.scope], path: m.file },
    state,
    decidedBy,
    tokens: state === 'on' ? m.tokens : 0,
    tokensIfOn: m.tokens,
    basis: 'file',
    countsInTotal: !m.onDemand,
    notes,
    actions
  }
}

function displayMemoryName(m: MemoryFile, folder: string, configDir: string): string {
  if (isInside(m.file, folder)) return path.relative(folder, m.file).replace(/\\/g, '/')
  if (isInside(m.file, configDir)) return '~config/' + path.relative(configDir, m.file).replace(/\\/g, '/')
  return m.file.replace(/\\/g, '/')
}

async function memoryItems(ctx: Ctx) {
  const dirDecision = decide(ctx.layers, (s) => s.autoMemoryDirectory)
  const files = await scanMemory({
    folder: ctx.input.folder,
    configDir: ctx.input.profile.configDir,
    homeDir: ctx.input.homeDir,
    platform: ctx.input.platform,
    managedSettingsFile: ctx.input.managedSettingsFile,
    autoMemoryDirectory: dirDecision?.value
  })
  for (const m of files) ctx.items.push(memoryItem(ctx, m))
}

// ---------------------------------------------------------------- totals and entry point

export function totalsOf(items: Item[]): Totals {
  const byKind = Object.fromEntries(ITEM_KINDS.map((k) => [k, 0])) as Record<ItemKind, number>
  let tokens = 0
  const counted = items.filter((i) => i.countsInTotal && i.state === 'on' && i.tokens > 0)
  for (const i of counted) {
    tokens += i.tokens
    byKind[i.kind] += i.tokens
  }
  const heaviest = [...counted].sort((a, b) => b.tokens - a.tokens).slice(0, 5).map((i) => i.id)
  return { tokens, byKind, heaviest }
}

export async function scanClaude(input: ClaudeScanInput): Promise<Omit<ScanResult, 'folderSource' | 'agentsPresent' | 'candidates'>> {
  const { folder, profile } = input
  const layers = await readLayers({ configDir: profile.configDir, folder, managedFile: input.managedSettingsFile })
  const state = await readUserState(stateFilePath(profile.configDir, input.homeDir), folder)
  const transcripts = await scanTranscripts(profile.configDir, folder)
  const named = new Set<string>()
  for (const layer of inPrecedence(layers)) for (const key of Object.keys(layer.s.enabledPlugins)) named.add(key)
  const plugins = await discoverPlugins(profile.configDir, folder, named)

  const ctx: Ctx = {
    input,
    layers,
    state,
    transcripts,
    seenBySegment: new Map(transcripts.servers.map((s) => [s.segment, s])),
    plugins,
    pluginState: new Map(),
    items: [],
    warnings: []
  }
  for (const layer of inPrecedence(layers)) {
    if (layer.broken) ctx.warnings.push(note('readError', { file: layer.file }))
  }
  if (transcripts.sessionCount === 0) ctx.warnings.push(note('noTranscripts'))

  pluginItems(ctx)
  await skillItems(ctx)
  await serverItems(ctx)
  await memoryItems(ctx)

  const sessions: ScanResult['sessions'] = { dir: transcripts.dir, count: transcripts.sessionCount }
  if (transcripts.latestAt) sessions.latestAt = transcripts.latestAt
  if (transcripts.skippedDesktop) sessions.skippedDesktop = transcripts.skippedDesktop
  return {
    agent: 'claude-code',
    folder,
    profile,
    items: ctx.items,
    totals: totalsOf(ctx.items),
    sessions,
    warnings: ctx.warnings,
    targets: {
      shared: { file: '.claude/settings.json', exists: await exists(path.join(folder, '.claude', 'settings.json')) },
      personal: { file: '.claude/settings.local.json', exists: await exists(path.join(folder, '.claude', 'settings.local.json')) }
    },
    scannedAt: input.now ?? Date.now()
  }
}

