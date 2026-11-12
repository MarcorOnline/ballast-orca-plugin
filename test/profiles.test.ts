// Profiles for both agents: Orca's account list (CLI, cached) with a disk fallback, and the
// automatic choice by agent and by launch. No real account data: the JSON below follows the
// schema of `orca account list --json` with made-up values.
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { afterEach, assert, test } from 'orca/testing'
import { childEnv, cliCandidates, createAccountSource, parseAccountList } from '../src/core/accounts.ts'
import { emptyMemory, rememberLaunch } from '../src/core/focus.ts'
import { agentsPresent, pickAgent } from '../src/core/service.ts'
import { type Fixture, focusFor, makeFixture, memoryStoreFor, serviceFor, workspaceFor } from './fixture.ts'

let fx: Fixture | undefined
afterEach(async () => {
  await fx?.cleanup()
  fx = undefined
})

const CLI_JSON = {
  id: 'x',
  ok: true,
  result: {
    claude: {
      accounts: [
        { id: 'cl-1', email: 'dev@example.com', managedAuthRuntime: 'host', authMethod: 'oauth', organizationName: 'Acme', createdAt: 1, home: 'C:/orca/claude-profiles/cl-1/home', authToken: 'SECRET_claude_token' }
      ],
      activeAccountId: 'cl-1',
      systemDefaultHome: 'C:/Users/dev/.claude',
      systemDefaultEmail: 'dev@example.com'
    },
    codex: {
      accounts: [
        { id: 'cx-1', email: 'dev@example.com', managedHomeRuntime: 'host', providerAccountId: 'SECRET_provider', workspaceLabel: 'Team', createdAt: 1 },
        { id: 'cx-2', email: 'dev@example.com', workspaceLabel: 'Personal (Plus)' }
      ],
      activeAccountId: 'cx-1',
      systemDefault: { hasAuth: true, authKind: 'chatgpt', email: 'sys@example.com', providerAccountId: 'SECRET_sys', workspaceLabel: 'Plus' }
    },
    rateLimits: { claude: { session: { usedPercent: 3 } } },
    opencode: { accounts: [], activeAccountId: null }
  }
}

test('parseAccountList keeps ids, e-mails, workspace labels and the claude home, and nothing else', () => {
  const parsed = parseAccountList(CLI_JSON)
  assert.ok(parsed)
  assert.deepEqual(parsed.claude.accounts, [{ id: 'cl-1', email: 'dev@example.com', home: 'C:/orca/claude-profiles/cl-1/home' }])
  assert.equal(parsed.claude.activeAccountId, 'cl-1')
  assert.equal(parsed.claude.systemDefaultHome, 'C:/Users/dev/.claude')
  assert.deepEqual(parsed.codex.accounts, [
    { id: 'cx-1', email: 'dev@example.com', workspaceLabel: 'Team' },
    { id: 'cx-2', email: 'dev@example.com', workspaceLabel: 'Personal (Plus)' }
  ])
  assert.equal(parsed.codex.activeAccountId, 'cx-1')
  assert.deepEqual(parsed.codex.systemDefault, { email: 'sys@example.com', workspaceLabel: 'Plus' })
  assert.ok(!JSON.stringify(parsed).includes('SECRET_'), 'no token or provider id survives parsing')
  assert.equal(parseAccountList({ ok: true, result: { nothing: 1 } }), null)
  assert.equal(parseAccountList('x'), null)
  // Both the whole answer and just `result` are accepted.
  assert.ok(parseAccountList(CLI_JSON.result))
})

test('the account source runs the CLI once per few minutes and caches failures briefly', async () => {
  let runs = 0
  let clock = 0
  const calls: string[][] = []
  const source = createAccountSource({
    command: 'orca-test',
    now: () => clock,
    run: async (file, args) => {
      runs++
      calls.push([file, ...args])
      return JSON.stringify(CLI_JSON)
    }
  })
  assert.ok(await source())
  assert.ok(await source())
  assert.equal(runs, 1, 'cached')
  assert.deepEqual(calls[0], ['orca-test', 'account', 'list', '--json'])
  clock += 6 * 60 * 1000
  await source()
  assert.equal(runs, 2, 'refreshed after the cache expired')

  let failing = 0
  const broken = createAccountSource({ command: 'orca-test', now: () => clock, run: async () => { failing++; throw new Error('ENOENT') } })
  assert.equal(await broken(), null)
  assert.equal(await broken(), null)
  assert.equal(failing, 1, 'a failure is cached too')
  clock += 61_000
  await broken()
  assert.equal(failing, 2, 'and retried after a minute')
  const garbage = createAccountSource({ command: 'orca-test', run: async () => 'not json' })
  assert.equal(await garbage(), null)
})

const hint = (agent: string | null, stateStartedAt: number) => ({ terminalId: null, title: null, agent, stateStartedAt })

