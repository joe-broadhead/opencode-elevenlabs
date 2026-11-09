/**
 * A stand-in for `ctx.storage`, with the surface the ledger uses: `get`, `set`, `remove` and `scan`. `scan` matches
 * what OpenCode documents — keys ascending, `prefix` a half-open range, `after` exclusive, `limit` clamped to 1 to
 * 1,000 and 100 by default, `next` the last key of a full page — so the ledger's paging is exercised, not assumed.
 */
export interface FakeStorage {
  get: (key: string) => Promise<never>
  set: (key: string, value: unknown) => Promise<void>
  remove: (key: string) => Promise<void>
  scan: (options: { prefix: string; after?: string; limit?: number }) => Promise<{ entries: Array<{ key: string; value: never }>; next?: string }>
}

/** A storage object over one backing map. Two of these over one map are two locations on one data directory. */
export const storageOver = (stored: Map<string, unknown>): FakeStorage => ({
  get: async (key) => stored.get(key) as never,
  set: async (key, value) => {
    await Promise.resolve()
    stored.set(key, value)
  },
  remove: async (key) => {
    await Promise.resolve()
    stored.delete(key)
  },
  scan: async ({ prefix, after, limit }) => {
    await Promise.resolve()
    const size = Math.min(1_000, Math.max(1, limit ?? 100))
    const keys = [...stored.keys()]
      .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      .sort()
    const page = keys.slice(0, size)
    const entries = page.map((key) => ({ key, value: stored.get(key) as never }))
    return page.length === size && keys.length > size ? { entries, next: page[page.length - 1] } : { entries }
  },
})

/** One backing store, handed out as a fresh storage object each time: another location, or another OpenCode. */
export const sharedStore = () => {
  const stored = new Map<string, unknown>()
  return { stored, handle: () => storageOver(stored) }
}
