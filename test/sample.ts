// A small scan result for panel tests and `orca plugin check` scenarios.
import type { ActionInfo, Item, ItemActions, ScanResult } from '../src/model.ts'

const ok = (mechanism: string): ActionInfo => ({
  allowed: true,
  notes: [],
  mechanism,
  mutations: []
})
const no = (code: 'alreadyThisWay' | 'noEntryInFile' | 'pluginSkillNoOverride', plugin?: string): ActionInfo => ({
  allowed: false,
  notes: [plugin ? { code, args: { plugin } } : { code }]
})

function actions(a: ItemActions): Item['actions'] {
  return { shared: a, personal: a }
}

export const sampleItems: Item[] = [
  {
    id: 'plugin:azure@acme',
    agent: 'claude-code',
    kind: 'plugin',
    name: 'azure@acme',
    origin: { level: 'plugin', plugin: 'azure@acme' },
    state: 'on',
    decidedBy: { level: 'project', file: '/repo/.claude/settings.json', key: 'enabledPlugins["azure@acme"]' },
    tokens: 1200,
    tokensIfOn: 1200,
    basis: 'components',
    countsInTotal: true,
    notes: [],
    actions: actions({
      enable: no('alreadyThisWay'),
      block: ok('enabledPlugins["azure@acme"]: false'),
      reset: ok('− enabledPlugins["azure@acme"]')
    })
  },
  {
    id: 'plugin:noisy@acme',
    agent: 'claude-code',
    kind: 'plugin',
    name: 'noisy@acme',
    origin: { level: 'plugin', plugin: 'noisy@acme' },
    state: 'off',
    decidedBy: { level: 'local', key: 'enabledPlugins["noisy@acme"]' },
    tokens: 0,
    tokensIfOn: 800,
    basis: 'components',
    countsInTotal: true,
    notes: [],
    actions: actions({
      enable: ok('enabledPlugins["noisy@acme"]: true'),
      block: no('alreadyThisWay'),
      reset: no('noEntryInFile')
    })
  },
  {
    id: 'plugin:helper@acme',
    agent: 'claude-code',
    kind: 'plugin',
    name: 'helper@acme',
    origin: { level: 'plugin', plugin: 'helper@acme' },
    state: 'on',
    decidedBy: { level: 'project', file: '/repo/.claude/settings.json', key: 'enabledPlugins["helper@acme"]' },
    tokens: 100,
    tokensIfOn: 100,
    basis: 'components',
    countsInTotal: true,
    notes: [],
    actions: actions({
      enable: no('alreadyThisWay'),
      block: ok('enabledPlugins["helper@acme"]: false'),
      reset: ok('− enabledPlugins["helper@acme"]')
    })
  },
  {
    id: 'skill:azure@acme:azure-deploy',
    agent: 'claude-code',
    kind: 'skill',
    name: 'azure-deploy',
    origin: { level: 'plugin', plugin: 'azure@acme' },
    state: 'on',
    decidedBy: { level: 'project' },
    tokens: 40,
    tokensIfOn: 40,
    basis: 'description',
    countsInTotal: false,
    parent: 'plugin:azure@acme',
    notes: [],
    actions: actions({
      enable: no('pluginSkillNoOverride', 'azure@acme'),
      block: no('pluginSkillNoOverride', 'azure@acme'),
      reset: no('pluginSkillNoOverride', 'azure@acme')
    })
  },
  {
    id: 'connector:session:claude.ai Gmail',
    agent: 'claude-code',
    kind: 'connector',
    name: 'claude.ai Gmail',
    origin: { level: 'session' },
    state: 'on',
    decidedBy: { level: 'session' },
    tokens: 300,
    tokensIfOn: 300,
    basis: 'tools',
    countsInTotal: true,
    toolCount: 24,
    isNew: true,
    notes: [{ code: 'connectorManageOnline' }],
    actions: actions({
      enable: no('alreadyThisWay'),
      block: ok('deniedMcpServers += {"serverName":"claude.ai Gmail"}'),
      reset: no('noEntryInFile')
    })
  },
  {
    id: 'memory:/repo/CLAUDE.md',
    agent: 'claude-code',
    kind: 'memory',
    name: 'CLAUDE.md',
    origin: { level: 'project', path: '/repo/CLAUDE.md' },
    state: 'on',
    decidedBy: { level: 'default' },
    tokens: 900,
    tokensIfOn: 900,
    basis: 'file',
    countsInTotal: true,
    notes: [],
    actions: actions({
      enable: no('alreadyThisWay'),
      block: ok('claudeMdExcludes += "**/repo/CLAUDE.md"'),
      reset: no('noEntryInFile')
    })
  }
]

export const sampleScan: ScanResult = {
  agent: 'claude-code',
  folder: '/work/repo',
  folderSource: 'name',
  profile: {
    configDir: '/orca/claude-profiles/acc-1/home',
    agent: 'claude-code',
    source: 'orca-active',
    account: 'dev@example.com',
    orcaAccountId: 'acc-1',
    exists: true
  },
  agentsPresent: ['claude-code'],
  candidates: [],
  items: sampleItems,
  totals: {
    tokens: 2400,
    byKind: { plugin: 1200, skill: 0, mcp: 0, connector: 300, memory: 900 },
    heaviest: ['plugin:azure@acme', 'memory:/repo/CLAUDE.md', 'connector:session:claude.ai Gmail']
  },
  sessions: { dir: '/orca/claude-profiles/acc-1/home/projects/-work-repo', count: 3, latestAt: 1_790_000_000_000 },
  warnings: [{ code: 'unmatchedDeny', args: { rule: 'claude.ai Atlassian', level: 'user', server: 'claude.ai Atlassian MCP' } }],
  targets: {
    shared: { file: '.claude/settings.json', exists: true },
    personal: { file: '.claude/settings.local.json', exists: false }
  },
  scannedAt: 1_790_000_000_000
}
