// Every string the person reads, in one module so a translation is one file. The panel and the
// worker (notifications, status bar) both read it. `{name}` placeholders are filled by `t`.
//
// Language: English, or Italian when the language starts with "it". The panel reads Orca's UI
// language from `env.locale` ('orca'); the worker has no Orca locale API, so it starts from the
// system locale and the panel hands it Orca's on every scan (`ScanInput.locale`). `setLocale` is
// the one place that decides.
import type { AgentId, FolderSource, ItemKind, ItemState, Level, NoteCode, Op, ProfileSource, WriteTarget } from './model.ts'

export const en = {
  title: 'Ballast',
  loading: 'Rebuilding the context…',
  noFolderTitle: 'No active workspace',
  noFolderBody: 'Open a workspace in Orca: Ballast always shows the one that has focus.',
  noAgentTitle: 'No agent in this workspace',
  noAgentBody: 'Data shows up as soon as you start a Claude Code or Codex agent in a tab: for now they are the only ones supported.',
  ambiguousTitle: 'Workspace not recognized',
  ambiguousBody: 'This workspace is not recognized yet: it attaches by itself as soon as an agent works in one of its tabs.',
  candidateLabel: 'Or pick which folder it is (“{name}”)',
  candidatePlaceholder: 'Pick the folder…',
  settingsTitle: 'Settings · writes to {target}',
  folderLabel: 'Folder',
  folderFrom: {
    terminal: 'from a known terminal of the workspace',
    agent: 'from an agent active in the workspace',
    name: 'by name and branch',
    ambiguous: '',
    none: ''
  } satisfies Record<FolderSource, string>,
  agentSwitchLabel: 'Agent',
  agentName: { 'claude-code': 'Claude', codex: 'Codex' } satisfies Record<AgentId, string>,
  profileSource: {
    chosen: 'picked by hand',
    launch: 'profile the agent was launched with',
    'orca-active': 'active account in Orca',
    env: 'from CLAUDE_CONFIG_DIR / CODEX_HOME',
    default: 'default folder'
  } satisfies Record<ProfileSource, string>,
  profileMissing: 'The profile folder does not exist.',
  untrustedTitle: 'Project not trusted by Codex',
  untrustedBody: 'Codex ignores .codex/config.toml until the project is trusted: changes are still written, but have no effect.',
  targetLabel: 'Commands write to',
  target: {
    shared: 'Shared · .claude/settings.json',
    personal: 'Personal · .claude/settings.local.json'
  } satisfies Record<WriteTarget, string>,
  targetCodex: {
    shared: 'Shared · .codex/config.toml',
    personal: 'Personal · not available for Codex'
  } satisfies Record<WriteTarget, string>,
  targetHintCodex: {
    shared: 'Committed to the repo; Codex only reads it if the project is trusted.',
    personal: 'Codex has no personal project file.'
  } satisfies Record<WriteTarget, string>,
  targetHint: {
    shared: 'Committed to the repo: applies to the whole team.',
    personal: 'This machine only, not committed.'
  } satisfies Record<WriteTarget, string>,
  totalTitle: 'Estimated context',
  totalValue: '~{tokens} tokens',
  estimateNote: 'Estimate: characters / 4, on names and descriptions (whole files for memory).',
  heaviest: 'Heaviest items',
  sessions: '{count} sessions read, latest',
  skippedDesktop: '{count} from the desktop app skipped (in-process connectors)',
  noSessions: 'No session recorded for this folder.',
  kind: {
    plugin: 'Plugins',
    skill: 'Skills',
    mcp: 'MCP servers',
    connector: 'claude.ai connectors',
    memory: 'Memory'
  } satisfies Record<ItemKind, string>,
  groupTitle: '{kind} · Active: {active}/{count} · ~{tokens} tokens',
  tabsLabel: '{kind}: status',
  tabOn: 'On ({count})',
  tabOff: 'Off ({count})',
  selectAll: 'Select all',
  selectNone: 'None',
  bulk: {
    block: 'Turn off selected ({count})',
    enable: 'Turn on selected ({count})'
  },
  emptyTab: 'No items.',
  searchLabel: 'Search',
  searchPlaceholder: 'Search…',
  noMatch: 'No item matches the search.',
  state: {
    on: 'on',
    off: 'off',
    'on-demand': 'on demand',
    pending: 'pending',
    'not-installed': 'not installed'
  } satisfies Record<ItemState, string>,
  level: {
    managed: 'managed (policy)',
    user: 'user',
    project: 'project',
    local: 'local',
    plugin: 'plugin',
    state: 'user state (/mcp)',
    session: 'session',
    default: 'default',
    builtin: 'built-in'
  } satisfies Record<Level, string>,
  originLine: 'from {origin}',
  originPlugin: 'plugin {plugin}',
  decidedBy: 'decided by {level}',
  tokensLine: '~{tokens} tokens',
  tokensIfOn: '~{tokens} tokens if on',
  tokensInParent: 'counted in the plugin',
  tokensSplit: '~{total} tokens: ~{own} plugin | ~{skills} from {count} skills',
  tokensSplitOne: '~{total} tokens: ~{own} plugin | ~{skills} from 1 skill',
  tokensSplitIfOn: '~{total} tokens if on: ~{own} plugin | ~{skills} from {count} skills',
  tokensSplitIfOnOne: '~{total} tokens if on: ~{own} plugin | ~{skills} from 1 skill',
  pluginSkillsTitle: 'Skills in this plugin ({count})',
  skillOnDemand: 'on demand',
  tools: '{count} tools',
  newBadge: 'new',
  op: {
    enable: 'Turn on here',
    block: 'Turn off here',
    reset: 'Reset to default'
  } satisfies Record<Op, string>,
  writtenTitle: 'Written to {file}: {count} items',
  writtenTitleOne: 'Written to {file}: 1 item',
  writtenBody: 'Applies from the agent’s next session in this folder.',
  notWritten: 'Not written:',
  itemFailure: '{name}: {why}',
  showDiff: 'Show the change',
  undo: 'Undo',
  undoneTitle: 'Change undone',
  undoneBody: '{file} is back to how it was before the write.',
  errorTitle: 'Something went wrong',
  arrivalsTitle: 'Arrived mid-session',
  arrivalsBody: '{names}',
  manageOnline: 'Manage on claude.ai',
  connectorsUrl: 'https://claude.ai/customize/connectors',
  warningsTitle: 'Good to know',
  notifyTitle: 'Ballast: new servers in the context',
  notifyBody: '{folder}: {names}',
  statusText: '~{tokens}',
  statusTooltip: 'Estimated context for {folder} (Ballast)',
  statusNone: 'Ballast',
  note: {
    notInstalled: 'On but not installed on this machine: Claude Code offers it at startup.',
    pluginSkillNoOverride: 'Claude Code cannot turn off a single skill of a plugin: turn off the plugin {plugin}.',
    pluginServerToolsOnly: 'Turn off here removes this server’s tools with permissions.deny (they leave the context), but the server still starts: to stop it, turn off the plugin {plugin}.',
    pluginOff: 'The plugin {plugin} is off: turn the plugin on first.',
    deniedElsewhere: 'Turned off at {level} level: it cannot be turned back on from here.',
    managedDecides: 'Decided by the managed policy ({level}): no project file changes it.',
    disabledByMcpToggle: 'Turned off with /mcp for this project (in the user state file): turn it back on from /mcp.',
    rejectedElsewhere: 'Rejected in disabledMcpjsonServers at {level} level: rejection wins over approval.',
    sharedApprovalNeedsTrust: 'In a folder that is not “trusted” yet, approval in the shared file is ignored: use the personal file or accept the trust dialog.',
    pendingApproval: 'A .mcp.json server not approved yet: it does not connect until you approve it.',
    connectorsOffElsewhere: 'disableClaudeAiConnectors is set at {level} level.',
    connectorManageOnline: 'To remove it everywhere, disconnect it on claude.ai.',
    tokensUnknown: 'Unknown weight: no session has seen it connected yet.',
    onDemand: 'Loaded only when Claude works in that folder or on those files.',
    managedMemory: 'CLAUDE.md managed by the organization: it cannot be excluded.',
    excludedElsewhere: 'Excluded by claudeMdExcludes at {level} level: lists add up, it cannot be turned back on from here.',
    autoMemoryOffElsewhere: 'autoMemoryEnabled is set at {level} level, which wins over this file.',
    modelInvocationOff: 'disable-model-invocation: Claude does not see it, it can still be invoked with /name.',
    alreadyThisWay: 'The chosen file already says so.',
    denyRuleRemovesTools: 'A permissions.deny rule removes its tools from the context.',
    needsAuth: 'Waiting for authentication in the last session.',
    failed: 'Connection failed in the last session.',
    newArrival: 'Seen for the first time in the last 24 hours.',
    noEntryInFile: 'The chosen file has no entry for this item.',
    bundledSkill: 'Claude Code built-in skill.',
    allowlistBlocks: 'Not in allowedMcpServers ({level}).',
    unmatchedDeny: 'The deniedMcpServers rule “{rule}” ({level}) does not block “{server}”: the name must match exactly.',
    readError: 'Cannot read {file}.',
    noTranscripts: 'No session for this folder in the profile: connectors and late servers show up after the first session.',
    userTargetRefused: 'Ballast does not write to user-level files, the state file or CODEX_HOME.',
    notInProject: 'It does not belong to this folder.',
    denyBlocksPluginServer: 'Turned off with permissions.deny.',
    fileChanged: 'The file changed in the meantime: nothing written.',
    undoGone: 'Cannot undo: the write is no longer among those remembered (undo only works while the worker stays alive, for the last 10).',
    projectNotTrusted: 'Project not trusted: the change is written to .codex/config.toml but Codex does not read it until it is.',
    noPersonalFile: 'Codex has no personal project file: commands only write to the shared file.',
    codexPluginSkillNoOverride: 'Codex cannot turn off a single skill of a plugin per project: turn off the plugin {plugin}.',
    tomlUnsupported: 'In {file} the entry is written in a form Ballast does not edit (dotted keys or inline tables): edit it by hand.',
    noSwitchInCodex: 'Codex has no setting to exclude this file: rename it or remove it from the repo.',
    beyondDocLimit: 'Beyond the project_doc_max_bytes limit ({bytes} bytes): Codex does not read it.',
    docTruncated: 'Truncated at the project_doc_max_bytes limit ({bytes} bytes).'
  } satisfies Record<NoteCode, string>
}

