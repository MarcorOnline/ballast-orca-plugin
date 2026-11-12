// Targeted text edits for a Codex `config.toml`. Reading goes through the vendored smol-toml
// (see codex.ts); writing never re-serializes: a small scanner finds the byte offsets of tables
// and `key = value` lines, and each edit splices the file text, so comments, order, quoting and
// line endings stay as they were. A shape the scanner cannot edit safely (a table defined through
// dotted keys or an inline table) is refused, never rewritten.
import type { Mutation } from '../model.ts'

export type Stmt =
  | { kind: 'header'; array: boolean; path: string[]; start: number; end: number }
  | { kind: 'kv'; path: string[]; start: number; end: number; valueStart: number; valueEnd: number }

const BARE = /^[A-Za-z0-9_-]+$/

function isEol(c: string | undefined): boolean {
  return c === '\n' || c === '\r' || c === undefined
}

/** Offset just past a string that starts at `i` (basic, literal, or either multi-line form). */
function skipString(t: string, i: number): number {
  const q = t[i]
  const triple = t.startsWith(q + q + q, i)
  let j = i + (triple ? 3 : 1)
  while (j < t.length) {
    const c = t[j]
    if (q === '"' && c === '\\') {
      j += 2
      continue
    }
    if (triple) {
      if (t.startsWith(q + q + q, j)) {
        // Up to two more quotes may belong to the string's end.
        let k = j + 3
        while (k < j + 5 && t[k] === q) k++
        return k
      }
    } else {
      if (c === q) return j + 1
      if (isEol(c)) return j
    }
    j++
  }
  return t.length
}

/** Offset just past the value that starts at `i`. */
function scanValue(t: string, i: number): number {
  const c = t[i]
  if (c === '"' || c === "'") return skipString(t, i)
  if (c === '[' || c === '{') {
    let depth = 0
    let j = i
    while (j < t.length) {
      const d = t[j]
      if (d === '"' || d === "'") {
        j = skipString(t, j)
        continue
      }
      if (d === '#') {
        while (j < t.length && !isEol(t[j])) j++
        continue
      }
      if (d === '[' || d === '{') depth++
      if (d === ']' || d === '}') {
        depth--
        if (depth === 0) return j + 1
      }
      j++
    }
    return t.length
  }
  let j = i
  while (j < t.length && !isEol(t[j]) && t[j] !== '#' && t[j] !== ' ' && t[j] !== '\t' && t[j] !== ',') j++
  return j
}

/** Unquotes the first string literal in a value's text; null when it is not a string. */
export function readString(raw: string): string | null {
  const r = raw.trim()
  if (r.startsWith("'''") && r.endsWith("'''") && r.length >= 6) return r.slice(3, -3).replace(/^\r?\n/, '')
  if (r.startsWith('"""') && r.endsWith('"""') && r.length >= 6) return r.slice(3, -3).replace(/^\r?\n/, '')
  if (r.startsWith("'") && r.endsWith("'") && r.length >= 2) return r.slice(1, -1)
  if (r.startsWith('"') && r.endsWith('"') && r.length >= 2) {
    try {
      return JSON.parse(r) as string
    } catch {
      return r.slice(1, -1)
    }
  }
  return null
}

/** A dotted key such as `a."b.c".d`, from `i` up to `stop` (`=` or `]`). */
function readKey(t: string, i: number): { path: string[]; end: number } | null {
  const path: string[] = []
  let j = i
  for (;;) {
    while (t[j] === ' ' || t[j] === '\t') j++
    const c = t[j]
    if (c === '"' || c === "'") {
      const e = skipString(t, j)
      const s = readString(t.slice(j, e))
      if (s === null) return null
      path.push(s)
      j = e
    } else {
      let e = j
      while (e < t.length && /[A-Za-z0-9_-]/.test(t[e])) e++
      if (e === j) return null
      path.push(t.slice(j, e))
      j = e
    }
    while (t[j] === ' ' || t[j] === '\t') j++
    if (t[j] === '.') {
      j++
      continue
    }
    return { path, end: j }
  }
}

function lineEnd(t: string, i: number): number {
  let j = i
  while (j < t.length && !isEol(t[j])) j++
  return j
}