test('pickAgent: the last pick when that agent is present, else the most recent, nothing without a supported agent', () => {
  assert.equal(pickAgent([]), null)
  assert.equal(pickAgent([hint('gemini', 900)]), null, 'agents Ballast does not read are ignored')
  assert.equal(pickAgent([hint(null, 900)]), null)
  assert.equal(pickAgent([hint('claude', 100), hint('codex', 200)]), 'codex')
  assert.equal(pickAgent([hint('codex', 100), hint('claude', 200)]), 'claude-code')
  assert.equal(pickAgent([hint('gemini', 900), hint('codex', 100)]), 'codex')
  assert.equal(pickAgent([hint('claude', 100), hint('codex', 200)], 'claude-code'), 'claude-code', 'the last pick wins over the most recent')
  assert.equal(pickAgent([hint('claude', 100)], 'codex'), 'claude-code', 'a pick that is no longer present falls back to the most recent')
  assert.equal(pickAgent([], 'codex'), null)
  assert.deepEqual(agentsPresent([hint('codex', 1), hint('gemini', 2), hint('claude', 3)]), ['claude-code', 'codex'])
  assert.deepEqual(agentsPresent([hint('gemini', 2)]), [])
})

test('the agent shown: the most recent, the pick when present, and the account of the active Orca account', async () => {
  fx = await makeFixture()
  const codexHome = path.join(fx.orcaData, 'codex-accounts', 'cx-1', 'home')
  await fs.mkdir(codexHome, { recursive: true })
  const accounts = async () => parseAccountList(CLI_JSON)
  const service = serviceFor(fx, { accounts })
  const claudeOnly = await service.scan({ ...focusFor(fx), agents: [hint('claude', 10)] })
  assert.equal(claudeOnly.agent, 'claude-code')
  assert.deepEqual(claudeOnly.agentsPresent, ['claude-code'])
  assert.equal(claudeOnly.profile.source, 'orca-active')

  const both = { ...focusFor(fx), agents: [hint('claude', 10), { ...hint('codex', 50), terminalId: 'term_1' }] }
  const codexNewest = await service.scan(both)
  assert.equal(codexNewest.agent, 'codex')
  assert.deepEqual(codexNewest.agentsPresent, ['claude-code', 'codex'])
  assert.equal(codexNewest.profile.configDir, codexHome)
  assert.equal(codexNewest.profile.source, 'orca-active')
  assert.equal(codexNewest.profile.account, 'dev@example.com')
  assert.equal(codexNewest.profile.orcaAccountId, 'cx-1')
  assert.equal(codexNewest.targets.personal.file, '', 'Codex has no personal file')

  const picked = await service.scan({ ...both, agent: 'claude-code' })
  assert.equal(picked.agent, 'claude-code', 'the pick wins over the most recent agent')
  const gone = await service.scan({ ...focusFor(fx), agents: [hint('claude', 10)], agent: 'codex' })
  assert.equal(gone.agent, 'claude-code', 'a pick whose agent left the workspace is ignored')
})

test('no supported agent in the workspace: the "no agent" answer, with nothing scanned', async () => {
  fx = await makeFixture()
  let listed = 0
  let asked = 0
  const service = serviceFor(fx, {
    listWorkspaces: async () => (listed++, []),
    accounts: async () => (asked++, null)
  })
  const input = focusFor(fx)
  for (const agents of [[], [hint('gemini', 5)]]) {
    const none = await service.scan({ ...input, agents })
    assert.deepEqual(none.agentsPresent, [])
    assert.equal(none.folder, '')
    assert.equal(none.folderSource, 'none')
    assert.equal(none.workspaceHint, input.workspace?.displayName, 'the panel tells this from "no workspace"')
    assert.deepEqual(none.items, [])
  }
  assert.equal(listed + asked, 0, 'no workspace lookup, no account lookup, no scan')
  const noWorkspace = await service.scan({ workspace: null, agents: [] })
  assert.equal(noWorkspace.workspaceHint, undefined)
})

test('Launch home: the home a launch in this workspace carried beats the active account', async () => {
  fx = await makeFixture()
  const launchedHome = path.join(fx.root, 'launched-claude-home')
  await fs.mkdir(launchedHome, { recursive: true })
  const memory = memoryStoreFor()
  await memory.update((m) => rememberLaunch(m, { workspaceId: workspaceFor(fx!).id, agent: 'claude', claudeConfigDir: launchedHome, at: 5 }))
  // Another workspace's launch and an unrelated agent do not count.
  await memory.update((m) => rememberLaunch(m, { workspaceId: 'other::C:/x', agent: 'claude', claudeConfigDir: path.join(fx!.root, 'nope'), at: 9 }))
  await memory.update((m) => rememberLaunch(m, { workspaceId: workspaceFor(fx!).id, agent: 'codex', codexHome: path.join(fx!.root, 'codex-nope'), at: 9 }))
  const service = serviceFor(fx, { memory })
  const result = await service.scan(focusFor(fx))
  assert.equal(result.profile.source, 'launch')
  assert.equal(result.profile.configDir, launchedHome)
  // A launch whose home no longer exists is ignored.
  const gone = memoryStoreFor()
  await gone.update((m) => rememberLaunch(m, { workspaceId: workspaceFor(fx!).id, agent: 'claude', claudeConfigDir: path.join(fx!.root, 'deleted'), at: 5 }))
  assert.equal((await serviceFor(fx, { memory: gone }).scan(focusFor(fx))).profile.source, 'orca-active')
  assert.equal(emptyMemory().launches.length, 0)
})

