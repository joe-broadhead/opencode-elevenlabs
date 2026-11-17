// The source contract's events_list and probe (src/events.ts) against the synthetic workspace
// (test/support/synthetic-conversations.ts): paging, an empty page, the cursor, ElevenLabs' failures, the sign-in, the
// privacy rule (metadata only), and that reading spends nothing. No ElevenLabs call, no sign-in.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { resultProblems } from "@we-the-rebel-alliance/source-contract/events"
import { mustPrice, READ_TOOLS, SOURCE_TOOLS, SPEND_ANY } from "../../src/elevenlabs-tools.js"
import {
  ACCOUNT,
  EVENTS_ACTION,
  EventsFailure,
  LIST_TOOL,
  PROBE_ACTION,
  SETTLE_MS,
  SOURCE,
  eventsMethod,
  probeMethod,
  type EventsContext,
  type EventsState,
} from "../../src/events.js"
import { pluginError } from "../../src/host/tools-rpc.js"
import { defaultRules, evaluate } from "../../src/permissions.js"
import { CALLER_TEXT, CONVERSATIONS, CREDENTIAL, NOW, OWNER, SECRET, SINCE, syntheticList, type SyntheticConversation } from "../support/synthetic-conversations.js"

const pkg = (await import("../../package.json", { with: { type: "json" } })).default as {
  sources: { items: { permission: { events: string; operations: string[]; identity?: string[] }; cost: { class: string } }[]; probe: { action: string } }
}

interface Options {
  readonly conversations?: readonly SyntheticConversation[]
  readonly fail?: (call: number) => string | undefined
  readonly throws?: unknown
  readonly credential?: unknown
  readonly listed?: boolean
  readonly status?: string
  readonly state?: Partial<EventsState>
  readonly now?: number
}

/** OpenCode's executor for the list over the synthetic workspace, recording every action asserted and every call. */
function setup(options: Options = {}) {
  const synthetic = syntheticList({ conversations: options.conversations ?? [...CONVERSATIONS, SECRET], ...(options.fail ? { fail: options.fail } : {}) })
  const asserted: string[] = []
  const ctx: EventsContext = {
    tool: {
      list: async () =>
        (options.listed === false
          ? []
          : [{
              id: `elevenlabs_${LIST_TOOL}`,
              execute: async (input: Record<string, unknown>) => {
                asserted.push(`elevenlabs_${LIST_TOOL}`)
                if (options.throws !== undefined) throw options.throws
                return synthetic.list(input)
              },
            }]) as never,
    },
    mcp: { list: async () => ({ data: [{ name: "elevenlabs", status: { status: options.status ?? "connected" }, integrationID: "int_elevenlabs" }] }) as never },
    integration: { connection: { active: async () => ("credential" in options ? options.credential : CREDENTIAL) as never } },
    permission: { assert: async (input: { action: string }) => void asserted.push(input.action) } as never,
  }
  const state: EventsState = { managed: () => true, disabled: () => false, ...options.state }
  const call = { sessionID: "ses_test", agent: "build", messageID: "msg_test", id: "call_test", signal: new AbortController().signal, progress: async () => {} }
  const now = options.now ?? NOW
  return {
    list: (input: Record<string, unknown>) => eventsMethod(ctx, state, () => now).run(input, call) as Promise<any>,
    probe: (input: Record<string, unknown>) => probeMethod(ctx, state).run(input, call) as Promise<any>,
    calls: synthetic.calls,
    asserted,
  }
}

/** Every page from `since` to the end, `limit` at a time, following the cursor while `more`. */
async function walk(source: ReturnType<typeof setup>, limit: number) {
  const pages: any[] = [await source.list({ since: SINCE, limit })]
  while (pages.at(-1).more) pages.push(await source.list({ account: ACCOUNT, cursor: pages.at(-1).cursor, limit }))
  return pages
}

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error instanceof EventsFailure ? error.code : `not an EventsFailure: ${String(error)}`
  }
  return "no refusal"
}