/** Every table header and `key = value` statement with its offsets. Unreadable lines are skipped. */
export function scanToml(t: string): Stmt[] {
  const out: Stmt[] = []
  let i = 0
  while (i < t.length) {
    const start = i
    while (t[i] === ' ' || t[i] === '\t') i++
    const c = t[i]
    if (isEol(c) || c === '#') {
      i = lineEnd(t, i)
      i += t[i] === '\r' && t[i + 1] === '\n' ? 2 : 1
      continue
    }
    if (c === '[') {
      const array = t[i + 1] === '['
      const key = readKey(t, i + (array ? 2 : 1))
      const end = lineEnd(t, key ? key.end : i)
      if (key) out.push({ kind: 'header', array, path: key.path, start, end })
      i = end + (t[end] === '\r' && t[end + 1] === '\n' ? 2 : 1)
      continue
    }
    const key = readKey(t, i)
    if (key && t[key.end] === '=') {
      let v = key.end + 1
      while (t[v] === ' ' || t[v] === '\t') v++
      const valueEnd = scanValue(t, v)
      out.push({ kind: 'kv', path: key.path, start, end: lineEnd(t, valueEnd), valueStart: v, valueEnd })
      i = lineEnd(t, valueEnd)
    } else {
      i = lineEnd(t, i)
    }
    i += t[i] === '\r' && t[i + 1] === '\n' ? 2 : 1
  }
  return out
}

function eolOf(t: string): string {
  return t.includes('\r\n') ? '\r\n' : '\n'
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i])
}

function startsWith(a: string[], prefix: string[]): boolean {
  return a.length >= prefix.length && prefix.every((s, i) => s === a[i])
}

export function headerText(path: string[]): string {
  return path.map((s) => (BARE.test(s) ? s : JSON.stringify(s))).join('.')
}

interface Block {
  header: Extract<Stmt, { kind: 'header' }>
  kvs: Extract<Stmt, { kind: 'kv' }>[]
}

function blocksOf(stmts: Stmt[], array: boolean, path: string[]): Block[] {
  const out: Block[] = []
  let current: Block | null = null
  for (const s of stmts) {
    if (s.kind === 'header') {
      current = s.array === array && samePath(s.path, path) ? { header: s, kvs: [] } : null
      if (current) out.push(current)
    } else if (current) {
      current.kvs.push(s)
    }
  }
  return out
}

/**
 * True when the file defines `table` (or a parent of it) through a dotted key or an inline
 * table, which this scanner will not edit. A sub-table header such as
 * `[plugins."a@b".mcp_servers.x]` does not count: adding the parent header is valid TOML.
 */
function definedInOtherForm(stmts: Stmt[], table: string[]): boolean {
  let at: string[] = []
  for (const s of stmts) {
    if (s.kind === 'header') {
      at = s.path
      continue
    }
    const abs = [...at, ...s.path]
    if (s.path.length > 1 && startsWith(abs, table)) return true
    if (abs.length <= table.length && startsWith(table, abs)) return true
  }
  return false
}

function setInBlock(t: string, block: Block, key: string, value: string): string {
  const kv = block.kvs.find((k) => k.path.length === 1 && k.path[0] === key)
  if (kv) return t.slice(0, kv.valueStart) + value + t.slice(kv.valueEnd)
  const eol = eolOf(t)
  const at = block.kvs.length > 0 ? block.kvs[block.kvs.length - 1].end : block.header.end
  return t.slice(0, at) + eol + `${BARE.test(key) ? key : JSON.stringify(key)} = ${value}` + t.slice(at)
}

function removeLine(t: string, start: number, end: number): string {
  let to = end
  if (t[to] === '\r' && t[to + 1] === '\n') to += 2
  else if (t[to] === '\n') to += 1
  return t.slice(0, start) + t.slice(to)
}

function appendBlock(t: string, lines: string[]): string {
  const eol = eolOf(t)
  let out = t
  if (out !== '' && !out.endsWith('\n')) out += eol
  if (out.trim() !== '') out += eol
  return out + lines.join(eol) + eol
}

