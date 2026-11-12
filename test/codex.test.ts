// What reaches Codex's context in a folder: config layers, trust, skills, MCP servers, plugins
// and the AGENTS.md chain, over fixtures/codex.
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { afterEach, assert, test } from 'orca/testing'
import { DEFAULT_DOC_MAX_BYTES, scanCodex } from '../src/core/codex.ts'
import type { Item, ProfileInfo, ScanResult } from '../src/model.ts'
import { type CodexFixture, focusFor, makeCodexFixture, serviceFor } from './fixture.ts'

let fx: CodexFixture | undefined
afterEach(async () => {
  await fx?.cleanup()
  fx = undefined
})

function profile(f: CodexFixture): ProfileInfo {
  return { agent: 'codex', configDir: f.codexHome, source: 'chosen', exists: true }
}

async function scan(f: CodexFixture, folder = f.repo): Promise<ScanResult> {
  const result = await scanCodex({ folder, profile: profile(f), homeDir: f.home, platform: process.platform })
  return { ...result, folderSource: 'name', agentsPresent: ['codex'], candidates: [] }
}

function byId(result: ScanResult, id: string): Item {
  const item = result.items.find((i) => i.id === id)
  assert.ok(item, `missing ${id}; have ${result.items.map((i) => i.id).join(', ')}`)
  return item
}

test('the project config beats the user config for plugins, MCP servers and skills', async () => {
  fx = await makeCodexFixture()
  const result = await scan(fx)
  assert.equal(result.agent, 'codex')
  assert.equal(result.projectTrusted, true)

  const tools = byId(result, 'plugin:tools@acme')
  assert.equal(tools.state, 'off', 'the user config turns it on, the project turns it off')
  assert.equal(tools.decidedBy.level, 'project')
  assert.equal(tools.decidedBy.key, 'plugins."tools@acme".enabled')
  assert.ok(tools.tokensIfOn > 0 && tools.tokens === 0)
  assert.equal(byId(result, 'plugin:quiet@acme').state, 'off')
  assert.equal(byId(result, 'plugin:quiet@acme').decidedBy.level, 'user')
  assert.equal(byId(result, 'plugin:ghost@acme').state, 'not-installed')

  const db = byId(result, 'mcp:user:db')
  assert.equal(db.state, 'off')
  assert.equal(db.decidedBy.level, 'project')
  assert.equal(db.decidedBy.key, 'mcp_servers.db.enabled')
  assert.equal(byId(result, 'mcp:user:docs').state, 'on')
  assert.equal(byId(result, 'mcp:project:local-tool').state, 'on')
  const pluginServer = byId(result, 'mcp:tools@acme:tool-server')
  assert.equal(pluginServer.state, 'off', 'a server of an off plugin is off')
  assert.equal(pluginServer.parent, 'plugin:tools@acme')
})

test('skills: user, system, repo and plugin skills, switched by [[skills.config]] rules', async () => {
  fx = await makeCodexFixture()
  const result = await scan(fx)
  const names = result.items.filter((i) => i.kind === 'skill').map((i) => i.name).sort()
  assert.deepEqual(names, ['helper-skill', 'noisy-skill', 'other-skill', 'repo-skill', 'skill-creator'], 'skills of an off plugin are not in context')
  assert.equal(byId(result, 'skill:user:helper-skill').state, 'on')
  const noisy = byId(result, 'skill:user:noisy-skill')
  assert.equal(noisy.state, 'off')
  assert.equal(noisy.decidedBy.level, 'user')
  const repoSkill = byId(result, 'skill:project:repo-skill')
  assert.equal(repoSkill.state, 'off')
  assert.equal(repoSkill.decidedBy.level, 'project')
  assert.equal(byId(result, 'skill:project:other-skill').state, 'on')
  const system = byId(result, 'skill:system:skill-creator')
  assert.equal(system.state, 'on')
  assert.equal(system.origin.level, 'builtin')
  assert.ok(system.tokens > 0)
})

test('an untrusted project: its .codex/config.toml is ignored and the rows say so', async () => {
  fx = await makeCodexFixture()
  const userConfig = path.join(fx.codexHome, 'config.toml')
  const text = await fs.readFile(userConfig, 'utf8')
  await fs.writeFile(userConfig, text.replace(/\[projects\.[^\n]*\]\ntrust_level = "trusted"\n/, ''))
  const result = await scan(fx)
  assert.equal(result.projectTrusted, false)
  assert.ok(result.warnings.some((w) => w.code === 'projectNotTrusted'))
  const tools = byId(result, 'plugin:tools@acme')
  assert.equal(tools.state, 'on', 'only the user config counts')
  assert.equal(tools.decidedBy.level, 'user')
  assert.ok(tools.notes.some((n) => n.code === 'projectNotTrusted'), 'the project entry exists but Codex does not read it')
  assert.equal(byId(result, 'mcp:user:db').state, 'on')
  assert.equal(byId(result, 'skill:project:repo-skill').state, 'on')
  // The write is still possible, and says it has no effect yet.
  const block = byId(result, 'mcp:user:docs').actions.shared.block
  assert.equal(block.allowed, true)
  assert.ok(block.notes.some((n) => n.code === 'projectNotTrusted'))
  // The plugin's own skill is listed (the plugin is on) and cannot be switched alone.
  const plug = byId(result, 'skill:tools@acme:plug-skill')
  assert.equal(plug.actions.shared.block.allowed, false)
  assert.equal(plug.actions.shared.block.notes[0].code, 'codexPluginSkillNoOverride')
})

