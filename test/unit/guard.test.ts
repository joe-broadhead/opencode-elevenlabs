import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ALL_TOOLS, ESTIMATE_TOOLS, SPEND_ANY, mustPrice } from "../../src/elevenlabs-tools.js"
import { estimatePrice, quoteCall, quoteCallSync, Ledger, SpendRefused } from "../../src/billing.js"
import { SAVE_ACTION, runSaveMedia } from "../../src/media/tool.js"
import { sharedStore } from "../fixtures/store.js"

const root = mkdtempSync(join(tmpdir(), "elevenlabs-guard-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const caps = (session: number | null = 2000, daily: number | null = 10000) => ({ sessionCreditCap: session, dailyCreditCap: daily })
const call = (id = "c1", sessionID = "ses_a") => ({ sessionID, agent: "build", messageID: "m1", id })

describe("nothing that may spend runs unguarded", () => {
  test("every creative_* tool is priced from ElevenLabs' own estimate or refused while a cap is on", async () => {
    const creative = ALL_TOOLS.filter((tool) => tool.startsWith("creative_"))
    expect(creative.length).toBeGreaterThan(5)
    // With no estimate to hand, every creative name the guard must price refuses: nothing here prices itself.
    for (const tool of creative.filter(mustPrice)) {
      const ledger = new Ledger()
      const outcome = await quoteCall({ ledger, caps: () => caps() }, tool, {}, call(tool)).then(
        () => "quoted",
        (error: unknown) => (error as SpendRefused).code,
      )
      expect({ tool, outcome }).toEqual({ tool, outcome: "PRICE_UNKNOWN" })
    }
    // Given ElevenLabs' own figure, the tools that accept `estimate_only` are priced and reserved rather than refused.
    for (const tool of ESTIMATE_TOOLS) {
      const ledger = new Ledger()
      const estimate = async (name: string, input: Record<string, unknown>) => estimatePrice(name, input, { output: { credits: 120 } })
      const { price, tracked } = await quoteCall({ ledger, caps: () => caps(), estimate }, tool, {}, call(tool))
      expect({ tool, credits: price.credits, tracked }).toEqual({ tool, credits: 120, tracked: true })
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

  // The gate used to be the `creative_` prefix, so a spending tool under any other name ran unpriced with both caps on,
  // and `get_more_tools` is a tool whose whole job is to ask ElevenLabs for more tools.
  test("an unknown name is refused under a cap whatever its prefix, on the model path and the script path alike", async () => {
    for (const tool of ["agents_new_spender", "foo_bar"]) {
      const ledger = new Ledger()
      const refused = await quoteCall({ ledger, caps: () => caps() }, tool, {}, call(tool)).then(
        () => undefined,
        (error: unknown) => error as SpendRefused,
      )
      expect({ tool, code: refused?.code }).toEqual({ tool, code: "PRICE_UNKNOWN" })
      // The next step is a configuration change or a later release, not another call: there is no estimate to
      // suggest for a tool with no schema here.
      expect(refused?.message).toContain("is not in this plugin's tool table")
      expect(refused?.nextStep).toContain('"dailyCreditCap" to null')
      expect(refused?.nextStep).toContain("wait for a release that classifies it")
      expect(refused?.nextStep).not.toContain("estimate_only")

      // The script path cannot await an estimate, and refuses the same way.
      const sync = new Ledger()
      const syncRefused = (() => {
        try {
          quoteCallSync({ ledger: sync, caps: () => caps() }, tool, {}, call(tool))
          return undefined
        } catch (error) {
          return error as SpendRefused
        }
      })()
      expect({ tool, code: syncRefused?.code }).toEqual({ tool, code: "PRICE_UNKNOWN" })
      expect(syncRefused?.message).toContain("is not in this plugin's tool table")

      // With both caps off there is nothing to enforce: it runs, untracked, on both paths.
      const off = new Ledger()
      expect((await quoteCall({ ledger: off, caps: () => caps(null, null) }, tool, {}, call(tool))).tracked).toBe(false)
      expect(quoteCallSync({ ledger: off, caps: () => caps(null, null) }, tool, {}, call(tool)).tracked).toBe(false)
    }
  })

  test("a classified read still runs with a cap on, and so does the plugin's own tool", async () => {
    const ledger = new Ledger()
    for (const tool of ["agents_list", "agents_get_conversation", "get_more_tools", "save_media"]) {
      const { tracked, price } = await quoteCall({ ledger, caps: () => caps() }, tool, {}, call(tool))
      expect({ tool, tracked, credits: price.credits }).toEqual({ tool, tracked: false, credits: 0 })
    }
  })
})

describe("two ledgers handed one storage object share one cap", () => {
  const stored = sharedStore

  // The sync path prices only from an estimate the ledger already holds, so each ledger here is given ElevenLabs'
  // figure for these arguments first, as a script does by sending `estimate_only` before the paid call.
  const SPEECH = { prompt: "x".repeat(600), voice_id: "voice_example", model_id: "model_example" }
  const knowing = (ledger: Ledger) => (ledger.rememberPrice("creative_generate_speech", SPEECH, { credits: 1200, basis: "exact", parts: [] }), ledger)

  test("a reservation in one ledger is visible to the other at once", () => {
    // One storage object is one location in one OpenCode: the two ledgers share a book, so the second sees the first's
    // hold with nothing awaited.
    const store = stored()
    const handle = store.handle()
    const first = knowing(new Ledger({ storage: handle }))
    const second = knowing(new Ledger({ storage: handle }))
    quoteCallSync({ ledger: first, caps: () => caps() }, "creative_generate_speech", { ...SPEECH }, call("a"))
    expect(first.spend("ses_a").sessionCredits).toBe(1200)
    expect(() => quoteCallSync({ ledger: second, caps: () => caps() }, "creative_generate_speech", { ...SPEECH }, call("b"))).toThrow(SpendRefused)
    expect(second.spend("ses_a").sessionCredits).toBe(1200)
  })

  test("two storage objects over one store do not decide together, and both charges survive", async () => {
    // Two OpenCodes on one data directory. Neither can see the other's reservation before it is written, so both are
    // admitted: that is the documented limit of a cap with no compare-and-set, not a cap that holds. What must hold is
    // that neither charge is lost, so the next call in each sees all 2,400.
    const store = stored()
    const first = knowing(new Ledger({ storage: store.handle() }))
    const second = knowing(new Ledger({ storage: store.handle() }))
    await Promise.all([first.hydrate(), second.hydrate()])
    quoteCallSync({ ledger: first, caps: () => caps() }, "creative_generate_speech", { ...SPEECH }, call("a"))
    quoteCallSync({ ledger: second, caps: () => caps() }, "creative_generate_speech", { ...SPEECH }, call("b"))
    first.settle("a", "ses_a", 1200)
    second.settle("b", "ses_a", 1200)
    await Promise.all([first.flush(), second.flush()])
    const restarted = knowing(new Ledger({ storage: store.handle() }))
    await restarted.hydrate()
    expect(restarted.daily()).toBe(2400)
    expect(() => quoteCallSync({ ledger: restarted, caps: () => caps() }, "creative_generate_speech", { ...SPEECH }, call("c"))).toThrow(SpendRefused)
  })
})

describe("elevenlabs_save_media asserts the path rule too", () => {
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

describe("one estimate per call", () => {
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
