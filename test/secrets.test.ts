// Ballast reads files full of tokens, env values, headers and credentialed URLs. Nothing it
// returns, previews, logs or stores may contain one. Every planted secret starts with SECRET_.
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import { OPS, WRITE_TARGETS } from '../src/model.ts'
import * as main from '../src/worker.ts'
import { type Fixture, focusFor, makeCodexFixture, makeFixture, pointWorkerAt, SECRET_MARK, serviceFor, workspaceFor } from './fixture.ts'

/** The Codex fixture's home is Orca's managed account acc-1, which the scan finds as the active one. */
const activeCodexAccount = { claude: { accounts: [] }, codex: { accounts: [{ id: 'acc-1' }], activeAccountId: 'acc-1' } }

let fx: Fixture | undefined
let restoreEnv: (() => void) | undefined
afterEach(async () => {
  restoreEnv?.()
  restoreEnv = undefined
  await fx?.cleanup()
  fx = undefined
})

test('scan output and every diff preview are free of secrets', async () => {
  fx = await makeFixture()
  const stored = new Map<string, unknown>()
  const s = serviceFor(fx, { store: { get: async (k) => stored.get(k) ?? null, set: async (k, v) => void stored.set(k, v) } })
  const result = await s.scan(focusFor(fx))
  const scanText = JSON.stringify(result)
  assert.ok(!scanText.includes(SECRET_MARK), 'scan leaks: ' + scanText.slice(scanText.indexOf(SECRET_MARK) - 80, scanText.indexOf(SECRET_MARK) + 40))
  assert.ok(!scanText.includes('api.example.com'), 'no configured URL reaches the panel')
  assert.ok(!scanText.includes('db.js'), 'no configured command reaches the panel')

  let previews = 0
  for (const item of result.items) {
    for (const target of WRITE_TARGETS) {
      for (const op of OPS) {
        const plan = await s.plan({ folder: fx.repo, agent: 'claude-code' as const, configDir: fx.config, itemId: item.id, op, target })
        const text = JSON.stringify(plan)
        assert.ok(!text.includes(SECRET_MARK), `${item.id} ${op} ${target} leaks: ${text}`)
        if (plan.ok) previews++
      }
    }
  }
  assert.ok(previews > 10, 'the loop really planned edits')
  assert.ok(!JSON.stringify([...stored.values()]).includes(SECRET_MARK), 'storage holds names only')
})

