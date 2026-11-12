// The worker watches agent events and two hooks to learn which workspace a terminal or an agent
// belongs to. The hooks only observe: they pass the event on at once, unchanged, and keep only
// CLAUDE_CONFIG_DIR and CODEX_HOME out of an agent's env.
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import { MEMORY_KEY } from '../src/core/memory-store.ts'
import * as main from '../src/worker.ts'
import { type Fixture, focusFor, makeFixture, workspaceFor } from './fixture.ts'

let fx: Fixture | undefined
afterEach(async () => {
  await fx?.cleanup()
  fx = undefined
})

// No Orca CLI in tests: the worker falls back to the disk and never spawns the real one.
process.env.ORCA_CLI_COMMAND = 'ballast-no-such-command'

const WS = 'repo1::C:/work/a'
const launch = (env: Record<string, string>) => ({
  agent: 'claude',
  workspaceId: WS,
  workspaceKind: 'worktree' as const,
  terminalId: 'term_7',
  command: 'claude',
  env
})

function stored(host: { data(): { storage?: Record<string, unknown> } }): { terminals: unknown[]; observations: unknown[]; launches: Record<string, unknown>[] } {
  return (host.data().storage?.[MEMORY_KEY] as never) ?? { terminals: [], observations: [], launches: [] }
}

test('agent.launch.before passes at once, unchanged, and keeps only the two home variables', async () => {
  const host = mockHost({ results: { 'workspace.list': { workspaces: [], truncated: false } } })
  const worker = await mountWorker(main, { host })
  const event = launch({
    CLAUDE_CONFIG_DIR: 'C:/orca/claude-profiles/a/home',
    CODEX_HOME: 'C:/orca/codex-accounts/c/home',
    ANTHROPIC_API_KEY: 'SECRET_key',
    GITHUB_TOKEN: 'SECRET_token',
    PATH: '/usr/bin'
  })
  const copy = JSON.parse(JSON.stringify(event))
  const started = Date.now()
  const decision = await worker.hooks.fire('agent.launch.before', event)
  assert.ok(Date.now() - started < 100, 'nothing slow happens before the answer')
  assert.equal(decision.kind, 'continue')
  assert.deepEqual(decision.kind === 'continue' && decision.event, copy, 'the event is passed on unchanged, env included')
  assert.deepEqual(stored(host).launches, [], 'nothing was written yet: persistence is not awaited by the hook')

  await worker.deactivate() // flushes the memory
  const memory = stored(host)
  assert.equal(memory.launches.length, 1)
  assert.deepEqual(Object.keys(memory.launches[0]).sort(), ['agent', 'at', 'claudeConfigDir', 'codexHome', 'terminalId', 'workspaceId'])
  assert.equal(memory.launches[0].claudeConfigDir, 'C:/orca/claude-profiles/a/home')
  assert.equal(memory.launches[0].codexHome, 'C:/orca/codex-accounts/c/home')
  const everything = JSON.stringify([host.data(), worker.logs, worker.posts])
  for (const secret of ['SECRET_key', 'SECRET_token', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', '/usr/bin']) assert.ok(!everything.includes(secret), `${secret} must not be stored or logged`)
  assert.deepEqual(worker.refusals, [])
})

test('a launch without either home variable stores only the terminal link', async () => {
  const host = mockHost({ results: { 'workspace.list': { workspaces: [], truncated: false } } })
  const worker = await mountWorker(main, { host })
  const decision = await worker.hooks.fire('agent.launch.before', launch({ ANTHROPIC_API_KEY: 'SECRET_key' }))
  assert.equal(decision.kind, 'continue')
  await worker.deactivate()
  const memory = stored(host)
  assert.deepEqual(memory.launches, [])
  assert.equal((memory.terminals as { id: string }[])[0].id, 'term_7')
  assert.ok(!JSON.stringify(host.data()).includes('SECRET_key'))
})

test('agent.tool.after passes at once and only observes', async () => {
  const host = mockHost({ results: { 'workspace.list': { workspaces: [], truncated: false } } })
  const worker = await mountWorker(main, { host })
  const event = { agent: 'claude', workspaceId: WS, terminalId: 'term_8', tool: 'Bash', input: { command: 'echo SECRET_in_input' }, output: 'SECRET_out' }
  const copy = JSON.parse(JSON.stringify(event))
  const decision = await worker.hooks.fire('agent.tool.after', event)
  assert.equal(decision.kind, 'continue')
  assert.deepEqual(decision.kind === 'continue' && decision.event, copy)
  await worker.deactivate()
  assert.deepEqual((stored(host).terminals as { id: string; workspaceId: string }[]).map((t) => [t.id, t.workspaceId]), [['term_8', WS]])
  assert.ok(!JSON.stringify([host.data(), worker.logs]).includes('SECRET_'), 'tool input and output are never kept')
})

test('agent status events teach the worker, and a chat agent resolves an ambiguous workspace', async () => {
  fx = await makeFixture()
  const twin = { ...workspaceFor(fx), id: 'repo2::C:/elsewhere/twin', path: 'C:/elsewhere/twin' } // same name and branch
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [twin, workspaceFor(fx)], truncated: false },
      'workspace.readContext': { branch: 'main', displayName: workspaceFor(fx).name, terminals: [] },
      'agents.list': { agents: [] }
    }
  })
  const worker = await mountWorker(main, { host })
  const chatAgent = { terminalId: null, title: null, agent: 'claude', stateStartedAt: 4242 }

  // Nothing is known yet: two workspaces share the name and branch.
  const before = await worker.request('ballast.scan', { ...focusFor(fx), agents: [chatAgent] })
  assert.equal(before.folderSource, 'ambiguous')
  assert.equal(before.candidates.length, 2)

  // The chat agent's status event carries the workspace id (no terminalId).
  await worker.emit('agent.status.changed', {
    workspaceId: workspaceFor(fx).id,
    paneKey: 'pane-1',
    state: 'working',
    receivedAt: 1,
    mainAgent: { state: 'working', stateStartedAt: 4242 }
  })
  const after = await worker.request('ballast.scan', { ...focusFor(fx), agents: [chatAgent] })
  assert.equal(after.folderSource, 'agent')
  assert.equal(after.folder, fx.repo)
  assert.equal(after.candidates.length, 0)

  // A stale start time (the agent moved on) is not matched.
  const stale = await worker.request('ballast.scan', { ...focusFor(fx), agents: [{ ...chatAgent, stateStartedAt: 4243 }] })
  assert.equal(stale.folderSource, 'ambiguous')
  await worker.deactivate()
  assert.deepEqual(worker.refusals, [])
})

