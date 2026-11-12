// The only code that writes. It changes one key of one file inside the focused folder:
// `.claude/settings.json` or `.claude/settings.local.json` (jsonc-parser's minimal edits), or
// `.codex/config.toml` (targeted text edits, see toml.ts). Every other byte (keys, order,
// comments, indentation, line endings) stays as it was.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { JsonMutation, Mutation, Note, WriteTarget } from '../model.ts'
import {
  applyEdits,
  type FormattingOptions,
  type JSONPath,
  modify,
  parse,
  visit
} from '../vendor/jsonc-parser/index.mjs'
import { parse as parseToml } from '../vendor/smol-toml/index.mjs'
import { unifiedDiff } from './diff.ts'
import { applyTomlMutations, redactToml } from './toml.ts'
import { isRecord, parseJsonObject, readText, realpathOrSelf } from './fsx.ts'
import { isInside, samePath } from './paths.ts'

export function targetFile(folder: string, target: WriteTarget): string {
  return path.join(folder, '.claude', target === 'shared' ? 'settings.json' : 'settings.local.json')
}

export function hashText(text: string | null): string {
  return createHash('sha256').update(text === null ? '\u0000missing' : text).digest('hex').slice(0, 32)
}

/** Files Ballast must never write, whatever folder it is pointed at. */
export interface Forbidden {
  configDir: string
  homeDir: string
  stateFile: string
  managedFile: string
}

/** Null when the target is a project file Ballast may write; a note saying why not otherwise. */
export async function checkTarget(file: string, folder: string, forbidden: Forbidden): Promise<Note | null> {
  const dir = path.dirname(file)
  const realDir = await realpathOrSelf(dir)
  const userFiles = [
    path.join(forbidden.configDir, 'settings.json'),
    path.join(forbidden.configDir, 'settings.local.json'),
    path.join(forbidden.homeDir, '.claude', 'settings.json'),
    path.join(forbidden.homeDir, '.claude', 'settings.local.json'),
    forbidden.stateFile,
    forbidden.managedFile
  ]
  const realConfig = await realpathOrSelf(forbidden.configDir)
  const realHomeClaude = await realpathOrSelf(path.join(forbidden.homeDir, '.claude'))
  if (
    userFiles.some((f) => samePath(f, file)) ||
    samePath(realDir, realConfig) ||
    samePath(realDir, realHomeClaude) ||
    samePath(dir, forbidden.configDir)
  ) {
    return { code: 'userTargetRefused' }
  }
  if (!samePath(path.dirname(dir), folder) || path.basename(dir) !== '.claude') {
    return { code: 'userTargetRefused' }
  }
  return null
}

function formatting(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const indented = /^([ \t]+)\S/m.exec(text)
  if (indented && indented[1].startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol }
  return { insertSpaces: true, tabSize: indented ? indented[1].length : 2, eol }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  return isRecord(a) && isRecord(b) && a.serverName === b.serverName && typeof a.serverName === 'string'
}

function getAt(root: unknown, p: string[]): unknown {
  let cur = root
  for (const key of p) {
    if (!isRecord(cur)) return undefined
    cur = cur[key]
  }
  return cur
}

/** Applies mutations to the file text; returns the new text, or null when one cannot apply. */
export function applyMutations(original: string, mutations: JsonMutation[]): string | null {
  const fmt = formatting(original)
  let text = original.trim() === '' ? '{}' : original
  for (const m of mutations) {
    const current = parse(text, [], { allowTrailingComma: true })
    if (!isRecord(current)) return null
    const at = getAt(current, m.path)
    let jsonPath: JSONPath = m.path
    let value: unknown
    if (m.type === 'set') {
      value = m.value
    } else if (m.type === 'unset') {
      if (at === undefined) continue
      value = undefined
    } else if (m.type === 'arrayAdd') {
      if (at !== undefined && !Array.isArray(at)) return null
      if (Array.isArray(at) && at.some((v) => sameValue(v, m.value))) continue
      if (Array.isArray(at)) {
        jsonPath = [...m.path, at.length]
        value = m.value
        text = applyEdits(text, modify(text, jsonPath, value, { formattingOptions: fmt, isArrayInsertion: true }))
        continue
      }
      value = [m.value]
    } else {
      if (!Array.isArray(at)) continue
      // Remove from the end so earlier indexes stay valid.
      for (let i = at.length - 1; i >= 0; i--) {
        if (sameValue(at[i], m.value)) {
          text = applyEdits(text, modify(text, [...m.path, i], undefined, { formattingOptions: fmt }))
        }
      }
      continue
    }
    text = applyEdits(text, modify(text, jsonPath, value, { formattingOptions: fmt }))
  }
  if (original.trim() === '' || original.endsWith('\n')) {
    if (!text.endsWith('\n')) text += fmt.eol ?? '\n'
  }
  return text
}

/** Paths whose string values Ballast itself writes; every other value is hidden in previews. */
function isShownPath(p: JSONPath, value: unknown): boolean {
  const [a, b, c] = p
  if (a === 'enabledPlugins' || a === 'skillOverrides') return p.length === 2
  if ((a === 'deniedMcpServers' || a === 'allowedMcpServers') && typeof b === 'number') return c === 'serverName' && p.length === 3
  if ((a === 'disabledMcpjsonServers' || a === 'enabledMcpjsonServers' || a === 'claudeMdExcludes') && typeof b === 'number') return p.length === 2
  if (a === 'permissions' && b === 'deny' && typeof c === 'number') return typeof value === 'string' && value.startsWith('mcp__')
  if (p.length === 1 && (a === 'autoMemoryEnabled' || a === 'enableAllProjectMcpServers' || a === 'disableClaudeAiConnectors' || a === '$schema')) return true
  return false
}

