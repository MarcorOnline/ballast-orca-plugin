// Ballast's panel: draws what the worker reports and asks it to plan and apply changes. It never
// reads or writes files itself. Every string comes from ./strings.ts.
import {
  atom,
  env,
  Badge,
  Box,
  Button,
  Callout,
  Checkbox,
  Code,
  CodeView,
  Collapsible,
  EmptyState,
  Heading,
  host,
  Input,
  KeyValue,
  on,
  plugin,
  RadioGroup,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  shell,
  Skeleton,
  Stack,
  Switch,
  Tab,
  Tabs,
  Text,
  update,
  type PanelContext,
  type Tone
} from 'orca'
import type {
  AgentId,
  Item,
  ItemKind,
  Note,
  Op,
  ScanResult,
  WriteTarget
} from './model.ts'
import { agentsPresent, ITEM_KINDS, OPS } from './model.ts'
import type { AgentHint, EditInput, ScanInput } from './protocol.ts'
import './protocol.ts'
import { formatTokens, s, setLocale, t } from './strings.ts'

// ------------------------------------------------------------------ state

const result = atom<ScanResult | null>(null)
const loading = atom(false)
/** What the last write (or undo) did: a callout with the failures, the redacted diff and the undo ids. */
interface Flash {
  tone: Tone
  title: string
  body?: string
  /** One line per item that was not written. */
  lines?: string[]
  diffs?: { relFile: string; diff: string }[]
  undoIds?: string[]
}
const flash = atom<Flash | null>(null)
/** Ticked rows, per group and tab (`<kind>/<tab>`), as item ids. Not persisted. */
const selected = atom<Record<string, string[]>>({})
/** The search text of each group (by kind), shared by its two tabs. Not persisted. */
const filters = atom<Record<string, string>>({})
const arrivals = atom<string[]>([])
/** The last scan's error; the next good scan clears it (a request that fails while the worker starts is not news). */
const scanError = atom<string | null>(null)

/** The agent the person last picked with the switch in this workspace ('' when none): persisted per workspace. */
const agentPick = atom('agentPick', '', { persist: 'workspace' })
const target = atom<WriteTarget>('target', 'shared', { persist: 'plugin' })
const showPluginSkills = atom('showPluginSkills', false, { persist: 'plugin' })

// ------------------------------------------------------------------ actions

function noteText(n: Note): string {
  return t(s.note[n.code], n.args ?? {})
}

function errorText(error: unknown): string {
  const e = error as { code?: string; message?: string }
  return e?.message ?? e?.code ?? String(error)
}

/** Only the newest scan may draw: a slow older one must not overwrite it. */
let scanSeq = 0

/**
 * What the panel knows about the focus: `workspace.readContext` and `agents.list`. The worker
 * turns them into a folder; the panel never sees a path until the scan comes back.
 */
async function focusInput(): Promise<ScanInput> {
  const ctx = (await host.call('workspace.readContext').catch(() => null)) as ScanInput['workspace']
  const listed = (await host.call('agents.list').catch(() => ({ agents: [] }))) as { agents: AgentHint[] }
  return { workspace: ctx, agents: listed.agents, locale: env.locale }
}

async function rescan(choose?: string): Promise<void> {
  const seq = ++scanSeq
  set(loading, true)
  try {
    const answer = await plugin.request(
      'ballast.scan',
      { ...(await focusInput()), ...(choose ? { choose } : {}), agent: (read(agentPick) as AgentId) || null },
      { timeoutMs: 60000 }
    )
    if (seq === scanSeq) {
      set(result, answer)
      set(scanError, null)
      update(selected, (prev) => pruneSelection(prev, answer))
    }
  } catch (error) {
    if (seq === scanSeq) set(scanError, errorText(error))
  } finally {
    if (seq === scanSeq) set(loading, false)
  }
}

/** Drops ticked ids whose item is gone, or no longer sits in the tab it was ticked in. */
function pruneSelection(prev: Record<string, string[]>, scan: ScanResult): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, ids] of Object.entries(prev)) {
    const tab = key.slice(key.indexOf('/') + 1) as Tab
    const keep = ids.filter((id) => {
      const item = scan.items.find((i) => i.id === id)
      return item !== undefined && tabOf(item) === tab
    })
    if (keep.length > 0) out[key] = keep
  }
  return out
}