test('a terminal id from an event resolves the focus, and the worker announces the new resolution', async () => {
  fx = await makeFixture()
  const twin = { ...workspaceFor(fx), id: 'repo2::C:/elsewhere/twin', path: 'C:/elsewhere/twin' }
  const terminals = [{ id: 'term_42' }]
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [twin, workspaceFor(fx)], truncated: false },
      'workspace.readContext': { branch: 'main', displayName: workspaceFor(fx).name, terminals },
      // A supported agent has to be running for the worker to look at the folder at all.
      'agents.list': { agents: [{ terminalId: 'term_42', title: null, agent: 'claude', state: 'working', stateStartedAt: 1 }] }
    }
  })
  const worker = await mountWorker(main, { host })
  await worker.emit('agent.status.changed', { workspaceId: workspaceFor(fx).id, paneKey: 'p', terminalId: 'term_42', state: 'working', receivedAt: 1 })
  await worker.emit('workspace.changed', { context: { branch: 'main', displayName: workspaceFor(fx).name, terminals } })
  const resolved = worker.posts.filter((p) => p.event === 'ballast.resolved')
  assert.equal(resolved.length, 1)
  assert.deepEqual(resolved[0].payload, { folder: fx.repo, source: 'terminal' })
  // The same folder again is not news.
  await worker.emit('workspace.changed', { context: { branch: 'main', displayName: workspaceFor(fx).name, terminals } })
  assert.equal(worker.posts.filter((p) => p.event === 'ballast.resolved').length, 1)
  await worker.deactivate()
})

test('the person\'s pick among the candidates is remembered for the terminals of that focus', async () => {
  fx = await makeFixture()
  const twin = { ...workspaceFor(fx), id: 'repo2::C:/elsewhere/twin', path: 'C:/elsewhere/twin' }
  const host = mockHost({ results: { 'workspace.list': { workspaces: [twin, workspaceFor(fx)], truncated: false } } })
  const worker = await mountWorker(main, { host })
  const input = { workspace: { displayName: workspaceFor(fx).name, branch: 'main', terminals: [{ id: 'term_5' }] }, agents: focusFor(fx).agents }
  assert.equal((await worker.request('ballast.scan', input)).folderSource, 'ambiguous')
  const picked = await worker.request('ballast.scan', { ...input, choose: workspaceFor(fx).id })
  assert.equal(picked.folderSource, 'terminal')
  assert.equal(picked.folder, fx.repo)
  // Next time, no pick is needed.
  assert.equal((await worker.request('ballast.scan', input)).folder, fx.repo)
  await worker.deactivate()
  assert.deepEqual((stored(host).terminals as { id: string }[]).map((t) => t.id), ['term_5'])
})
