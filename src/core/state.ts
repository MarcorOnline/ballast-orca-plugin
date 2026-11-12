// The user state file (`.claude.json`): user- and local-scope MCP servers, the per-project
// `/mcp` toggles and the trust flag. It also holds OAuth data and server env and headers, so this
// module copies out names and the few fields matching needs and lets the rest go.
import * as path from 'node:path'
import { asString, asStringArray, isRecord, readJsonObject } from './fsx.ts'
import { samePath } from './paths.ts'

/** A configured MCP server. `url` and `command` never leave the worker. */
export interface ServerConfig {
  name: string
  transport: 'stdio' | 'http' | 'sse' | 'other'
  url?: string
  command?: string[]
}

export interface ProjectState {
  mcpServers: ServerConfig[]
  disabledMcpServers: string[]
  enabledMcpServers: string[]
  hasTrustDialogAccepted: boolean
}

export interface UserState {
  file: string
  exists: boolean
  account?: string
  mcpServers: ServerConfig[]
  project: ProjectState
}

/** With a custom config dir the state file sits inside it; the default one sits in the home. */
export function stateFilePath(configDir: string, homeDir: string): string {
  if (samePath(configDir, path.join(homeDir, '.claude'))) return path.join(homeDir, '.claude.json')
  return path.join(configDir, '.claude.json')
}

export function serverConfigs(map: unknown): ServerConfig[] {
  if (!isRecord(map)) return []
  const out: ServerConfig[] = []
  for (const [name, raw] of Object.entries(map)) {
    if (!isRecord(raw)) continue
    const type = asString(raw.type)
    const url = asString(raw.url)
    const command = asString(raw.command)
    const transport =
      type === 'http' || type === 'sse' || type === 'stdio'
        ? type
        : url
          ? 'http'
          : command
            ? 'stdio'
            : 'other'
    const server: ServerConfig = { name, transport }
    if (url) server.url = url
    if (command) server.command = [command, ...asStringArray(raw.args)]
    out.push(server)
  }
  return out
}

export async function readUserState(file: string, folder: string): Promise<UserState> {
  const read = await readJsonObject(file)
  const raw = read.value ?? {}
  const project: ProjectState = {
    mcpServers: [],
    disabledMcpServers: [],
    enabledMcpServers: [],
    hasTrustDialogAccepted: false
  }
  if (isRecord(raw.projects)) {
    // Claude Code has written both slash styles over time; merge every entry for the folder.
    for (const [key, entry] of Object.entries(raw.projects)) {
      if (!isRecord(entry) || !samePath(key, folder)) continue
      project.mcpServers.push(...serverConfigs(entry.mcpServers))
      project.disabledMcpServers.push(...asStringArray(entry.disabledMcpServers))
      project.enabledMcpServers.push(...asStringArray(entry.enabledMcpServers))
      if (entry.hasTrustDialogAccepted === true) project.hasTrustDialogAccepted = true
    }
  }
  const oauth = isRecord(raw.oauthAccount) ? raw.oauthAccount : {}
  return {
    file,
    exists: read.exists,
    account: asString(oauth.emailAddress),
    mcpServers: serverConfigs(raw.mcpServers),
    project
  }
}
