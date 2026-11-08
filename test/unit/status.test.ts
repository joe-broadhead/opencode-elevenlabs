// The status model: the S13 shared fields, ElevenLabs' own rows (region, spend, conversations, media), and one next step
// per state. No network and no host.
import { describe, expect, test } from "bun:test"
import { ENDPOINT, TESTED_HOSTS } from "../../src/constants.js"
import { checkHost } from "../../src/host-version.js"
import { defaultRules } from "../../src/permissions.js"
import { buildStatus, formatStatus, StatusRpc, type StatusFacts } from "../../src/status.js"
import { READ_TOOLS, TRANSCRIPT_TOOLS } from "../../src/elevenlabs-tools.js"

const host = checkHost("2.2.3", false)
const READ = READ_TOOLS[0]!
const SPEND = { dailyCredits: 1200, sessionCap: 2000, dailyCap: 10000 }
const base: StatusFacts = { server: { status: "connected" }, source: { type: "plugin", url: ENDPOINT }, host, tools: [READ], spend: SPEND }

const row = (status: ReturnType<typeof buildStatus>, label: string) => formatStatus(status).split("\n").find((line) => line.startsWith(`- ${label}:`)) ?? ""

describe("buildStatus", () => {
  test("carries the shared fields and nothing to do when all is well", () => {
    const status = buildStatus(base)
    expect(status).toMatchObject({ state: "connected", access: "all", conversations: "full", region: "global", endpoint: ENDPOINT, tools: 1, unknownCount: 0 })
    expect(status.unguardedAgents).toEqual([])
    expect(status.host).toEqual(host)
    expect(status.nextStep).toBe("Nothing to do.")
    expect(status.spend).toEqual(SPEND)
    expect(status.mediaRoot).toBe("~/Downloads/elevenlabs")
  })

  test("maps every server state, and a conflict outranks the server", () => {
    for (const [server, state] of [["connected", "connected"], ["pending", "connecting"], ["needs_auth", "sign_in_required"], ["failed", "failed"], ["disabled", "disabled"]] as const) {
      expect(buildStatus({ ...base, server: { status: server } }).state).toBe(state)
    }
    expect(buildStatus({ host }).state).toBe("not_configured")
    expect(buildStatus({ ...base, source: { type: "conflict", url: "https://example.com/mcp", expected: ENDPOINT } }).state).toBe("conflict")
    // A server at another region's URL is a stale entry, not a configured server.
    expect(buildStatus({ ...base, source: { type: "stale", url: "https://api.eu.residency.elevenlabs.io/v1/mcp", expected: ENDPOINT } }).state).toBe("not_configured")
  })

  test("the conflict next step names both addresses; the stale one names the region and the fix", () => {
    const conflict = buildStatus({ ...base, source: { type: "conflict", url: "https://example.com/mcp", expected: ENDPOINT } })
    expect(conflict.nextStep).toBe(`mcp.servers.elevenlabs is set to https://example.com/mcp, but ElevenLabs's server is ${ENDPOINT}. Point it there or remove it, then restart OpenCode.`)
    const stale = buildStatus({ ...base, source: { type: "stale", url: "https://api.eu.residency.elevenlabs.io/v1/mcp", expected: ENDPOINT } })
    expect(stale.nextStep).toContain("the server for a different region")
    expect(stale.nextStep).toContain(`/connect and choose ElevenLabs for region "global"`)
  })

  test("each state and problem gives exactly one next step, and a failure's reason is cut", () => {
    const signIn = buildStatus({ ...base, server: { status: "needs_auth" } })
    expect(signIn.nextStep).toBe("Run /connect and choose ElevenLabs, then press o or Enter to open the link (in a terminal, opencode mcp auth elevenlabs opens it automatically).")
    expect(buildStatus({ ...base, server: { status: "disabled" } }).nextStep).toContain("The elevenlabs MCP server is disabled. Enable it in /mcps")
    expect(buildStatus({ ...base, server: { status: "pending" } }).nextStep).toContain("still connecting")
    const failed = buildStatus({ ...base, server: { status: "failed", error: "SSE error:\n  fetch https://api.elevenlabs.io/v1/mcp?token=secret-123 failed.\n" } })
    expect(failed.error).toBe("SSE error: fetch https://api.elevenlabs.io/v1/mcp failed")
    expect(failed.error).not.toContain("secret-123")
    expect(failed.nextStep).toBe("Check your network, then run /elevenlabs-status again.")
    expect(buildStatus({ host }).nextStep).toContain("OpenCode has no elevenlabs MCP server")
    expect(buildStatus({ ...base, tools: [], server: { status: "connected" } }).nextStep).toContain("lists no tools for this account")
  })

  test("a problem's own next step becomes the status's, and the agent fix names the block", () => {
    const problem = "RULES_NOT_ADDED: ElevenLabs's default permission rules could not be added (boom), so ElevenLabs tools may run without asking. Next step: Restart OpenCode."
    expect(buildStatus({ ...base, problems: [problem], agents: [{ id: "build", permissions: [] }] }).nextStep).toBe("Restart OpenCode.")
    const agents = [{ id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" as const }] }]
    const unguarded = buildStatus({ ...base, agents })
    expect(unguarded.unguardedAgents).toEqual(["build"])
    expect(unguarded.nextStep).toContain("Put the default rules shown by /elevenlabs-status first in each listed agent's own permissions")
  })

  test("the rows read in order, with the region, spend, conversations and media", () => {
    const text = formatStatus(buildStatus({ ...base, account: "work" }))
    const labels = text.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2, line.indexOf(":")))
    expect(labels).toEqual(["Connection", "Account", "Access", "Region", "Spend", "Conversations", "Media", "Skills", "Tools", "Agents without default rules", "OpenCode", "Next step"])
    expect(text).toContain(`- Region: global (${ENDPOINT})`)
    expect(text).toContain("- Spend: 1,200 credits spent in the last 24 hours of 10,000; a session is capped at 2,000")
    expect(text).toContain("workspace balance unknown")
    expect(text).toContain("- Conversations: full: the transcript tools run, and they carry other people's calls")
    expect(text).toContain("- Account: work")
  })

  test("the spend row shows the balance only when the optional key gave one, and names no key", () => {
    const withBalance = formatStatus(buildStatus({ ...base, spend: { ...SPEND, balance: { used: 500, limit: 30000, resetsAt: Date.UTC(2026, 11, 1), extension: 0 } } }))
    expect(withBalance).toContain("workspace balance 29,500 of 30,000 credits left, resetting 2026-12-01")
    expect(withBalance).not.toMatch(/xi-api-key|api key: [A-Za-z0-9]/i)
  })

  test("conversations summary and off say exactly what is denied", () => {
    expect(row(buildStatus({ ...base, conversations: "summary" }), "Conversations")).toContain(TRANSCRIPT_TOOLS.join(" and "))
    expect(row(buildStatus({ ...base, conversations: "off" }), "Conversations")).toContain("every read of a call's history is denied")
  })

  test("counts unknown tools, lists safe names only, and says what the posture does with them", () => {
    const status = buildStatus({ ...base, tools: [READ, "shiny_new_tool", "bad name!", "another_new"] })
    expect(status.unknownCount).toBe(3)
    expect(status.unknownTools).toEqual(["shiny_new_tool", "another_new"])
    expect(row(status, "Tools")).toContain("(new tools run too)")
    expect(row(buildStatus({ ...base, access: "read-only", tools: [READ, "shiny_new_tool"] }), "Tools")).toContain("(new tools are denied)")
  })

  test("names a skill OpenCode loads from another file, and its fix", () => {
    const status = buildStatus({
      ...base,
      skills: { own: [{ name: "elevenlabs", path: "pkg/skills/elevenlabs/SKILL.md" }, { name: "elevenlabs-creative", path: "pkg/skills/elevenlabs-creative/SKILL.md" }], listed: [{ id: "elevenlabs", path: "$HOME/.config/opencode/skills/elevenlabs/SKILL.md" }, { id: "elevenlabs-creative", path: "pkg/skills/elevenlabs-creative/SKILL.md" }] },
    })
    expect(status.shadowedSkills).toEqual([{ name: "elevenlabs", path: "$HOME/.config/opencode/skills/elevenlabs/SKILL.md" }])
    expect(row(status, "Skills")).toContain("elevenlabs is replaced by $HOME/.config/opencode/skills/elevenlabs/SKILL.md")
    expect(status.nextStep).toContain("Rename or move the skill at $HOME/.config/opencode/skills/elevenlabs/SKILL.md")
  })

  test("an untested host still starts, and the row says so", () => {
    const status = buildStatus({ ...base, host: checkHost("2.2.99", false) })
    expect(status.host.tested).toBe(false)
    expect(row(status, "OpenCode")).toContain("2.2.99 (untested; supported range >=2.2.3 <2.3.0)")
    expect(TESTED_HOSTS).toEqual(["2.2.3", "2.2.4", "2.2.5", "2.2.6"])
  })

  test("the agent fix prints the block for the current options, in full", () => {
    const agents = [{ id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" as const }] }]
    const text = formatStatus(buildStatus({ ...base, access: "read-only", conversations: "off", agents }))
    const printed = text.split("- Agents without default rules: build\n")[1]!.split("\n- OpenCode:")[0]!
    expect(JSON.parse(`[${printed}]`)).toEqual(defaultRules("read-only", "off"))
  })
})

describe("the status contract", () => {
  test("requires the shared fields, and the spend row's caps are nullable", () => {
    const output = StatusRpc.methods.status.output as { required: string[]; properties: Record<string, { required?: string[]; properties?: Record<string, unknown> }> }
    for (const field of ["version", "state", "access", "host", "unguardedAgents", "nextStep", "spend", "region", "conversations", "mediaRoot"]) expect(output.required).toContain(field)
    expect(output.properties.spend!.required).toEqual(["dailyCredits", "sessionCap", "dailyCap"])
  })
})
