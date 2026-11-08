import { describe, expect, test } from "bun:test"
import { readBalance } from "../../src/balance.js"
import { AUTH_SERVERS, OAUTH_SCOPES, REGIONS } from "../../src/constants.js"
import { checkDiscovery, doctorSummary, runDoctor, type DoctorContext, type DoctorFacts } from "../../src/doctor.js"
import { checkHost } from "../../src/host-version.js"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const SCOPES = OAUTH_SCOPES.split(" ")

/** The discovery chain, answered as ElevenLabs answers it, with the pieces a test can break. */
const discovery = (overrides: { resource?: unknown; auth?: unknown; metadata?: unknown; status?: number } = {}) =>
  (async (url: string) => {
    if (url.includes("/.well-known/oauth-protected-resource")) {
      return json(overrides.resource ?? { resource: REGIONS.global, authorization_servers: [AUTH_SERVERS.global] }, overrides.status ?? 200)
    }
    return json(overrides.metadata ?? { issuer: AUTH_SERVERS.global, client_id_metadata_document_supported: true, scopes_supported: [...SCOPES, "ads_read"] }, overrides.auth === undefined ? 200 : 500)
  }) as unknown as typeof fetch

describe("discovery", () => {
  test("walks the resource document to the sign-in server, and confirms CIMD and every scope the plugin asks for", async () => {
    const lines = await checkDiscovery("global", discovery())
    expect(lines.every(([ok]) => ok)).toBe(true)
    const text = lines.map(([, line]) => line).join("\n")
    expect(text).toContain(`names ${AUTH_SERVERS.global} as its sign-in server`)
    expect(text).toContain("accepts a client metadata document")
    expect(text).toContain(`all ${SCOPES.length} the plugin asks for are advertised`)
  })

  test("fails when the resource names another sign-in server, or the metadata is unreachable", async () => {
    const wrong = await checkDiscovery("global", discovery({ resource: { resource: REGIONS.global, authorization_servers: ["https://example.com"] } }))
    expect(wrong[0]![0]).toBe(false)
    expect(wrong[0]![1]).toContain("not https://api.us.elevenlabs.io")
    const unreachable = await checkDiscovery("global", (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch)
    expect(unreachable[0]![0]).toBe(false)
  })

  test("fails a scope the plugin asks for that the server no longer advertises", async () => {
    const lines = await checkDiscovery("global", discovery({ metadata: { client_id_metadata_document_supported: true, scopes_supported: ["convai_read"] } }))
    const scopes = lines.find(([, line]) => line.startsWith("scopes:"))!
    expect(scopes[0]).toBe(false)
    expect(scopes[1]).toContain("convai_write")
  })

  test("each region is checked against its own sign-in server", () => {
    for (const region of Object.keys(REGIONS) as (keyof typeof REGIONS)[]) {
      expect(new URL(REGIONS[region]).origin).not.toBe("")
      expect(AUTH_SERVERS[region]).toMatch(/^https:\/\//)
    }
  })
})

/** A context that reports what a working setup would, with nothing to fetch. */
const context = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({
  mcp: { list: async () => ({ data: [{ name: "elevenlabs", status: { status: "connected" }, integrationID: "mcp_1" }] }) },
  tool: { list: async () => [{ id: "elevenlabs_agents_list", name: "agents_list", options: { namespace: "elevenlabs" } }] as never },
  skill: { list: async () => ({ data: [{ id: "elevenlabs", path: "/pkg/skills/elevenlabs/SKILL.md" }, { id: "elevenlabs-creative", path: "/pkg/skills/elevenlabs-creative/SKILL.md" }, { id: "elevenlabs-calls", path: "/pkg/skills/elevenlabs-calls/SKILL.md" }] }) },
  agent: { list: async () => ({ data: [{ id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] }] }) },
  ...overrides,
}) as unknown as DoctorContext

const facts = (overrides: Partial<DoctorFacts> = {}): DoctorFacts => ({
  region: "global",
  access: "all",
  conversations: "full",
  mediaRoot: "~/Downloads/elevenlabs",
  maxMediaBytes: 1024,
  host: checkHost("2.2.3", false),
  spend: { dailyCredits: 1200, sessionCap: 2000, dailyCap: 10000 },
  skills: [
    { name: "elevenlabs", path: "/pkg/skills/elevenlabs/SKILL.md" },
    { name: "elevenlabs-creative", path: "/pkg/skills/elevenlabs-creative/SKILL.md" },
    { name: "elevenlabs-calls", path: "/pkg/skills/elevenlabs-calls/SKILL.md" },
  ],
  problems: [],
  fetch: discovery(),
  ...overrides,
})

describe("the doctor", () => {
  test("reports each check as ok and ends with nothing to do", async () => {
    const report = await runDoctor(context(), facts())
    expect(report).toContain("ElevenLabs doctor")
    expect(report).toContain("ok   region: global")
    expect(report).toContain("ok   server: connected")
    expect(report).toContain("ok   tools: 1 listed")
    expect(report).toContain("ok   skills: 3 of 3 loaded")
    expect(report).toContain("ok   spend: 1,200 credits in the last 24 hours of 10,000")
    expect(report).toContain("balance: no API key added")
    expect(report).toContain("Everything checked out. Nothing to do.")
    expect(report).not.toContain("FAIL")
  })

  test("marks a missing sign-in, a missing skill and a server that lists no tools as failures, with one next step", async () => {
    const report = await runDoctor(
      context({
        mcp: { list: async () => ({ data: [{ name: "elevenlabs", status: { status: "needs_auth" } }] }) } as unknown as DoctorContext["mcp"],
        tool: { list: async () => [] } as unknown as DoctorContext["tool"],
        skill: { list: async () => ({ data: [] }) } as unknown as DoctorContext["skill"],
      }),
      facts(),
    )
    expect(report).toContain("FAIL sign-in: a sign-in is required")
    expect(report).toContain("FAIL tools: 0 listed")
    expect(report).toContain("FAIL skills: 0 of 3 loaded")
    expect(report).toContain("Next step: fix the")
  })

  test("shows the balance when the optional key gave one, and never the key", async () => {
    const report = await runDoctor(context(), facts({ spend: { dailyCredits: 0, sessionCap: null, dailyCap: null, balance: { used: 500, limit: 30000 } } }))
    expect(report).toContain("balance: 29,500 of 30,000 credits left this period")
    expect(report).not.toMatch(/xi-api-key/i)
  })

  test("a summary line for the dialog names the failures", () => {
    expect(doctorSummary([[true, "a"]])).toBe("doctor: all checks passed")
    expect(doctorSummary([[true, "a"], [false, "b"]])).toBe("doctor: 1 check(s) failed; run /elevenlabs-doctor")
  })
})

describe("the balance read", () => {
  test("parses the subscription's credit counts, reset date and overage", async () => {
    const balance = await readBalance("key", "https://api.example/subscription", (async () => json({
      character_count: 500,
      character_limit: 30000,
      next_character_count_reset_unix: 1767225600,
      max_credit_limit_extension: "unlimited",
      tier: "creator",
    })) as unknown as typeof fetch)
    expect(balance).toEqual({ used: 500, limit: 30000, resetsAt: 1767225600000, extension: "unlimited", tier: "creator" })
  })

  test("a refused key is a coded problem, not a failed status", async () => {
    await expect(readBalance("bad", "https://api.example/subscription", (async () => json({}, 401)) as unknown as typeof fetch)).rejects.toMatchObject({ code: "BALANCE_UNAVAILABLE" })
    await expect(readBalance("bad", "https://api.example/subscription", (async () => json({}, 500)) as unknown as typeof fetch)).rejects.toMatchObject({ code: "BALANCE_UNAVAILABLE" })
    await expect(readBalance("bad", "https://api.example/subscription", (async () => new Response("nope", { status: 200 })) as unknown as typeof fetch)).rejects.toMatchObject({ code: "BALANCE_UNAVAILABLE" })
    await expect(readBalance("bad", "https://api.example/subscription", (async () => { throw new Error("offline") }) as unknown as typeof fetch)).rejects.toMatchObject({ code: "BALANCE_UNAVAILABLE" })
  })
})
