// Token estimates. Characters divided by four, rounded up: a declared estimate, not a count.

export function estimateTokens(text: string | number): number {
  const chars = typeof text === 'number' ? text : text.length
  return chars <= 0 ? 0 : Math.ceil(chars / 4)
}

/** Strips block HTML comments, which Claude Code removes from CLAUDE.md before loading it. */
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

/** The part of MEMORY.md Claude Code loads: the first 200 lines or 25 KB, whichever is less. */
export function memoryIndexSlice(text: string): string {
  const lines = text.split(/\r?\n/).slice(0, 200).join('\n')
  return lines.length > 25 * 1024 ? lines.slice(0, 25 * 1024) : lines
}
