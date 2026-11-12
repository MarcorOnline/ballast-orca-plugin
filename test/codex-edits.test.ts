// Codex commands write one key of <folder>/.codex/config.toml with targeted text edits: the diff
// is shown first, comments, order and the rest of the file stay, reset removes only the key, a
// changed file is refused, and nothing inside CODEX_HOME is ever written.
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { afterEach, assert, test } from 'orca/testing'
import { checkCodexTarget } from '../src/core/edits.ts'
import { applyTomlMutations, redactToml } from '../src/core/toml.ts'
import type { Op, WriteTarget } from '../src/model.ts'
import { type CodexFixture, makeCodexFixture, serviceFor } from './fixture.ts'

let fx: CodexFixture | undefined
afterEach(async () => {
  await fx?.cleanup()
  fx = undefined
})

const projectFile = (f: CodexFixture) => path.join(f.repo, '.codex', 'config.toml')

function edit(f: CodexFixture, itemId: string, op: Op, target: WriteTarget = 'shared') {
  return { folder: f.repo, agent: 'codex' as const, configDir: f.codexHome, itemId, op, target }
}

async function write(f: CodexFixture, itemId: string, op: Op) {
  const s = serviceFor(f)
  const plan = await s.plan(edit(f, itemId, op))
  assert.ok(plan.ok && plan.baseHash, `plan ${itemId} ${op}: ${JSON.stringify(plan)}`)
  const done = await s.apply({ ...edit(f, itemId, op), baseHash: plan.baseHash })
  assert.ok(done.ok, JSON.stringify(done))
  return { plan, text: await fs.readFile(projectFile(f), 'utf8') }
}

test('blocking a server with no table in the project file appends one table and changes nothing else', async () => {
  fx = await makeCodexFixture()
  const before = await fs.readFile(projectFile(fx), 'utf8')
  const { plan, text } = await write(fx, 'mcp:user:docs', 'block')
  assert.ok(text.startsWith(before), 'every existing byte, comments and order included, stays first')
  assert.equal(text.slice(before.length), '\n[mcp_servers.docs]\nenabled = false\n')
  assert.match(plan.diff ?? '', /\+\[mcp_servers\.docs\]/)
  assert.match(plan.diff ?? '', /\+enabled = false/)
  assert.equal(plan.relFile, '.codex/config.toml')
  assert.equal(plan.created, false)
})

test('enable changes only the value and keeps the trailing comment', async () => {
  fx = await makeCodexFixture()
  const before = await fs.readFile(projectFile(fx), 'utf8')
  const { text } = await write(fx, 'mcp:user:db', 'enable')
  assert.ok(text.includes('[mcp_servers.db]   # tightened for this repo\nenabled = true\n'), text)
  assert.ok(text.includes('# Project overrides for Codex.\n# Keep this comment and the order of the tables.'))
  assert.equal(text, before.replace('# tightened for this repo\nenabled = false', '# tightened for this repo\nenabled = true'), 'only that value moved')
})

test('a missing key goes at the end of its table; secrets in that table are untouched', async () => {
  fx = await makeCodexFixture()
  const before = await fs.readFile(projectFile(fx), 'utf8')
  const { text } = await write(fx, 'mcp:project:local-tool', 'block')
  assert.ok(text.includes('env = { API_KEY = "SECRET_inline_env" }\nenabled = false\n'), text)
  assert.equal(text, before.replace('env = { API_KEY = "SECRET_inline_env" }\n', 'env = { API_KEY = "SECRET_inline_env" }\nenabled = false\n'))
})

test('reset removes only the key, not the table or its comment', async () => {
  fx = await makeCodexFixture()
  const before = await fs.readFile(projectFile(fx), 'utf8')
  const { text } = await write(fx, 'plugin:tools@acme', 'reset')
  assert.equal(text, before.replace('enabled = false  # off here\n', ''))
  assert.ok(text.includes('[plugins."tools@acme"]\n'), 'the table stays')
})

test('skill rules: block appends an entry, enable flips it, reset drops the entry Ballast wrote', async () => {
  fx = await makeCodexFixture()
  const before = await fs.readFile(projectFile(fx), 'utf8')
  const blocked = await write(fx, 'skill:project:other-skill', 'block')
  assert.equal(blocked.text, before + '\n[[skills.config]]\nname = "other-skill"\nenabled = false\n')
  const enabled = await write(fx, 'skill:project:repo-skill', 'enable')
  assert.ok(enabled.text.includes('name = "repo-skill"\nenabled = true\n'))
  const reset = await write(fx, 'skill:project:other-skill', 'reset')
  assert.ok(!reset.text.includes('other-skill'))
  assert.ok(reset.text.includes('name = "repo-skill"'), 'the other rule stays')
})

test('a project without .codex/config.toml gets one', async () => {
  fx = await makeCodexFixture()
  await fs.rm(path.join(fx.repo, '.codex'), { recursive: true })
  const s = serviceFor(fx)
  const plan = await s.plan(edit(fx, 'plugin:quiet@acme', 'enable'))
  assert.ok(plan.ok && plan.created)
  await s.apply({ ...edit(fx, 'plugin:quiet@acme', 'enable'), baseHash: plan.baseHash ?? '' })
  assert.equal(await fs.readFile(projectFile(fx), 'utf8'), '[plugins."quiet@acme"]\nenabled = true\n')
})

