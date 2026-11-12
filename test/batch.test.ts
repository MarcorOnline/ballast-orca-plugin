// Batch writes: many items into one file with one atomic write, per-item failures that do not
// stop the others, undo that restores byte for byte (and refuses after an outside change), and the
// same guarantees as a single write: only the project file of the folder, never a user-level one.
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { afterEach, assert, test } from 'orca/testing'
import { parseJsonObject } from '../src/core/fsx.ts'
import type { Op, WriteTarget } from '../src/model.ts'
import { type CodexFixture, type Fixture, focusFor, makeCodexFixture, makeFixture, serviceFor } from './fixture.ts'

let fx: Fixture | undefined
let cx: CodexFixture | undefined
afterEach(async () => {
  await fx?.cleanup()
  await cx?.cleanup()
  fx = undefined
  cx = undefined
})

const sharedFile = (f: Fixture) => path.join(f.repo, '.claude', 'settings.json')

function edit(f: Fixture, itemId: string, op: Op, target: WriteTarget = 'shared') {
  return { folder: f.repo, agent: 'claude-code' as const, configDir: f.config, itemId, op, target }
}

test('several items go into one file with exactly one write, every other byte kept (CRLF)', async () => {
  fx = await makeFixture()
  const before = await fs.readFile(sharedFile(fx), 'utf8')
  const s = serviceFor(fx)
  const out = await s.applyBatch({
    items: [
      edit(fx, 'plugin:helper@acme', 'block'),
      edit(fx, 'connector:session:claude.ai Gmail', 'block'),
      edit(fx, 'plugin:docs@acme', 'block')
    ]
  })
  assert.deepEqual(out.results.map((r) => r.ok), [true, true, true], JSON.stringify(out.results))
  assert.equal(out.writes.length, 1, 'one write for one file')
  assert.equal(out.writes[0].count, 3)
  assert.equal(out.writes[0].relFile, '.claude/settings.json')

  const after = await fs.readFile(sharedFile(fx), 'utf8')
  const was = parseJsonObject(before)
  const now = parseJsonObject(after)
  assert.ok(was && now)
  // Parse equals the original plus the changes.
  const expected = structuredClone(was)
  expected.deniedMcpServers = [{ serverName: 'claude.ai Gmail' }]
  expected.enabledPlugins = { ...(expected.enabledPlugins as object), 'helper@acme': false, 'docs@acme': false }
  assert.deepEqual(now, expected)
  assert.ok(!/[^\r]\n/.test(after), 'still CRLF everywhere')
  assert.ok(out.writes[0].diff.includes('docs@acme'))
})

test('a mixed batch reports each item: the allowed ones are written, the others say why', async () => {
  fx = await makeFixture()
  const s = serviceFor(fx)
  const out = await s.applyBatch({
    items: [
      edit(fx, 'plugin:helper@acme', 'block'),
      edit(fx, 'skill:azure@acme:azure-deploy', 'block'),
      edit(fx, 'plugin:nope@nowhere', 'block')
    ]
  })
  assert.deepEqual(
    out.results.map((r) => [r.itemId, r.ok]),
    [
      ['plugin:helper@acme', true],
      ['skill:azure@acme:azure-deploy', false],
      ['plugin:nope@nowhere', false]
    ]
  )
  assert.equal(out.results[1].error?.code, 'pluginSkillNoOverride')
  assert.equal(out.results[2].error?.code, 'notInProject')
  assert.equal(out.writes.length, 1)
  assert.equal(out.writes[0].count, 1)
  const now = parseJsonObject(await fs.readFile(sharedFile(fx), 'utf8'))
  assert.equal((now?.enabledPlugins as Record<string, unknown>)['helper@acme'], false)
})

test('a batch with nothing to write changes nothing and returns no write', async () => {
  fx = await makeFixture()
  const before = await fs.readFile(sharedFile(fx), 'utf8')
  const out = await serviceFor(fx).applyBatch({ items: [edit(fx, 'skill:azure@acme:azure-deploy', 'block')] })
  assert.equal(out.writes.length, 0)
  assert.equal(out.results[0].ok, false)
  assert.equal(await fs.readFile(sharedFile(fx), 'utf8'), before)
})

test('undo restores the file byte for byte, and only once', async () => {
  fx = await makeFixture()
  const before = await fs.readFile(sharedFile(fx), 'utf8')
  const s = serviceFor(fx)
  const out = await s.applyBatch({ items: [edit(fx, 'plugin:helper@acme', 'block'), edit(fx, 'plugin:docs@acme', 'block')] })
  assert.notEqual(await fs.readFile(sharedFile(fx), 'utf8'), before)
  const undone = await s.undo({ undoId: out.writes[0].undoId })
  assert.equal(undone.ok, true, JSON.stringify(undone))
  assert.equal(await fs.readFile(sharedFile(fx), 'utf8'), before)
  assert.equal((await s.undo({ undoId: out.writes[0].undoId })).error?.code, 'undoGone')
})

