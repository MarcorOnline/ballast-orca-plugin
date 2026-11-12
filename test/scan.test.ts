// The context chain for a fixture folder: which layer decides each plugin, skill, server,
// connector and memory file, and what the panel would see.
import { afterEach, assert, test } from 'orca/testing'
import type { Item, ScanResult } from '../src/model.ts'
import { type Fixture, makeFixture, focusFor, serviceFor } from './fixture.ts'

let fx: Fixture | undefined
afterEach(async () => {
  await fx?.cleanup()
  fx = undefined
})

function memoryStore() {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: Record<string, number>) => void data.set(key, value)
  }
}

async function scan(f: Fixture): Promise<ScanResult> {
  return serviceFor(f).scan(focusFor(f))
}

function byId(result: ScanResult, id: string): Item {
  const item = result.items.find((i) => i.id === id)
  assert.ok(item, `missing ${id}; have ${result.items.map((i) => i.id).join(', ')}`)
  return item
}

test('uses the Orca profile Orca selected, not ~/.claude', async () => {
  fx = await makeFixture()
  const result = await scan(fx)
  assert.equal(result.profile.configDir, fx.config)
  assert.equal(result.profile.source, 'orca-active')
  assert.equal(result.profile.orcaAccountId, 'acc-1')
  assert.equal(result.profile.account, 'dev@example.com')
})

test('project settings turn on plugins the user level turns off', async () => {
  fx = await makeFixture()
  const result = await scan(fx)
  for (const key of ['azure@acme', 'cloudflare@acme', 'docs@acme']) {
    const plugin = byId(result, `plugin:${key}`)
    assert.equal(plugin.state, 'on', key)
    assert.equal(plugin.decidedBy.level, 'project', key)
    assert.equal(plugin.decidedBy.key, `enabledPlugins["${key}"]`)
  }
})

test('local settings beat project and user; user decides when nothing else does', async () => {
  fx = await makeFixture()
  const result = await scan(fx)
  const noisy = byId(result, 'plugin:noisy@acme')
  assert.equal(noisy.state, 'off')
  assert.equal(noisy.decidedBy.level, 'local')
  assert.equal(noisy.tokens, 0)
  assert.ok(noisy.tokensIfOn > 0, 'an off plugin still says what it would cost')
  const helper = byId(result, 'plugin:helper@acme')
  assert.equal(helper.state, 'on')
  assert.equal(helper.decidedBy.level, 'user')
  const ghost = byId(result, 'plugin:ghost@acme')
  assert.equal(ghost.state, 'not-installed')
})

test('plugin skills follow the marketplace entry and their plugin', async () => {
  fx = await makeFixture()
  const result = await scan(fx)
  const names = result.items.filter((i) => i.kind === 'skill').map((i) => i.name)
  assert.ok(names.includes('azure-deploy'))
  assert.ok(!names.includes('azure-other'), 'skills the entry does not list never load')
  assert.ok(names.includes('wrangler'))
  assert.ok(!names.includes('noise'), 'skills of an off plugin are not in context')
  const deploy = byId(result, 'skill:azure@acme:azure-deploy')
  assert.equal(deploy.countsInTotal, false, 'the plugin row counts its skills')
  assert.equal(deploy.actions.shared.block.allowed, false)
  assert.equal(deploy.actions.shared.block.notes[0].code, 'pluginSkillNoOverride')
  const mine = byId(result, 'skill:user:my-skill')
  assert.equal(mine.state, 'off')
  assert.equal(mine.decidedBy.level, 'local')
  assert.equal(byId(result, 'skill:project:proj-skill').state, 'on')
})

test('MCP servers: deny rules, approvals, /mcp toggles and plugins', async () => {
  fx = await makeFixture()
  const result = await scan(fx)
  const userDb = byId(result, 'mcp:user:user-db')
  assert.equal(userDb.state, 'on')
  assert.equal(userDb.toolCount, 1)
  const remote = byId(result, 'mcp:user:remote-api')
  assert.equal(remote.state, 'off', 'a serverUrl deny rule matches the configured URL')
  assert.equal(remote.decidedBy.level, 'user')
  assert.equal(byId(result, 'mcp:local:local-tool').decidedBy.level, 'state')
  const projDb = byId(result, 'mcp:project:proj-db')
  assert.equal(projDb.state, 'on')
  assert.equal(projDb.decidedBy.key, 'enabledMcpjsonServers')
  assert.equal(projDb.decidedBy.level, 'local')
  assert.equal(byId(result, 'mcp:project:proj-api').state, 'pending')
  const cf = byId(result, 'mcp:cloudflare@acme:plugin:cloudflare:cloudflare')
  assert.equal(cf.state, 'on')
  assert.equal(cf.toolCount, 1)
  assert.equal(cf.actions.personal.block.mechanism, 'permissions.deny += "mcp__plugin_cloudflare_cloudflare__*"')
})

test('connectors come from the transcript, with their tool counts', async () => {
  fx = await makeFixture()
  const result = await scan(fx)
  const gmail = byId(result, 'connector:session:claude.ai Gmail')
  assert.equal(gmail.state, 'on')
  assert.equal(gmail.toolCount, 2, 'a removed tool no longer counts')
  assert.equal(gmail.actions.shared.block.mechanism, 'deniedMcpServers += {"serverName":"claude.ai Gmail"}')
  const atlassian = byId(result, 'connector:session:claude.ai Atlassian MCP')
  assert.equal(atlassian.toolCount, 1)
  assert.ok(atlassian.tokens > 20, 'server instructions count toward its weight')
  assert.ok(!result.items.some((i) => i.name.includes('Fake')), 'message text is never parsed')
  const warn = result.warnings.find((w) => w.code === 'unmatchedDeny')
  assert.ok(warn, 'a deny rule that misses the arrived connector by name is flagged')
  assert.equal(warn.args?.rule, 'claude.ai Atlassian')
})

test('memory: the CLAUDE.md chain, on-demand sub-folders and totals', async () => {
  fx = await makeFixture()
  const result = await scan(fx)
  const memory = result.items.filter((i) => i.kind === 'memory')
  const names = memory.map((m) => m.name)
  assert.ok(names.includes('~config/CLAUDE.md'))
  assert.ok(names.includes('CLAUDE.md'))
  assert.ok(names.includes('CLAUDE.local.md'))
  const sub = memory.find((m) => m.name === 'sub/CLAUDE.md')
  assert.ok(sub)
  assert.equal(sub.state, 'on-demand')
  assert.equal(sub.countsInTotal, false)
  const counted = result.items.filter((i) => i.countsInTotal && i.state === 'on')
  assert.equal(result.totals.tokens, counted.reduce((n, i) => n + i.tokens, 0))
  assert.ok(result.totals.heaviest.length > 0)
})
