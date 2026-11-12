# How Ballast works

An [Orca](https://github.com/stablyai/orca) plugin that shows what weighs on a **Claude Code** or
**Codex** agent's context in one folder, and lets you turn each item on or off **for that folder
only**.

The panel always shows the workspace that has the focus in Orca, whatever tab is open there
(agent, CLI, terminal), like Explorer and Source Control. There is no folder field: the folder is
shown at the top as read-only information (name and path, and how it was found).

| Group | Claude Code reads | Codex reads |
| :- | :- | :- |
| Plugins | `installed_plugins.json`, `known_marketplaces.json`, marketplace entries and plugin manifests in the config dir, plugins synced from claude.ai, `enabledPlugins` at the managed, user, project (`.claude/settings.json`) and local (`.claude/settings.local.json`) levels | `[plugins."name@marketplace"] enabled` in `<CODEX_HOME>/config.toml` and every `.codex/config.toml` of the project; installed copies in `<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>/` |
| Skills | user skills (`<config>/skills`, including skills synced from claude.ai), project skills (`.claude/skills`), skills of the plugins that are on | `<CODEX_HOME>/skills` and its `.system` folder (the bundled system skills), `~/.agents/skills`, `.agents/skills` in every folder from the working folder up to the project root, skills of the plugins that are on; switched by `[[skills.config]]` |
| MCP servers | user and local-scope servers in the user state file (`.claude.json`), the project's `.mcp.json`, the `.mcp.json` / `mcpServers` of every plugin, and the rules that allow or block them | `[mcp_servers.<name>]` (and its `enabled`) in the user and project `config.toml`; the servers a plugin ships in its `.mcp.json`, with `plugins.<p>.mcp_servers.<s>.enabled` |
| claude.ai connectors | not on disk: read from the folder's session transcripts (see below) | — |
| Memory | managed `CLAUDE.md`, the user `CLAUDE.md` and rules, every `CLAUDE.md` / `CLAUDE.local.md` from the root down to the folder, `.claude/CLAUDE.md` and rules, `CLAUDE.md` files in sub-folders (on demand), the auto-memory `MEMORY.md` | the global `AGENTS.override.md` or `AGENTS.md` in `CODEX_HOME` (the first non-empty one), then from the project root down to the folder one file per folder (`AGENTS.override.md`, `AGENTS.md`, then `project_doc_fallback_filenames`), up to `project_doc_max_bytes` (32 KiB by default) |
| Sessions | the eight most recent transcripts of the folder | the number of `<CODEX_HOME>/sessions/**/rollout-*.jsonl` whose first record has this folder as `cwd` |

## The panel, top to bottom

1. **Folder**: the folder being read and how it was resolved. When the focus is ambiguous, the
   candidate picker is here.
2. **Agent**: a Claude | Codex switch (only when both agents are in the workspace) and a line
   saying which agent, which account and why that account.
3. **Estimated context**: the estimated total and the heaviest items.
4. **Settings** (collapsed): the write target (Shared / Personal), the switch that shows
   plugin skills, and the config dir in use.
5. The result of the last write (see "Commands"), the connectors and servers that arrived mid-session,
   then **one group per kind** (plugins, skills, MCP servers, claude.ai connectors, memory), then
   "Good to know" with the warnings. There is no refresh button: the panel scans again on its own (see
   "Which agent and account").

When the workspace has no Claude or Codex agent (nothing launched yet, or only agents Ballast does
not read), the panel shows only "No agent in this workspace" and the worker scans nothing;
the status bar item shows its plain text.

Each group header reads "Plugins · Active: 18/20 · ~3.1k tokens". **Active** counts the items that
are on or on-demand out of the items listed in that group, the same ones the tabs show. The Skills
group lists only standalone skills; a plugin's skills sit in a collapsible inside the plugin's row,
and the plugin's weight is split into its own tokens and its skills'. The token figure is the
group's counted total.

Inside a group, two tabs split the rows: **On (N)** (on and on-demand) and **Off (M)** (off,
not installed and pending). Items the folder itself decides come first, then the heaviest.

Each row has a checkbox labelled with the item name, its origin, its effective state, **which level
decides it** (and the key that does), an estimated token weight and the three commands. A checkbox
is disabled when the tab's bulk action is not allowed for that row under the current write target,
and its description says why. Above the rows of each tab:

- **Select all** ticks only the rows the bulk action is allowed for; **None** clears the
  ticks.
- In On the bulk button reads **Turn off selected (N)** and runs *Turn off here* on the ticked
  rows; in Off it reads **Turn on selected (N)** and runs *Turn on here*.

Ticks are kept per group and tab, are cleared after a write, and ids that disappear on a rescan are
dropped. They are not persisted.

Token weights are estimates: characters divided by four, over what the agent puts in context up
front: the name and description for skills, agents and commands, the deferred tool names plus
server instructions for Claude Code MCP servers and connectors, and the whole file for memory
(`MEMORY.md`: the first 200 lines or 25 KB; `AGENTS.md`: cut at the byte limit). A plugin row
counts its skills, agents, commands and servers; its child rows say "contati nel plugin" and are
not added twice. On-demand files are shown but not added to the total. Codex MCP servers show
"unknown weight": nothing on disk says how many tools they expose.

## Which workspace is it?

Orca's `workspace.readContext` and the `workspace.changed` event give a name, a branch and the
ids of the terminals, but no path and no workspace id, and many workspaces share a name and a
branch (on one machine 51 of 59 do, 30 of them `develop`/`develop`). Ballast therefore resolves
the folder from what Orca reports **together with a workspace id**, in this order, and never
guesses:

1. **Terminal ids.** The worker listens to `agent.status.changed` and two hooks, which carry
   `terminalId` and `workspaceId` together, and keeps a bounded map `terminalId -> workspaceId`
   (500 entries, oldest dropped). `readContext.terminals[].id` is the same identifier (checked live
   on Orca 1.4.255: the id of a CLI terminal is identical in `readContext`, `agents.list`, the
   event, the hook and `orca terminal list`). If every known terminal of the focused workspace
   points to the same workspace and that workspace exists in `workspace.list`, that is the folder
   (shown as "da un terminale noto").
2. **Agent start time.** Native chat agents have no terminal, and `agents.list` reports them with
   `terminalId: null`. But an agent's `stateStartedAt` is exactly the `mainAgent.stateStartedAt` of
   the status event that carried its `workspaceId` (checked live). The worker keeps a bounded log of
   `{ workspaceId, stateStartedAt, title, receivedAt }` (300 entries), the panel sends
   `agents.list` with each scan, and an agent matches an event when the start times are equal (and
   the titles, when both have one). All matched agents must agree on one workspace that exists in
   `workspace.list`. An event for an agent that has since changed state does not match: the next
   event brings the new start time.
3. **Name and branch** that fit exactly one workspace.
4. Otherwise the panel says "Non riconosco ancora questo workspace: si aggancia da solo appena un
   agente lavora in una sua tab", and below it lists **only** the workspaces with that name and
   branch (at most 50). The pick is remembered by the terminal ids and the agents of that focus
   (as extra entries in the maps above), so that workspace stays recognised. There is no field for
   free paths. With no focused workspace the panel says "No active workspace" and shows nothing else.

**The limit:** a tab with no terminal and no agent that has ever reported while Ballast was
running is recognised only by name and branch, or by your pick. A workspace whose name and branch
are shared with another one stays ambiguous until an agent works in it. The worker announces each
new resolution to the panel (`ballast.resolved`), which scans again.

Orca 1.4.255 detail: `workspace.list` ids look like `identity:wt2:local:<uuid>`, while events and
hooks carry `<repoId>::<path>`. Ballast ties the two by the path after `::`.

The status bar item and the notification when a server or connector arrives follow the same
resolved folder.

## Which agent and account

**The agent.** The panel shows one agent at a time. `agents.list` (focused workspace only) says
which supported agents are there (Claude Code and Codex; others are ignored). With both present, the
**Claude | Codex** switch picks one; with one, there is no switch and the line below says which. The
default is your last pick for this workspace when that agent is still there, otherwise the one
with the most recent `stateStartedAt`. The pick is stored per workspace (a panel atom persisted
with the `workspace` scope).

**Known limit.** The panel cannot follow the focused tab automatically yet: Orca's plugin API does
not say which tab has the focus and fires no event when you switch tab, so Ballast only learns of a
new agent from `agents.list` when something else triggers a scan (workspace change, an agent
status change, a write). The switch is the interim answer until Orca exposes the focused tab.

**The account** is never chosen by hand. It is the home that an `agent.launch.before` hook saw for
a launch of that agent in that workspace (only `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are kept from
`env`); otherwise Orca's active account for that agent (`activeAccountId`), then
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` as the worker sees them, then `~/.claude` / `~/.codex`. The line
under the switch says which: the launch, the active account in Orca, the environment or the default
folder.

Where the active account comes from: `orca account list --json`, run by the worker (`execFile`, 6 s
timeout, cached for five minutes, a failure for one minute). Only ids, e-mails, workspace labels and
the Claude home are read from it, never tokens. The command is `ORCA_CLI_COMMAND` when the worker
sees it (it does not on Orca 1.4.255), otherwise the CLI shipped beside the running app
(`<app>/resources/bin/orca`), otherwise `orca` on the PATH. The child process drops
`ELECTRON_RUN_AS_NODE` (workers run as Electron-as-Node) and gets `APPDATA`/`LOCALAPPDATA` when the
worker's trimmed environment lacks them; without that the CLI fails. If the CLI does not answer,
Claude's active account comes from the file Orca keeps for the host (`claude-profiles/selected-host`).
No `auth.json` or other credential file is ever opened.

**Scans** run on `workspace.changed`, `agent.status.changed`, when the worker learns the folder,
and after every write or undo. The panel could also scan when it becomes visible again, but
`PanelContext.visible` is a value that can be read, not one that notifies, so Ballast does not use it.

**What the live check found about `CODEX_HOME`** (Orca 1.4.255, Windows): a Codex terminal agent
started from the CLI ran with `CODEX_HOME = <orca data>/codex-accounts/<activeAccountId>/home`.
Its session file appeared there, and neither in `~/.codex` nor in `codex-runtime-home/home`. So
Codex reads MCP servers and plugins from the managed account's `config.toml`, not from
`codex-runtime-home`, whose `config.toml` holds only `[projects]` trust entries. The
`agent.launch.before` hook carried an **empty `env`** for both Claude and Codex launches, so the
launch capture rarely has anything and Ballast usually falls back to the active account. An agent
started before you switched account still runs on the old one: Ballast shows the active account.

## Connectors and servers that arrive mid-session (Claude Code)

claude.ai connectors (Gmail, Slack, Figma, Google Drive…) and MCP servers that connect late are
not on disk. Claude Code announces them in the session transcript as deferred tools
(`mcp__claude_ai_<Name>__*`, `mcp__plugin_<plugin>_<server>__*`) and server instructions. Ballast
reads the folder's transcripts under `<config>/projects/<encoded folder>/` (the eight most recent
sessions), and from two record types only (`deferred_tools_delta` and `mcp_instructions_delta`)
lists each server or connector with its tool count. Sessions from the Claude desktop app are left
out: the app delivers connectors in-process and none of these settings reach them.

The worker watches the transcript folder of the folder it follows. When a server or connector
shows up that Ballast has never seen for that folder, it posts an Orca desktop notification and
marks it "new" in the panel for 24 hours. The first look at a folder records what is already
there without notifying. A `deniedMcpServers` rule that almost matches an arrived connector is
flagged: names match exactly.

## Commands

Every row has **Turn on here**, **Turn off here** and **Reset to default**, and the bulk buttons act
on the ticked rows. They write only in the focused folder, **straight away**: there is no preview
and no confirmation step. The panel calls `ballast.applyBatch` (also for a single row, with one
item). The worker scans once, applies every item aimed at the same file to the same text and writes
that file **once**, atomically. An item that is not allowed or cannot apply is reported on its own,
with its note, while the others are still written. Each write changes only the keys it needs and
keeps every other byte (key order, indentation, line endings). Changes apply from the next session
of the agent in that folder.

After a write the panel shows a callout "Written to <file>: N items", the failures if any, a closed
"Show the change" section with the diff (every value outside the keys Ballast writes is hidden
as `"…"`) and an **Undo** button.

### Undo

**Undo** calls `ballast.undo`, which puts the file back byte for byte (or deletes it, if the
write created it) and then rescans. The undo state lives **in the worker's memory only**: the last
10 writes, nothing on disk. Undo refuses (and touches nothing) when:

- the file changed after the write, however slightly (the current hash is no longer the one the
  write left): an outside edit, or another Ballast write, wins;
- the worker restarted since the write (reloading the plugin, restarting Orca), or more than 10
  writes happened since.

`ballast.plan` and `ballast.apply` (preview, then write if the file did not change) remain in the
worker, but the panel no longer calls them.

### Claude Code

They write to the file chosen under "Settings": **Shared** `.claude/settings.json` (committed, the
default) or **Personal** `.claude/settings.local.json` (this machine only), with
[jsonc-parser](https://github.com/microsoft/node-jsonc-parser)'s minimal edits (keys, order,
indentation and line endings stay). User-level files (`<config>/settings.json`,
`~/.claude/settings.json`), the user state file (`.claude.json`) and managed settings are read
only, including through a symlinked `.claude` folder.

What each command writes, checked against the Claude Code documentation
([settings](https://code.claude.com/docs/en/settings-reference),
[MCP](https://code.claude.com/docs/en/mcp), [managed MCP](https://code.claude.com/docs/en/managed-mcp),
[permissions](https://code.claude.com/docs/en/permissions),
[plugins](https://code.claude.com/docs/en/plugins-reference),
[skills](https://code.claude.com/docs/en/skills), [memory](https://code.claude.com/docs/en/memory)):

| Item | Turn off here | Turn on here | What it cannot do |
| :- | :- | :- | :- |
| Plugin | `enabledPlugins["name@marketplace"]: false` | `…: true` | Override managed settings. In the shared file it cannot beat a value in the local file (local > project > user). Enabling in project settings does not install the plugin. |
| User or project skill | `skillOverrides["name"]: "off"` | `…: "on"` | — |
| Plugin skill | not available | not available | `skillOverrides` does not apply to plugin skills: turn the plugin off. |
| `.mcp.json` server | `disabledMcpjsonServers += "name"` | `enabledMcpjsonServers += "name"` | Re-enable a server rejected in another file. In a folder whose trust dialog you have not accepted, an approval in the shared file is ignored: use the personal file. |
| User or local server | `deniedMcpServers += {"serverName": "name"}` | removes that entry | Undo a deny in another file or a `/mcp` toggle (stored in `.claude.json`, which Ballast does not write). |
| claude.ai connector | `deniedMcpServers += {"serverName": "claude.ai Name"}` | removes that entry | Undo `disableClaudeAiConnectors` or a deny set elsewhere; to remove a connector everywhere, disconnect it at [claude.ai/customize/connectors](https://claude.ai/customize/connectors). |
| Plugin MCP server | `permissions.deny += "mcp__plugin_<plugin>_<server>__*"` | removes that rule | The deny rule removes the server's tools from context but the server still starts; turn the plugin off to stop it. |
| `CLAUDE.md` / rules file | `claudeMdExcludes += pattern` | removes the matching pattern | Exclude the managed `CLAUDE.md`; undo an exclusion made in another file. |
| `MEMORY.md` (auto memory) | `autoMemoryEnabled: false` | `autoMemoryEnabled: true` | Override a value set at a higher level. |

**Reset to default** removes the entry the command would have written from the chosen file, and
nothing else (an object or array that becomes empty stays).

### Codex

They write to `<folder>/.codex/config.toml` (the "Shared" target). Codex has no equivalent of
`settings.local.json`, so the "Personal" target is disabled with a note. The write is a **targeted
text edit** (not a re-serialised TOML): comments, order, quoting and line endings stay; a new table
is appended at the end; **Reset to default** removes only the key it set (the table and its comment
stay; a `[[skills.config]]` entry Ballast wrote is removed whole). Nothing is ever written inside
`CODEX_HOME`, `~/.codex` or one of Orca's Codex homes (symlinks included), and a plan is refused if
the file changed after the preview (`ballast.apply`). A table written with dotted keys or an inline table
(`plugins."a@b".enabled = false`, `mcp_servers = { … }`) is refused with a note instead of being
rewritten.

| Item | Turn off here | Turn on here | What it cannot do |
| :- | :- | :- | :- |
| Plugin | `[plugins."name@marketplace"] enabled = false` | `enabled = true` | Uninstall it; override a workspace-managed state. |
| Skill (user, repo, system) | `[[skills.config]] name = "…"` with `enabled = false` | `enabled = true` | — |
| Plugin skill | not available | not available | The docs do not say a name rule reaches a plugin's skill: turn the plugin off. |
| MCP server | `[mcp_servers.<name>] enabled = false` | `enabled = true` | Remove its configuration. |
| Plugin MCP server | `[plugins."p@m".mcp_servers.<s>] enabled = false` | `enabled = true` | — |
| `AGENTS.md` | not available | not available | Codex has no key to exclude an instruction file; rename it or remove it. |

**Trust.** A project's `.codex/config.toml` counts only when the project is trusted
(`[projects.'<path>'] trust_level = "trusted"` in the user config, for the folder or a folder above
it). For a folder that is not trusted, Ballast ignores that file when it works out the state, says
so in the panel, and still writes the file when asked: the change is saved but Codex does not read
it. Project files can also not override some keys (`model_provider`, `notify`, `profile`…);
Ballast never writes those.

Codex documentation used (all keys above were checked on these pages):
[config basics](https://developers.openai.com/codex/config-basic) (layers, precedence, trust),
[advanced config](https://developers.openai.com/codex/config-advanced) (project config files,
project root markers, `project_doc_*`),
[configuration reference](https://developers.openai.com/codex/config-reference)
(`plugins.<plugin>.enabled`, `plugins.<plugin>.mcp_servers.<server>.enabled`,
`mcp_servers.<id>.enabled`, `skills.config`, `skills.bundled.enabled`, `projects.<path>.trust_level`),
[MCP](https://developers.openai.com/codex/mcp),
[skills](https://developers.openai.com/codex/skills) (locations, `[[skills.config]]`, `agents/openai.yaml`),
[AGENTS.md](https://developers.openai.com/codex/guides/agents-md) (global and project chain,
override files, `project_doc_max_bytes`, fallback names),
[plugins](https://developers.openai.com/codex/plugins) and
[build plugins](https://developers.openai.com/codex/plugins/build) (plugin layout, the
`plugin-name@marketplace-name` key, `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`).

## What Ballast cannot see or change

- Built-in tools, the system prompt, output styles and hooks are not listed.
- Claude Code: connectors and late servers are known only after a session in the folder ran with
  them. MCP tool weights assume tool search (the default). `@imports` inside `CLAUDE.md` are not
  followed. Desktop-app sessions are ignored.
- Codex: MCP server weights are unknown. System-level config (`/etc/codex/config.toml`),
  cloud-managed config and `--profile` files are not read. `skills.bundled.enabled` is read but no
  command writes it. The MCP servers and tools Codex sessions have used are not listed.
- A tab with no terminal and no agent that reported while Ballast was running is recognised only by
  name and branch or by your pick (see "Which workspace is it?").
- Which account a running agent uses is not exposed by Orca; see "Which agent and account".

Rules this README states from the Codex documentation but that the pages do not spell out, so
treat them as assumptions: an installed plugin that no config names is on (unless
`plugins._default.enabled` says otherwise); `[[skills.config]]` entries of a project layer come
after the user's, so the project wins; a project `[mcp_servers.x]` table with only `enabled`
merges key by key with the user's definition; `project_doc_max_bytes` counts the project files, not
the global one; `project_root_markers` is read from the user config; `<CODEX_HOME>/skills/.system`
and `<CODEX_HOME>/sessions/**/rollout-*.jsonl` (first record's `cwd`) are what Codex writes on disk,
not something the pages above document; a plugin folder directly under `<CODEX_HOME>/plugins/<name>`
is listed as `<name>@local`.

## Data safety

The state file, the MCP configs and Codex's `config.toml` hold tokens, env values, headers and URLs
with credentials. Ballast copies out names, booleans and structure only: the readers keep only the
keys listed above, server URLs, commands and arguments stay inside the worker, and nothing reaches
the panel, the logs, the notifications or plugin storage except names. The diff (preview and write result) replaces
every string and number outside the keys Ballast writes with `"…"` in Claude Code's JSON; in Codex's
TOML it replaces every value except booleans and the `name` of a `[[skills.config]]` entry. From an agent launch only `CLAUDE_CONFIG_DIR`
and `CODEX_HOME` are kept; tool inputs and outputs are never read. `test/secrets.test.ts` plants
secrets in every source, Claude's and Codex's, and checks the scan, every plan and diff, every `applyBatch` and `undo` answer, the
worker's answers, posts, logs and storage.

## Install from a folder

```sh
orca plugin install C:\path\to\ballast-orca-plugin      # or: orca plugin dev load C:\path\to\ballast-orca-plugin
```

Orca shows the access it asks for and needs your approval. Open the panel from the right
sidebar (gauge icon) or press the "Ballast" item in the status bar.

## Permissions

| Asked | Why |
| :- | :- |
| `trusted-worker` (a Node worker) | reading the agents' config dirs, the folder and its sessions, running `orca account list --json`, and writing the folder's `.claude/settings*.json` or `.codex/config.toml` when you press a command |
| `workspace:read` | the focused workspace (`workspace.changed`, `workspace.readContext`) and the list of workspaces with their paths (`workspace.list`) |
| `agent:read` | `agent.status.changed` and `agents.list`: which agents work in the focused workspace, and the workspace and terminal each belongs to |
| `storage:own` | the terminal and agent links, launch profiles, and when each MCP server was first seen per folder (ids, titles, timestamps and paths only) |
| `notifications:show` | the desktop notification when a new server or connector reaches a session |

Hooks (`contributes.hooks`, `engines.orca >=1.4.248`): `agent.launch.before` and
`agent.tool.after`. Both only observe. They return `next(event)` at once, before anything is
awaited, and never change the event; Orca does not wait for `agent.tool.after` at all. Ballast
keeps `workspaceId`, `terminalId` and, for a launch, `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.

The status bar item needs no capability.

## Development

```sh
npm install                 # TypeScript and Node typings, for `npm run typecheck` only
orca plugin validate .
orca plugin test .          # node:test over fixtures copied to a temp folder
orca plugin check .
orca plugin dev load .
```

- `src/core/` is the worker's logic, with no Orca dependency; `src/worker.ts` wires it to Orca.
  `focus.ts` resolves the workspace, `claude.ts` and `codex.ts` scan, `toml.ts` edits Codex's TOML,
  `accounts.ts` and `profile.ts` find the profiles, `service.ts` ties them together.
- `src/strings.ts` holds every user-facing string, in English and Italian, and picks the table: Italian when Orca's language starts with `it`, else English. The panel reads `env.locale`; the worker has no locale API, so it starts from the system locale and takes Orca's from the panel on every scan.
- `src/model.ts` is the data the worker sends. Every item carries its `agent` (`claude-code` or
  `codex`); both scanners return the same shape.
- Tests never touch a real config dir or repository: `test/fixture.ts` copies `fixtures/` (Claude
  Code under `fixtures/basic`, Codex under `fixtures/codex`, regenerated by
  `test/make-codex-fixtures.cjs`) to a temporary folder first. Every planted secret starts with
  `SECRET_`.

`src/vendor/jsonc-parser/` is jsonc-parser 3.3.1 (MIT, Microsoft), bundled into one file.
`src/vendor/smol-toml/` is smol-toml 1.3.1 (**BSD-3-Clause**, Squirrel Chat; the license is beside
it), the `.js`/`.d.ts` files of its `dist/` renamed `.mjs`/`.d.mts`; it only reads TOML, writes
are text edits. The license for Ballast itself is not chosen yet.