function tomlSet(t: string, table: string[], key: string, value: boolean): string | null {
  const stmts = scanToml(t)
  const block = blocksOf(stmts, false, table)[0]
  if (block) return setInBlock(t, block, key, String(value))
  if (definedInOtherForm(stmts, table)) return null
  return appendBlock(t, [`[${headerText(table)}]`, `${BARE.test(key) ? key : JSON.stringify(key)} = ${value}`])
}

function tomlUnset(t: string, table: string[], key: string): string {
  const stmts = scanToml(t)
  const block = blocksOf(stmts, false, table)[0]
  const kv = block?.kvs.find((k) => k.path.length === 1 && k.path[0] === key)
  return kv ? removeLine(t, kv.start, kv.end) : t
}

function skillBlock(t: string, stmts: Stmt[], name: string): Block | undefined {
  return blocksOf(stmts, true, ['skills', 'config']).find((b) => {
    const n = b.kvs.find((k) => k.path.length === 1 && k.path[0] === 'name')
    return n !== undefined && !b.kvs.some((k) => k.path[0] === 'path') && readString(t.slice(n.valueStart, n.valueEnd)) === name
  })
}

function skillRuleSet(t: string, name: string, enabled: boolean): string | null {
  const stmts = scanToml(t)
  const block = skillBlock(t, stmts, name)
  if (block) return setInBlock(t, block, 'enabled', String(enabled))
  if (definedInOtherForm(stmts, ['skills', 'config'])) return null
  return appendBlock(t, ['[[skills.config]]', `name = ${JSON.stringify(name)}`, `enabled = ${enabled}`])
}

function skillRuleRemove(t: string, name: string): string {
  const stmts = scanToml(t)
  const block = skillBlock(t, stmts, name)
  if (!block) return t
  const enabled = block.kvs.find((k) => k.path.length === 1 && k.path[0] === 'enabled')
  const others = block.kvs.filter((k) => k !== enabled && !(k.path.length === 1 && k.path[0] === 'name'))
  if (others.length > 0 || block.kvs.length === 0) return enabled ? removeLine(t, enabled.start, enabled.end) : t
  // The entry holds only what Ballast wrote: drop it whole, with the blank line before it.
  const last = block.kvs[block.kvs.length - 1]
  let start = block.header.start
  if (t.slice(Math.max(0, start - 2), start) === '\n\n' || t.slice(Math.max(0, start - 4), start) === '\r\n\r\n') {
    start -= t[start - 2] === '\r' ? 2 : 1
  }
  let to = last.end
  if (t[to] === '\r' && t[to + 1] === '\n') to += 2
  else if (t[to] === '\n') to += 1
  return t.slice(0, start) + t.slice(to)
}

/** Applies Codex mutations to the file text; null when one cannot be applied safely. */
export function applyTomlMutations(original: string, mutations: Mutation[]): string | null {
  let text = original
  for (const m of mutations) {
    let next: string | null
    if (m.type === 'tomlSet') next = tomlSet(text, m.table, m.key, m.value)
    else if (m.type === 'tomlUnset') next = tomlUnset(text, m.table, m.key)
    else if (m.type === 'skillRuleSet') next = skillRuleSet(text, m.name, m.enabled)
    else if (m.type === 'skillRuleRemove') next = skillRuleRemove(text, m.name)
    else return null
    if (next === null) return null
    text = next
  }
  return text
}

/**
 * The file with every value replaced by `"…"` except booleans and the `name` of a
 * `[[skills.config]]` entry. Env values, headers, tokens, URLs, commands and paths never reach a
 * preview; table and key names stay, so the diff reads.
 */
export function redactToml(text: string): string {
  const stmts = scanToml(text)
  const spans: { from: number; to: number }[] = []
  let table: string[] = []
  let isArray = false
  for (const s of stmts) {
    if (s.kind === 'header') {
      table = s.path
      isArray = s.array
      continue
    }
    const raw = text.slice(s.valueStart, s.valueEnd).trim()
    if (raw === 'true' || raw === 'false') continue
    if (isArray && samePath(table, ['skills', 'config']) && samePath(s.path, ['name'])) continue
    spans.push({ from: s.valueStart, to: s.valueEnd })
  }
  let out = text
  for (const sp of spans.sort((a, b) => b.from - a.from)) out = out.slice(0, sp.from) + '"…"' + out.slice(sp.to)
  return out
}
