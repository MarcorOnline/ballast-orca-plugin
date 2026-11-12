// One-off generator for fixtures/codex (kept in the repo so the fixture can be regenerated).
// Every planted secret starts with SECRET_.
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..', 'fixtures', 'codex')

const files = {
  'home/config.toml': `# User config for Codex (fixture)
model = "gpt-5"
project_doc_max_bytes = 520

[projects.'__PROJECT__']
trust_level = "trusted"

[plugins."tools@acme"]
enabled = true

[plugins."quiet@acme"]
enabled = false

[plugins."ghost@acme"]
enabled = true

[mcp_servers.docs]
url = "https://SECRET_user:SECRET_pass@mcp.example.com/mcp"
bearer_token_env_var = "SECRET_TOKEN_VAR"

[mcp_servers.docs.http_headers]
Authorization = "Bearer SECRET_header"

[mcp_servers.db]
command = "node"
args = ["db.js", "--token=SECRET_arg"]
enabled = true

[mcp_servers.db.env]
DB_PASSWORD = "SECRET_env_value"

[[skills.config]]
name = "noisy-skill"
enabled = false
`,
  'home/AGENTS.md': `# Global rules\nAlways answer in Italian.\n`,
  'home/skills/helper-skill/SKILL.md': `---\nname: helper-skill\ndescription: Helps with everyday tasks in the user home.\n---\nBody.\n`,
  'home/skills/noisy-skill/SKILL.md': `---\nname: noisy-skill\ndescription: A noisy skill the user config turns off.\n---\nBody.\n`,
  'home/skills/.system/skill-creator/SKILL.md': `---\nname: skill-creator\ndescription: Bundled system skill that creates skills.\n---\nBody.\n`,
  'home/plugins/cache/acme/tools/1.0.0/.codex-plugin/plugin.json': `{ "name": "tools", "version": "1.0.0", "skills": "./skills/", "mcpServers": "./.mcp.json" }\n`,
  'home/plugins/cache/acme/tools/1.0.0/skills/plug-skill/SKILL.md': `---\nname: plug-skill\ndescription: A skill that ships with the tools plugin.\n---\nBody.\n`,
  'home/plugins/cache/acme/tools/1.0.0/.mcp.json': `{ "mcpServers": { "tool-server": { "command": "node", "args": ["srv.js"], "env": { "PLUGIN_SECRET": "SECRET_plugin_env" } } } }\n`,
  'home/plugins/cache/acme/quiet/1.0.0/.codex-plugin/plugin.json': `{ "name": "quiet", "version": "1.0.0", "skills": "./skills/" }\n`,
  'home/plugins/cache/acme/quiet/1.0.0/skills/quiet-skill/SKILL.md': `---\nname: quiet-skill\ndescription: Skill of a plugin that is off.\n---\nBody.\n`,
  'home/sessions/2026/11/01/rollout-2026-11-01T10-00-00-aaaa.jsonl': `{"timestamp":"2026-11-01T10:00:00Z","type":"session_meta","payload":{"id":"aaaa","cwd":"__PROJECT__"}}\n{"type":"event_msg","payload":{"type":"task_started"}}\n`,
  'home/sessions/2026/11/02/rollout-2026-11-02T10-00-00-bbbb.jsonl': `{"timestamp":"2026-11-02T10:00:00Z","type":"session_meta","payload":{"id":"bbbb","cwd":"__PROJECT__"}}\n`,
  'home/sessions/2026/11/03/rollout-2026-11-03T10-00-00-cccc.jsonl': `{"timestamp":"2026-11-03T10:00:00Z","type":"session_meta","payload":{"id":"cccc","cwd":"C:/somewhere/else"}}\n`,
  'repo/.codex/config.toml': `# Project overrides for Codex.
# Keep this comment and the order of the tables.
[mcp_servers.db]   # tightened for this repo
enabled = false

[mcp_servers.local-tool]
command = "SECRET_cmd"
env = { API_KEY = "SECRET_inline_env" }

[plugins."tools@acme"]
enabled = false  # off here

[[skills.config]]
name = "repo-skill"
enabled = false
`,
  'repo/AGENTS.md': `# Repo rules\nUse tabs. Keep functions short. Run the tests before every commit; never skip them.\n`,
  'repo/.agents/skills/repo-skill/SKILL.md': `---\nname: repo-skill\ndescription: A skill checked into the repo.\n---\nBody.\n`,
  'repo/.agents/skills/other-skill/SKILL.md': `---\nname: other-skill\ndescription: Another repo skill, on.\n---\nBody.\n`,
  'repo/sub/AGENTS.md': `# Sub rules (ignored: an override sits beside it)\n`,
  'repo/sub/AGENTS.override.md': `# Sub override\n${'Payments rules. '.repeat(30)}\n`
}

for (const [rel, text] of Object.entries(files)) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
console.log(Object.keys(files).length + ' files')