test('the worker answers, posts, stores and logs nothing secret', async () => {
  fx = await makeFixture()
  // No Orca CLI here: the worker falls back to the disk and never spawns the real one.
  process.env.ORCA_CLI_COMMAND = 'ballast-no-such-command'
  restoreEnv = pointWorkerAt(fx)
  const host = mockHost({ results: { 'workspace.list': { workspaces: [workspaceFor(fx)], truncated: false } } })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('ballast.scan', focusFor(fx))
  const item = result.items.find((i) => i.id === 'mcp:user:remote-api')
  assert.ok(item)
  const plan = await worker.request('ballast.plan', { folder: fx.repo, agent: 'claude-code', configDir: fx.config, itemId: item.id, op: 'block', target: 'shared' })
  const everything = JSON.stringify([result, plan, worker.posts, worker.logs, host.data(), host.calls])
  assert.ok(!everything.includes(SECRET_MARK))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('applyBatch and undo outputs over the fixture contain no secret', async () => {
  fx = await makeFixture()
  const f = fx
  const s = serviceFor(f)
  const scan = await s.scan(focusFor(f))
  const items = scan.items.flatMap((i) =>
    OPS.flatMap((op) => WRITE_TARGETS.map((target) => ({ folder: f.repo, agent: 'claude-code' as const, configDir: f.config, itemId: i.id, op, target })))
  )
  const out = await s.applyBatch({ items })
  assert.ok(out.writes.length > 0, 'the batch really wrote')
  const undone = []
  for (const w of out.writes) undone.push(await s.undo({ undoId: w.undoId }))
  const text = JSON.stringify([out, undone])
  assert.ok(!text.includes(SECRET_MARK), 'leaks: ' + text.slice(Math.max(0, text.indexOf(SECRET_MARK) - 80), text.indexOf(SECRET_MARK) + 40))

  const cx = await makeCodexFixture()
  try {
    const cs = serviceFor(cx, { accounts: async () => activeCodexAccount })
    const cscan = await cs.scan(focusFor(cx, 'codex'))
    const citems = cscan.items.flatMap((i) => OPS.map((op) => ({ folder: cx.repo, agent: 'codex' as const, configDir: cx.codexHome, itemId: i.id, op, target: 'shared' as const })))
    const cout = await cs.applyBatch({ items: citems })
    assert.ok(cout.writes.length > 0)
    const cundone = []
    for (const w of cout.writes) cundone.push(await cs.undo({ undoId: w.undoId }))
    assert.ok(!JSON.stringify([cout, cundone]).includes(SECRET_MARK))
  } finally {
    await cx.cleanup()
  }
})

// ---------------------------------------------------------------- Codex

test('Codex: scan output, every plan and diff, storage, logs and posts are free of secrets', async () => {
  const cx = await makeCodexFixture()
  try {
    // The fixture plants secrets in URLs, headers, env tables, args, inline tables and a plugin's .mcp.json.
    const planted = (await fs.readFile(path.join(cx.repo, '.codex', 'config.toml'), 'utf8')) + (await fs.readFile(path.join(cx.codexHome, 'config.toml'), 'utf8'))
    assert.ok(planted.includes(SECRET_MARK), 'the fixture really holds secrets')

    process.env.ORCA_CLI_COMMAND = 'ballast-no-such-command'
    const stored = new Map<string, unknown>()
    const s = serviceFor(cx, { accounts: async () => activeCodexAccount, store: { get: async (k) => stored.get(k) ?? null, set: async (k, v) => void stored.set(k, v) } })
    const input = focusFor(cx, 'codex')
    const result = await s.scan(input)
    assert.equal(result.agent, 'codex')
    const scanText = JSON.stringify(result)
    assert.ok(!scanText.includes(SECRET_MARK), 'scan leaks: ' + scanText.slice(Math.max(0, scanText.indexOf(SECRET_MARK) - 80), scanText.indexOf(SECRET_MARK) + 40))
    for (const hidden of ['mcp.example.com', 'db.js', 'srv.js']) assert.ok(!scanText.includes(hidden), `no configured URL, command or argument (${hidden}) reaches the panel`)

    let previews = 0
    for (const item of result.items) {
      for (const target of WRITE_TARGETS) {
        for (const op of OPS) {
          const plan = await s.plan({ folder: cx.repo, agent: 'codex' as const, configDir: cx.codexHome, itemId: item.id, op, target })
          const text = JSON.stringify(plan)
          assert.ok(!text.includes(SECRET_MARK), `${item.id} ${op} ${target} leaks: ${text}`)
          if (plan.ok) previews++
        }
      }
    }
    assert.ok(previews > 8, 'the loop really planned edits')
    assert.ok(!JSON.stringify([...stored.values()]).includes(SECRET_MARK), 'storage holds names only')

    // And through the worker: answers, posts, logs, storage and host calls.
    restoreEnv = pointWorkerAt({ orcaData: cx.orcaData, codexHome: cx.codexHome })
    const host = mockHost({ results: { 'workspace.list': { workspaces: [workspaceFor(cx)], truncated: false } } })
    const worker = await mountWorker(main, { host })
    const viaWorker = await worker.request('ballast.scan', input)
    const item = viaWorker.items.find((i) => i.id === 'mcp:user:docs')
    assert.ok(item)
    const plan = await worker.request('ballast.plan', { folder: cx.repo, agent: 'codex', configDir: cx.codexHome, itemId: item.id, op: 'block', target: 'shared' })
    assert.ok(plan.ok)
    await worker.emit('agent.status.changed', { workspaceId: workspaceFor(cx).id, paneKey: 'p', terminalId: 'term_1', state: 'working', receivedAt: 1 })
    await worker.hooks.fire('agent.launch.before', { agent: 'codex', workspaceId: workspaceFor(cx).id, workspaceKind: 'worktree', terminalId: 'term_1', command: 'codex', env: { CODEX_HOME: cx.codexHome, OPENAI_API_KEY: 'SECRET_openai' } })
    await worker.deactivate()
    const everything = JSON.stringify([viaWorker, plan, worker.posts, worker.logs, host.data(), host.calls])
    assert.ok(!everything.includes(SECRET_MARK))
    assert.deepEqual(worker.refusals, [])
  } finally {
    await cx.cleanup()
  }
})
