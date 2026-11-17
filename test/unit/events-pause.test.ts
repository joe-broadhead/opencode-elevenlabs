// A read that pauses after its gap (src/events.ts, the gap window): the reviewer's probes D1 and D2, against a workspace
// whose retention deletes conversations at every call as the clock moves. A gap covers the read that pages on within
// GAP_WINDOW_MS; a cursor used later is a new read, so what retention deleted during the pause is answered with a gap.
import { describe, expect, test } from "bun:test"
import { listEvents } from "../../src/events.js"

const OWNER = { id: "elevenlabs:credential:c1", label: "me" }
const DAY = 86_400_000
type C = { conversation_id: string; start_time_unix_secs: number; agent_id: string; status: string; call_successful: string }
type Agent = { id: string; days: number | null; zrm?: boolean }

/** A workspace whose retention deletes conversations older than (now - days) at every call. */
function workspace(agents: Agent[], all: C[], clock: { now: number }) {
  const alive = () => all.filter((c) => {
    const agent = agents.find((x) => x.id === c.agent_id)!
    return !(agent.days && agent.days > 0 && c.start_time_unix_secs * 1000 < clock.now - agent.days * DAY)
  })
  const read = async (tool: string, input: Record<string, unknown>) => {
    if (tool === "agents_list") return input["archived"] ? { agents: [], has_more: false } : { agents: agents.map((a) => ({ agent_id: a.id })), has_more: false }
    if (tool === "agents_get") {
      const agent = agents.find((x) => x.id === input["agent_id"])!
      return { config: { "platform_settings.privacy": { retention_days: agent.days ?? -1, zero_retention_mode: !!agent.zrm } } }
    }
    const after = Number(input["call_start_after_unix"])
    const size = Number(input["page_size"])
    const offset = input["cursor"] ? Number(input["cursor"]) : 0
    const rows = alive().filter((c) => c.start_time_unix_secs > after).sort((a, b) => a.start_time_unix_secs - b.start_time_unix_secs || (a.conversation_id < b.conversation_id ? -1 : 1))
    const page = rows.slice(offset, offset + size)
    const more = offset + size < rows.length
    return { conversations: page, has_more: more, ...(more ? { next_cursor: String(offset + size) } : {}) }
  }
  return { read, alive }
}
const conv = (id: string, sec: number, agent: string): C => ({ conversation_id: id, start_time_unix_secs: sec, agent_id: agent, status: "done", call_successful: "success" })

/** Up to `pages` pages, the clock moving `step` ms a page. */
async function readPages(read: (tool: string, input: Record<string, unknown>) => Promise<unknown>, clock: { now: number }, input: Record<string, unknown>, limit: number, step: number, pages: number) {
  const seen: string[] = []
  const gaps: unknown[] = []
  let cursor = ""
  let more = true
  let next: Record<string, unknown> = { ...input, limit }
  for (let page = 0; page < pages; page++) {
    const result = await listEvents(read, OWNER, next, clock.now)
    seen.push(...result.events.map((event) => event.external_id))
    if (result.gap) gaps.push(result.gap)
    cursor = result.cursor
    more = result.more
    clock.now += step
    if (!result.more) break
    next = { cursor, account: "default", limit }
  }
  return { seen, gaps, cursor, more }
}

describe("a read that pauses after its gap", () => {
  for (const [pauseDays, gaps] of [[0.004, 0], [1, 1], [10, 1]] as const) {
    test(`D1: paused mid-read (more: true) just past the horizon, resumed ${pauseDays} days later: ${gaps} more gap`, async () => {
      const now0 = Date.UTC(2026, 10, 17, 12)
      const clock = { now: now0 }
      const h0 = Math.floor((now0 - 30 * DAY) / 1000)
      const all: C[] = []
      for (let s = h0 - 3600; s < h0 + 3600; s += 60) all.push(conv(`L${s}`, s, "L"))
      for (let s = h0 + 30; s < h0 + 20 * 86400; s += 3600) all.push(conv(`S${s}`, s, "S"))
      const ws = workspace([{ id: "S", days: 30 }, { id: "L", days: null }], all, clock)
      const first = await readPages(ws.read, clock, { since: new Date((h0 - 3700) * 1000).toISOString() }, 70, 1000, 1)
      expect(first.gaps.length).toBe(1)
      expect(first.more).toBe(true)
      const aliveAtPause = new Set(ws.alive().map((c) => c.conversation_id))
      clock.now += pauseDays * DAY
      const rest = await readPages(ws.read, clock, { cursor: first.cursor, account: "default" }, 70, 1000, 5000)
      expect(rest.gaps.length).toBe(gaps)
      const seen = new Set([...first.seen, ...rest.seen])
      const lost = [...aliveAtPause].filter((id) => !seen.has(id))
      // A conversation alive at the pause and never listed is only ever one retention deleted during it: then the read
      // answered a gap for it.
      if (lost.length > 0) expect(rest.gaps.length).toBe(1)
      expect(seen.size).toBe(first.seen.length + rest.seen.length)
    })
  }

  for (const [pauseDays, gaps] of [[0.004, 0], [40, 1]] as const) {
    test(`D2: a quiet workspace's gap read ends (more: false) behind the horizon; re-read ${pauseDays} days later: ${gaps} gap`, async () => {
      const now0 = Date.UTC(2026, 10, 17, 12)
      const clock = { now: now0 }
      const all: C[] = [conv("old", Math.floor((now0 - 40 * DAY) / 1000), "L")]
      const ws = workspace([{ id: "S", days: 30 }, { id: "L", days: null }], all, clock)
      const first = await readPages(ws.read, clock, { since: new Date(now0 - 50 * DAY).toISOString() }, 50, 1000, 50)
      expect(first.gaps.length).toBe(1)
      expect(first.more).toBe(false)
      for (let d = 1; d <= 9; d++) all.push(conv(`new${d}`, Math.floor((now0 + d * DAY) / 1000), "S"))
      clock.now += pauseDays * DAY
      const again = await readPages(ws.read, clock, { cursor: first.cursor, account: "default" }, 50, 1000, 50)
      expect(again.gaps.length).toBe(gaps)
      // After 40 days the 30-day agent's nine calls are gone: none is listed, and the gap says so.
      const created = all.filter((c) => c.conversation_id.startsWith("new") && c.start_time_unix_secs * 1000 < clock.now).map((c) => c.conversation_id)
      const missed = created.filter((id) => !again.seen.includes(id))
      if (missed.length > 0) expect(again.gaps.length).toBe(1)
    })
  }
})
