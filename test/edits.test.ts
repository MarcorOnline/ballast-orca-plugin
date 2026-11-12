// Writing: every command changes one key of one project file and leaves the rest byte for byte,
// shows a diff first, refuses stale plans and never touches user-level files.
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { afterEach, assert, test } from 'orca/testing'
import { applyMutations, checkTarget, redactJson } from '../src/core/edits.ts'
import { parseJsonObject } from '../src/core/fsx.ts'
import { stateFilePath } from '../src/core/state.ts'
import { type Fixture, makeFixture, focusFor, serviceFor } from './fixture.ts'

let fx: Fixture | undefined
afterEach(async () => {
  await fx?.cleanup()
  fx = undefined
})

function service(f: Fixture) {
  return serviceFor(f)
}

const sharedFile = (f: Fixture) => path.join(f.repo, '.claude', 'settings.json')
const localFile = (f: Fixture) => path.join(f.repo, '.claude', 'settings.local.json')

test('blocking a connector adds one entry and keeps every other byte, CRLF and 4-space indent', async () => {
  fx = await makeFixture()
  const before = await fs.readFile(sharedFile(fx), 'utf8')
  const s = service(fx)
  const input = {
    folder: fx.repo,
    agent: 'claude-code' as const, configDir: fx.config,
    itemId: 'connector:session:claude.ai Gmail',
    op: 'block' as const,
    target: 'shared' as const
  }
  const plan = await s.plan(input)
  assert.equal(plan.ok, true, JSON.stringify(plan.error))
  assert.match(plan.diff ?? '', /\+\s+"serverName": "claude\.ai Gmail"/)
  assert.equal(await fs.readFile(sharedFile(fx), 'utf8'), before, 'planning writes nothing')

  const applied = await s.apply({ ...input, baseHash: plan.baseHash ?? '' })
  assert.equal(applied.ok, true)
  const after = await fs.readFile(sharedFile(fx), 'utf8')

  const was = parseJsonObject(before)
  const now = parseJsonObject(after)
  assert.ok(was && now)
  assert.deepEqual(now.deniedMcpServers, [{ serverName: 'claude.ai Gmail' }])
  delete now.deniedMcpServers
  assert.deepEqual(now, was, 'nothing else changed')
  assert.ok(!/[^\r]\n/.test(after), 'still CRLF everywhere')
  assert.ok(after.startsWith(before.slice(0, before.lastIndexOf('}') - 3)), 'the original text is a prefix')
  assert.match(after, /\r\n {4}"deniedMcpServers": \[\r\n {8}\{\r\n {12}"serverName": "claude\.ai Gmail"/)
})

test('torna al default removes only that key; enable flips only its value', async () => {
  fx = await makeFixture()
  const s = service(fx)
  const base = { folder: fx.repo, agent: 'claude-code' as const, configDir: fx.config, target: 'personal' as const }

  const reset = await s.plan({ ...base, itemId: 'plugin:noisy@acme', op: 'reset' })
  assert.equal(reset.ok, true)
  await s.apply({ ...base, itemId: 'plugin:noisy@acme', op: 'reset', baseHash: reset.baseHash ?? '' })
  const afterReset = parseJsonObject(await fs.readFile(localFile(fx), 'utf8'))
  assert.deepEqual(afterReset, {
    enabledPlugins: {},
    enabledMcpjsonServers: ['proj-db'],
    skillOverrides: { 'my-skill': 'off' }
  })

  const enable = await s.plan({ ...base, itemId: 'skill:user:my-skill', op: 'enable' })
  await s.apply({ ...base, itemId: 'skill:user:my-skill', op: 'enable', baseHash: enable.baseHash ?? '' })
  const text = await fs.readFile(localFile(fx), 'utf8')
  assert.match(text, /"my-skill": "on"/)
  assert.match(text, /"enabledMcpjsonServers": \["proj-db"\]/, 'untouched keys keep their inline form')
})

test('a plan goes stale when the file changes before confirming', async () => {
  fx = await makeFixture()
  const s = service(fx)
  const input = { folder: fx.repo, agent: 'claude-code' as const, configDir: fx.config, itemId: 'plugin:helper@acme', op: 'block' as const, target: 'shared' as const }
  const plan = await s.plan(input)
  await fs.appendFile(sharedFile(fx), ' ')
  const applied = await s.apply({ ...input, baseHash: plan.baseHash ?? '' })
  assert.equal(applied.ok, false)
  assert.equal(applied.error?.code, 'fileChanged')
})

test('creates .claude/settings.local.json when missing', async () => {
  fx = await makeFixture()
  await fs.rm(localFile(fx))
  const s = service(fx)
  const input = { folder: fx.repo, agent: 'claude-code' as const, configDir: fx.config, itemId: 'plugin:docs@acme', op: 'block' as const, target: 'personal' as const }
  const plan = await s.plan(input)
  assert.equal(plan.created, true)
  await s.apply({ ...input, baseHash: plan.baseHash ?? '' })
  assert.deepEqual(parseJsonObject(await fs.readFile(localFile(fx), 'utf8')), {
    enabledPlugins: { 'docs@acme': false }
  })
})

test('never writes user-level files, even when the folder is the home whose .claude is the config', async () => {
  fx = await makeFixture()
  const forbidden = {
    agent: 'claude-code' as const, configDir: fx.config,
    homeDir: fx.home,
    stateFile: stateFilePath(fx.config, fx.home),
    managedFile: fx.env.managedSettingsFile
  }
  const userFile = path.join(fx.config, 'settings.json')
  const parentOfConfig = path.dirname(fx.config)
  // A folder whose .claude would be the config dir itself.
  await fs.mkdir(path.join(fx.home, '.claude'), { recursive: true })
  assert.equal((await checkTarget(path.join(fx.home, '.claude', 'settings.json'), fx.home, forbidden))?.code, 'userTargetRefused')
  assert.equal((await checkTarget(userFile, parentOfConfig, forbidden))?.code, 'userTargetRefused')
  assert.equal(await checkTarget(path.join(fx.repo, '.claude', 'settings.json'), fx.repo, forbidden), null)

  const s = service(fx)
  const userBefore = await fs.readFile(userFile, 'utf8')
  const stateBefore = await fs.readFile(path.join(fx.config, '.claude.json'), 'utf8')
  for (const target of ['shared', 'personal'] as const) {
    for (const op of ['enable', 'block', 'reset'] as const) {
      const plan = await s.plan({ folder: fx.repo, agent: 'claude-code' as const, configDir: fx.config, itemId: 'plugin:helper@acme', op, target })
      if (plan.ok) await s.apply({ folder: fx.repo, agent: 'claude-code' as const, configDir: fx.config, itemId: 'plugin:helper@acme', op, target, baseHash: plan.baseHash ?? '' })
    }
  }
  assert.equal(await fs.readFile(userFile, 'utf8'), userBefore)
  assert.equal(await fs.readFile(path.join(fx.config, '.claude.json'), 'utf8'), stateBefore)
})

test('commands the platform does not support are refused with the alternative', async () => {
  fx = await makeFixture()
  const s = service(fx)
  const plan = await s.plan({ folder: fx.repo, agent: 'claude-code' as const, configDir: fx.config, itemId: 'skill:azure@acme:azure-deploy', op: 'block', target: 'shared' })
  assert.equal(plan.ok, false)
  assert.equal(plan.error?.code, 'pluginSkillNoOverride')
  assert.equal(plan.error?.args?.plugin, 'azure@acme')
  const toggled = await s.plan({ folder: fx.repo, agent: 'claude-code' as const, configDir: fx.config, itemId: 'mcp:local:local-tool', op: 'enable', target: 'personal' })
  assert.equal(toggled.error?.code, 'disabledByMcpToggle')
})

test('applyMutations handles a missing parent, a tab-indented file and array removal', () => {
  const tabbed = '{\n\t"model": "x"\n}\n'
  const added = applyMutations(tabbed, [{ type: 'arrayAdd', path: ['permissions', 'deny'], value: 'mcp__a__*' }])
  assert.equal(added, '{\n\t"model": "x",\n\t"permissions": {\n\t\t"deny": [\n\t\t\t"mcp__a__*"\n\t\t]\n\t}\n}\n')
  const removed = applyMutations(added ?? '', [{ type: 'arrayRemove', path: ['permissions', 'deny'], value: 'mcp__a__*' }])
  assert.equal(removed, '{\n\t"model": "x",\n\t"permissions": {\n\t\t"deny": []\n\t}\n}\n')
  assert.equal(redactJson('{"env":{"K":"v"},"enabledPlugins":{"a@b":true}}'), '{"env":{"K":"…"},"enabledPlugins":{"a@b":true}}')
})
