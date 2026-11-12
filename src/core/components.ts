// Skills, agents and commands on disk, with what each puts in context: the name and description
// Claude sees in its listings (the body loads only when used).
import * as path from 'node:path'
import { exists, isDir, listDirs, listFiles, readText } from './fsx.ts'
import { body, frontmatter } from './frontmatter.ts'
import { estimateTokens } from './tokens.ts'

export interface SkillFile {
  name: string
  dir: string
  /** Tokens of the listing entry (name, description, when_to_use). */
  tokens: number
  /** False with `disable-model-invocation: true`: Claude does not see it. */
  modelInvocable: boolean
}

export interface Component {
  name: string
  tokens: number
}

export async function readSkill(dir: string): Promise<SkillFile | null> {
  const text = await readText(path.join(dir, 'SKILL.md'), 2 * 1024 * 1024)
  if (text === null) return null
  const fm = frontmatter(text)
  const name = fm.name || path.basename(dir)
  const listing = [name, fm.description ?? '', fm.when_to_use ?? ''].join(' ')
  return {
    name,
    dir,
    tokens: estimateTokens(listing),
    modelInvocable: fm['disable-model-invocation'] !== 'true'
  }
}

/** A skill folder (holding SKILL.md) or a folder of skill folders. */
export async function scanSkillRoot(root: string): Promise<SkillFile[]> {
  if (await exists(path.join(root, 'SKILL.md'))) {
    const one = await readSkill(root)
    return one ? [one] : []
  }
  const out: SkillFile[] = []
  for (const name of await listDirs(root)) {
    const skill = await readSkill(path.join(root, name))
    if (skill) out.push(skill)
  }
  return out
}

async function readDescribed(file: string, fallbackName: string): Promise<Component | null> {
  const text = await readText(file, 1024 * 1024)
  if (text === null) return null
  const fm = frontmatter(text)
  const name = fm.name || fallbackName
  const description = fm.description ?? body(text).trim().split('\n')[0] ?? ''
  return { name, tokens: estimateTokens(`${name} ${description}`) }
}

/** `.md` files given one by one or as folders of them. */
export async function readMarkdownComponents(paths: string[]): Promise<Component[]> {
  const out: Component[] = []
  for (const p of paths) {
    if (await isDir(p)) {
      for (const file of await listFiles(p, '.md')) {
        const c = await readDescribed(path.join(p, file), file.replace(/\.md$/i, ''))
        if (c) out.push(c)
      }
    } else if (p.toLowerCase().endsWith('.md')) {
      const c = await readDescribed(p, path.basename(p).replace(/\.md$/i, ''))
      if (c) out.push(c)
    }
  }
  return out
}
