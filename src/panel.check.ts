// `orca plugin check` renders the panel once per scenario. The scan is stubbed so the check
// never depends on this machine's Claude or Codex config.
import { defineCheck } from 'orca/testing'
import { sampleScan } from '../test/sample.ts'

const noFolder = { ...sampleScan, folder: '', folderSource: 'none' as const, items: [], warnings: [] }

const ambiguous = {
  ...noFolder,
  folderSource: 'ambiguous' as const,
  workspaceHint: 'main',
  candidates: [
    { id: 'r1::/work/a', name: 'main', path: '/work/a', branch: 'main' },
    { id: 'r2::/work/b', name: 'main', path: '/work/b', branch: 'main' }
  ]
}

const codex = {
  ...sampleScan,
  agent: 'codex' as const,
  profile: { agent: 'codex' as const, configDir: '/orca/codex-accounts/c1/home', source: 'orca-active' as const, account: 'dev@example.com', exists: true },
  agentsPresent: ['claude-code' as const, 'codex' as const],
  projectTrusted: false,
  targets: { shared: { file: '.codex/config.toml', exists: false }, personal: { file: '', exists: false } }
}

const noAgent = { ...noFolder, agentsPresent: [], workspaceHint: 'repo' }

const focused = {
  'workspace.readContext': { branch: 'main', displayName: 'repo', terminals: [{ id: 'term_1' }] },
  'agents.list': { agents: [{ terminalId: null, title: null, agent: 'claude', state: 'working' as const, stateStartedAt: 1_790_000_000_000 }] }
}

// The write requests are stubbed too: a check never writes a file.
const writes = {
  'ballast.applyBatch': () => ({ results: [], writes: [] }),
  'ballast.undo': () => ({ ok: true })
}

export default defineCheck({
  populated: { results: focused, requests: { 'ballast.scan': () => sampleScan, ...writes } },
  noAgent: { results: { 'workspace.readContext': { branch: 'main', displayName: 'repo', terminals: [] }, 'agents.list': { agents: [] } }, requests: { 'ballast.scan': () => noAgent } },
  codexNotTrusted: { results: focused, requests: { 'ballast.scan': () => codex } },
  ambiguous: { results: focused, requests: { 'ballast.scan': () => ambiguous } },
  noFolder: { results: { 'workspace.readContext': null, 'agents.list': { agents: [] } }, requests: { 'ballast.scan': () => noFolder } }
})
