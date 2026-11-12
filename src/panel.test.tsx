// The panel draws the worker's scan, and writes straight through ballast.applyBatch.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import type { EditInput } from './protocol.ts'
import * as panel from './panel.tsx'
import { sampleScan } from '../test/sample.ts'

let view: TestPanel | undefined
afterEach(async () => {
  await view?.unmount()
  view = undefined
})

interface Calls {
  plan: unknown[]
  batch: { items: EditInput[] }[]
  undo: { undoId: string }[]
}
const newCalls = (): Calls => ({ plan: [], batch: [], undo: [] })

function host(calls: Calls) {
  return mockHost({
    results: { 'workspace.readContext': { branch: 'main', displayName: 'repo', terminals: [] } },
    requests: {
      'ballast.scan': () => sampleScan,
      'ballast.plan': (input) => {
        calls.plan.push(input)
        return { ok: false, error: { code: 'alreadyThisWay' } }
      },
      'ballast.applyBatch': (input) => {
        calls.batch.push(input)
        return {
          results: input.items.map((i) => ({ itemId: i.itemId, ok: true })),
          writes: [
            {
              file: '/work/repo/.claude/settings.json',
              relFile: '.claude/settings.json',
              diff: '--- a/.claude/settings.json\n+++ b/.claude/settings.json\n@@ -1,2 +1,4 @@\n {\n+  "enabledPlugins": {}\n }',
              undoId: 'u1',
              count: input.items.length
            }
          ]
        }
      },
      'ballast.undo': (input) => {
        calls.undo.push(input)
        return { ok: true, file: '/work/repo/.claude/settings.json' }
      }
    }
  })
}

/** Text or label: how a Callout title, a Collapsible title or a Tab label shows up depends on the component. */
function seen(v: TestPanel, re: RegExp | string): boolean {
  return v.find({ text: re }) !== null || v.find({ label: re }) !== null
}

