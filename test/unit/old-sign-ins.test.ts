// A region change leaves the earlier region's sign-in stored in OpenCode, keyed by the server's name and old URL. A
// plugin cannot delete a credential, so it finds each one, lists it in /connect under a name that says what it is, and
// status names it with the command that removes it. No network and no host.
import { describe, expect, test } from "bun:test"
import { ENDPOINT, oldSignInName, REGIONS } from "../../src/constants.js"
import { checkHost } from "../../src/host-version.js"
import { findOldSignIns, registerOldSignIns, serverIntegrationID } from "../../src/old-sign-ins.js"
import { buildStatus, formatStatus, StatusRpc, type StatusFacts } from "../../src/status.js"
import { READ_TOOLS } from "../../src/elevenlabs-tools.js"

const host = checkHost("2.2.3", false)
const base: StatusFacts = { server: { status: "connected" }, source: { type: "plugin", url: ENDPOINT }, host, tools: [READ_TOOLS[0]!], spend: { dailyCredits: 0, sessionCap: null, dailyCap: null } }
const row = (facts: StatusFacts, label: string) => formatStatus(buildStatus(facts)).split("\n").find((line) => line.startsWith(`- ${label}:`)) ?? ""

/** A store holding a credential under each id given, and nothing else. */
const store = (ids: readonly string[]) => ({
  connection: {
    active: async (id: string) => (ids.includes(id) ? ({ type: "credential", id: `cred-${id}`, label: "me", method: "oauth" } as never) : undefined),
  },
})

describe("the integration id", () => {
  test("is OpenCode's own: mcp_ and the first 16 hex digits of sha1(name, NUL, url)", () => {
    // Computed by hand from the host's formula, so a change to either side fails here.
    const id = serverIntegrationID("elevenlabs", REGIONS.eu)
    expect(id).toMatch(/^mcp_[0-9a-f]{16}$/)
    const expected = new Bun.CryptoHasher("sha1").update(`elevenlabs\u0000${REGIONS.eu}`).digest("hex").slice(0, 16)
    expect(id).toBe(`mcp_${expected}`)
    expect(serverIntegrationID("elevenlabs", REGIONS.global)).not.toBe(id)
  })
})

describe("finding the sign-ins an earlier region left", () => {
  test("finds each other region whose sign-in is stored, never the selected one", async () => {
    const ids = [serverIntegrationID("elevenlabs", REGIONS.global), serverIntegrationID("elevenlabs", REGIONS.eu)]
    expect(await findOldSignIns(store(ids), "eu")).toEqual([{ region: "global", integrationID: ids[0]! }])
    expect(await findOldSignIns(store(ids), "us")).toEqual([
      { region: "global", integrationID: ids[0]! },
      { region: "eu", integrationID: ids[1]! },
    ])
    expect(await findOldSignIns(store([]), "global")).toEqual([])
  })

  test("a lookup that fails counts as none: it is advice", async () => {
    const failing = { connection: { active: async () => Promise.reject(new Error("store down")) } }
    expect(await findOldSignIns(failing, "global")).toEqual([])
  })

  test("lists each one in /connect under a name that says what it is", async () => {
    const named = new Map<string, string>()
    const integration = {
      transform: async (callback: (editor: { update: (id: string, update: (draft: { name: string }) => void) => void }) => void) => {
        callback({ update: (id, update) => {
          const draft = { name: id }
          update(draft)
          named.set(id, draft.name)
        } })
        return { dispose: async () => {} }
      },
    }
    const id = serverIntegrationID("elevenlabs", REGIONS.eu)
    await registerOldSignIns(integration as never, [{ region: "eu", integrationID: id }])
    expect([...named]).toEqual([[id, "ElevenLabs, old eu sign-in (not in use)"]])
    expect(oldSignInName("eu")).toBe("ElevenLabs, old eu sign-in (not in use)")
  })
})

describe("status", () => {
  const old = { region: "eu" as const, integrationID: serverIntegrationID("elevenlabs", REGIONS.eu) }

  test("names the old sign-in on the Region row and gives the command that removes it", () => {
    const status = buildStatus({ ...base, oldSignIns: [old] })
    expect(status.oldSignIns).toEqual([old])
    expect(row({ ...base, oldSignIns: [old] }, "Region")).toBe(`- Region: global (${ENDPOINT}); a sign-in for eu is still stored and unused`)
    expect(status.nextStep).toBe(`Remove the eu sign-in left from an earlier region: run opencode auth logout ${old.integrationID}, or sign out of "ElevenLabs, old eu sign-in (not in use)" in /connect.`)
  })

  test("says nothing about it when there is none, and a real problem still comes first", () => {
    const none = buildStatus(base)
    expect(none.oldSignIns).toBeUndefined()
    expect(none.nextStep).toBe("Nothing to do.")
    expect(row(base, "Region")).toBe(`- Region: global (${ENDPOINT})`)
    expect(buildStatus({ ...base, oldSignIns: [old], server: { status: "needs_auth" } }).state).toBe("sign_in_required")
  })

  test("the status RPC's contract carries it", () => {
    const properties = StatusRpc.methods.status.output.properties as Record<string, unknown>
    expect(properties.oldSignIns).toBeDefined()
    expect(StatusRpc.methods.status.output.required).not.toContain("oldSignIns")
  })
})
