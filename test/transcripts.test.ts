// Connectors and late MCP servers exist only in transcripts: parsing them, and noticing when a
// new one reaches a session already running.
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { afterEach, assert, test } from 'orca/testing'
import { parseTranscript, scanTranscripts, serverSegment } from '../src/core/transcripts.ts'
import { type Fixture, fixtureSource, makeFixture, focusFor, serviceFor } from './fixture.ts'

let fx: Fixture | undefined
afterEach(async () => {
  await fx?.cleanup()
  fx = undefined
})

test('server segments match Claude Code tool names', () => {
  assert.equal(serverSegment('claude.ai Atlassian MCP'), 'claude_ai_Atlassian_MCP')
  assert.equal(serverSegment('plugin:gitkraken:gitkraken'), 'plugin_gitkraken_gitkraken')
})

test('parses deferred tools and instructions, ignoring message text', async () => {
  const text = await fs.readFile(fixtureSource('basic', 'transcripts', 'session-1.jsonl'), 'utf8')
  const s = parseTranscript(text)
  assert.deepEqual([...(s.tools.get('claude_ai_Gmail') ?? [])].sort(), [
    'mcp__claude_ai_Gmail__search_threads',
    'mcp__claude_ai_Gmail__send_message'
  ])
  assert.equal(s.names.get('claude_ai_Atlassian_MCP'), 'claude.ai Atlassian MCP')
  assert.ok((s.instructions.get('claude_ai_Atlassian_MCP') ?? 0) > 50)
  assert.equal(s.tools.has('claude_ai_Fake'), false)
})

test('scanTranscripts reports kinds, counts and the latest session', async () => {
  fx = await makeFixture()
  const scan = await scanTranscripts(fx.config, fx.repo)
  assert.equal(scan.sessionCount, 1)
  const gmail = scan.servers.find((s) => s.name === 'claude.ai Gmail')
  assert.equal(gmail?.kind, 'connector')
  assert.equal(gmail?.toolCount, 2)
  assert.equal(gmail?.inLatestSession, true)
  assert.equal(scan.servers.find((s) => s.segment === 'plugin_cloudflare_cloudflare')?.kind, 'plugin')
})

test('a connector arriving mid-session is reported once, after a quiet baseline', async () => {
  fx = await makeFixture()
  const stored = new Map<string, unknown>()
  let clock = 1_000
  const s = serviceFor(fx, { store: { get: async (k) => stored.get(k) ?? null, set: async (k, v) => void stored.set(k, v) }, now: () => clock })
  const first = await s.recordSeen(fx.config, fx.repo)
  assert.deepEqual(first.names, [], 'what was there before Ballast looked is the baseline')

  // The running session gains Google Drive.
  const late = await fs.readFile(fixtureSource('basic', 'transcripts', 'late-arrival.jsonl'), 'utf8')
  await fs.appendFile(path.join(fx.projectDir, 'session-1.jsonl'), late)
  clock = 5_000
  const second = await s.recordSeen(fx.config, fx.repo)
  assert.deepEqual(second.names, ['claude.ai Google Drive'])
  assert.equal(second.firstSeen['claude.ai Google Drive'], 5_000)
  assert.deepEqual((await s.recordSeen(fx.config, fx.repo)).names, [], 'reported once')

  const result = await s.scan(focusFor(fx))
  const drive = result.items.find((i) => i.name === 'claude.ai Google Drive')
  assert.equal(drive?.kind, 'connector')
  assert.equal(drive?.isNew, true)
  assert.equal(drive?.toolCount, 2)
  assert.equal(result.items.find((i) => i.name === 'claude.ai Gmail')?.isNew, undefined)
})

test('Claude desktop app sessions are left out: settings do not reach their connectors', async () => {
  fx = await makeFixture()
  const record = {
    type: 'attachment',
    entrypoint: 'claude-desktop',
    timestamp: '2026-11-10T11:00:00.000Z',
    attachment: { type: 'deferred_tools_delta', addedNames: ['mcp__ccd_sidebar__open'], removedNames: [] }
  }
  await fs.writeFile(path.join(fx.projectDir, 'desktop.jsonl'), JSON.stringify(record) + '\n')
  const scan = await scanTranscripts(fx.config, fx.repo)
  assert.equal(scan.skippedDesktop, 1)
  assert.equal(scan.servers.some((s) => s.segment === 'ccd_sidebar'), false)
  assert.ok(scan.servers.some((s) => s.name === 'claude.ai Gmail'), 'CLI sessions still count')
})
