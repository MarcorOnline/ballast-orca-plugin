// A small line diff (LCS) printed as unified hunks. Settings files are short, so the quadratic
// table is fine; past a size limit it falls back to showing whole old and new text.

type Op = { kind: ' ' | '-' | '+'; line: string }

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: '-', line: a[i++] })
    } else {
      ops.push({ kind: '+', line: b[j++] })
    }
  }
  while (i < n) ops.push({ kind: '-', line: a[i++] })
  while (j < m) ops.push({ kind: '+', line: b[j++] })
  return ops
}

export function unifiedDiff(before: string, after: string, name: string, context = 2): string {
  const a = before === '' ? [] : before.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
  const b = after === '' ? [] : after.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
  const header = [`--- ${before === '' ? '/dev/null' : 'a/' + name}`, `+++ b/${name}`]
  if (a.length * b.length > 4_000_000) {
    return [...header, ...a.map((l) => '-' + l), ...b.map((l) => '+' + l)].join('\n')
  }
  const ops = lcsOps(a, b)
  const changed = ops.map((o) => o.kind !== ' ')
  const keep = ops.map((_, idx) => {
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) {
      if (changed[k]) return true
    }
    return false
  })
  const out = [...header]
  let oldLine = 1
  let newLine = 1
  let idx = 0
  while (idx < ops.length) {
    if (!keep[idx]) {
      if (ops[idx].kind !== '+') oldLine++
      if (ops[idx].kind !== '-') newLine++
      idx++
      continue
    }
    const start = idx
    const startOld = oldLine
    const startNew = newLine
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    while (idx < ops.length && keep[idx]) {
      const op = ops[idx]
      body.push(op.kind + op.line)
      if (op.kind !== '+') {
        oldLine++
        oldCount++
      }
      if (op.kind !== '-') {
        newLine++
        newCount++
      }
      idx++
    }
    if (idx > start) out.push(`@@ -${startOld},${oldCount} +${startNew},${newCount} @@`, ...body)
  }
  return out.join('\n')
}
