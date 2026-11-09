// From the review of the estimate-first reconcile. RE-1 and RE-2 are covered where the behaviour they changed already
// lived — the tool table's own tests, the money gate's, and `billing.test.ts`'s strict-parse block — so what is here
// is RE-5 to RE-8.
//
// RE-5 to RE-7 are reproductions: five of these tests failed at e07ebfc and pass after the fix, and the rest of each
// block states what already held, so a fix cannot quietly take it away. The three were filed as nits and fixed anyway,
// each because a guard was deciding from the wrong thing.
//
// RE-8 is different: nothing was broken, and nothing in it failed at e07ebfc. It is the coverage the review found
// missing — four documents promised the user is "asked once" and no test counted a single assert, so a second prompt
// would have been invisible here. What a host shows is still a host's to settle, and live pass 2 counts it.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Ledger, quoteCall, quoteCallSync, RESERVATION_MS, SpendRefused } from "../../src/billing.js"
import { ENDPOINT } from "../../src/constants.js"
import { classify, READ_TOOLS, WRITE_TOOLS } from "../../src/elevenlabs-tools.js"
import { defaultRules } from "../../src/permissions.js"
import { createElevenlabsPlugin } from "../../src/plugin.js"
import { mcpEditor, pluginContext } from "./fake.js"

const skillsDir = mkdtempSync(join(tmpdir(), "elevenlabs-rr6-"))
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }))
const seam = { endpoint: ENDPOINT, skillsDir }
type Hook = (event: never) => Promise<void>

const caps = (session: number | null = 100_000, daily: number | null = 100_000) => ({ sessionCreditCap: session, dailyCreditCap: daily })
const call = (id = "c1", sessionID = "ses_a") => ({ sessionID, agent: "build", messageID: "m1", id })

const refusal = async (run: Promise<unknown> | (() => unknown)) => {
  const outcome = await (typeof run === "function" ? Promise.resolve().then(run) : run).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(outcome).toBeInstanceOf(SpendRefused)
  return outcome as SpendRefused
}

/** The effect the generated default rules give one tool at one `access`. */
const effectOf = (tool: string, access: "all" | "ask-changes" | "read-only") =>
  defaultRules(access).find((rule) => rule.action === `elevenlabs_${tool}`)?.effect

describe("RE-5 — a tool that renders a view is classed by what it does, not by what it returns", () => {
  // At e07ebfc `creative_show_flow_results` was in READ_TOOLS, so `access: "read-only"` allowed it: a session that
  // denied every other change could still push a view into the user's workspace. The catalogue draws the line itself.

  test("showing a run's results is a write, and reading the same run's status is still a read", () => {
    expect(classify("creative_show_flow_results")).toBe("write")
    expect(WRITE_TOOLS).toContain("creative_show_flow_results")
    expect(READ_TOOLS).not.toContain("creative_show_flow_results")
    // Its sibling returns the same data and renders nothing, which is what a read is.
    expect(classify("creative_get_flow_run_status")).toBe("read")
  })

  test("`read-only` denies it and `ask-changes` asks, as for any other effect on the workspace", () => {
    expect(effectOf("creative_show_flow_results", "read-only")).toBe("deny")
    expect(effectOf("creative_show_flow_results", "ask-changes")).toBe("ask")
    expect(effectOf("creative_show_flow_results", "all")).toBe("allow")
    // The read it was grouped with is allowed at every access, which is the difference the class now records.
    for (const access of ["all", "ask-changes", "read-only"] as const) {
      expect({ access, effect: effectOf("creative_get_flow_run_status", access) }).toEqual({ access, effect: "allow" })
    }
  })

  test("it is still priced by nothing: the class says what it may do, not what it costs", async () => {
    // It generates nothing, so no cap touches it; moving it out of the reads must not have made it a money question.
    const quote = await quoteCall({ ledger: new Ledger(), caps: () => caps() }, "creative_show_flow_results", { flow_id: "flow_example" }, call())
    expect(quote).toEqual({ price: { credits: 0, basis: "exact", parts: [] }, tracked: false })
  })
})