/** The write target the commands use: Codex has only the shared file. */
function targetFor(scan: ScanResult): WriteTarget {
  return scan.agent === 'codex' ? 'shared' : read(target)
}

/** Writes `op` for these items straight away, in one request, then shows what happened. */
async function writeItems(ids: string[], op: Op): Promise<void> {
  const scan = read(result)
  if (!scan || ids.length === 0) return
  const items: EditInput[] = ids.map((itemId) => ({
    folder: scan.folder,
    agent: scan.profile.agent,
    configDir: scan.profile.configDir,
    itemId,
    op,
    target: targetFor(scan)
  }))
  set(flash, null)
  try {
    const answer = await plugin.request('ballast.applyBatch', { items }, { timeoutMs: 60000 })
    const nameOf = (id: string) => scan.items.find((i) => i.id === id)?.name ?? id
    const lines = answer.results
      .filter((r) => !r.ok)
      .map((r) => t(s.itemFailure, { name: nameOf(r.itemId), why: r.error ? noteText(r.error) : s.errorTitle }))
    const count = answer.writes.reduce((n, w) => n + w.count, 0)
    if (answer.writes.length === 0) {
      set(flash, { tone: 'warning', title: s.errorTitle, lines })
    } else {
      const file = answer.writes.map((w) => w.relFile).join(', ')
      set(flash, {
        tone: lines.length > 0 ? 'warning' : 'success',
        title: t(count === 1 ? s.writtenTitleOne : s.writtenTitle, { file, count }),
        body: s.writtenBody,
        lines,
        diffs: answer.writes.map((w) => ({ relFile: w.relFile, diff: w.diff })),
        undoIds: answer.writes.map((w) => w.undoId)
      })
    }
  } catch (error) {
    set(flash, { tone: 'danger', title: s.errorTitle, body: errorText(error) })
  }
  set(selected, {})
  await rescan()
}

/** Puts the files of the last write back, then scans again. */
async function undoLast(undoIds: string[]): Promise<void> {
  const files: string[] = []
  const lines: string[] = []
  for (const undoId of undoIds) {
    try {
      const answer = await plugin.request('ballast.undo', { undoId })
      if (answer.ok) files.push(baseName(answer.file ?? ''))
      else lines.push(answer.error ? noteText(answer.error) : s.errorTitle)
    } catch (error) {
      lines.push(errorText(error))
    }
  }
  set(
    flash,
    lines.length > 0
      ? { tone: 'warning', title: s.errorTitle, lines }
      : { tone: 'success', title: s.undoneTitle, body: t(s.undoneBody, { file: files.join(', ') }) }
  )
  set(selected, {})
  await rescan()
}

/** True when both lists hold the same agents, whatever the order. */
function sameAgents(a: AgentId[], b: AgentId[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id))
}

/** Agent events come in bursts: wait, then scan only if the supported agents present changed. */
const AGENT_DEBOUNCE_MS = 500
async function rescanIfAgentsChanged(): Promise<void> {
  const listed = (await host.call('agents.list').catch(() => null)) as { agents: AgentHint[] } | null
  if (!listed) return
  if (!sameAgents(agentsPresent(listed.agents), read(result)?.agentsPresent ?? [])) await rescan()
}

export function setup(ctx: PanelContext): void {
  let agentTimer: ReturnType<typeof setTimeout> | null = null
  ctx.subscriptions.push(
    on('agent.status.changed', () => {
      if (agentTimer) clearTimeout(agentTimer)
      agentTimer = setTimeout(() => void rescanIfAgentsChanged(), AGENT_DEBOUNCE_MS)
    }),
    { dispose: () => agentTimer && clearTimeout(agentTimer) },
    // The panel follows the focused workspace, whatever tab is open there.
    on('workspace.changed', () => void rescan()),
    // The worker learned which folder the focused workspace is.
    plugin.on('ballast.resolved', () => void rescan()),
    plugin.on('ballast.arrivals', (payload) => {
      if (payload.folder === read(result)?.folder) {
        set(arrivals, payload.names)
        void rescan()
      }
    })
  )
  void rescan()
}

// ------------------------------------------------------------------ pieces

const STATE_TONE: Record<Item['state'], Tone> = {
  on: 'success',
  off: 'neutral',
  'on-demand': 'accent',
  pending: 'warning',
  'not-installed': 'warning'
}

