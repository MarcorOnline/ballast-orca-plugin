// readContext gives a name and a branch, not a path: Ballast resolves the folder from terminal
// ids, then agent start times, then a unique name and branch, and otherwise asks the person.
import { assert, test } from 'orca/testing'
import {
  type AgentRef,
  emptyMemory,
  type FocusContext,
  LIMITS,
  matchesWorkspace,
  matchWorkspace,
  rememberChoice,
  rememberLaunch,
  rememberObservation,
  rememberTerminal,
  resolveWorkspace,
  type WorkspaceRecord
} from '../src/core/focus.ts'
import { launchHomeFor } from '../src/core/service.ts'

const ws = (id: string, name: string, p: string, branch: string | null): WorkspaceRecord => ({ id, kind: 'worktree', name, path: p, branch, hostId: null })

const A = ws('r1::C:/repos/a', 'main', 'C:/repos/a', 'main')
const B = ws('r2::C:/repos/b', 'main', 'C:/repos/b', 'main')
const C = ws('r3::C:/repos/c', 'feature', 'C:/repos/c', 'feature')
const LIST = [A, B, C]

const focus = (terminals: string[] = [], displayName = 'main', branch = 'main'): FocusContext => ({
  displayName,
  branch,
  terminals: terminals.map((id) => ({ id }))
})
const agent = (stateStartedAt: number, title: string | null = null, terminalId: string | null = null): AgentRef => ({ terminalId, title, agent: 'claude', stateStartedAt })

test('matchWorkspace matches a unique name and branch and refuses to guess', () => {
  assert.equal(matchWorkspace({ displayName: 'feature', branch: 'feature' }, LIST)?.id, C.id)
  assert.equal(matchWorkspace({ displayName: 'main', branch: 'main' }, LIST), null)
  assert.equal(matchWorkspace({ displayName: 'b', branch: 'refs/heads/main' }, LIST)?.id, B.id, 'a folder name fits; refs/heads/ is ignored')
})

test('a known terminal beats the name', () => {
  const m = rememberTerminal(emptyMemory(), 'term_1', B.id, 1)
  const r = resolveWorkspace(focus(['term_1', 'term_unknown']), [], LIST, m)
  assert.equal(r.status, 'resolved')
  if (r.status === 'resolved') {
    assert.equal(r.source, 'terminal')
    assert.equal(r.workspace.id, B.id)
  }
})

test('terminals that disagree fall through instead of picking one', () => {
  let m = rememberTerminal(emptyMemory(), 'term_1', A.id, 1)
  m = rememberTerminal(m, 'term_2', B.id, 2)
  const r = resolveWorkspace(focus(['term_1', 'term_2']), [], LIST, m)
  assert.equal(r.status, 'ambiguous')
})

test('a unique name and branch resolves by name', () => {
  const r = resolveWorkspace(focus([], 'feature', 'feature'), [], LIST, emptyMemory())
  assert.deepEqual(r.status === 'resolved' && [r.source, r.workspace.id], ['name', C.id])
})

test('an ambiguous focus lists only the workspaces with that name and branch', () => {
  const r = resolveWorkspace(focus(), [], LIST, emptyMemory())
  assert.equal(r.status, 'ambiguous')
  if (r.status === 'ambiguous') assert.deepEqual(r.candidates.map((w) => w.id).sort(), [A.id, B.id])
})

test('candidates are capped', () => {
  const many = Array.from({ length: 80 }, (_, i) => ws(`r${i}::C:/m/${i}`, 'main', `C:/m/${i}`, 'main'))
  const r = resolveWorkspace(focus(), [], many, emptyMemory())
  assert.equal(r.status === 'ambiguous' && r.candidates.length, LIMITS.candidates)
})

test('a choice is remembered by the terminal ids and the agents of that focus', () => {
  const ctx = focus(['term_9'])
  const agents = [agent(500)]
  const m = rememberChoice(emptyMemory(), ctx, agents, B.id, 10)
  const byTerminal = resolveWorkspace(focus(['term_9']), [], LIST, m)
  assert.deepEqual(byTerminal.status === 'resolved' && [byTerminal.source, byTerminal.workspace.id], ['terminal', B.id])
  const byAgent = resolveWorkspace(focus(), agents, LIST, m)
  assert.deepEqual(byAgent.status === 'resolved' && [byAgent.source, byAgent.workspace.id], ['agent', B.id])
})

test('no focused workspace', () => {
  assert.deepEqual(resolveWorkspace(null, [], LIST, emptyMemory()), { status: 'none' })
})

test('a workspace the memory knows but workspace.list no longer has is not used', () => {
  const m = rememberTerminal(emptyMemory(), 'term_1', 'gone::C:/repos/gone', 1)
  const r = resolveWorkspace(focus(['term_1'], 'feature', 'feature'), [], LIST, m)
  assert.deepEqual(r.status === 'resolved' && [r.source, r.workspace.id], ['name', C.id], 'falls through to the name')
  const none = resolveWorkspace(focus(['term_1']), [], LIST, m)
  assert.equal(none.status, 'ambiguous')
})

test('the terminal map is bounded and drops the oldest entries', () => {
  let m = emptyMemory()
  for (let i = 0; i < LIMITS.terminals + 25; i++) m = rememberTerminal(m, `term_${i}`, A.id, i)
  assert.equal(m.terminals.length, LIMITS.terminals)
  assert.ok(!m.terminals.some((t) => t.id === 'term_0'), 'the oldest is gone')
  assert.ok(m.terminals.some((t) => t.id === `term_${LIMITS.terminals + 24}`), 'the newest stays')
})