/** Paths of properties set to undefined: Orca refuses an answer that has one ("non-JSON value"). */
function undefinedPaths(value: unknown, at = '$'): string[] {
  if (value === undefined) return [at]
  if (Array.isArray(value)) return value.flatMap((v, i) => undefinedPaths(v, `${at}[${i}]`))
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([k, v]) => undefinedPaths(v, `${at}.${k}`))
  return []
}

test('a scan answer is plain JSON: no property is set to undefined', async () => {
  fx = await makeFixture()
  const service = serviceFor(fx, { accounts: async () => parseAccountList(CLI_JSON) })
  const claude = await service.scan(focusFor(fx))
  assert.deepEqual(undefinedPaths(claude), [])
  const codex = await service.scan(focusFor(fx, 'codex'))
  assert.deepEqual(undefinedPaths(codex), [])
  assert.equal(codex.agent, 'codex')
  const none = await service.scan({ workspace: null, agents: [] })
  assert.deepEqual(undefinedPaths(none), [])
})

test('sparse accounts (no e-mail, no workspace label) still give a plain JSON answer', async () => {
  fx = await makeFixture()
  await fs.mkdir(path.join(fx.orcaData, 'codex-accounts', 'cx-3', 'home'), { recursive: true })
  const sparse = parseAccountList({
    ...CLI_JSON,
    result: {
      claude: { accounts: [{ id: 'cl-9', home: path.join(fx.orcaData, 'claude-profiles', 'cl-9', 'home') }], systemDefaultHome: path.join(fx.home, '.claude') },
      codex: { accounts: [{ id: 'cx-3' }], activeAccountId: 'cx-3', systemDefault: { hasAuth: false } }
    }
  })
  const service = serviceFor(fx, { accounts: async () => sparse })
  const result = await service.scan(focusFor(fx, 'codex'))
  assert.deepEqual(undefinedPaths(result), [])
  assert.equal(result.profile.orcaAccountId, 'cx-3', 'the active account, with no e-mail')
})

test('the CLI child does not inherit ELECTRON_RUN_AS_NODE (workers run as Electron-as-Node)', () => {
  const env = childEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: '/bin', ORCA_CLI_COMMAND: 'orca' })
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
  assert.equal(env.PATH, '/bin')
  assert.equal(env.ORCA_CLI_COMMAND, 'orca')
})

test('the Orca CLI is ORCA_CLI_COMMAND, else the one shipped beside the app, else orca on the PATH', () => {
  assert.deepEqual(cliCandidates({ command: 'C:/x/orca.exe', execPath: 'C:/app/Orca.exe', platform: 'win32' }), ['C:/x/orca.exe'])
  const win = cliCandidates({ execPath: 'C:/Users/a/AppData/Local/Programs/orca/Orca.exe', platform: 'win32' })
  assert.equal(win[0].split(String.fromCharCode(92)).join('/'), 'C:/Users/a/AppData/Local/Programs/orca/resources/bin/orca.exe')
  assert.equal(win[1], 'orca')
  const mac = cliCandidates({ execPath: '/Applications/Orca.app/Contents/MacOS/Orca', platform: 'darwin' })
  const fwd = (p: string) => p.split(String.fromCharCode(92)).join('/') // the host's path module decides the separator
  assert.equal(fwd(mac[0]), '/Applications/Orca.app/Contents/Resources/bin/orca')
  assert.equal(fwd(cliCandidates({ execPath: '/opt/orca/orca', platform: 'linux' })[0]), '/opt/orca/resources/bin/orca')
})

test('the CLI child gets the Windows profile variables a trimmed worker environment lacks', () => {
  const env = childEnv({ PATH: 'p' }, 'win32', 'C:/Users/dev')
  assert.ok(env.APPDATA?.endsWith('Roaming') && env.LOCALAPPDATA?.endsWith('Local') && env.USERPROFILE === 'C:/Users/dev')
  assert.equal(childEnv({ APPDATA: 'D:/roaming' }, 'win32', 'C:/Users/dev').APPDATA, 'D:/roaming', 'an existing value is kept')
  assert.equal(childEnv({ PATH: 'p' }, 'linux', '/home/dev').APPDATA, undefined)
})