function originLabel(item: Item): string {
  if (item.origin.plugin) return t(s.originPlugin, { plugin: item.origin.plugin })
  return s.level[item.origin.level]
}

function weightLabel(item: Item): string {
  if (item.parent && item.state === 'on') return `${t(s.tokensLine, { tokens: formatTokens(item.tokens) })} · ${s.tokensInParent}`
  if (item.state === 'on' || item.state === 'on-demand') return t(s.tokensLine, { tokens: formatTokens(item.tokensIfOn) })
  return t(s.tokensIfOn, { tokens: formatTokens(item.tokensIfOn) })
}

/** Off and not-installed rows draw their name in grey, next to the state badge. */
function isOff(item: Item): boolean {
  return item.state === 'off' || item.state === 'not-installed'
}

type Tab = 'on' | 'off'

/** Accesi: on and on-demand. Spenti: off, not installed and pending. */
function tabOf(item: Item): Tab {
  return item.state === 'on' || item.state === 'on-demand' ? 'on' : 'off'
}

/** What a tab's checkboxes and bulk button do: On switches off, Off switches on. */
const TAB_OP: Record<Tab, 'block' | 'enable'> = { on: 'block', off: 'enable' }

function ItemRow({ item, tgt, tab, picked, onPick }: { item: Item; tgt: WriteTarget; tab: Tab; picked: boolean; onPick: (on: boolean) => void }) {
  const actions = item.actions[tgt]
  const bulk = actions[TAB_OP[tab]]
  const extra: string[] = []
  if (item.toolCount !== undefined) extra.push(t(s.tools, { count: item.toolCount }))
  return (
    <Box key={item.id} border radius="sm" padding="sm" gap="xs">
      <Row justify="between" gap="sm">
        <Checkbox
          label={item.name}
          description={bulk.allowed ? undefined : bulk.notes.map(noteText).join(' ')}
          checked={bulk.allowed && picked}
          disabled={!bulk.allowed}
          onChange={onPick}
        />
        <Row gap="xs">
          {item.isNew ? <Badge tone="warning">{s.newBadge}</Badge> : null}
          <Badge tone={STATE_TONE[item.state]}>{s.state[item.state]}</Badge>
        </Row>
      </Row>
      <Text size="xs" muted>
        {[
          ...(item.kind === 'plugin' ? [] : [t(s.originLine, { origin: originLabel(item) })]),
          t(s.decidedBy, { level: s.level[item.decidedBy.level] }),
          weightLabel(item),
          ...extra
        ].join(' · ')}
      </Text>
      {item.decidedBy.key && item.kind !== 'plugin' ? (
        <Text size="xs" muted>
          <Code>{item.decidedBy.key}</Code>
        </Text>
      ) : null}
      {item.notes.map((n) => (
        <Text size="xs" tone="warning">
          {noteText(n)}
        </Text>
      ))}
      <Row gap="xs" wrap>
        {OPS.map((op) => {
          const a = actions[op]
          const why = a.notes.map(noteText).join(' ')
          return (
            <Button
              key={`${item.id}#${op}`}
              size="xs"
              variant={op === 'reset' ? 'ghost' : 'outline'}
              tone={op === 'block' ? 'danger' : op === 'enable' ? 'success' : 'neutral'}
              disabled={!a.allowed}
              tooltip={a.allowed ? (a.mechanism ?? s.op[op]) : why || s.op[op]}
              onPress={() => writeItems([item.id], op)}
            >
              {s.op[op]}
            </Button>
          )
        })}
        {item.kind === 'connector' ? (
          <Button size="xs" variant="ghost" icon="open-external" onPress={() => shell.openExternal(s.connectorsUrl)}>
            {s.manageOnline}
          </Button>
        ) : null}
      </Row>
    </Box>
  )
}

function folderRank(item: Item): number {
  return item.decidedBy.level === 'project' || item.decidedBy.level === 'local' ? 0 : 1
}

function visibleItems(scan: ScanResult, kind: ItemKind): Item[] {
  const pluginSkills = read(showPluginSkills)
  return scan.items
    .filter((i) => i.kind === kind)
    .filter((i) => kind !== 'skill' || !i.parent || pluginSkills)
    // What this folder decides comes first, then the heaviest.
    .sort((a, b) => folderRank(a) - folderRank(b) || b.tokensIfOn - a.tokensIfOn || a.name.localeCompare(b.name))
}