export type Strings = typeof en

export const it: Strings = {
  title: 'Ballast',
  loading: 'Ricostruisco il contesto…',
  noFolderTitle: 'Nessun workspace attivo',
  noFolderBody: 'Apri un workspace in Orca: Ballast mostra sempre quello che ha il focus.',
  noAgentTitle: 'Nessun agente in questo workspace',
  noAgentBody: 'Vedrai i dati appena avvii un agente Claude o Codex in una tab: per ora sono gli unici supportati.',
  ambiguousTitle: 'Workspace non riconosciuto',
  ambiguousBody: 'Non riconosco ancora questo workspace: si aggancia da solo appena un agente lavora in una sua tab.',
  candidateLabel: 'Oppure scegli quale cartella è (“{name}”)',
  candidatePlaceholder: 'Scegli la cartella…',
  settingsTitle: 'Impostazioni · scrive in {target}',
  folderLabel: 'Cartella',
  folderFrom: {
    terminal: 'da un terminale noto del workspace',
    agent: 'da un agente attivo nel workspace',
    name: 'per nome e branch',
    ambiguous: '',
    none: ''
  } satisfies Record<FolderSource, string>,
  agentSwitchLabel: 'Agente',
  agentName: { 'claude-code': 'Claude', codex: 'Codex' } satisfies Record<AgentId, string>,
  profileSource: {
    chosen: 'scelto a mano',
    launch: 'profilo del lancio dell’agente',
    'orca-active': 'account attivo in Orca',
    env: 'da CLAUDE_CONFIG_DIR / CODEX_HOME',
    default: 'cartella predefinita'
  } satisfies Record<ProfileSource, string>,
  profileMissing: 'La cartella del profilo non esiste.',
  untrustedTitle: 'Progetto non trusted per Codex',
  untrustedBody: 'Codex ignora .codex/config.toml finché il progetto non è trusted: le modifiche si scrivono lo stesso, ma non hanno effetto.',
  targetLabel: 'I comandi scrivono in',
  target: {
    shared: 'Condiviso · .claude/settings.json',
    personal: 'Personale · .claude/settings.local.json'
  } satisfies Record<WriteTarget, string>,
  targetCodex: {
    shared: 'Condiviso · .codex/config.toml',
    personal: 'Personale · non disponibile per Codex'
  } satisfies Record<WriteTarget, string>,
  targetHintCodex: {
    shared: 'Committato nel repo; Codex lo legge solo se il progetto è trusted.',
    personal: 'Codex non ha un file di progetto personale.'
  } satisfies Record<WriteTarget, string>,
  targetHint: {
    shared: 'Committato nel repo: vale per tutto il team.',
    personal: 'Solo su questa macchina, non committato.'
  } satisfies Record<WriteTarget, string>,
  totalTitle: 'Contesto stimato',
  totalValue: '~{tokens} token',
  estimateNote: 'Stima: caratteri / 4, su nomi e descrizioni (file interi per la memoria).',
  heaviest: 'Voci più pesanti',
  sessions: '{count} sessioni lette, ultima',
  skippedDesktop: '{count} dell’app desktop escluse (connettori in-process)',
  noSessions: 'Nessuna sessione registrata per questa cartella.',
  kind: {
    plugin: 'Plugin',
    skill: 'Skill',
    mcp: 'Server MCP',
    connector: 'Connettori claude.ai',
    memory: 'Memoria'
  } satisfies Record<ItemKind, string>,
  groupTitle: '{kind} · Attivi: {active}/{count} · ~{tokens} token',
  tabsLabel: '{kind}: stato',
  tabOn: 'Accesi ({count})',
  tabOff: 'Spenti ({count})',
  selectAll: 'Seleziona tutti',
  selectNone: 'Nessuno',
  bulk: {
    block: 'Spegni selezionati ({count})',
    enable: 'Accendi selezionati ({count})'
  },
  emptyTab: 'Nessuna voce.',
  searchLabel: 'Cerca',
  searchPlaceholder: 'Cerca…',
  noMatch: 'Nessuna voce corrisponde alla ricerca.',
  state: {
    on: 'acceso',
    off: 'spento',
    'on-demand': 'su richiesta',
    pending: 'in attesa',
    'not-installed': 'non installato'
  } satisfies Record<ItemState, string>,
  level: {
    managed: 'gestito (policy)',
    user: 'utente',
    project: 'progetto',
    local: 'locale',
    plugin: 'plugin',
    state: 'stato utente (/mcp)',
    session: 'sessione',
    default: 'default',
    builtin: 'integrata'
  } satisfies Record<Level, string>,
  originLine: 'da {origin}',
  originPlugin: 'plugin {plugin}',
  decidedBy: 'deciso da {level}',
  tokensLine: '~{tokens} token',
  tokensIfOn: '~{tokens} token se acceso',
  tokensInParent: 'contati nel plugin',
  tokensSplit: '~{total} token: ~{own} plugin | ~{skills} da {count} skill',
  tokensSplitOne: '~{total} token: ~{own} plugin | ~{skills} da 1 skill',
  tokensSplitIfOn: '~{total} token se acceso: ~{own} plugin | ~{skills} da {count} skill',
  tokensSplitIfOnOne: '~{total} token se acceso: ~{own} plugin | ~{skills} da 1 skill',
  pluginSkillsTitle: 'Skill del plugin ({count})',
  skillOnDemand: 'su richiesta',
  tools: '{count} tool',
  newBadge: 'nuovo',
  op: {
    enable: 'Accendi qui',
    block: 'Spegni qui',
    reset: 'Torna al default'
  } satisfies Record<Op, string>,
  writtenTitle: 'Scritto in {file}: {count} voci',
  writtenTitleOne: 'Scritto in {file}: 1 voce',
  writtenBody: 'Vale dalla prossima sessione dell’agente in questa cartella.',
  notWritten: 'Non scritte:',
  itemFailure: '{name}: {why}',
  showDiff: 'Mostra la modifica',
  undo: 'Annulla',
  undoneTitle: 'Modifica annullata',
  undoneBody: '{file} è tornato com’era prima della scrittura.',
  errorTitle: 'Qualcosa non va',
  arrivalsTitle: 'Arrivati a sessione in corso',
  arrivalsBody: '{names}',
  manageOnline: 'Gestisci su claude.ai',
  connectorsUrl: 'https://claude.ai/customize/connectors',
  warningsTitle: 'Da sapere',
  notifyTitle: 'Ballast: nuovi server nel contesto',
  notifyBody: '{folder}: {names}',
  statusText: '~{tokens}',
  statusTooltip: 'Contesto stimato per {folder} (Ballast)',
  statusNone: 'Ballast',
  note: {
    notInstalled: 'Acceso ma non installato su questa macchina: Claude Code lo propone all’avvio.',
    pluginSkillNoOverride: 'Claude Code non permette di spegnere una singola skill di un plugin: spegni il plugin {plugin}.',
    pluginServerToolsOnly: 'Spegni qui toglie i tool di questo server con permissions.deny (spariscono dal contesto), ma il server parte lo stesso: per fermarlo spegni il plugin {plugin}.',
    pluginOff: 'Il plugin {plugin} è spento: accendi prima il plugin.',
    deniedElsewhere: 'Spento a livello {level}: da qui non si può riaccendere.',
    managedDecides: 'Deciso dalla policy gestita ({level}): nessun file di progetto lo cambia.',
    disabledByMcpToggle: 'Spento con /mcp per questo progetto (nel file di stato utente): riaccendilo da /mcp.',
    rejectedElsewhere: 'Rifiutato in disabledMcpjsonServers a livello {level}: il rifiuto vince sull’approvazione.',
    sharedApprovalNeedsTrust: 'In una cartella non ancora “trusted” l’approvazione nel file condiviso viene ignorata: usa il file personale o accetta il trust dialog.',
    pendingApproval: 'Server di .mcp.json non ancora approvato: non si connette finché non lo approvi.',
    connectorsOffElsewhere: 'disableClaudeAiConnectors è attivo a livello {level}.',
    connectorManageOnline: 'Per toglierlo ovunque scollegalo su claude.ai.',
    tokensUnknown: 'Peso sconosciuto: nessuna sessione l’ha ancora visto connesso.',
    onDemand: 'Si carica solo quando Claude lavora in quella cartella o su quei file.',
    managedMemory: 'CLAUDE.md gestito dall’organizzazione: non si può escludere.',
    excludedElsewhere: 'Escluso da claudeMdExcludes a livello {level}: le liste si sommano, da qui non si riaccende.',
    autoMemoryOffElsewhere: 'autoMemoryEnabled è deciso a livello {level}, più forte di questo file.',
    modelInvocationOff: 'disable-model-invocation: Claude non la vede, resta invocabile con /nome.',
    alreadyThisWay: 'Il file scelto dice già così.',
    denyRuleRemovesTools: 'Una regola permissions.deny toglie i suoi tool dal contesto.',
    needsAuth: 'In attesa di autenticazione nell’ultima sessione.',
    failed: 'Connessione fallita nell’ultima sessione.',
    newArrival: 'Visto per la prima volta nelle ultime 24 ore.',
    noEntryInFile: 'Il file scelto non ha una voce per questo elemento.',
    bundledSkill: 'Skill integrata di Claude Code.',
    allowlistBlocks: 'Non è in allowedMcpServers ({level}).',
    unmatchedDeny: 'La regola deniedMcpServers “{rule}” ({level}) non blocca “{server}”: il nome deve coincidere esattamente.',
    readError: 'Non riesco a leggere {file}.',
    noTranscripts: 'Nessuna sessione per questa cartella nel profilo: connettori e server tardivi si vedono dopo la prima sessione.',
    userTargetRefused: 'Ballast non scrive nei file di livello utente, nel file di stato né in CODEX_HOME.',
    notInProject: 'Non appartiene a questa cartella.',
    denyBlocksPluginServer: 'Spento con permissions.deny.',
    fileChanged: 'Il file è cambiato nel frattempo: niente scritto.',
    undoGone: 'Non posso annullare: la scrittura non è più tra quelle ricordate (l’annullamento vale solo finché il worker resta attivo, per le ultime 10).',
    projectNotTrusted: 'Progetto non trusted: la modifica si scrive in .codex/config.toml ma Codex non la legge finché non lo è.',
    noPersonalFile: 'Codex non ha un file di progetto personale: i comandi scrivono solo nel file condiviso.',
    codexPluginSkillNoOverride: 'Codex non permette di spegnere una singola skill di un plugin per progetto: spegni il plugin {plugin}.',
    tomlUnsupported: 'In {file} la voce è scritta in una forma che Ballast non modifica (chiavi puntate o tabelle inline): modificala a mano.',
    noSwitchInCodex: 'Codex non ha un’impostazione per escludere questo file: rinominalo o toglilo dal repo.',
    beyondDocLimit: 'Oltre il limite project_doc_max_bytes ({bytes} byte): Codex non lo legge.',
    docTruncated: 'Troncato al limite project_doc_max_bytes ({bytes} byte).'
  } satisfies Record<NoteCode, string>
}

export type Lang = 'en' | 'it'

export const tables: Record<Lang, Strings> = { en, it }

/** Italian for "it", "it-IT", "it_CH"; English for everything else, including a missing tag. */
export function pickLang(locale: string | null | undefined): Lang {
  return /^it([-_]|$)/i.test((locale ?? '').trim()) ? 'it' : 'en'
}

let lang: Lang = 'en'

/** The strings in use right now (a live binding: read it at render time, not at import time). */
export let s: Strings = en

export function setLocale(locale: string | null | undefined): void {
  lang = pickLang(locale)
  s = tables[lang]
}

/** The system's language, for where Orca gives none (the worker). */
export function systemLocale(): string {
  const fromEnv = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || fromEnv
  } catch {
    return fromEnv
  }
}

/** Fills `{name}` placeholders. */
export function t(template: string, args: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => (key in args ? String(args[key]) : all))
}

/** 12345 -> "12.3k" in English, "12,3k" in Italian. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  const body = k >= 100 ? Math.round(k).toString() : k.toFixed(1)
  return (lang === 'it' ? body.replace('.', ',') : body) + 'k'
}
