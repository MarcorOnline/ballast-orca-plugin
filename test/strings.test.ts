// The language is English unless Orca's (or the system's) language is Italian.
import { assert, test } from 'orca/testing'
import { en, formatTokens, it, pickLang, s, setLocale, tables } from '../src/strings.ts'

function keysOf(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([k, v]) => keysOf(v, prefix ? `${prefix}.${k}` : k))
}

test('Italian for an Italian locale, English for everything else', () => {
  for (const tag of ['it', 'it-IT', 'it_CH', 'IT-it']) assert.equal(pickLang(tag), 'it', tag)
  for (const tag of ['en-US', 'de-DE', 'fr', 'ita', '', null, undefined]) assert.equal(pickLang(tag), 'en', String(tag))
  setLocale('it-IT')
  assert.equal(s, it)
  setLocale('en-US')
  assert.equal(s, en)
  setLocale('xx')
  assert.equal(s, en)
})

test('both tables have the same keys', () => {
  assert.deepEqual(keysOf(tables.it), keysOf(tables.en))
})

test('token counts use the locale decimal mark', () => {
  setLocale('en-US')
  assert.equal(formatTokens(2700), '2.7k')
  setLocale('it-IT')
  assert.equal(formatTokens(2700), '2,7k')
  setLocale('en-US')
})