describe("RE-6 — the free estimate probe is held to the same argument allowlist the paid call is", () => {
  // At e07ebfc both `quote` and `quoteSync` opened with `isEstimate(...) || !mustPrice(...)`, which returned ahead of
  // the allowlist check. An invented argument was forwarded to ElevenLabs on the probe, which the server rejects —
  // leaving a flow and a node behind for a call that answered nothing, the exact cost the check exists to avoid.
  const bogus = { prompt: "a mug", generations_count: 1, estimate_only: true, bogus_field: "x" }
  const sound = { prompt: "a mug", generations_count: 1, estimate_only: true }

  test("an argument ElevenLabs' schema does not have refuses the probe, on both paths, while a cap is on", async () => {
    for (const run of [
      () => quoteCall({ ledger: new Ledger(), caps: () => caps() }, "creative_generate_image", { ...bogus }, call()),
      () => quoteCallSync({ ledger: new Ledger(), caps: () => caps() }, "creative_generate_image", { ...bogus }, call()),
    ]) {
      const failure = await refusal(run)
      expect(failure.code).toBe("PRICE_UNKNOWN")
      expect(failure.message).toContain(`"bogus_field" is an argument ElevenLabs' own schema for this tool does not have`)
      expect(failure.message).toContain("this probe was not sent")
      // Not `unknownPrice`'s next step: this caller already sent `estimate_only`, so telling them to send it is no step
      // at all. The argument is the thing to change.
      expect(failure.nextStep).toContain("Ask for the estimate again without that argument")
      expect(failure.nextStep).not.toContain(`once with "estimate_only": true`)
    }
  })

  test("a sound probe still runs free: not priced, not reserved, not charged", async () => {
    const ledger = new Ledger()
    const quote = await quoteCall({ ledger, caps: () => caps() }, "creative_generate_image", { ...sound }, call())
    expect(quote).toEqual({ price: { credits: 0, basis: "exact", parts: [] }, tracked: false })
    expect(ledger.daily()).toBe(0)
    expect(quoteCallSync({ ledger, caps: () => caps() }, "creative_generate_image", { ...sound }, call())).toMatchObject({ tracked: false })
    expect(ledger.daily()).toBe(0)
  })

  test("with both caps off nothing is checked here either, as everywhere else", async () => {
    const off = { ledger: new Ledger(), caps: () => caps(null, null) }
    expect(await quoteCall(off, "creative_generate_image", { ...bogus }, call())).toMatchObject({ tracked: false })
    expect(quoteCallSync(off, "creative_generate_image", { ...bogus }, call())).toMatchObject({ tracked: false })
  })

  test("the paid call carrying that argument was already refused, so no figure could ever have paid for one", async () => {
    // Why the review filed this as a nit and not as money: the probe's figure is keyed by its arguments, and the paid
    // call with those arguments is refused before any remembered price is read.
    const { bogus_field, estimate_only, ...rest } = { ...bogus }
    const failure = await refusal(quoteCall({ ledger: new Ledger(), caps: () => caps() }, "creative_generate_image", { ...rest, bogus_field }, call()))
    expect(failure.code).toBe("PRICE_UNKNOWN")
    expect(failure.message).toContain(`"bogus_field"`)
    expect(estimate_only).toBe(true)
  })
})

describe("RE-7 — a remembered estimate is dropped when it expires, not kept for the life of the process", () => {
  // At e07ebfc `prune()` aged `book.own` and `book.folded` and never touched `remembered`. `rememberedPrice` refused
  // to return a stale entry but left it in the Map, and its key is the tool name plus the stable JSON of every
  // argument — so the whole prompt stayed in memory until the process ended.
  //
  // The Map is private, and its size is the finding: a stale entry cannot be observed through the public answer,
  // because that answer was already correct. So the test reads the field the review named.
  const sizeOf = (ledger: Ledger) => (ledger as unknown as { remembered: Map<string, unknown> }).remembered.size
  const price = { credits: 10, basis: "exact" as const, parts: [] }

  test("estimates past their ten minutes are gone from the Map, not merely refused", () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    ledger.rememberPrice("creative_generate_speech", { prompt: "the first secret" }, price)
    ledger.rememberPrice("creative_generate_speech", { prompt: "the second secret" }, price)
    expect(sizeOf(ledger)).toBe(2)
    // Still fresh: nothing is dropped, and the figure is still usable.
    now += RESERVATION_MS - 1
    ledger.rememberPrice("creative_generate_image", { prompt: "a mug" }, price)
    expect(sizeOf(ledger)).toBe(3)
    expect(ledger.rememberedPrice("creative_generate_speech", { prompt: "the first secret" })).toEqual(price)
    // Past the window the two speech prompts can price nothing, so they are not kept.
    now += 2
    ledger.rememberPrice("creative_generate_video", { prompt: "a river" }, price)
    expect(sizeOf(ledger)).toBe(2)
    expect(ledger.rememberedPrice("creative_generate_speech", { prompt: "the first secret" })).toBeUndefined()
    expect(ledger.rememberedPrice("creative_generate_image", { prompt: "a mug" })).toEqual(price)
  })

  test("the ledger's own sweep drops them too, so a session that settles a call does not need to estimate again", async () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    ledger.rememberPrice("creative_generate_speech", { prompt: "a secret" }, price)
    expect(sizeOf(ledger)).toBe(1)
    now += RESERVATION_MS + 1
    // `settle` prunes; before the fix this swept the book and left the prompt behind.
    await ledger.record("ses_a", 1)
    expect(sizeOf(ledger)).toBe(0)
  })

  test("a fresh estimate is never dropped by another tool's sweep", () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    ledger.rememberPrice("creative_generate_speech", { prompt: "a secret" }, price)
    now += 60_000
    ledger.rememberPrice("creative_generate_image", { prompt: "a mug" }, price)
    expect(sizeOf(ledger)).toBe(2)
    expect(ledger.rememberedPrice("creative_generate_speech", { prompt: "a secret" })).toEqual(price)
  })
})