/**
 * The file with every string and number literal outside the keys Ballast writes replaced by
 * "…". Env values, headers, tokens and URLs never reach the preview.
 */
export function redactJson(text: string): string {
  const spans: { offset: number; length: number }[] = []
  visit(
    text,
    {
      onLiteralValue: (value, offset, length, _l, _c, pathSupplier) => {
        if (typeof value === 'boolean' || value === null) return
        if (!isShownPath(pathSupplier(), value)) spans.push({ offset, length })
      }
    },
    { allowTrailingComma: true }
  )
  let out = text
  for (const s of spans.sort((x, y) => y.offset - x.offset)) {
    out = out.slice(0, s.offset) + '"…"' + out.slice(s.offset + s.length)
  }
  return out
}

export interface Planned {
  file: string
  before: string | null
  after: string
  diff: string
  baseHash: string
}

/** What a planned file is for: Claude Code's JSON settings or Codex's TOML config. */
export type FileKind = 'claude' | 'codex'

/**
 * One item's mutations applied to the current text of a target file; the new text, or a note
 * saying why not. `alreadyThisWay` when the text would not change.
 */
function transformText(kind: FileKind, file: string, before: string | null, mutations: Mutation[]): { after: string } | { error: Note } {
  const bad = { error: { code: 'readError', args: { file } } } as const
  if (kind === 'claude') {
    if (before !== null && parseJsonObject(before) === null) return bad
    const after = applyMutations(before ?? '', mutations.filter((m): m is JsonMutation => 'path' in m))
    if (after === null) return bad
    if (after === before) return { error: { code: 'alreadyThisWay' } }
    return { after }
  }
  if (before !== null) {
    try {
      parseToml(before)
    } catch {
      return bad
    }
  }
  const after = applyTomlMutations(before ?? '', mutations)
  if (after === null) return { error: { code: 'tomlUnsupported', args: { file } } }
  if (after === before) return { error: { code: 'alreadyThisWay' } }
  try {
    parseToml(after)
  } catch {
    return bad
  }
  return { after }
}

function plannedOf(kind: FileKind, folder: string, file: string, before: string | null, after: string): Planned {
  const rel = path.relative(folder, file).replace(/\\/g, '/')
  const redact = kind === 'claude' ? redactJson : redactToml
  return { file, before, after, diff: unifiedDiff(redact(before ?? ''), redact(after), rel), baseHash: hashText(before) }
}

export async function planFile(
  folder: string,
  target: WriteTarget,
  mutations: Mutation[]
): Promise<Planned | { error: Note }> {
  const file = targetFile(folder, target)
  const before = await readText(file)
  const done = transformText('claude', file, before, mutations)
  if ('error' in done) return done
  return plannedOf('claude', folder, file, before, done.after)
}

/**
 * Several items' mutations into one file: each item applies, in order, to the text the previous
 * one left. An item that cannot apply is reported and skipped; the rest still make the one write.
 * `after` is null when no item changed anything.
 */
export async function planBatchFile(
  kind: FileKind,
  folder: string,
  file: string,
  items: { id: string; mutations: Mutation[] }[]
): Promise<{ planned: Planned | null; results: { id: string; error?: Note }[] }> {
  const before = await readText(file)
  let text = before
  const results: { id: string; error?: Note }[] = []
  for (const item of items) {
    const done = transformText(kind, file, text, item.mutations)
    if ('error' in done) {
      results.push({ id: item.id, error: done.error })
    } else {
      text = done.after
      results.push({ id: item.id })
    }
  }
  return { planned: text === before || text === null ? null : plannedOf(kind, folder, file, before, text), results }
}

/** Writes through a temporary file in the same folder, so a crash never leaves half a file. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.ballast-${process.pid}-${Date.now()}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  try {
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true })
    throw error
  }
}

// ------------------------------------------------------------------ Codex

export function codexTargetFile(folder: string): string {
  return path.join(folder, '.codex', 'config.toml')
}

/** Folders whose files Ballast must never write for Codex: CODEX_HOME in every form it can take. */
export interface CodexForbidden {
  codexHome: string
  homeDir: string
  /** `<orca data>/codex-accounts` and `codex-runtime-home`: Orca's own homes. */
  orcaHomes: string[]
}

/**
 * Null when the target is `<folder>/.codex/config.toml`; a note saying why not otherwise. Anything
 * inside CODEX_HOME, `~/.codex` or one of Orca's Codex homes is refused, symlinks included.
 */
export async function checkCodexTarget(file: string, folder: string, forbidden: CodexForbidden): Promise<Note | null> {
  const dir = path.dirname(file)
  const realDir = await realpathOrSelf(dir)
  const homes = [forbidden.codexHome, path.join(forbidden.homeDir, '.codex'), ...forbidden.orcaHomes]
  for (const home of homes) {
    const realHome = await realpathOrSelf(home)
    if (isInside(file, home) || isInside(realDir, home) || isInside(realDir, realHome)) return { code: 'userTargetRefused' }
  }
  if (!samePath(path.dirname(dir), folder) || path.basename(dir) !== '.codex' || path.basename(file) !== 'config.toml') {
    return { code: 'userTargetRefused' }
  }
  return null
}

export async function planCodexFile(folder: string, mutations: Mutation[]): Promise<Planned | { error: Note }> {
  const file = codexTargetFile(folder)
  const before = await readText(file)
  const done = transformText('codex', file, before, mutations)
  if ('error' in done) return done
  return plannedOf('codex', folder, file, before, done.after)
}