/** One tab of a group: the select-all toolbar with the bulk action, then the rows. */
function TabBody({ kind, tab, items, tgt }: { kind: ItemKind; tab: Tab; items: Item[]; tgt: WriteTarget }) {
  const key = `${kind}/${tab}`
  const op = TAB_OP[tab]
  const ticked = read(selected)[key] ?? []
  const query = (read(filters)[kind] ?? '').trim().toLowerCase()
  const shown = query ? items.filter((i) => `${i.name} ${originLabel(i)}`.toLowerCase().includes(query)) : items
  // Select all and the bulk button only see the rows the search leaves on screen.
  const allowed = shown.filter((i) => i.actions[tgt][op].allowed).map((i) => i.id)
  const chosen = ticked.filter((id) => allowed.includes(id))
  const pick = (ids: string[]) => update(selected, (prev) => ({ ...prev, [key]: ids }))
  if (items.length === 0) {
    return (
      <Text muted size="xs">
        {s.emptyTab}
      </Text>
    )
  }
  return (
    <Stack gap="xs">
      <Input
        label={s.searchLabel}
        labelHidden
        type="search"
        placeholder={s.searchPlaceholder}
        value={read(filters)[kind] ?? ''}
        onChange={(v) => update(filters, (prev) => ({ ...prev, [kind]: v }))}
      />
      <Row gap="xs" wrap>
        <Button size="xs" variant="ghost" onPress={() => pick(allowed)}>
          {s.selectAll}
        </Button>
        <Button size="xs" variant="ghost" onPress={() => pick([])}>
          {s.selectNone}
        </Button>
        <Button
          size="xs"
          variant="outline"
          tone={op === 'block' ? 'danger' : 'success'}
          disabled={chosen.length === 0}
          onPress={() => writeItems(chosen, op)}
        >
          {t(s.bulk[op], { count: chosen.length })}
        </Button>
      </Row>
      {shown.length === 0 ? (
        <Text muted size="xs">
          {s.noMatch}
        </Text>
      ) : null}
      {shown.map((item) => (
        <ItemRow
          item={item}
          tgt={tgt}
          tab={tab}
          picked={ticked.includes(item.id)}
          onPick={(on) => pick(on ? [...ticked.filter((id) => id !== item.id), item.id] : ticked.filter((id) => id !== item.id))}
        />
      ))}
    </Stack>
  )
}

function Group({ scan, kind }: { scan: ScanResult; kind: ItemKind }) {
  // "Attivi: x/y" counts every item of the kind for this agent, plugin skills included even when
  // the "show plugin skills" filter hides them from the tabs: the header is the full picture.
  const all = scan.items.filter((i) => i.kind === kind)
  const shown = visibleItems(scan, kind)
  const on = shown.filter((i) => tabOf(i) === 'on')
  const off = shown.filter((i) => tabOf(i) === 'off')
  const title = t(s.groupTitle, {
    kind: s.kind[kind],
    active: all.filter((i) => tabOf(i) === 'on').length,
    count: all.length,
    tokens: formatTokens(scan.totals.byKind[kind])
  })
  const tgt = read(target)
  return (
    <Collapsible key={kind} title={title} defaultOpen={kind === 'plugin'}>
      <Tabs label={t(s.tabsLabel, { kind: s.kind[kind] })} defaultValue="on">
        <Tab value="on" label={t(s.tabOn, { count: on.length })}>
          <TabBody kind={kind} tab="on" items={on} tgt={tgt} />
        </Tab>
        <Tab value="off" label={t(s.tabOff, { count: off.length })}>
          <TabBody kind={kind} tab="off" items={off} tgt={tgt} />
        </Tab>
      </Tabs>
    </Collapsible>
  )
}

