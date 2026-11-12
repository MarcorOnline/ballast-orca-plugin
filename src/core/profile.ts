// Which home the folder's agents use: CLAUDE_CONFIG_DIR for Claude Code, CODEX_HOME for Codex.
// Orca gives each managed account its own home (`<orca data>/claude-profiles/<id>/home`,
// `<orca data>/codex-accounts/<id>/home`) and starts new agents with the active account's. The
// plugin API does not say which account a running agent uses, so Ballast reads Orca's account
// list (`orca account list --json`, see accounts.ts) and, when that is not available, the disk.
// It never opens an `auth.json` or any other credential file.
import * as path from 'node:path'
import type { AgentId, ProfileInfo } from '../model.ts'
import type { OrcaAccounts } from './accounts.ts'
import { isDir, readText } from './fsx.ts'
import { samePath } from './paths.ts'
import { readUserState, stateFilePath } from './state.ts'

export interface HostEnv {
  homeDir: string
  platform: NodeJS.Platform
  /** Orca's data folder (`%APPDATA%\orca` on Windows), or null when unknown. */
  orcaDataDir: string | null
  /** CLAUDE_CONFIG_DIR as the worker sees it. */
  envConfigDir?: string
  /** CODEX_HOME as the worker sees it. */
  envCodexHome?: string
  managedSettingsFile: string
}

export function defaultOrcaDataDir(
  homeDir: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string {
  if (platform === 'win32')
    return path.join(env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming'), 'orca')
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', 'orca')
  return path.join(env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config'), 'orca')
}

export function systemHome(env: HostEnv, agent: AgentId): string {
  if (agent === 'claude-code') return env.envConfigDir ?? path.join(env.homeDir, '.claude')
  return env.envCodexHome ?? path.join(env.homeDir, '.codex')
}

function managedRoot(env: HostEnv, agent: AgentId): string | null {
  if (!env.orcaDataDir) return null
  return path.join(env.orcaDataDir, agent === 'claude-code' ? 'claude-profiles' : 'codex-accounts')
}

/** The managed account id when `home` is `<orca data>/<root>/<id>/home`. */
export function managedAccountId(home: string, env: HostEnv, agent: AgentId): string | undefined {
  const root = managedRoot(env, agent)
  if (!root) return undefined
  const parent = path.dirname(home)
  if (path.basename(home) !== 'home' || !samePath(path.dirname(parent), root)) return undefined
  return path.basename(parent)
}

async function claudeEmail(env: HostEnv, home: string): Promise<string | undefined> {
  const state = await readUserState(stateFilePath(home, env.homeDir), home)
  return state.account
}

/** Orca's active managed Claude account, from the file Orca keeps for the host. */
export async function orcaActiveClaudeDir(env: HostEnv): Promise<string | null> {
  if (!env.orcaDataDir) return null
  const text = await readText(path.join(env.orcaDataDir, 'claude-profiles', 'selected-host'), 4096)
  const dir = text?.trim()
  if (!dir || !path.isAbsolute(dir) || !(await isDir(dir))) return null
  return dir
}

export interface ResolveProfileInput {
  agent: AgentId
  /** A home a write request names (the scan never takes one from the panel). */
  chosen?: string | null
  /** A home a recent agent launch in this workspace carried. */
  launchHome?: string | null
  accounts?: OrcaAccounts | null
}

export async function resolveProfile(env: HostEnv, input: ResolveProfileInput): Promise<ProfileInfo> {
  const { agent, accounts } = input
  let configDir: string
  let source: ProfileInfo['source']
  if (input.chosen) {
    configDir = input.chosen
    source = 'chosen'
  } else if (input.launchHome && (await isDir(input.launchHome))) {
    configDir = input.launchHome
    source = 'launch'
  } else {
    const active = await activeHome(env, agent, accounts ?? null)
    if (active) {
      configDir = active
      source = 'orca-active'
    } else {
      const sys = systemHome(env, agent)
      configDir = sys
      const fromEnv = agent === 'claude-code' ? env.envConfigDir : env.envCodexHome
      source = fromEnv ? 'env' : 'default'
    }
  }
  const exists = await isDir(configDir)
  const info: ProfileInfo = { agent, configDir, source, exists }
  const id = managedAccountId(configDir, env, agent)
  if (id) info.orcaAccountId = id
  const account = await accountOf(env, agent, configDir, accounts ?? null, id)
  if (account) info.account = account
  return info
}

async function activeHome(env: HostEnv, agent: AgentId, accounts: OrcaAccounts | null): Promise<string | null> {
  if (agent === 'claude-code') {
    const a = accounts?.claude
    const viaCli = a?.activeAccountId ? a.accounts.find((x) => x.id === a.activeAccountId)?.home : undefined
    if (viaCli && (await isDir(viaCli))) return viaCli
    return orcaActiveClaudeDir(env)
  }
  const id = accounts?.codex.activeAccountId
  const root = managedRoot(env, 'codex')
  if (!id || !root) return null
  const home = path.join(root, id, 'home')
  return (await isDir(home)) ? home : null
}

async function accountOf(env: HostEnv, agent: AgentId, home: string, accounts: OrcaAccounts | null, id: string | undefined): Promise<string | undefined> {
  if (agent === 'claude-code') {
    return (await claudeEmail(env, home)) ?? accounts?.claude.accounts.find((a) => a.id === id)?.email
  }
  if (id) return accounts?.codex.accounts.find((a) => a.id === id)?.email
  if (samePath(home, systemHome(env, 'codex'))) return accounts?.codex.systemDefault?.email
  return undefined
}
