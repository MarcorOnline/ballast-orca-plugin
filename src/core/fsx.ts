// Small, failure-tolerant file helpers. A missing or broken file is a normal state for every
// source Ballast reads, so these return null instead of throwing.
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { parse, type ParseError } from '../vendor/jsonc-parser/index.mjs'

export async function readText(file: string, maxBytes = 8 * 1024 * 1024): Promise<string | null> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > maxBytes) return null
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

export interface JsonRead {
  exists: boolean
  value: Record<string, unknown> | null
  /** True when the file exists but is not a JSON object. */
  broken: boolean
}

/** Reads a JSON (or JSONC) object file. */
export async function readJsonObject(file: string): Promise<JsonRead> {
  const text = await readText(file)
  if (text === null) return { exists: await exists(file), value: null, broken: false }
  const value = parseJsonObject(text)
  return { exists: true, value, broken: value === null }
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return {}
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isRecord(value)) return null
  return value
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

export async function isDir(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/** Sub-directory names, following symlinks; empty when the folder is missing. */
export async function listDirs(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names.sort()) {
    if (await isDir(path.join(dir, name))) out.push(name)
  }
  return out
}

export async function listFiles(dir: string, ext?: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries.sort()) {
    if (ext && !name.toLowerCase().endsWith(ext)) continue
    try {
      if ((await fs.stat(path.join(dir, name))).isFile()) out.push(name)
    } catch {
      // A dangling link: skip it.
    }
  }
  return out
}

export async function mtime(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch {
    return null
  }
}

export async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return p
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}