/** The last write: what was written, what was not, the redacted diff and the undo. */
function Written() {
  const f = read(flash)
  if (!f) return null
  return (
    <Callout tone={f.tone} title={f.title}>
      <Stack gap="xs">
        {f.body ? <Text size="sm">{f.body}</Text> : null}
        {f.lines && f.lines.length > 0 ? (
          <Stack gap="xs">
            <Text size="xs" weight="medium">
              {s.notWritten}
            </Text>
            {f.lines.map((line) => (
              <Text size="xs" tone="warning">
                {line}
              </Text>
            ))}
          </Stack>
        ) : null}
        {f.diffs && f.diffs.length > 0 ? (
          <Collapsible title={s.showDiff}>
            <Stack gap="xs">
              {f.diffs.map((d) => (
                <CodeView code={d.diff} language="diff" label={d.relFile} maxHeight="md" />
              ))}
            </Stack>
          </Collapsible>
        ) : null}
        {f.undoIds && f.undoIds.length > 0 ? (
          <Row gap="xs">
            <Button size="xs" variant="outline" onPress={() => undoLast(f.undoIds ?? [])}>
              {s.undo}
            </Button>
          </Row>
        ) : null}
      </Stack>
    </Callout>
  )
}

/** Workspace names are often the branch; the folder name tells repos apart. */
function workspaceLabel(w: { name: string; path: string; branch: string | null }): string {
  const parts = w.path.split(/[\\/]/).filter(Boolean)
  const folder = parts[parts.length - 1] ?? w.path
  const base = w.name && w.name !== folder ? `${folder} · ${w.name}` : folder
  return w.branch ? `${base} (${w.branch})` : base
}

/** Claude | Codex, only when both are in the workspace; the pick is remembered for this workspace. */
function AgentSwitch({ scan }: { scan: ScanResult }) {
  if (scan.agentsPresent.length < 2) return null
  return (
    <Tabs
      label={s.agentSwitchLabel}
      value={scan.agent}
      onChange={(v) => {
        set(agentPick, v)
        void rescan()
      }}
    >
      {scan.agentsPresent.map((id) => (
        <Tab value={id} label={s.agentName[id]}>
          {null}
        </Tab>
      ))}
    </Tabs>
  )
}