describe("RE-8 — the asserts raised for one priced call are counted, so the docs' promise is held to a number", () => {
  // At e07ebfc no test counted them: every fake supplies `assert: async () => undefined`, so a second prompt would
  // have been invisible to the suite while four documents promised the user is "asked once". What is decidable here
  // is what *this plugin* raises. The generation's own assert is OpenCode's, raised when the tool runs, and whether a
  // host folds the two into one prompt needs a host — live pass 2 counts the prompts.
  const speech = { prompt: "x".repeat(750), voice_id: "voice_example", model_id: "model_example", context: "a test" }

  /** The pricing hook, with every `permission.assert` the plugin raises recorded, and ElevenLabs answering estimates. */
  async function counted(caps: { sessionCreditCap: number | null; dailyCreditCap: number | null } = { sessionCreditCap: 1_000_000, dailyCreditCap: 1_000_000 }, assert?: () => void) {
    const { ctx, mcp, hookFns, toolList } = pluginContext(caps)
    const asserts: { action: string; sessionID: string }[] = []
    const estimates: Record<string, unknown>[] = []
    ;(ctx as unknown as { permission: { assert: (input: { action: string; sessionID: string }) => Promise<void> } }).permission.assert = async (input) => {
      asserts.push({ action: input.action, sessionID: input.sessionID })
      assert?.()
    }
    toolList.push({
      id: "elevenlabs_creative_generate_speech",
      execute: async (input: unknown) => {
        estimates.push(input as Record<string, unknown>)
        return { output: { estimate: { credits: 1_500 } } }
      },
    })
    const cleanup = await createElevenlabsPlugin(seam).setup(ctx)
    mcp.run(mcpEditor().editor)
    const before = hookFns.get("execute.before")! as Hook
    const run = (id: string) =>
      before({ tool: "elevenlabs_creative_generate_speech", input: { ...speech }, id, sessionID: "ses_test", agent: "build", messageID: "m1" } as never)
    return { run, asserts, estimates, cleanup: cleanup! }
  }

  test("one priced call raises exactly one assert here, and it is the generation's own action", async () => {
    const { run, asserts, estimates, cleanup } = await counted()
    await run("c1")
    // One, not two and not zero: the estimate has no permission of its own, so it cannot be allowed where the
    // generation is not. OpenCode raises the second for the generation itself; this plugin raises only this one.
    expect(asserts).toEqual([{ action: "elevenlabs_creative_generate_speech", sessionID: "ses_test" }])
    expect(estimates).toHaveLength(1)
    expect(estimates[0]).toMatchObject({ estimate_only: true, prompt: speech.prompt })
    await cleanup()
  })

  test("the remembered figure means a second call with the same arguments raises no further assert", async () => {
    const { run, asserts, estimates, cleanup } = await counted()
    await run("c1")
    await run("c2")
    // The price is ten minutes fresh, so no estimate and no assert: the only prompts left are the generations' own.
    expect({ asserts: asserts.length, estimates: estimates.length }).toEqual({ asserts: 1, estimates: 1 })
    await cleanup()
  })

  test("a refused assert sends no estimate at all, which is the ordering the whole claim rests on", async () => {
    const refused = await counted({ sessionCreditCap: 1_000_000, dailyCreditCap: 1_000_000 }, () => {
      throw new Error("denied")
    })
    const failure = await refused.run("c1").then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(SpendRefused)
    expect((failure as SpendRefused).code).toBe("PRICE_UNKNOWN")
    // The assert was raised and refused, and nothing reached ElevenLabs: no flow and no node for a refused generation.
    expect(refused.asserts).toHaveLength(1)
    expect(refused.estimates).toHaveLength(0)
    await refused.cleanup()
  })

  test("with both caps off nothing is priced, so no assert of this plugin's is raised at all", async () => {
    const { run, asserts, estimates, cleanup } = await counted({ sessionCreditCap: null, dailyCreditCap: null })
    await run("c1")
    expect({ asserts: asserts.length, estimates: estimates.length }).toEqual({ asserts: 0, estimates: 0 })
    await cleanup()
  })
})
