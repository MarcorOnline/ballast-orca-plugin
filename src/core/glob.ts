// Glob matching for `claudeMdExcludes` and `serverUrl` rules: `**` crosses folders, `*` does not
// (except in URLs, where Claude Code's `*` is a plain wildcard), `?` is one character.

function toRegExp(pattern: string, starCrossesSlash: boolean, ignoreCase: boolean): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          out += '(?:.*/)?'
          i++
        } else {
          out += '.*'
        }
      } else {
        out += starCrossesSlash ? '.*' : '[^/]*'
      }
    } else if (c === '?') {
      out += starCrossesSlash ? '.' : '[^/]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`, ignoreCase ? 'i' : '')
}

export function matchPathGlob(pattern: string, file: string, platform: NodeJS.Platform): boolean {
  const normalizedFile = file.replace(/\\/g, '/')
  const normalizedPattern = pattern.replace(/\\/g, '/')
  return toRegExp(normalizedPattern, false, platform === 'win32' || platform === 'darwin').test(
    normalizedFile
  )
}

export function matchUrlPattern(pattern: string, url: string): boolean {
  return toRegExp(pattern, true, false).test(url)
}

/** True when a path has characters a glob would read as syntax. */
export function hasGlobSyntax(p: string): boolean {
  return /[*?[\]{}]/.test(p)
}