test('undo refuses after the file changed elsewhere, and deletes a file the batch created', async () => {
  fx = await makeFixture()
  const s = serviceFor(fx)
  const out = await s.applyBatch({ items: [edit(fx, 'plugin:helper@acme', 'block')] })
  await fs.appendFile(sharedFile(fx), '\n')
  const changed = await fs.readFile(sharedFile(fx), 'utf8')
  const refused = await s.undo({ undoId: out.writes[0].undoId })
  assert.equal(refused.ok, false)
  assert.equal(refused.error?.code, 'fileChanged')
  assert.equal(await fs.readFile(sharedFile(fx), 'utf8'), changed, 'nothing was touched')

  const local = path.join(fx.repo, '.claude', 'settings.local.json')
  await fs.rm(local)
  const created = await s.applyBatch({ items: [edit(fx, 'plugin:docs@acme', 'block', 'personal')] })
  assert.equal(created.writes.length, 1)
  assert.ok(await fs.stat(local))
  assert.equal((await s.undo({ undoId: created.writes[0].undoId })).ok, true)
  // The file did not exist before the batch: undo removes it.
  await assert.rejects(fs.stat(local))
})

test('only the last 10 writes can be undone', async () => {
  fx = await makeFixture()
  const s = serviceFor(fx)
  const ids: string[] = []
  for (let i = 0; i < 11; i++) {
    const op: Op = i % 2 === 0 ? 'block' : 'reset'
    const out = await s.applyBatch({ items: [edit(fx, 'plugin:helper@acme', op)] })
    assert.equal(out.writes.length, 1, `write ${i}: ${JSON.stringify(out.results)}`)
    ids.push(out.writes[0].undoId)
  }
  assert.equal((await s.undo({ undoId: ids[0] })).error?.code, 'undoGone')
  assert.equal((await s.undo({ undoId: ids[10] })).ok, true)
})

test('a batch never writes user-level files', async () => {
  fx = await makeFixture()
  const userFile = path.join(fx.config, 'settings.json')
  const stateFile = path.join(fx.config, '.claude.json')
  const userBefore = await fs.readFile(userFile, 'utf8')
  const stateBefore = await fs.readFile(stateFile, 'utf8')
  const s = serviceFor(fx)
  const repo = fx.repo
  const scan = await s.scan(focusFor(fx))
  const f = fx
  const items = scan.items.flatMap((i) => (['enable', 'block', 'reset'] as const).flatMap((op) => (['shared', 'personal'] as const).map((target) => edit(f, i.id, op, target))))
  const out = await s.applyBatch({ items })
  assert.ok(out.writes.length > 0)
  for (const w of out.writes) assert.ok(w.file.startsWith(path.join(repo, '.claude')), w.file)
  assert.equal(await fs.readFile(userFile, 'utf8'), userBefore)
  assert.equal(await fs.readFile(stateFile, 'utf8'), stateBefore)
})

test('a batch aimed at the home folder writes nothing, even with a .claude there', async () => {
  fx = await makeFixture()
  const s = serviceFor(fx)
  await fs.mkdir(path.join(fx.home, '.claude'), { recursive: true })
  const out = await s.applyBatch({ items: [{ ...edit(fx, 'plugin:helper@acme', 'block'), folder: fx.home }] })
  assert.equal(out.writes.length, 0)
  assert.equal(out.results[0].ok, false)
  await assert.rejects(fs.stat(path.join(fx.home, '.claude', 'settings.json')))
})

test('Codex: a batch writes only <folder>/.codex/config.toml, in one write, and undo restores it', async () => {
  cx = await makeCodexFixture()
  const c = cx
  const file = path.join(c.repo, '.codex', 'config.toml')
  const before = await fs.readFile(file, 'utf8')
  const homeBefore = await fs.readFile(path.join(c.codexHome, 'config.toml'), 'utf8')
  const s = serviceFor(c)
  const codex = (itemId: string, op: Op) => ({ folder: c.repo, agent: 'codex' as const, configDir: c.codexHome, itemId, op, target: 'shared' as const })
  const out = await s.applyBatch({ items: [codex('mcp:user:docs', 'block'), codex('mcp:user:db', 'enable')] })
  assert.deepEqual(out.results.map((r) => r.ok), [true, true], JSON.stringify(out.results))
  assert.equal(out.writes.length, 1)
  assert.equal(out.writes[0].file, file)
  assert.equal(out.writes[0].relFile, '.codex/config.toml')
  const after = await fs.readFile(file, 'utf8')
  assert.ok(after.startsWith('# Project overrides for Codex.'))
  assert.match(after, /\[mcp_servers\.docs\]\nenabled = false/)
  assert.equal(await fs.readFile(path.join(c.codexHome, 'config.toml'), 'utf8'), homeBefore, 'CODEX_HOME untouched')
  assert.equal((await s.undo({ undoId: out.writes[0].undoId })).ok, true)
  assert.equal(await fs.readFile(file, 'utf8'), before)
})