test('CRLF files keep their line endings', async () => {
  fx = await makeCodexFixture()
  const crlf = '# keep\r\n[mcp_servers.db]\r\nenabled = false\r\n'
  await fs.writeFile(projectFile(fx), crlf)
  const out = applyTomlMutations(crlf, [
    { type: 'tomlSet', table: ['mcp_servers', 'docs'], key: 'enabled', value: false },
    { type: 'tomlSet', table: ['mcp_servers', 'db'], key: 'enabled', value: true }
  ])
  assert.equal(out, '# keep\r\n[mcp_servers.db]\r\nenabled = true\r\n\r\n[mcp_servers.docs]\r\nenabled = false\r\n')
})

test('a plan goes stale when the file changes before confirming', async () => {
  fx = await makeCodexFixture()
  const s = serviceFor(fx)
  const plan = await s.plan(edit(fx, 'mcp:user:docs', 'block'))
  assert.ok(plan.ok && plan.baseHash)
  const changed = (await fs.readFile(projectFile(fx), 'utf8')) + '# someone else edited this\n'
  await fs.writeFile(projectFile(fx), changed)
  const done = await s.apply({ ...edit(fx, 'mcp:user:docs', 'block'), baseHash: plan.baseHash })
  assert.equal(done.ok, false)
  assert.equal(done.error?.code, 'fileChanged')
  assert.equal(await fs.readFile(projectFile(fx), 'utf8'), changed, 'nothing was written')
})

test('there is no personal target for Codex', async () => {
  fx = await makeCodexFixture()
  const plan = await serviceFor(fx).plan(edit(fx, 'mcp:user:docs', 'block', 'personal'))
  assert.equal(plan.ok, false)
  assert.equal(plan.error?.code, 'noPersonalFile')
})

test('nothing inside CODEX_HOME is ever written, even when it is the folder', async () => {
  fx = await makeCodexFixture()
  // The person opened CODEX_HOME itself as a workspace: <home>/.codex/config.toml is inside it.
  const s = serviceFor(fx, { listWorkspaces: async () => [] })
  const folder = fx.codexHome
  const plan = await s.plan({ folder, agent: 'codex', configDir: fx.codexHome, itemId: 'plugin:quiet@acme', op: 'enable', target: 'shared' })
  assert.equal(plan.ok, false)
  assert.equal(plan.error?.code, 'userTargetRefused')
  await assert.rejects(fs.stat(path.join(folder, '.codex')), /ENOENT/) // no .codex folder appeared in CODEX_HOME

  const forbidden = { codexHome: fx.codexHome, homeDir: fx.home, orcaHomes: [path.join(fx.orcaData, 'codex-accounts')] }
  assert.equal((await checkCodexTarget(path.join(fx.codexHome, 'config.toml'), fx.codexHome, forbidden))?.code, 'userTargetRefused')
  assert.equal((await checkCodexTarget(path.join(fx.home, '.codex', 'config.toml'), fx.home, forbidden))?.code, 'userTargetRefused', '~/.codex')
  assert.equal((await checkCodexTarget(path.join(fx.orcaData, 'codex-accounts', 'acc-2', 'home', '.codex', 'config.toml'), path.join(fx.orcaData, 'codex-accounts', 'acc-2', 'home'), forbidden))?.code, 'userTargetRefused', "another managed account's home")
  assert.equal(await checkCodexTarget(projectFile(fx), fx.repo, forbidden), null, 'the project file is fine')
  assert.equal((await checkCodexTarget(path.join(fx.repo, 'other', 'config.toml'), fx.repo, forbidden))?.code, 'userTargetRefused', 'only <folder>/.codex/config.toml')
})

test('a table defined with dotted keys or an inline table is refused, not rewritten', async () => {
  fx = await makeCodexFixture()
  const odd = '[plugins]\n"quiet@acme".enabled = false\n'
  await fs.writeFile(projectFile(fx), odd)
  const plan = await serviceFor(fx).plan(edit(fx, 'plugin:quiet@acme', 'enable'))
  assert.equal(plan.ok, false)
  assert.equal(plan.error?.code, 'tomlUnsupported')
  assert.equal(applyTomlMutations('mcp_servers = { docs = { enabled = true } }\n', [{ type: 'tomlSet', table: ['mcp_servers', 'docs'], key: 'enabled', value: false }]), null)
  assert.equal(await fs.readFile(projectFile(fx), 'utf8'), odd)
})

test('a broken config.toml is reported, not overwritten', async () => {
  fx = await makeCodexFixture()
  await fs.writeFile(projectFile(fx), '[mcp_servers.db\nenabled = true\n')
  const plan = await serviceFor(fx).plan(edit(fx, 'mcp:user:docs', 'block'))
  assert.equal(plan.ok, false)
  assert.equal(plan.error?.code, 'readError')
})

test('the diff hides every value but booleans and a skill rule name', async () => {
  const text = [
    '[mcp_servers.x]',
    'url = "https://SECRET_u:SECRET_p@host/"',
    'args = ["--token=SECRET_a",',
    '  "second"]',
    'note = """',
    'SECRET_multi',
    '"""',
    'enabled = false # keep',
    '[mcp_servers.x.env]',
    "TOKEN = 'SECRET_literal'",
    '[[skills.config]]',
    'name = "visible-name"',
    'path = "C:/SECRET_path/SKILL.md"',
    'enabled = true',
    ''
  ].join('\n')
  const out = redactToml(text)
  assert.ok(!out.includes('SECRET_'), out)
  assert.ok(out.includes('enabled = false # keep'))
  assert.ok(out.includes('name = "visible-name"'))
  assert.ok(out.includes('[mcp_servers.x.env]') && out.includes('TOKEN = "…"'))
})
