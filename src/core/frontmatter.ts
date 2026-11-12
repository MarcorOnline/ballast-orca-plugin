// Just enough YAML front matter for SKILL.md, agent and command files: scalar keys, quoted
// strings, and `>` / `|` block scalars. Anything richer is skipped, not guessed.

export function frontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return out
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return out
  const lines = normalized.slice(4, end).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!match) continue
    const key = match[1]
    let value = match[2].trim()
    if (/^[>|][+-]?$/.test(value)) {
      const fold = value.startsWith('>')
      const block: string[] = []
      while (i + 1 < lines.length && (lines[i + 1].startsWith(' ') || lines[i + 1] === '')) {
        block.push(lines[++i].trim())
      }
      value = block.join(fold ? ' ' : '\n').trim()
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    } else if (value === '') {
      // An indented plain continuation, as some skills write long descriptions.
      const block: string[] = []
      while (i + 1 < lines.length && lines[i + 1].startsWith(' ')) block.push(lines[++i].trim())
      value = block.join(' ')
    }
    out[key] = value
  }
  return out
}

/** The body after the front matter. */
export function body(text: string): string {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return normalized
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return normalized
  const after = normalized.indexOf('\n', end + 4)
  return after < 0 ? '' : normalized.slice(after + 1)
}