// ---- chat agents: stateStartedAt is the key

test('an agent whose stateStartedAt equals an event resolves the workspace', () => {
  const m = rememberObservation(emptyMemory(), { workspaceId: B.id, stateStartedAt: 1_000, at: 5 })
  const r = resolveWorkspace(focus(), [agent(1_000)], LIST, m)
  assert.deepEqual(r.status === 'resolved' && [r.source, r.workspace.id], ['agent', B.id])
})

test('matched agents that disagree on the workspace fall through', () => {
  let m = rememberObservation(emptyMemory(), { workspaceId: A.id, stateStartedAt: 1_000, at: 5 })
  m = rememberObservation(m, { workspaceId: B.id, stateStartedAt: 2_000, at: 6 })
  const r = resolveWorkspace(focus(), [agent(1_000), agent(2_000)], LIST, m)
  assert.equal(r.status, 'ambiguous')
})

test('an unmatched agent is ignored, a matched one still decides', () => {
  const m = rememberObservation(emptyMemory(), { workspaceId: B.id, stateStartedAt: 1_000, at: 5 })
  const r = resolveWorkspace(focus(), [agent(1_000), agent(9_999)], LIST, m)
  assert.equal(r.status === 'resolved' && r.workspace.id, B.id)
})

test('a stale event (the agent changed state since) does not match', () => {
  const m = rememberObservation(emptyMemory(), { workspaceId: B.id, stateStartedAt: 1_000, at: 5 })
  const r = resolveWorkspace(focus(), [agent(1_001)], LIST, m)
  assert.equal(r.status, 'ambiguous')
})

test('no events at all: the name decides', () => {
  const r = resolveWorkspace(focus([], 'feature', 'feature'), [agent(1_000)], LIST, emptyMemory())
  assert.equal(r.status === 'resolved' && r.source, 'name')
})

test('titles must agree when both sides have one', () => {
  const m = rememberObservation(emptyMemory(), { workspaceId: B.id, stateStartedAt: 1_000, title: 'Refactor', at: 5 })
  assert.equal(resolveWorkspace(focus(), [agent(1_000, 'Other')], LIST, m).status, 'ambiguous')
  assert.equal(resolveWorkspace(focus(), [agent(1_000, 'Refactor')], LIST, m).status, 'resolved')
  assert.equal(resolveWorkspace(focus(), [agent(1_000, null)], LIST, m).status, 'resolved', 'one side without a title still matches')
})

test('terminal ids win over agent matches', () => {
  let m = rememberTerminal(emptyMemory(), 'term_1', A.id, 1)
  m = rememberObservation(m, { workspaceId: B.id, stateStartedAt: 1_000, at: 2 })
  const r = resolveWorkspace(focus(['term_1']), [agent(1_000)], LIST, m)
  assert.equal(r.status === 'resolved' && r.workspace.id, A.id)
})

// ---- Orca 1.4.255: workspace.list ids are `identity:wt2:local:<uuid>`, events carry `<repoId>::<path>`

const identity = (uuid: string, w: WorkspaceRecord): WorkspaceRecord => ({ ...w, id: `identity:wt2:local:${uuid}` })
const LISTED = [identity('aaa', A), identity('bbb', B), identity('ccc', C)]

test('an event id (repoId::path) finds the workspace whose list id is an identity id', () => {
  const m = rememberObservation(emptyMemory(), { workspaceId: B.id, stateStartedAt: 1_000, at: 5 })
  const r = resolveWorkspace(focus(), [agent(1_000)], LISTED, m)
  assert.deepEqual(r.status === 'resolved' && [r.source, r.workspace.id, r.workspace.path], ['agent', 'identity:wt2:local:bbb', B.path])
  const t = rememberTerminal(emptyMemory(), 'term_1', A.id, 1)
  const byTerminal = resolveWorkspace(focus(['term_1']), [], LISTED, t)
  assert.equal(byTerminal.status === 'resolved' && byTerminal.workspace.id, 'identity:wt2:local:aaa')
})

test('the same workspace named in both id forms is one workspace, not a disagreement', () => {
  let m = rememberTerminal(emptyMemory(), 'term_1', B.id, 1) // from an event
  m = rememberTerminal(m, 'term_2', 'identity:wt2:local:bbb', 2) // from the person's pick
  const r = resolveWorkspace(focus(['term_1', 'term_2']), [], LISTED, m)
  assert.equal(r.status === 'resolved' && r.workspace.id, 'identity:wt2:local:bbb')
  // A path that no listed workspace has still does not match by accident.
  assert.equal(matchesWorkspace('r9::C:/repos/zzz', LISTED[0]), false)
  const backslashes = ['r1::C:', 'repos', 'a'].join(String.fromCharCode(92))
  assert.equal(matchesWorkspace(backslashes, LISTED[0]), process.platform === 'win32', 'slashes and case do not matter on Windows paths')
})

test('a launch recorded with an event id is found for the listed workspace', () => {
  const m = rememberLaunch(emptyMemory(), { workspaceId: B.id, agent: 'codex', codexHome: 'C:/orca/codex-accounts/x/home', at: 1 })
  assert.equal(launchHomeFor(m, LISTED[1], 'codex'), 'C:/orca/codex-accounts/x/home')
  assert.equal(launchHomeFor(m, LISTED[0], 'codex'), null)
  assert.equal(launchHomeFor(m, LISTED[1], 'claude-code'), null)
})
