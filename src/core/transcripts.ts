// What MCP servers and claude.ai connectors actually reached a session. They are not on disk:
// Claude Code announces them in the transcript as deferred tools (`deferred_tools_delta`) and
// server instructions (`mcp_instructions_delta`). Only those two record types are parsed; user
// and assistant messages are never read into memory as objects.
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { listFiles, mtime } from './fsx.ts'
import { encodeProjectDir } from './paths.ts'

export type ServerKind = 'connector' | 'plugin' | 'other'

export interface SeenServer {
  /** Display name, e.g. `claude.ai Slack` or `plugin:gitkraken:gitkraken`. */
  name: string
  /** The segment in tool names: `mcp__<segment>__<tool>`. */
  segment: string
  kind: ServerKind
  toolCount: number
  /** Characters Claude sees for it: deferred tool names and server instructions. */
  chars: number
  lastSeenAt: number
  sessionId: string
  inLatestSession: boolean
  status: 'connected' | 'pending' | 'needs-auth' | 'failed'
}

export interface TranscriptScan {
  dir: string
  sessionCount: number
  /** Claude desktop app sessions: it delivers connectors in-process, outside these settings. */
  skippedDesktop: number
  latestAt?: number
  latestSessionId?: string
  servers: SeenServer[]
}

/** The tool-name segment for a server name: anything outside `[A-Za-z0-9_-]` becomes `_`. */
export function serverSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

export function kindOfSegment(segment: string): ServerKind {
  if (segment.startsWith('claude_ai_')) return 'connector'
  if (segment.startsWith('plugin_')) return 'plugin'
  return 'other'
}

/** A readable name when no record named the server: `claude_ai_Google_Drive` → `claude.ai Google Drive`. */
function guessName(segment: string): string {
  if (segment.startsWith('claude_ai_')) return 'claude.ai ' + segment.slice(10).replace(/_/g, ' ')
  return segment
}

function splitTool(tool: string): { segment: string; tool: string } | null {
  if (!tool.startsWith('mcp__')) return null
  const rest = tool.slice(5)
  const at = rest.lastIndexOf('__')
  if (at <= 0) return null
  return { segment: rest.slice(0, at), tool: rest.slice(at + 2) }
}

interface SessionServers {
  tools: Map<string, Set<string>>
  instructions: Map<string, number>
  names: Map<string, string>
  status: Map<string, SeenServer['status']>
  lastAt: number
  /** `cli`, `sdk-ts`, `claude-desktop`…, from the first parsed record. */
  entrypoint?: string
}

const MARKERS = ['"deferred_tools_delta"', '"mcp_instructions_delta"']

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Parses one transcript's text. Exported for tests. */
export function parseTranscript(text: string): SessionServers {
  const s: SessionServers = {
    tools: new Map(),
    instructions: new Map(),
    names: new Map(),
    status: new Map(),
    lastAt: 0
  }
  const nameOf = (display: string) => {
    const segment = serverSegment(display)
    s.names.set(segment, display)
    return segment
  }
  for (const line of text.split('\n')) {
    if (!MARKERS.some((m) => line.includes(m))) continue
    let record: { attachment?: Record<string, unknown>; timestamp?: string }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const a = record.attachment
    if (!a || typeof a !== 'object') continue
    if (!s.entrypoint && typeof (record as { entrypoint?: unknown }).entrypoint === 'string') {
      s.entrypoint = (record as { entrypoint: string }).entrypoint
    }
    const at = record.timestamp ? Date.parse(record.timestamp) : NaN
    if (a.type === 'deferred_tools_delta') {
      for (const n of strings(a.pendingMcpServers)) s.status.set(nameOf(n), 'pending')
      for (const n of strings(a.needsAuthMcpServers)) s.status.set(nameOf(n), 'needs-auth')
      for (const n of strings(a.failedMcpServers)) s.status.set(nameOf(n), 'failed')
      for (const t of [...strings(a.addedNames), ...strings(a.readdedNames)]) {
        const parts = splitTool(t)
        if (!parts) continue
        const set = s.tools.get(parts.segment) ?? new Set<string>()
        set.add(t)
        s.tools.set(parts.segment, set)
        s.status.set(parts.segment, 'connected')
        if (!Number.isNaN(at)) s.lastAt = Math.max(s.lastAt, at)
      }
      for (const t of strings(a.removedNames)) {
        const parts = splitTool(t)
        if (parts) s.tools.get(parts.segment)?.delete(t)
      }
    } else if (a.type === 'mcp_instructions_delta') {
      const names = strings(a.addedNames)
      const blocks = strings(a.addedBlocks)
      names.forEach((n, i) => {
        const segment = nameOf(n)
        s.instructions.set(segment, (blocks[i] ?? '').length)
        if (!s.status.has(segment)) s.status.set(segment, 'connected')
      })
      for (const n of strings(a.removedNames)) s.instructions.delete(serverSegment(n))
      if (!Number.isNaN(at)) s.lastAt = Math.max(s.lastAt, at)
    }
  }
  return s
}

/** The project dir under `<config>/projects/` for a folder; long names are truncated, so match the prefix. */
export async function projectDirFor(configDir: string, folder: string): Promise<string> {
  const base = path.join(configDir, 'projects')
  const encoded = encodeProjectDir(folder)
  if (encoded.length <= 200) return path.join(base, encoded)
  try {
    const names = await fs.readdir(base)
    const hit = names.find((n) => n.startsWith(encoded.slice(0, 200)))
    if (hit) return path.join(base, hit)
  } catch {
    // No projects folder yet.
  }
  return path.join(base, encoded)
}

export async function scanTranscripts(
  configDir: string,
  folder: string,
  maxSessions = 8
): Promise<TranscriptScan> {
  const dir = await projectDirFor(configDir, folder)
  const files = await listFiles(dir, '.jsonl')
  const dated: { file: string; at: number }[] = []
  for (const f of files) dated.push({ file: f, at: (await mtime(path.join(dir, f))) ?? 0 })
  dated.sort((a, b) => b.at - a.at)
  const recent = dated.slice(0, maxSessions)
  const latest = recent[0]

  const servers = new Map<string, SeenServer>()
  let skippedDesktop = 0
  // Oldest first, so the newest session's counts win.
  for (const { file, at } of [...recent].reverse()) {
    let text: string
    try {
      text = await fs.readFile(path.join(dir, file), 'utf8')
    } catch {
      continue
    }
    const s = parseTranscript(text)
    if (s.entrypoint === 'claude-desktop') {
      skippedDesktop++
      continue
    }
    const sessionId = file.replace(/\.jsonl$/i, '')
    const segments = new Set([...s.tools.keys(), ...s.instructions.keys(), ...s.status.keys()])
    for (const segment of segments) {
      const tools = s.tools.get(segment) ?? new Set<string>()
      let chars = s.instructions.get(segment) ?? 0
      for (const t of tools) chars += t.length + 1
      const previous = servers.get(segment)
      servers.set(segment, {
        name: s.names.get(segment) ?? previous?.name ?? guessName(segment),
        segment,
        kind: kindOfSegment(segment),
        toolCount: tools.size,
        chars,
        lastSeenAt: s.lastAt || at,
        sessionId,
        inLatestSession: file === latest?.file,
        status: s.status.get(segment) ?? 'connected'
      })
    }
  }
  const scan: TranscriptScan = {
    dir,
    sessionCount: files.length,
    skippedDesktop,
    servers: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
  if (latest) {
    scan.latestAt = latest.at
    scan.latestSessionId = latest.file.replace(/\.jsonl$/i, '')
  }
  return scan
}