function Controls({ scan }: { scan: ScanResult | null }) {
  const codex = scan?.agent === 'codex'
  const labels = codex ? s.targetCodex : s.target
  const hints = codex ? s.targetHintCodex : s.targetHint
  return (
    <Stack gap="sm">
      {scan ? (
        <KeyValue
          items={[{ label: scan.profile.agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR', value: scan.profile.configDir, code: true }]}
        />
      ) : null}
      <Row gap="md" wrap>
        <Switch label={s.showPluginSkills} checked={read(showPluginSkills)} onChange={(v) => set(showPluginSkills, v)} />
      </Row>
      <RadioGroup
        label={s.targetLabel}
        value={codex ? 'shared' : read(target)}
        orientation="vertical"
        options={(['shared', 'personal'] as const).map((v) => ({
          value: v,
          label: labels[v],
          description: hints[v],
          disabled: codex && v === 'personal'
        }))}
        onChange={(v) => set(target, v as WriteTarget)}
      />
    </Stack>
  )
}

function Summary({ scan }: { scan: ScanResult }) {
  const heavy = scan.totals.heaviest
    .slice(0, 3)
    .map((id) => scan.items.find((i) => i.id === id))
    .filter((i): i is Item => i !== undefined)
  return (
    <Box border radius="md" padding="sm" gap="sm" background="muted">
      <Row justify="between">
        <Heading level={3}>{s.totalTitle}</Heading>
        <Badge tone="accent">{t(s.totalValue, { tokens: formatTokens(scan.totals.tokens) })}</Badge>
      </Row>
      <Text size="xs" weight="medium">
        {s.heaviest}
      </Text>
      {heavy.map((i) => (
        <Text size="xs">
          {`~${formatTokens(i.tokens)} · ${s.kind[i.kind]} · ${i.name}`}
        </Text>
      ))}
      <Text size="xs" muted>
        {s.estimateNote}
      </Text>
      {scan.sessions.count > 0 && scan.sessions.latestAt ? (
        <Text size="xs" muted>
          {t(s.sessions, { count: scan.sessions.count })} <RelativeTime at={scan.sessions.latestAt} />
          {scan.sessions.skippedDesktop ? ` · ${t(s.skippedDesktop, { count: scan.sessions.skippedDesktop })}` : ''}
        </Text>
      ) : (
        <Text size="xs" muted>
          {s.noSessions}
        </Text>
      )}
    </Box>
  )
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function profileLine(scan: ScanResult): string {
  const p = scan.profile
  const who = [s.agentName[p.agent], p.account ?? p.orcaAccountId ?? '—'].join(' · ')
  return `${who} · ${s.profileSource[p.source]}`
}

/** Cartella: the folder being read and how it was found; when the focus is ambiguous, the candidate picker. */
function FolderSection({ scan, busy }: { scan: ScanResult | null; busy: boolean }) {
  if (!scan) return busy ? <Skeleton lines={6} label={s.loading} /> : null
  if (scan.folder) {
    const from = s.folderFrom[scan.folderSource]
    return (
      <Stack gap="xs">
        <KeyValue items={[{ label: s.folderLabel, value: `${baseName(scan.folder)} · ${scan.folder}`, code: true }]} />
        {from ? (
          <Text size="xs" muted>
            {from}
          </Text>
        ) : null}
      </Stack>
    )
  }
  if (scan.folderSource === 'ambiguous') {
    return (
      <Stack gap="sm">
        <EmptyState icon="folder" title={s.ambiguousTitle} description={s.ambiguousBody} />
        {scan.candidates.length > 0 ? (
          <Select
            label={t(s.candidateLabel, { name: scan.workspaceHint ?? '' })}
            placeholder={s.candidatePlaceholder}
            options={scan.candidates.map((w) => ({ value: w.id, label: workspaceLabel(w) }))}
            onChange={(id) => void rescan(id)}
          />
        ) : null}
      </Stack>
    )
  }
  return <EmptyState icon="folder" title={s.noFolderTitle} description={s.noFolderBody} />
}

export default function Panel() {
  setLocale(env.locale)
  const scan = read(result)
  const busy = read(loading)
  return (
    <Stack gap="md">
      <Heading>{s.title}</Heading>
      {scan && scan.agentsPresent.length === 0 && scan.workspaceHint !== undefined ? (
        <EmptyState icon="agent" title={s.noAgentTitle} description={s.noAgentBody} />
      ) : (
        <Content scan={scan} busy={busy} />
      )}
    </Stack>
  )
}

/** Everything below the title; not drawn while no supported agent is in the workspace. */
function Content({ scan, busy }: { scan: ScanResult | null; busy: boolean }) {
  const failed = read(scanError)
  const arrived = read(arrivals)
  // Codex has no personal project file: its commands always write the shared one.
  const tgt = scan?.agent === 'codex' ? 'shared' : read(target)
  return (
    <Stack gap="md">
      <FolderSection scan={scan} busy={busy} />
      <Stack gap="xs">
        {scan ? <AgentSwitch scan={scan} /> : null}
        {scan ? (
          <Text size="xs" muted>
            {profileLine(scan)}
          </Text>
        ) : null}
      </Stack>
      {scan && scan.folder ? <Summary scan={scan} /> : null}
      <Collapsible title={t(s.settingsTitle, { target: (scan?.agent === 'codex' ? s.targetCodex : s.target)[tgt] })}>
        <Controls scan={scan} />
      </Collapsible>
      {scan && !scan.profile.exists ? <Callout tone="danger">{s.profileMissing}</Callout> : null}
      {scan && scan.projectTrusted === false ? (
        <Callout tone="warning" title={s.untrustedTitle}>
          <Text size="sm">{s.untrustedBody}</Text>
        </Callout>
      ) : null}
      {failed ? (
        <Callout tone="danger" title={s.errorTitle}>
          <Text size="sm">{failed}</Text>
        </Callout>
      ) : null}
      <Written />
      {arrived.length > 0 ? (
        <Callout tone="warning" title={s.arrivalsTitle} icon="bell">
          <Text size="sm">{t(s.arrivalsBody, { names: arrived.join(', ') })}</Text>
        </Callout>
      ) : null}
      {scan && scan.folder ? (
        <Stack gap="md">
          {ITEM_KINDS.filter((kind) => kind !== 'connector' || scan.agent !== 'codex').map((kind) => (
            <Group scan={scan} kind={kind} />
          ))}
          {scan.warnings.length > 0 ? (
            <Callout tone="warning" title={s.warningsTitle}>
              <Stack gap="xs">
                {scan.warnings.map((w) => (
                  <Text size="xs">{noteText(w)}</Text>
                ))}
              </Stack>
            </Callout>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  )
}
