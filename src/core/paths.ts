// Path rules shared by every reader: comparing folders, Claude Code's project-folder encoding,
// and the git root that decides where auto memory lives.
import * as path from 'node:path'
import { exists } from './fsx.ts'

/** A key for comparing paths: absolute, forward slashes, no trailing slash, case-folded on Windows. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  let out = path.resolve(p).replace(/\\/g, '/')
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return platform === 'win32' || platform === 'darwin' ? out.toLowerCase() : out
}

export function samePath(a: string, b: string, platform?: NodeJS.Platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform)
}

/** True when `child` is `parent` or inside it. */
export function isInside(child: string, parent: string, platform?: NodeJS.Platform): boolean {
  const c = pathKey(child, platform)
  const p = pathKey(parent, platform)
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/')
}

/**
 * The folder name Claude Code uses under `<config>/projects/` for a working directory: every
 * character that is not a letter or digit becomes `-`.
 */
export function encodeProjectDir(folder: string): string {
  return path.resolve(folder).replace(/[^a-zA-Z0-9]/g, '-')
}

/** The nearest folder at or above `folder` that holds `.git`, or null. */
export async function findGitRoot(folder: string): Promise<string | null> {
  let dir = path.resolve(folder)
  for (;;) {
    if (await exists(path.join(dir, '.git'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** `folder` and every folder above it, root last. */
export function ancestors(folder: string): string[] {
  const out: string[] = []
  let dir = path.resolve(folder)
  for (;;) {
    out.push(dir)
    const up = path.dirname(dir)
    if (up === dir) return out
    dir = up
  }
}

/** Expands a leading `~/`. */
export function expandHome(p: string, homeDir: string): string {
  if (p === '~') return homeDir
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homeDir, p.slice(2))
  return p
}