test('shows the profile, the total and project-enabled plugins', async () => {
  view = await mount(panel, { host: host(newCalls()), locale: 'en-US' })
  assert.ok(view.find({ text: /dev@example\.com/ }), 'the profile is in the panel')
  assert.ok(view.find({ text: /~2.4k tokens/ }))
  assert.ok(view.find({ text: 'azure@acme' }) ?? view.find({ label: 'azure@acme' }))
  assert.ok(view.find({ text: /decided by project/ }))
  assert.ok(view.find({ text: /“claude\.ai Atlassian”/ }), 'the near-miss deny rule is explained')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('the group header counts the active items out of all of them, plugin skills included', async () => {
  view = await mount(panel, { host: host(newCalls()), locale: 'en-US' })
  assert.ok(seen(view, /Plugins · Active: 2\/3 · ~1.2k tokens/))
  // The plugin skill is hidden by "show plugin skills" and still counts: Active 1/1.
  assert.ok(seen(view, /Skills · Active: 1\/1/))
  assert.deepEqual(view.errors, [])
})

test('the tabs split the rows into On and Off', async () => {
  view = await mount(panel, { host: host(newCalls()), locale: 'en-US' })
  assert.ok(seen(view, 'On (2)'))
  assert.ok(seen(view, 'Off (1)'))
  assert.ok(view.find({ label: 'azure@acme' }) && view.find({ label: 'helper@acme' }), 'on rows are in On')
  assert.equal(view.find({ label: 'noisy@acme' }), null, 'an off row is not in On')
  await view.select({ label: 'Plugins: status' }, 'off')
  assert.ok(view.find({ label: 'noisy@acme' }))
  assert.equal(view.find({ label: 'azure@acme' }), null)
  assert.ok(view.find({ role: 'button', text: 'Turn on selected (0)' }))
  assert.equal(view.find({ text: /Nascondi le voci spente/ }), null, 'the hide-off switch is gone')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('two ticked rows and Turn off selected send ONE applyBatch and never plan', async () => {
  const calls = newCalls()
  view = await mount(panel, { host: host(calls), locale: 'en-US' })
  await view.toggle({ label: 'azure@acme' })
  await view.toggle({ label: 'helper@acme' })
  await view.press({ role: 'button', text: 'Turn off selected (2)' })
  assert.equal(calls.batch.length, 1)
  assert.deepEqual(calls.batch[0].items.map((i) => i.itemId).sort(), ['plugin:azure@acme', 'plugin:helper@acme'])
  assert.ok(calls.batch[0].items.every((i) => i.op === 'block'))
  assert.equal(calls.plan.length, 0, 'no plan step')
  assert.ok(seen(view, /Written to \.claude\/settings\.json: 2 items/))
  assert.ok(view.find({ text: /next session/ }))
  assert.ok(view.find({ role: 'button', text: 'Undo' }))
  assert.equal(view.find({ text: 'Conferma e scrivi' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('Select all picks the allowed rows; None clears them', async () => {
  view = await mount(panel, { host: host(newCalls()), locale: 'en-US' })
  await view.press({ role: 'button', text: 'Select all' })
  assert.ok(view.find({ role: 'button', text: 'Turn off selected (2)' }))
  await view.press({ role: 'button', text: 'None' })
  assert.ok(view.find({ role: 'button', text: 'Turn off selected (0)' }))
  assert.deepEqual(view.errors, [])
})

test('a single-row button writes at once through applyBatch with one item', async () => {
  const calls = newCalls()
  view = await mount(panel, { host: host(calls), locale: 'en-US' })
  await view.press(view.findAll({ role: 'button', text: 'Turn off here' })[0])
  assert.equal(calls.batch.length, 1)
  assert.equal(calls.batch[0].items.length, 1)
  assert.equal(calls.plan.length, 0)
  assert.ok(seen(view, /Written to \.claude\/settings\.json: 1 item/))
  assert.deepEqual(view.errors, [])
})

test('the write result keeps the diff in a closed Show the change, and Undo calls undo then rescans', async () => {
  const calls = newCalls()
  const h = host(calls)
  view = await mount(panel, { host: h, locale: 'en-US' })
  await view.press(view.findAll({ role: 'button', text: 'Turn off here' })[0])
  assert.equal(view.valueOf({ label: /^Show the change/ }), false, 'the diff is closed')
  await view.toggle({ label: /^Show the change/ })
  assert.ok(JSON.stringify(view.tree()).includes('enabledPlugins'), 'the diff is shown once opened')
  const scansBefore = h.callsOf('workspace.readContext').length
  await view.press({ role: 'button', text: 'Undo' })
  assert.deepEqual(calls.undo, [{ undoId: 'u1' }])
  assert.ok(h.callsOf('workspace.readContext').length > scansBefore, 'rescanned')
  assert.ok(seen(view, 'Change undone'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
})

test('per-item failures are listed with their note', async () => {
  const h = mockHost({
    results: { 'workspace.readContext': { branch: 'main', displayName: 'repo', terminals: [] } },
    requests: {
      'ballast.scan': () => sampleScan,
      'ballast.applyBatch': (input) => ({
        results: input.items.map((i, n) => (n === 0 ? { itemId: i.itemId, ok: true } : { itemId: i.itemId, ok: false, error: { code: 'alreadyThisWay' as const } })),
        writes: [{ file: '/w/.claude/settings.json', relFile: '.claude/settings.json', diff: '', undoId: 'u2', count: 1 }]
      })
    }
  })
  view = await mount(panel, { host: h, locale: 'en-US' })
  await view.press({ role: 'button', text: 'Select all' })
  await view.press({ role: 'button', text: 'Turn off selected (2)' })
  assert.ok(view.find({ text: /Not written/ }))
  assert.ok(view.find({ text: /The chosen file already says so/ }))
  assert.deepEqual(view.errors, [])
})

test('a disabled checkbox carries the reason', async () => {
  view = await mount(panel, { host: host(newCalls()), locale: 'en-US' })
  await view.toggle({ label: /^Settings/ })
  await view.toggle({ label: 'Show plugin skills' })
  await view.toggle({ label: /^Skills ·/ })
  const box = view.find({ label: 'azure-deploy' })
  assert.ok(box, 'the skill row has a checkbox')
  const props = box.props as { disabled?: boolean; description?: string }
  assert.equal(props.disabled, true)
  assert.match(props.description ?? '', /turn off the plugin azure@acme/)
  assert.deepEqual(view.errors, [])
})

test('the panel is laid out Folder, agent line, Estimated context, Settings, then the groups', async () => {
  view = await mount(panel, { host: host(newCalls()), locale: 'en-US' })
  const tree = JSON.stringify(view.tree())
  const at = (needle: string) => {
    const i = tree.indexOf(needle)
    assert.ok(i >= 0, needle + ' is drawn')
    return i
  }
  const order = [at('Folder'), at('active account in Orca'), at('Estimated context'), at('Settings'), at('Plugins · Active')]
  assert.deepEqual(order, [...order].sort((x, y) => x - y))
  assert.ok(at('Good to know') > order[4], 'warnings come last')
  assert.deepEqual(view.errors, [])
})

test('a plugin skill cannot be blocked on its own', async () => {
  view = await mount(panel, { host: host(newCalls()), locale: 'en-US' })
  await view.toggle({ label: /^Settings/ })
  await view.toggle({ label: 'Show plugin skills' })
  await view.toggle({ label: /^Skills ·/ })
  assert.ok(view.find({ label: 'azure-deploy' }))
  const blocks = view.findAll({ role: 'button', text: 'Turn off here' })
  const props = blocks[blocks.length - 1].props as { disabled?: boolean; tooltip?: string }
  assert.equal(props.disabled, true)
  assert.match(props.tooltip ?? '', /turn off the plugin azure@acme/)
  assert.deepEqual(view.errors, [])
})

function hostWith(scan: typeof sampleScan, calls: { scans: unknown[] } = { scans: [] }) {
  return mockHost({
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'repo', terminals: [{ id: 'term_1' }] },
      'agents.list': { agents: [{ terminalId: null, title: null, agent: 'claude', state: 'working', stateStartedAt: 1234 }] }
    },
    requests: {
      'ballast.scan': (input) => {
        calls.scans.push(input)
        return scan
      }
    }
  })
}

test('there is no folder field: the folder is read-only information', async () => {
  const calls = { scans: [] as unknown[] }
  view = await mount(panel, { host: hostWith(sampleScan, calls), locale: 'en-US' })
  await view.toggle({ label: /^Settings/ })
  assert.equal(view.find({ label: 'Folder' }), null, 'no folder select')
  assert.equal(view.find({ label: /Altra cartella/ }), null, 'no free-path input')
  assert.equal(view.find({ label: /Segui il workspace/ }), null)
  assert.ok(view.find({ text: /repo · \/work\/repo/ }), 'the folder name and path are shown')
  // The panel sends the focus it sees, never a folder.
  const sent = calls.scans[0] as { workspace?: { terminals: { id: string }[] }; agents?: { stateStartedAt: number }[]; folder?: string }
  assert.deepEqual(sent.workspace?.terminals, [{ id: 'term_1' }])
  assert.equal(sent.agents?.[0].stateStartedAt, 1234)
  assert.equal(sent.folder, undefined)
  assert.deepEqual(view.errors, [])
})

test('off and not-installed rows sit in Off with their state badge', async () => {
  const notInstalled = { ...sampleScan.items[0], id: 'plugin:ghost@acme', name: 'ghost@acme', state: 'not-installed' as const }
  view = await mount(panel, { host: hostWith({ ...sampleScan, items: [...sampleScan.items, notInstalled] }), locale: 'en-US' })
  assert.equal(view.find({ label: 'ghost@acme' }), null, 'not in On')
  await view.select({ label: 'Plugins: status' }, 'off')
  assert.ok(view.find({ label: 'noisy@acme' }))
  assert.ok(view.find({ label: 'ghost@acme' }))
  assert.ok(view.find({ text: 'not installed' }))
  assert.deepEqual(view.errors, [])
})

const twoAgents = { ...sampleScan, agentsPresent: ['claude-code' as const, 'codex' as const] }

test('with both agents present a Claude | Codex switch shows; there is no Profilo select and no refresh button', async () => {
  view = await mount(panel, { host: hostWith(twoAgents), locale: 'en-US' })
  const tabs = view.find({ label: 'Agent' })
  assert.ok(tabs, 'the switch is there')
  assert.equal((tabs.props as { value?: string }).value, 'claude-code')
  assert.ok(view.find({ role: 'tab', text: 'Claude' }) && view.find({ role: 'tab', text: 'Codex' }))
  assert.equal(view.find({ label: 'Profilo' }), null)
  assert.equal(view.find({ label: 'Aggiorna' }), null)
  assert.ok(view.find({ text: /Claude · dev@example.com · active account in Orca/ }), 'the info line has no "automatico" wording')
  assert.deepEqual(view.errors, [])
})

test('with one agent present there is no switch; picking an agent is sent with the next scan', async () => {
  view = await mount(panel, { host: hostWith(sampleScan), locale: 'en-US' })
  assert.equal(view.find({ label: 'Agent' }), null)
  await view.unmount?.()
  const calls = { scans: [] as unknown[] }
  view = await mount(panel, { host: hostWith(twoAgents, calls), locale: 'en-US' })
  assert.equal((calls.scans[0] as { agent?: string | null }).agent, null, 'nothing picked yet')
  await view.select({ label: 'Agent' }, 'codex')
  assert.equal((calls.scans[calls.scans.length - 1] as { agent?: string }).agent, 'codex')
  assert.deepEqual(view.errors, [])
})

test('no supported agent: only the short message, nothing else', async () => {
  const none = { ...sampleScan, agentsPresent: [], folder: '', folderSource: 'none' as const, items: [], workspaceHint: 'repo', candidates: [] }
  view = await mount(panel, { host: hostWith(none), locale: 'en-US' })
  assert.ok(view.find({ text: /No agent in this workspace/ }))
  assert.ok(view.find({ text: /Data shows up as soon as you start a Claude Code or Codex agent/ }))
  const tree = JSON.stringify(view.tree())
  for (const gone of ['Folder', 'Estimated context', 'Settings', 'Workspace not recognized', 'Agent']) assert.ok(!tree.includes(gone), gone + ' is not drawn')
  assert.deepEqual(view.errors, [])
})

test('a Codex scan writes to the shared file only and says when the project is not trusted', async () => {
  const codexScan = {
    ...sampleScan,
    agent: 'codex' as const,
    profile: { ...sampleScan.profile, agent: 'codex' as const, source: 'orca-active' as const },
    projectTrusted: false,
    targets: { shared: { file: '.codex/config.toml', exists: false }, personal: { file: '', exists: false } }
  }
  view = await mount(panel, { host: hostWith(codexScan), locale: 'en-US' })
  assert.ok(view.find({ text: /Project not trusted by Codex/ }))
  assert.ok(view.find({ text: /Codex · / }), 'the header names the agent')
  assert.ok(view.find({ text: /Shared · \.codex\/config\.toml/ }))
  assert.deepEqual(view.errors, [])
})

test('an ambiguous workspace shows the notice and only the candidates; picking one asks the worker to remember it', async () => {
  const calls = { scans: [] as unknown[] }
  const ambiguous = {
    ...sampleScan,
    folder: '',
    folderSource: 'ambiguous' as const,
    items: [],
    workspaceHint: 'main',
    candidates: [
      { id: 'r1::/a', name: 'main', path: '/work/a', branch: 'main' },
      { id: 'r2::/b', name: 'main', path: '/work/b', branch: 'main' }
    ]
  }
  view = await mount(panel, { host: hostWith(ambiguous, calls), locale: 'en-US' })
  assert.ok(view.find({ text: /This workspace is not recognized yet: it attaches by itself as soon as an agent works in one of its tabs/ }))
  const select = view.find({ label: /Or pick which folder it is/ })
  assert.ok(select)
  assert.equal((select.props as { options: unknown[] }).options.length, 2)
  await view.select({ label: /Or pick which folder it is/ }, 'r2::/b')
  assert.equal((calls.scans[calls.scans.length - 1] as { choose?: string }).choose, 'r2::/b')
  assert.deepEqual(view.errors, [])
})

test('with no focused workspace the panel says so and offers nothing to pick', async () => {
  const none = { ...sampleScan, folder: '', folderSource: 'none' as const, items: [], candidates: [] }
  view = await mount(panel, { host: hostWith(none), locale: 'en-US' })
  assert.ok(view.find({ text: /No active workspace/ }))
  assert.equal(view.find({ label: /Oppure scegli/ }), null)
  assert.deepEqual(view.errors, [])
})

test('an agent appearing in the workspace rescans once and shows the switch; an unchanged set does not rescan', async () => {
  let agents = [{ terminalId: null, title: null, agent: 'claude', state: 'working', stateStartedAt: 1 }]
  let scans = 0
  const h = mockHost({
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'repo', terminals: [] },
      'agents.list': () => ({ agents })
    },
    requests: {
      'ballast.scan': () => {
        scans++
        return { ...sampleScan, agentsPresent: agents.some((a) => a.agent === 'codex') ? ['claude-code' as const, 'codex' as const] : ['claude-code' as const] }
      }
    }
  })
  view = await mount(panel, { host: h, locale: 'en-US' })
  const event = { workspaceId: 'w', paneKey: 'p', state: 'working' as const, receivedAt: 1 }
  const settle = () => new Promise((r) => setTimeout(r, 700))
  const first = scans
  for (let i = 0; i < 3; i++) await view.emit('agent.status.changed', event)
  await settle()
  assert.equal(scans, first, 'same agents: no rescan, however many events')
  agents = [...agents, { terminalId: null, title: null, agent: 'codex', state: 'working', stateStartedAt: 2 }]
  for (let i = 0; i < 3; i++) await view.emit('agent.status.changed', event)
  await settle()
  await view.settled()
  assert.equal(scans, first + 1, 'a burst of events gives one rescan')
  assert.ok(view.find({ label: 'Agent' }), 'the switch is there')
  assert.deepEqual(view.errors, [])
})

test('the claude.ai connectors group shows for Claude and is gone for Codex', async () => {
  view = await mount(panel, { host: host(newCalls()), locale: 'en-US' })
  assert.ok(seen(view, /^claude\.ai connectors ·/), 'Claude keeps the group')
  await view.unmount()
  const codexScan = {
    ...sampleScan,
    agent: 'codex' as const,
    profile: { ...sampleScan.profile, agent: 'codex' as const },
    items: sampleScan.items.filter((i) => i.kind !== 'connector')
  }
  view = await mount(panel, { host: hostWith(codexScan), locale: 'en-US' })
  assert.ok(seen(view, /^Plugins ·/))
  assert.ok(!JSON.stringify(view.tree()).includes('claude.ai connectors'), 'no connector group for Codex')
  assert.deepEqual(view.errors, [])
})

test('the search box filters a group by name or origin; Select all and the bulk button follow it', async () => {
  view = await mount(panel, { host: host(newCalls()), locale: 'en-US' })
  assert.ok(view.find({ label: 'azure@acme' }) && view.find({ label: 'helper@acme' }))
  await view.type({ label: 'Search' }, 'AZU')
  assert.ok(view.find({ label: 'azure@acme' }))
  assert.equal(view.find({ label: 'helper@acme' }), null, 'a non-matching row is hidden')
  assert.ok(seen(view, 'On (2)'), 'the tab count stays the total')
  await view.press({ role: 'button', text: 'Select all' })
  assert.ok(view.find({ role: 'button', text: 'Turn off selected (1)' }), 'only the visible row is picked')
  await view.type({ label: 'Search' }, 'zzz')
  assert.ok(view.find({ text: 'No item matches the search.' }))
  assert.ok(view.find({ role: 'button', text: 'Turn off selected (0)' }), 'a hidden row is not acted on')
  assert.deepEqual(view.errors, [])
})

test('the panel follows Orca’s language: Italian when it is Italian', async () => {
  view = await mount(panel, { host: host(newCalls()), locale: 'it-IT' })
  assert.ok(seen(view, 'Accesi (2)'))
  assert.ok(view.find({ text: /~2,4k token/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
  view = await mount(panel, { host: host(newCalls()), locale: 'en-US' })
  assert.ok(seen(view, 'On (2)'))
})