test('a trust_level of "untrusted" is not trusted either', async () => {
  fx = await makeCodexFixture()
  const userConfig = path.join(fx.codexHome, 'config.toml')
  await fs.writeFile(userConfig, (await fs.readFile(userConfig, 'utf8')).replace('trust_level = "trusted"', 'trust_level = "untrusted"'))
  assert.equal((await scan(fx)).projectTrusted, false)
})

test('AGENTS.md: global file, root file, the override beats AGENTS.md, and project_doc_max_bytes', async () => {
  fx = await makeCodexFixture()
  const sub = path.join(fx.repo, 'sub')
  const result = await scan(fx, sub)
  const memory = result.items.filter((i) => i.kind === 'memory')
  assert.deepEqual(
    memory.map((m) => m.name),
    ['~codex/AGENTS.md', '../AGENTS.md', 'AGENTS.override.md'],
    'global first, then root down to the folder; sub/AGENTS.md is shadowed by the override in the same folder'
  )
  const [global, root, override] = memory
  assert.equal(global.origin.level, 'user')
  assert.equal(root.state, 'on')
  assert.ok(!root.notes.some((n) => n.code === 'docTruncated'))
  // 520 bytes in the fixture's user config: the root file takes ~90, the override does not fit whole.
  assert.equal(override.state, 'on')
  assert.ok(override.notes.some((n) => n.code === 'docTruncated'), 'cut at the byte limit')
  assert.ok(override.tokens < override.tokensIfOn)
  for (const m of memory) {
    assert.equal(m.actions.shared.block.allowed, false, 'Codex has no key to exclude an AGENTS.md')
    assert.equal(m.actions.shared.block.notes[0].code, 'noSwitchInCodex')
  }
  assert.equal(DEFAULT_DOC_MAX_BYTES, 32768)
})

test('a file past the limit is off, and a global AGENTS.override.md replaces AGENTS.md', async () => {
  fx = await makeCodexFixture()
  const userConfig = path.join(fx.codexHome, 'config.toml')
  await fs.writeFile(userConfig, (await fs.readFile(userConfig, 'utf8')).replace('project_doc_max_bytes = 520', 'project_doc_max_bytes = 50'))
  await fs.writeFile(path.join(fx.codexHome, 'AGENTS.override.md'), '# Temporary global override\n')
  const result = await scan(fx, path.join(fx.repo, 'sub'))
  const memory = result.items.filter((i) => i.kind === 'memory')
  assert.equal(memory[0].name, '~codex/AGENTS.override.md')
  assert.ok(!memory.some((m) => m.name === '~codex/AGENTS.md'), 'only the first non-empty global file counts')
  const root = memory.find((m) => m.name === '../AGENTS.md')
  assert.ok(root?.notes.some((n) => n.code === 'docTruncated'))
  const override = memory.find((m) => m.name === 'AGENTS.override.md')
  assert.equal(override?.state, 'off')
  assert.ok(override?.notes.some((n) => n.code === 'beyondDocLimit'))
  assert.equal(override?.tokens, 0)
})

test('sessions are the rollout files whose cwd is the folder', async () => {
  fx = await makeCodexFixture()
  const result = await scan(fx)
  assert.equal(result.sessions.count, 2)
  assert.ok(result.sessions.latestAt)
  assert.ok(result.sessions.dir.endsWith('sessions'))
})

test('Codex commands target .codex/config.toml; the personal target does not exist', async () => {
  fx = await makeCodexFixture()
  const result = await scan(fx)
  assert.deepEqual(result.targets.shared, { file: '.codex/config.toml', exists: true })
  assert.equal(result.targets.personal.file, '')
  const item = byId(result, 'mcp:user:docs')
  for (const op of ['enable', 'block', 'reset'] as const) {
    assert.equal(item.actions.personal[op].allowed, false)
    assert.equal(item.actions.personal[op].notes[0].code, 'noPersonalFile')
  }
  assert.deepEqual(item.actions.shared.block.mutations, [{ type: 'tomlSet', table: ['mcp_servers', 'docs'], key: 'enabled', value: false }])
  assert.equal(item.actions.shared.reset.allowed, false, 'the folder file has no entry for it')
})

test('through the service: the most recent agent and the active Orca account', async () => {
  fx = await makeCodexFixture()
  const service = serviceFor(fx, {
    accounts: async () => ({
      claude: { accounts: [] },
      codex: { accounts: [{ id: 'acc-1', email: 'dev@example.com', workspaceLabel: 'Team' }], activeAccountId: 'acc-1' }
    })
  })
  const input = {
    ...focusFor(fx),
    agents: [
      { terminalId: null, title: null, agent: 'claude', stateStartedAt: 100 },
      { terminalId: null, title: null, agent: 'codex', stateStartedAt: 900 }
    ]
  }
  const result = await service.scan(input)
  assert.equal(result.agent, 'codex')
  assert.equal(result.profile.source, 'orca-active')
  assert.equal(result.profile.configDir, fx.codexHome)
  assert.equal(result.profile.account, 'dev@example.com')
  assert.deepEqual(result.agentsPresent, ['claude-code', 'codex'])
  // The person's pick wins over the most recent agent.
  assert.equal((await service.scan({ ...input, agent: 'claude-code' })).agent, 'claude-code')
})
