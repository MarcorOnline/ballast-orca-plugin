// The instruction files Claude Code loads for a folder: user CLAUDE.md and rules, every
// CLAUDE.md and CLAUDE.local.md from the root down to the folder, the project's `.claude/`
// files, the CLAUDE.md files in known sub-folders (loaded on demand) and the auto-memory index.
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { exists, listFiles, readText } from './fsx.ts'
import { frontmatter } from './frontmatter.ts'
import { ancestors, encodeProjectDir, expandHome, findGitRoot, isInside } from './paths.ts'
import { estimateTokens, memoryIndexSlice, stripHtmlComments } from './tokens.ts'

export type MemoryScope = 'managed' | 'user' | 'ancestor' | 'project' | 'local' | 'subfolder' | 'auto'

export interface MemoryFile {
  file: string
  scope: MemoryScope
  tokens: number
  onDemand: boolean
  /** True for the auto-memory MEMORY.md, which `autoMemoryEnabled` controls. */
  autoMemory: boolean
}

/** The organization CLAUDE.md sits beside managed-settings.json. */
export function managedClaudeMd(managedSettingsFile: string): string {
  return path.join(path.dirname(managedSettingsFile), 'CLAUDE.md')
}

async function instruction(
  file: string,
  scope: MemoryScope,
  onDemand = false
): Promise<MemoryFile | null> {
  const text = await readText(file, 4 * 1024 * 1024)
  if (text === null) return null
  return { file, scope, tokens: estimateTokens(stripHtmlComments(text)), onDemand, autoMemory: false }
}

/** Rules files; one with `paths:` front matter loads only when Claude works on matching files. */
async function rules(dir: string, scope: MemoryScope): Promise<MemoryFile[]> {
  const out: MemoryFile[] = []
  const walk = async (d: string, depth: number) => {
    if (depth > 4) return
    for (const f of await listFiles(d, '.md')) {
      const file = path.join(d, f)
      const text = (await readText(file, 4 * 1024 * 1024)) ?? ''
      const scoped = frontmatter(text).paths !== undefined
      out.push({ file, scope, tokens: estimateTokens(stripHtmlComments(text)), onDemand: scoped, autoMemory: false })
    }
    let names: string[] = []
    try {
      names = (await fs.readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return
    }
    for (const n of names.sort()) await walk(path.join(d, n), depth + 1)
  }
  await walk(dir, 0)
  return out
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'bin', 'obj', 'target', '.venv', 'vendor'])

/** CLAUDE.md files in sub-folders, at most `maxDepth` levels down and `limit` files. */
async function subfolderFiles(folder: string, maxDepth = 3, limit = 40): Promise<MemoryFile[]> {
  const out: MemoryFile[] = []
  const walk = async (dir: string, depth: number) => {
    if (depth > maxDepth || out.length >= limit) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
      const sub = path.join(dir, e.name)
      for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
        const f = await instruction(path.join(sub, name), 'subfolder', true)
        if (f && out.length < limit) out.push(f)
      }
      await walk(sub, depth + 1)
    }
  }
  await walk(folder, 1)
  return out
}

export interface MemoryInput {
  folder: string
  configDir: string
  homeDir: string
  platform: NodeJS.Platform
  managedSettingsFile: string
  /** `autoMemoryDirectory` from the settings layers, if any sets it. */
  autoMemoryDirectory?: string
}

export async function autoMemoryIndex(input: MemoryInput): Promise<string> {
  if (input.autoMemoryDirectory) {
    return path.join(expandHome(input.autoMemoryDirectory, input.homeDir), 'MEMORY.md')
  }
  const root = (await findGitRoot(input.folder)) ?? input.folder
  return path.join(input.configDir, 'projects', encodeProjectDir(root), 'memory', 'MEMORY.md')
}

export async function scanMemory(input: MemoryInput): Promise<MemoryFile[]> {
  const out: MemoryFile[] = []
  const push = (f: MemoryFile | null) => {
    if (f && !out.some((o) => o.file === f.file)) out.push(f)
  }
  push(await instruction(managedClaudeMd(input.managedSettingsFile), 'managed'))
  push(await instruction(path.join(input.configDir, 'CLAUDE.md'), 'user'))
  out.push(...(await rules(path.join(input.configDir, 'rules'), 'user')))

  // Root first, so the list reads in the order Claude Code concatenates them.
  for (const dir of ancestors(input.folder).reverse()) {
    const isFolder = dir === path.resolve(input.folder)
    // The config dir's own CLAUDE.md is the user file, already listed.
    if (isInside(path.join(dir, 'CLAUDE.md'), input.configDir)) continue
    push(await instruction(path.join(dir, 'CLAUDE.md'), isFolder ? 'project' : 'ancestor'))
    if (isFolder) push(await instruction(path.join(dir, '.claude', 'CLAUDE.md'), 'project'))
    push(await instruction(path.join(dir, 'CLAUDE.local.md'), isFolder ? 'local' : 'ancestor'))
  }
  out.push(...(await rules(path.join(input.folder, '.claude', 'rules'), 'project')))
  out.push(...(await subfolderFiles(input.folder)))

  const index = await autoMemoryIndex(input)
  if (await exists(index)) {
    const text = (await readText(index)) ?? ''
    out.push({ file: index, scope: 'auto', tokens: estimateTokens(memoryIndexSlice(text)), onDemand: false, autoMemory: true })
  }
  return out
}
