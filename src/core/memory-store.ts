// The worker's memory (terminal and agent links, launch profiles) in plugin storage. Updates are
// queued and written after a short pause, so a busy agent does not rewrite storage on every event;
// `flush` writes at once (deactivate, tests). Hooks call `update` without awaiting it.
import { capMemory, type Memory, normalizeMemory } from './focus.ts'

export interface MemoryStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface MemoryStore {
  get(): Promise<Memory>
  /** Applies `fn`; returning the same object means "nothing changed" and writes nothing. */
  update(fn: (m: Memory) => Memory): Promise<void>
  flush(): Promise<void>
}

export const MEMORY_KEY = 'memory'

export function createMemoryStore(storage: MemoryStorage, debounceMs = 800): MemoryStore {
  let current: Memory | null = null
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let queue: Promise<void> = Promise.resolve()

  async function load(): Promise<Memory> {
    if (!current) current = normalizeMemory(await storage.get(MEMORY_KEY).catch(() => null))
    return current
  }

  async function write() {
    timer = null
    if (!dirty || !current) return
    dirty = false
    await storage.set(MEMORY_KEY, capMemory(current)).catch(() => {
      dirty = true
    })
  }

  return {
    get: load,
    update(fn) {
      queue = queue
        .then(async () => {
          const next = fn(await load())
          if (next === current) return
          current = next
          dirty = true
          if (debounceMs <= 0) return write()
          timer ??= setTimeout(() => void write(), debounceMs)
          timer.unref?.()
        })
        .catch(() => undefined)
      return queue
    },
    async flush() {
      await queue
      if (timer) clearTimeout(timer)
      await write()
    }
  }
}