const conversation = (index: number, at: string, overrides: Partial<SyntheticConversation> = {}): SyntheticConversation => ({
  conversation_id: `conv_${String(index).padStart(4, "0")}`,
  agent_id: "agent_01synthsupport0000000000",
  agent_name: "Support Desk",
  at,
  status: "done",
  call_successful: "success",
  direction: "inbound",
  ...overrides,
})

describe("events_list", () => {
  test("lists the settled conversations oldest first, as metadata only, and refuses the one whose title holds a secret", async () => {
    const source = setup()
    const page = await source.list({ since: SINCE })
    expect(resultProblems(page, 100, 65_536)).toEqual([])
    expect(page).toMatchObject({ source: SOURCE, account: ACCOUNT, owner: OWNER, more: false, trust: "untrusted", plugin: "@joe-broadhead/opencode-elevenlabs" })
    // conv_07 is still in progress and started 30 minutes ago, so the listing stops before it: conv_08 waits too.
    expect(page.events.map((event: any) => event.external_id)).toEqual(["conv_01", "conv_02", "conv_03a", "conv_03b", "conv_04", "conv_05", "conv_06"])
    expect(page.refused).toEqual([{ external_id: SECRET.conversation_id, reason: "secret", detail: expect.any(String) }])
    expect(page.events[0]).toMatchObject({
      kind: "session",
      occurred_at: "2026-10-21T09:00:00.000Z",
      thread: null,
      actors: [{ role: "agent", id: "elevenlabs:agent_01synthsupport0000000000", name: "Support Desk" }],
      title: "Support Desk: inbound call, done, successful",
      text: "",
      url: null,
      labels: ["status:done", "outcome:success", "direction:inbound"],
    })
    // An agent with no name is named by its id; a failed call has no outcome in its title; a processing one settled by time.
    const titles = Object.fromEntries(page.events.map((event: any) => [event.external_id, event.title]))
    expect(titles).toMatchObject({
      conv_02: "Booking Line: outbound call, done, unsuccessful",
      conv_03a: "Booking Line: call, failed",
      conv_04: "agent_03synthnoname00000000000: inbound call, done, successful",
      conv_06: "Booking Line: inbound call, processing",
    })
  })

  test("never carries a caller's words, name or number, and never asks for a summary", async () => {
    const source = setup()
    const text = JSON.stringify(await walk(source, 2))
    for (const value of CALLER_TEXT) expect(text).not.toContain(value)
    expect(source.calls.length).toBeGreaterThan(0)
    for (const call of source.calls) expect(call.input).toMatchObject({ sort_direction: "asc", summary_mode: "exclude", page_size: 100 })
    // It reads only the list: its own action, then agents_list_conversations.
    expect([...new Set(source.asserted)].sort()).toEqual([EVENTS_ACTION, `elevenlabs_${LIST_TOOL}`].sort())
  })

  test("pages two at a time through every listable conversation once, in order, and the cursor resumes where it stopped", async () => {
    const whole = (await setup().list({ since: SINCE })).events.map((event: any) => event.external_id)
    const pages = await walk(setup(), 2)
    expect(pages.flatMap((page) => page.events.map((event: any) => event.external_id))).toEqual(whole)
    expect(pages.slice(0, -1).every((page) => page.more)).toBe(true)
    expect(pages.at(-1).more).toBe(false)
    // Two in the same second are listed by id, whatever order ElevenLabs gave them in.
    expect(whole.indexOf("conv_03a")).toBeLessThan(whole.indexOf("conv_03b"))
  })

  test("keeps a second whose conversations straddle ElevenLabs' page boundary whole, so none is skipped or repeated", async () => {
    // 250 conversations: three share a second across each 100-conversation page boundary, in no particular id order.
    const base = Date.parse("2026-10-21T00:00:00Z")
    const at = (second: number) => new Date(base + second * 1000).toISOString().replace(".000", "")
    const conversations = Array.from({ length: 250 }, (_, index) => {
      const second = index >= 98 && index <= 101 ? 98 : index >= 198 && index <= 201 ? 198 : index
      return conversation(1000 - index, at(second))
    })
    const expected = conversations.map((item) => ({ t: Date.parse(item.at), i: item.conversation_id })).sort((a, b) => a.t - b.t || (a.i < b.i ? -1 : 1)).map((key) => key.i)
    for (const limit of [7, 50, 99, 100, 500]) {
      const pages = await walk(setup({ conversations }), limit)
      const listed = pages.flatMap((page) => page.events.map((event: any) => event.external_id))
      expect({ limit, listed }).toEqual({ limit, listed: expected })
    }
  })

  test("an empty page names its source, account and owner, keeps its cursor, and says there is no more", async () => {
    const source = setup()
    const last = (await source.list({ since: SINCE, limit: 500 })).cursor
    const empty = await source.list({ account: ACCOUNT, cursor: last })
    expect(empty).toMatchObject({ source: SOURCE, account: ACCOUNT, owner: OWNER, events: [], more: false, trust: "untrusted" })
    expect(empty.cursor).toBe(last)
    expect(resultProblems(empty)).toEqual([])
    // A workspace with no conversations at all.
    expect(await setup({ conversations: [] }).list({ since: SINCE })).toMatchObject({ events: [], more: false, owner: OWNER })
  })

  test("lists a conversation still running once its outcome is known, or two hours after its start", async () => {
    const later = setup({ now: Date.parse("2026-11-01T11:30:00Z") + SETTLE_MS })
    const events = (await later.list({ since: SINCE, limit: 500 })).events.map((event: any) => event.external_id)
    expect(events.slice(-2)).toEqual(["conv_07", "conv_08"])
    const finished = setup({ conversations: CONVERSATIONS.map((item) => (item.conversation_id === "conv_07" ? { ...item, status: "done" as const } : item)) })
    expect((await finished.list({ since: SINCE, limit: 500 })).events.map((event: any) => event.external_id).slice(-2)).toEqual(["conv_07", "conv_08"])
  })

  test("a cursor never expires: one from a year back resumes at its own position, and a broken one is CURSOR_INVALID", async () => {
    const digest = createHash("sha256").update(OWNER.id).digest("hex").slice(0, 16)
    const binding = { plugin: "elevenlabs", source: SOURCE, account: ACCOUNT }
    const old = encodeBoundCursor(binding, { o: digest, t: Date.parse("2025-10-01T00:00:00Z"), i: "" })
    const page = await setup().list({ account: ACCOUNT, cursor: old, limit: 500 })
    expect(page.gap).toBeUndefined()
    expect(page.events[0].external_id).toBe("conv_01")
    expect(await refusal(setup().list({ account: ACCOUNT, cursor: "not-a-cursor" }))).toBe("CURSOR_INVALID")
    expect(await refusal(setup().list({ account: ACCOUNT, cursor: encodeBoundCursor({ ...binding, source: "gmail" }, { o: digest, t: 0, i: "" }) }))).toBe("CURSOR_INVALID")
  })

  test("ElevenLabs' failures: UNAVAILABLE with the first line redacted, RATE_LIMITED for a rate limit, a permission refusal unchanged", async () => {
    const failing = setup({ fail: () => "upstream exploded: token=abcdef1234567890\nstack" })
    const error = await failing.list({ since: SINCE }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(EventsFailure)
    expect((error as EventsFailure).code).toBe("UNAVAILABLE")
    expect((error as EventsFailure).message).not.toContain("abcdef1234567890")
    expect((error as EventsFailure).message).not.toContain("stack")
    expect(pluginError(error)).toEqual({ code: "UNAVAILABLE", what: (error as EventsFailure).what, next: (error as EventsFailure).next })
    expect(await refusal(setup({ fail: () => "HTTP 429: Too Many Requests" }).list({ since: SINCE }))).toBe("RATE_LIMITED")
    expect(await refusal(setup({ fail: () => 'MCP server "elevenlabs" is not connected' }).list({ since: SINCE }))).toBe("UNAVAILABLE")
    // The second page fails: the whole call fails, and nothing is listed past what the cursor holds.
    const many = Array.from({ length: 150 }, (_, index) => conversation(index, new Date(Date.parse("2026-10-21T00:00:00Z") + index * 60_000).toISOString().replace(".000", "")))
    expect(await refusal(setup({ conversations: many, fail: (call) => (call === 2 ? "boom" : undefined) }).list({ since: SINCE, limit: 500 }))).toBe("UNAVAILABLE")
    // A refusal from the host's permission check is not ElevenLabs' failure: it passes through unchanged.
    const denied = new Error("PermissionDeniedError")
    expect(await setup({ throws: denied }).list({ since: SINCE }).catch((caught: unknown) => caught)).toBe(denied)
  })

  test("an answer without a conversations list is UNAVAILABLE, never an empty page", async () => {
    const ctx = {
      tool: { list: async () => [{ id: `elevenlabs_${LIST_TOOL}`, execute: async () => ({ content: [{ type: "text", text: "Something went wrong" }] }) }] as never },
      mcp: { list: async () => ({ data: [{ name: "elevenlabs", status: { status: "connected" }, integrationID: "int" }] }) as never },
      integration: { connection: { active: async () => CREDENTIAL as never } },
      permission: { assert: async () => {} } as never,
    } satisfies EventsContext
    const call = { sessionID: "s", agent: "build", messageID: "m", id: "c", signal: new AbortController().signal, progress: async () => {} }
    expect(await refusal(eventsMethod(ctx, { managed: () => true, disabled: () => false }, () => NOW).run({ since: SINCE }, call))).toBe("UNAVAILABLE")
  })

  test("the input, the account, the sign-in and the cursor are checked before any read", async () => {
    const cases: [Record<string, unknown>, Options, string][] = [
      [{ since: SINCE, limit: 0 }, {}, "INPUT_INVALID"],
      [{ since: SINCE, extra: true }, {}, "INPUT_INVALID"],
      [{ since: "yesterday" }, {}, "INPUT_INVALID"],
      [{ cursor: "abc" }, {}, "INPUT_INVALID"],
      [{ since: SINCE, source: "transcripts" }, {}, "SOURCE_UNKNOWN"],
      [{ since: SINCE, account: "work" }, {}, "ACCOUNT_MISMATCH"],
      [{ since: SINCE }, { credential: undefined }, "NEEDS_SIGN_IN"],
      [{ since: SINCE }, { state: { disabled: () => true } }, "SOURCE_DISABLED"],
      [{ since: SINCE }, { state: { managed: () => false } }, "UNAVAILABLE"],
    ]
    for (const [input, options, code] of cases) {
      const source = setup(options)
      expect({ input, code: await refusal(source.list(input)) }).toEqual({ input, code })
      expect(source.calls).toEqual([])
    }
    // A cursor issued for another sign-in is ACCOUNT_MISMATCH, before ElevenLabs is asked anything.
    const cursor = (await setup().list({ since: SINCE, limit: 1 })).cursor
    const other = setup({ credential: { type: "credential", id: "cred_someone_else", label: "Someone" } })
    expect(await refusal(other.list({ account: ACCOUNT, cursor }))).toBe("ACCOUNT_MISMATCH")
    expect(other.calls).toEqual([])
  })

  test("a server that needs a sign-in, or lists no such tool, refuses with the server's state", async () => {
    expect(await refusal(setup({ listed: false, status: "needs_auth" }).list({ since: SINCE }))).toBe("NEEDS_SIGN_IN")
    expect(await refusal(setup({ listed: false, status: "failed" }).list({ since: SINCE }))).toBe("UNAVAILABLE")
    expect(await refusal(setup({ listed: false }).list({ since: SINCE }))).toBe("UNAVAILABLE")
  })
})

describe("probe", () => {
  test("names OpenCode's sign-in as the owner, and calls ElevenLabs for nothing", async () => {
    const source = setup()
    expect(await source.probe({})).toEqual({ source: SOURCE, account: ACCOUNT, owner: OWNER, trust: "untrusted" })
    expect(await source.probe({ source: SOURCE, account: ACCOUNT })).toMatchObject({ owner: OWNER })
    expect(source.asserted).toEqual([PROBE_ACTION, PROBE_ACTION])
    expect(source.calls).toEqual([])
  })

  test("refuses another account, another source, a stray key and a missing sign-in", async () => {
    expect(await refusal(setup().probe({ account: "work" }))).toBe("ACCOUNT_MISMATCH")
    expect(await refusal(setup().probe({ source: "transcripts" }))).toBe("SOURCE_UNKNOWN")
    expect(await refusal(setup().probe({ cursor: "x" }))).toBe("INPUT_INVALID")
    expect(await refusal(setup({ credential: undefined }).probe({}))).toBe("NEEDS_SIGN_IN")
    expect(await refusal(setup({ credential: { type: "api", key: "x" } }).probe({}))).toBe("NEEDS_SIGN_IN")
  })

  test("an owner is the same on every page and probe, and a new sign-in is a new owner", async () => {
    const page = await setup().list({ since: SINCE, limit: 1 })
    expect(page.owner).toEqual((await setup().probe({})).owner)
    const other = await setup({ credential: { type: "credential", id: "cred 2/x", label: "" } }).probe({})
    expect(other.owner).toEqual({ id: "elevenlabs:credential:cred%202%2Fx", label: "ElevenLabs sign-in" })
  })
})

describe("reading spends nothing", () => {
  const item = pkg.sources.items[0]!

  test("the source declares only free reads, and its cost is free", () => {
    expect(item.cost).toEqual({ class: "free" })
    expect(item.permission.operations).toEqual([LIST_TOOL])
    for (const operation of item.permission.operations) {
      expect({ operation, read: READ_TOOLS.includes(operation), spends: SPEND_ANY.includes(operation), priced: mustPrice(operation) }).toEqual({ operation, read: true, spends: false, priced: false })
    }
    // events_list and probe are the plugin's own: the spending guard never prices or refuses them.
    for (const tool of SOURCE_TOOLS) expect({ tool, priced: mustPrice(tool) }).toEqual({ tool, priced: false })
    expect(item.permission.events).toBe(EVENTS_ACTION)
    expect(pkg.sources.probe.action).toBe(PROBE_ACTION)
    // No identity operation: probe reads nothing from ElevenLabs.
    expect(item.permission.identity).toBeUndefined()
  })

  test("every access allows both methods; conversations off denies events_list and keeps probe", () => {
    const base = { action: "*", resource: "*", effect: "allow" as const }
    for (const access of ["all", "ask-changes", "read-only"] as const) {
      for (const conversations of ["full", "summary"] as const) {
        const rules = [base, ...defaultRules(access, conversations)]
        expect({ access, conversations, events: evaluate(rules, EVENTS_ACTION), probe: evaluate(rules, PROBE_ACTION), list: evaluate(rules, `elevenlabs_${LIST_TOOL}`) })
          .toEqual({ access, conversations, events: "allow", probe: "allow", list: "allow" })
      }
      const off = [base, ...defaultRules(access, "off")]
      expect({ access, events: evaluate(off, EVENTS_ACTION), probe: evaluate(off, PROBE_ACTION) }).toEqual({ access, events: "deny", probe: "allow" })
    }
  })
})
