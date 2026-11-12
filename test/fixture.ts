// Copies a fixture tree into a fresh temporary folder, so tests read and write there and never
// in a real config dir or repository. Placeholders in the JSON files become the copy's paths.
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HostEnv } from '../src/core/profile.ts'
import { encodeProjectDir } from '../src/core/paths.ts'

export interface Fixture {
  root: string
  home: string
  config: string
  repo: string
  orcaData: string
  env: HostEnv
  projectDir: string
  cleanup: () => Promise<void>
}

function fixturesDir(): string {
  try {
    return fileURLToPath(new URL('../fixtures/', import.meta.url))
  } catch {
    return path.join(process.cwd(), 'fixtures')
  }
}

async function copyTree(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true })
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) await copyTree(src, dst)
    else await fs.copyFile(src, dst)
  }
}

async function fillPlaceholders(file: string, values: Record<string, string>): Promise<void> {
  let text = await fs.readFile(file, 'utf8')
  for (const [key, value] of Object.entries(values)) {
    // JSON-escape the path, then drop the surrounding quotes.
    text = text.split(key).join(JSON.stringify(value).slice(1, -1))
  }
  await fs.writeFile(file, text)
}

/** `fixtures/<name>/config` becomes the Claude config dir, `repo` the working folder. */
export async function makeFixture(name = 'basic', repoName = 'alp-docs'): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ballast-'))
  const source = path.join(fixturesDir(), name)
  const home = path.join(root, 'home')
  const orcaData = path.join(root, 'orca')
  const config = path.join(orcaData, 'claude-profiles', 'acc-1', 'home')
  const repo = path.join(root, 'work', repoName)
  await copyTree(path.join(source, 'config'), config)
  await copyTree(path.join(source, 'repo'), repo)
  await fs.mkdir(path.join(repo, '.git'), { recursive: true })
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(path.join(orcaData, 'claude-profiles', 'selected-host'), config)

  const values = { __PROJECT__: repo, __CONFIG__: config }
  for (const rel of ['.claude.json', 'plugins/installed_plugins.json', 'plugins/known_marketplaces.json']) {
    await fillPlaceholders(path.join(config, rel), values)
  }

  const projectDir = path.join(config, 'projects', encodeProjectDir(repo))
  await fs.mkdir(projectDir, { recursive: true })
  await fs.copyFile(path.join(source, 'transcripts', 'session-1.jsonl'), path.join(projectDir, 'session-1.jsonl'))

  const env: HostEnv = {
    homeDir: home,
    platform: process.platform,
    orcaDataDir: orcaData,
    managedSettingsFile: path.join(root, 'managed', 'managed-settings.json')
  }
  return {
    root,
    home,
    config,
    repo,
    orcaData,
    env,
    projectDir,
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  }
}

export const fixtureSource = (name: string, ...rest: string[]) => path.join(fixturesDir(), name, ...rest)

/** Every planted secret in the fixtures starts with this. */
export const SECRET_MARK = 'SECRET_'

// ---------------------------------------------------------------- service helpers

import { createService, type ServiceDeps, type WorkspaceRecord } from '../src/core/service.ts'
import { createMemoryStore, type MemoryStore } from '../src/core/memory-store.ts'
import type { ScanInput } from '../src/protocol.ts'

/** A memory store over a Map, written at once. */
export function memoryStoreFor(data = new Map<string, unknown>()): MemoryStore & { data: Map<string, unknown> } {
  const store = createMemoryStore({ get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) }, 0)
  return Object.assign(store, { data })
}

export function workspaceFor(f: Pick<Fixture, 'repo'>): WorkspaceRecord {
  return { id: `repo1::${f.repo}`, kind: 'worktree', name: path.basename(f.repo), path: f.repo, branch: 'main', hostId: null }
}

/** What the panel sends when the fixture repo is the only workspace and has the focus. */
/**
 * Points the worker (which reads its own process environment) at a fixture: Orca's data folder,
 * so the active Claude account is the fixture's, and CODEX_HOME. Returns the undo.
 */
export function pointWorkerAt(f: Pick<Fixture, 'orcaData'> & { codexHome?: string }): () => void {
  const names = ['APPDATA', 'XDG_CONFIG_HOME', 'CODEX_HOME'] as const
  const saved = names.map((n) => process.env[n])
  process.env.APPDATA = process.env.XDG_CONFIG_HOME = path.dirname(f.orcaData)
  if (f.codexHome) process.env.CODEX_HOME = f.codexHome
  return () => names.forEach((n, i) => (saved[i] === undefined ? delete process.env[n] : (process.env[n] = saved[i])))
}

/** The focus with one running agent: a scan needs a supported agent in the workspace. */
export function focusFor(f: Pick<Fixture, 'repo'>, agent: 'claude' | 'codex' = 'claude'): ScanInput {
  return {
    workspace: { displayName: path.basename(f.repo), branch: 'main', terminals: [] },
    agents: [{ terminalId: null, title: null, agent, stateStartedAt: 1 }]
  }
}

export function serviceFor(f: Pick<Fixture, 'repo' | 'env'>, extra: Partial<ServiceDeps> = {}) {
  const data = new Map<string, unknown>()
  return createService({
    env: f.env,
    store: { get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) },
    memory: memoryStoreFor(),
    listWorkspaces: async () => [workspaceFor(f)],
    ...extra
  })
}

// ---------------------------------------------------------------- Codex fixture

export interface CodexFixture {
  root: string
  /** The "user home" (`~`): holds nothing for Codex here. */
  home: string
  /** CODEX_HOME of the managed account `acc-1`. */
  codexHome: string
  repo: string
  orcaData: string
  env: HostEnv
  cleanup: () => Promise<void>
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walkFiles(p)))
    else out.push(p)
  }
  return out
}

/** `fixtures/codex/home` becomes the Codex home of a managed account, `repo` the working folder. */
export async function makeCodexFixture(): Promise<CodexFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ballast-codex-'))
  const source = path.join(fixturesDir(), 'codex')
  const home = path.join(root, 'home')
  const orcaData = path.join(root, 'orca')
  const codexHome = path.join(orcaData, 'codex-accounts', 'acc-1', 'home')
  const repo = path.join(root, 'work', 'alp-docs')
  await copyTree(path.join(source, 'home'), codexHome)
  await copyTree(path.join(source, 'repo'), repo)
  await fs.mkdir(path.join(repo, '.git'), { recursive: true })
  await fs.mkdir(home, { recursive: true })
  // TOML literal strings take the path as it is; JSONL takes it JSON-escaped.
  for (const file of await walkFiles(codexHome)) {
    if (file.endsWith('.toml')) {
      await fs.writeFile(file, (await fs.readFile(file, 'utf8')).split('__PROJECT__').join(repo))
    } else if (file.endsWith('.jsonl')) {
      await fs.writeFile(file, (await fs.readFile(file, 'utf8')).split('__PROJECT__').join(JSON.stringify(repo).slice(1, -1)))
    }
  }
  const env: HostEnv = {
    homeDir: home,
    platform: process.platform,
    orcaDataDir: orcaData,
    managedSettingsFile: path.join(root, 'managed', 'managed-settings.json')
  }
  return { root, home, codexHome, repo, orcaData, env, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}
