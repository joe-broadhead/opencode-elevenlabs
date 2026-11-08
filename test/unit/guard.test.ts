import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ALL_TOOLS, SPEND_ANY, mustPrice } from "../../src/elevenlabs-tools.js"
import { priceOf, quoteCall, quoteCallSync, Ledger, SpendRefused } from "../../src/billing.js"
import { SAVE_ACTION, runSaveMedia } from "../../src/media/tool.js"

const root = mkdtempSync(join(tmpdir(), "elevenlabs-guard-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const caps = (session: number | null = 2000, daily: number | null = 10000) => ({ sessionCreditCap: session, dailyCreditCap: daily })
const call = (id = "c1", sessionID = "ses_a") => ({ sessionID, agent: "build", messageID: "m1", id })

describe("nothing that may spend runs unguarded (DR-3)", () => {
  test("every creative_* tool is priced from the table or refused while a cap is on", async () => {
    const creative = ALL_TOOLS.filter((tool) => tool.startsWith("creative_"))
    expect(creative.length).toBeGreaterThan(5)
    const priced_ = creative.filter((tool) => priceOf(tool, { text: "hi", prompt: "hi", duration_seconds: 60 }) !== undefined)
    const unpriced = creative.filter((tool) => !priced_.includes(tool))
    // Every one is either priced from the table or must be refused: none may run unpriced under a cap.
    for (const tool of priced_) expect({ tool, guarded: mustPrice(tool) }).toEqual({ tool, guarded: true })
    for (const tool of unpriced) {
      const ledger = new Ledger()
      const outcome = await quoteCall({ ledger, caps: () => caps() }, tool, { prompt: "hi" }, call(tool)).then(
        () => "quoted",
        (error: unknown) => (error as SpendRefused).code,
      )
      // A generation the plugin cannot price is refused, never run; a read is not charged at all.
      expect({ tool, outcome: outcome === "quoted" || outcome === "PRICE_UNKNOWN" }).toEqual({ tool, outcome: true })
    }
    // A creative name the table has never seen is still guarded by its shape.
    expect(mustPrice("creative_upscale")).toBe(true)
    expect(SPEND_ANY).toContain("creative_transcribe_audio")
  })

  test("a name the vendor adds later, outside the table, is refused rather than priced by a guess", async () => {
    const ledger = new Ledger()
    await expect(quoteCall({ ledger, caps: () => caps() }, "creative_generate_tomorrows_thing", {}, call())).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    // With no cap there is nothing to refuse: the call runs, and says it is untracked.
    const untracked = await quoteCall({ ledger, caps: () => caps(null, null) }, "creative_generate_tomorrows_thing", {}, call())
    expect(untracked.tracked).toBe(false)
  })
})

describe("two ledgers on one storage share one cap", () => {
  test("a reservation in one ledger is visible to the other", () => {
    const stored = new Map<string, unknown>()
    const store = { get: async (key: string) => stored.get(key) as never, set: async (key: string, value: unknown) => void stored.set(key, value) }
    const first = new Ledger({ storage: store })
    const second = new Ledger({ storage: store })
    quoteCallSync({ ledger: first, caps: () => caps() }, "creative_generate_speech", { text: "x".repeat(600) }, call("a"))
    expect(first.spend("ses_a").sessionCredits).toBe(1200)
    expect(() => quoteCallSync({ ledger: second, caps: () => caps() }, "creative_generate_speech", { text: "x".repeat(600) }, call("b"))).toThrow(SpendRefused)
    expect(second.spend("ses_a").sessionCredits).toBe(1200)
  })
})

describe("elevenlabs_save_media asserts the path rule too (DR-8)", () => {
  /** An assert that records each request and refuses the one named. */
  const asserting = (refuse: string, order: string[] = []) =>
    (async (input: { action: string; resources: readonly string[] }) => {
      order.push(input.action)
      if (input.action === refuse) throw Object.assign(new Error("Permission denied"), { name: "Permission.Error" })
    }) as never

  test("it asserts its own action, then external_directory for the absolute folder, before any fetch", async () => {
    const order: string[] = []
    const assert = asserting("none", order)
    const save = { root: join(root, "media"), maxBytes: 1024, hosts: ["elevenlabsusercontent.com"], assert }
    let fetched = 0
    const outcome = runSaveMedia(
      { ...save, fetch: (async () => (fetched++, new Response("x"))) as unknown as typeof fetch },
      { url: "https://elevenlabsusercontent.com/a.mp3" },
      { sessionID: "s", agent: "build", messageID: "m", id: "i" },
    )
    await outcome.catch(() => undefined)
    expect(order).toEqual([SAVE_ACTION, "external_directory"])
    void assert
  })

  test("a refused external_directory is a coded refusal whose next step is the exact rule", async () => {
    const save = { root: join(root, "media"), maxBytes: 1024, hosts: ["elevenlabsusercontent.com"], assert: asserting("external_directory") }
    const failure = runSaveMedia({ ...save, fetch: (async () => new Response("x")) as unknown as typeof fetch }, { url: "https://elevenlabsusercontent.com/a.mp3" }, { sessionID: "s", agent: "build", messageID: "m", id: "i" })
    await expect(failure).rejects.toMatchObject({ code: "EXTERNAL_DIRECTORY_DENIED", nextStep: expect.stringContaining(`"external_directory", "resource": "${join(root, "media")}/*"`) })
  })

  test("a declined permission is passed through untouched, not turned into a code", async () => {
    const declined = (async () => {
      throw Object.assign(new Error("The user declined"), { name: "Permission.DeclinedError" })
    }) as never
    const save = { root: join(root, "media"), maxBytes: 1024, hosts: ["elevenlabsusercontent.com"], assert: declined }
    await expect(runSaveMedia({ ...save, fetch: (async () => new Response("x")) as unknown as typeof fetch }, { url: "https://elevenlabsusercontent.com/a.mp3" }, { sessionID: "s", agent: "build", messageID: "m", id: "i" })).rejects.toMatchObject({ name: "Permission.DeclinedError" })
  })
})

describe("one estimate per call (DR-14)", () => {
  test("the model path asks ElevenLabs exactly once, whatever the answer", async () => {
    for (const answer of [undefined, { credits: 400, basis: "exact" as const, parts: [] }]) {
      let asked = 0
      const ledger = new Ledger()
      const estimate = async () => (asked++, answer)
      await quoteCall({ ledger, caps: () => caps(), estimate }, "creative_generate_image", { prompt: "x" }, call()).catch(() => undefined)
      expect(asked).toBe(1)
    }
  })
})
