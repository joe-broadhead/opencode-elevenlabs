// Reproductions from the fourth re-review. Each one failed at 6c21964 and must pass after the fix. RR4-1 to RR4-4
// were answered in the round before this one and keep their tests in `re-review-3.test.ts`.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ENDPOINT } from "../../src/constants.js"
import { countValue, estimatePrice, Ledger, measureAudio, NOT_A_COUNT, priceOf, quoteCall, quoteCallSync, RESERVATION_MS, settlementOf, transcriptionPrice } from "../../src/billing.js"
import { understatedThenJunk, WAV_FIXTURES } from "../fixtures/wav.js"
import { createElevenlabsPlugin } from "../../src/plugin.js"
import { mcpEditor, pluginContext } from "./fake.js"

const skillsDir = mkdtempSync(join(tmpdir(), "elevenlabs-rr4-"))
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }))
const seam = { endpoint: ENDPOINT, skillsDir }

type Hook = (event: never) => Promise<void>
type Cost = { credits: number; basis: string; dailySpent: number }

/** The two spending hooks, on a context with the caps this test needs. */
async function hooks(caps: { sessionCreditCap: number | null; dailyCreditCap: number | null }) {
  const { ctx, mcp, hookFns } = pluginContext(caps)
  const cleanup = await createElevenlabsPlugin(seam).setup(ctx)
  mcp.run(mcpEditor().editor)
  const before = hookFns.get("execute.before")! as Hook
  const after = hookFns.get("execute.after")! as Hook
  const event = (id: string, input: Record<string, unknown>) => ({
    tool: "elevenlabs_creative_generate_speech",
    input,
    id,
    sessionID: "ses_test",
    agent: "build",
    messageID: "m1",
  })
  /** One completed result through `execute.after`, and the cost the owner is shown for it. */
  const complete = async (id: string, input: Record<string, unknown>, output: Record<string, unknown>) => {
    const result: { output: Record<string, unknown> } = { output: { ...output } }
    await after({ ...event(id, input), status: "completed", result } as never)
    return result.output.cost as Cost
  }
  return { before, after, event, complete, cleanup: cleanup! }
}

const TEXT = { text: "x".repeat(750) } // 750 characters, two takes: 1,500 credits reserved.

describe("RR4-5 — a recorded charge never goes down after its first settlement", () => {
  test("a result delivered again for a call already charged is ignored unless it is higher", async () => {
    const { before, complete, event, cleanup } = await hooks({ sessionCreditCap: 1_000_000, dailyCreditCap: 1_000_000 })
    await before(event("c1", TEXT) as never)
    // The first result reports nothing, so the reservation is the charge. At 6c21964 the two results after it each
    // overwrote that charge downwards — 1,500 -> 30 -> 1 — because the hook had forgotten what it reserved and read
    // its floor as zero, and `settle` let an attested figure past the floor it did have.
    expect(await complete("c1", TEXT, {})).toMatchObject({ credits: 1_500, basis: "at-most", dailySpent: 1_500 })
    const second = await complete("c1", TEXT, { credits: 30 })
    const third = await complete("c1", TEXT, { credits: 1 })
    expect([second.dailySpent, third.dailySpent]).toEqual([1_500, 1_500])
    // Not 30 and not 1: the first settlement recorded 1,500, and a repeat may only raise it. The lowest the sequence
    // can reach is the 30 it reported, and it does not reach even that.
    for (const cost of [second, third]) expect(cost.dailySpent).toBeGreaterThanOrEqual(30)
    expect(second.credits).toBe(1_500)
    // A repeat that is higher is still a raise.
    expect((await complete("c1", TEXT, { credits: 4_000 })).dailySpent).toBe(4_000)
    await cleanup()
  })

  test("a one-credit completion replayed after every call does not buy a second call", async () => {
    // The review's reproduction: a 5,000 daily cap at 1,500 a call admits three calls, and at 6c21964 replaying a
    // 1-credit result after each emptied the ledger and admitted 200 — 300,000 credits against a 5,000 cap.
    const { before, complete, event, cleanup } = await hooks({ sessionCreditCap: 5_000, dailyCreditCap: 5_000 })
    let admitted = 0
    let refused: unknown
    for (let call = 0; call < 200; call += 1) {
      const id = `c${call}`
      try {
        await before(event(id, TEXT) as never)
      } catch (error) {
        refused = error
        break
      }
      admitted += 1
      await complete(id, TEXT, {})
      await complete(id, TEXT, { credits: 1 })
    }
    expect(admitted).toBe(3)
    expect(refused).toMatchObject({ code: "SPEND_CAP_REACHED" })
    await cleanup()
  })

  test("only a live hold may be settled below its own figure, and only inside the band", () => {
    const ledger = new Ledger()
    const caps = { sessionCreditCap: 100_000, dailyCreditCap: 100_000 }
    // The first settlement of a live hold may lower it, inside the tenth-band.
    ledger.reserve("a", "ses_a", 1_500, caps)
    expect(ledger.settle("a", "ses_a", 900, true).dailyCredits).toBe(900)
    // Every settlement after that may only raise it, whatever it attests.
    expect(ledger.settle("a", "ses_a", 300, true).dailyCredits).toBe(900)
    expect(ledger.settle("a", "ses_a", 1_100, true).dailyCredits).toBe(1_100)
    expect(ledger.settle("a", "ses_a", 1_100, true).dailyCredits).toBe(1_100)
    expect(ledger.recorded("a")).toEqual({ kind: "charge", credits: 1_100 })
  })

  test("a hold that outlived its ten minutes is a charge, and a late figure cannot lower it", () => {
    let now = Date.now()
    const ledger = new Ledger({ now: () => now })
    ledger.reserve("a", "ses_a", 3_000, { sessionCreditCap: 100_000, dailyCreditCap: 100_000 })
    now += RESERVATION_MS + 1_000
    // `prune` records the expired hold as a charge; the call it belongs to is still running and reports 30 later.
    expect(ledger.daily()).toBe(3_000)
    expect(ledger.reservation("a")).toBeUndefined()
    expect(ledger.recorded("a")).toEqual({ kind: "charge", credits: 3_000 })
    expect(ledger.settle("a", "ses_a", 30, true).dailyCredits).toBe(3_000)
  })

  test("a figure below a charge says so in the cost line instead of attesting", () => {
    expect(settlementOf({ output: { credits: 900 } }, 1_500, null, "charge")).toEqual({
      credits: 1_500,
      attested: false,
      note: "the result reported 900 against 1,500 already charged for this call, so the recorded charge stands",
    })
    // The same figure against a live hold is this call's charge, as it was before.
    expect(settlementOf({ output: { credits: 900 } }, 1_500, null)).toEqual({ credits: 900, attested: true })
  })
})

describe("RR4-6 — a count multiplies the price, for every priced tool", () => {
  const caps = { sessionCreditCap: 50_000, dailyCreditCap: 50_000 }
  const call = (id = "c1") => ({ sessionID: "ses_a", agent: "build", messageID: "m1", id })
  const speech = (extra: Record<string, unknown> = {}) => ({ text: "x".repeat(600), ...extra })

  test("speech is priced per generation, in whichever count key the caller used", () => {
    // At 6c21964 every one of these priced 1,200: the count was computed and then read only by sound effects.
    expect(priceOf("creative_generate_speech", speech())?.credits).toBe(1_200)
    expect(priceOf("creative_generate_speech", speech({ generations_count: 2 }))?.credits).toBe(2_400)
    expect(priceOf("creative_generate_speech", speech({ generations_count: 10 }))?.credits).toBe(12_000)
    expect(priceOf("creative_generate_speech", speech({ generations_count: 100 }))?.credits).toBe(120_000)
    expect(priceOf("creative_generate_speech", speech({ generations: 5 }))?.credits).toBe(6_000)
    expect(priceOf("creative_generate_speech", speech({ variations: 5 }))?.credits).toBe(6_000)
    expect(priceOf("creative_generate_speech", speech({ num_generations: 5 }))?.credits).toBe(6_000)
    expect(priceOf("creative_generate_speech", speech({ num_outputs: 5 }))?.credits).toBe(6_000)
    // The cost line says what it multiplied by, so an owner reading it can check the figure.
    expect(priceOf("creative_generate_speech", speech({ generations_count: 5 }))?.parts.join(", ")).toContain("5 generations")
  })

  test("600 characters a hundred times is refused under a 50,000 cap, on both guard paths", async () => {
    const args = speech({ generations_count: 100 })
    await expect(quoteCall({ ledger: new Ledger(), caps: () => caps }, "creative_generate_speech", { ...args }, call())).rejects.toMatchObject({
      code: "SPEND_CAP_REACHED",
    })
    expect(() => quoteCallSync({ ledger: new Ledger(), caps: () => caps }, "creative_generate_speech", { ...args }, call())).toThrow("SPEND_CAP_REACHED")
    // A count the budget does afford still goes through, at the multiplied price.
    const { price } = await quoteCall({ ledger: new Ledger(), caps: () => caps }, "creative_generate_speech", speech({ generations_count: 10 }), call())
    expect(price.credits).toBe(12_000)
  })

  test("music multiplies too, and twenty takes of five minutes does not fit", async () => {
    expect(priceOf("creative_generate_music", { prompt: "a waltz", music_length_ms: 300_000 })?.credits).toBe(4_500)
    expect(priceOf("creative_generate_music", { prompt: "a waltz", music_length_ms: 300_000, generations_count: 20 })?.credits).toBe(90_000)
    await expect(
      quoteCall({ ledger: new Ledger(), caps: () => caps }, "creative_generate_music", { prompt: "a waltz", music_length_ms: 300_000, generations_count: 20 }, call()),
    ).rejects.toMatchObject({ code: "SPEND_CAP_REACHED" })
    // Sound effects multiplied before this fix and still does, at the same figure.
    expect(priceOf("creative_generate_sound_effect", { prompt: "a door", generations_count: 5 })?.credits).toBe(1_000)
  })

  test("a call naming two counts is priced from the larger, and a clamp bounds both keys", async () => {
    // Nothing says which key the server reads, so the larger is the one a price must not be below.
    expect(priceOf("creative_generate_speech", speech({ generations_count: 2, variations: 7 }))?.credits).toBe(8_400)
    expect(priceOf("creative_generate_speech", speech({ generations_count: 7, variations: 2 }))?.credits).toBe(8_400)
    // An estimate-priced tool clamps rather than refuses: both keys are cut, so the smaller cannot be left behind.
    const ledger = new Ledger()
    const estimate = async (_tool: string, input: Record<string, unknown>) => estimatePrice(input, { output: { credits: 1_000 } })
    const args: Record<string, unknown> = { prompt: "a mug", generations_count: 2, variations: 7 }
    const { price } = await quoteCall({ ledger, caps: () => ({ sessionCreditCap: 3_000, dailyCreditCap: 50_000 }), estimate }, "creative_generate_image", args, call())
    expect(args).toEqual({ prompt: "a mug", generations_count: 3, variations: 3 })
    expect(price.credits).toBe(3_000)
  })

  test("a count is read as the number it spells, and one nothing can be read out of refuses the call", () => {
    expect(countValue("4")).toBe(4)
    expect(countValue(4)).toBe(4)
    expect(countValue(0)).toBeUndefined()
    expect(countValue(undefined)).toBeUndefined()
    expect(countValue("a few")).toBe(NOT_A_COUNT)
    expect(countValue({})).toBe(NOT_A_COUNT)
    // A string count multiplies, as a string length raises a price (RR3-9).
    expect(priceOf("creative_generate_speech", speech({ generations_count: "4" }))?.credits).toBe(4_800)
    // Prose in a count field is a multiplier this plugin does not know: PRICE_UNKNOWN, not a price that assumes one.
    expect(priceOf("creative_generate_speech", speech({ generations_count: "a few" }))).toBeUndefined()
    expect(estimatePrice({ generations_count: "a few" }, { output: { credits: 1_000 } })).toBeUndefined()
    expect(() => quoteCallSync({ ledger: new Ledger(), caps: () => caps }, "creative_generate_speech", speech({ generations_count: "a few" }), call())).toThrow("PRICE_UNKNOWN")
  })

  test("where a published rate and a remembered estimate disagree, the dearer one is reserved", async () => {
    const ledger = new Ledger()
    // The estimate is remembered for these arguments, then the formula prices them lower. The cap must see the larger.
    ledger.rememberPrice("creative_generate_speech", speech(), { credits: 9_000, basis: "exact", parts: ["estimated by ElevenLabs"] })
    const { price } = await quoteCall({ ledger, caps: () => caps }, "creative_generate_speech", speech(), call())
    expect(price.credits).toBe(9_000)
    // And the other way around: a formula price above the estimate stands.
    const second = new Ledger()
    second.rememberPrice("creative_generate_speech", speech({ generations_count: 10 }), { credits: 500, basis: "exact", parts: [] })
    expect(quoteCallSync({ ledger: second, caps: () => caps }, "creative_generate_speech", speech({ generations_count: 10 }), call("c2")).price.credits).toBe(12_000)
  })
})

describe("RR4-7 — a WAV with more than one `data` chunk is not measured", () => {
  const root = mkdtempSync(join(tmpdir(), "elevenlabs-rr4-wav-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const file = (name: string, bytes: Buffer) => {
    const path = join(root, name)
    writeFileSync(path, bytes)
    return path
  }
  const caps = { sessionCreditCap: 100_000, dailyCreditCap: 100_000 }
  const refusal = (path: string) => {
    try {
      quoteCallSync({ ledger: new Ledger(), caps: () => caps }, "creative_transcribe_audio", { path }, { sessionID: "ses_a", agent: "build", messageID: "m1", id: "c1" })
      return undefined
    } catch (error) {
      return error as { code?: string }
    }
  }

  test("the review's two-data.wav is refused rather than priced as its first second", () => {
    // At 6c21964 the second `data` chunk was read as metadata: 1 second, 6 credits, against the 60 seconds and 330
    // credits CoreAudio reads out of the same file. Python's `wave` agrees with the 1; nothing settles which the
    // server does, so the file has no length this plugin knows.
    const path = file("two-data.wav", WAV_FIXTURES.twoData())
    expect(measureAudio({ path })).toBeUndefined()
    expect(transcriptionPrice({ path })).toBeUndefined()
    expect(refusal(path)).toMatchObject({ code: "PRICE_UNKNOWN" })
  })

  test("the reversed file, and one with metadata between the two chunks, are refused the same way", () => {
    for (const name of ["twoDataReversed", "twoDataAfterMeta"] as const) {
      const path = file(`${name}.wav`, WAV_FIXTURES[name]())
      expect(measureAudio({ path })).toBeUndefined()
      expect(refusal(path)).toMatchObject({ code: "PRICE_UNKNOWN" })
    }
  })

  test("one `data` chunk still measures, whatever follows it or how short its size field is", () => {
    // The rule reaches a second `data` chunk and nothing else: a trailing `LIST` is still metadata, and a stated size
    // that understates the audio still prices every byte that follows it (RR3-7, RR4-1).
    const trailing = file("trailing.wav", WAV_FIXTURES.trailing())
    expect(measureAudio({ path: trailing })?.durationSeconds).toBe(1)
    expect(transcriptionPrice({ path: trailing })?.credits).toBe(6)
    const short = file("understated-then-junk.wav", understatedThenJunk())
    expect(measureAudio({ path: short })?.durationSeconds).toBe(60)
    expect(transcriptionPrice({ path: short })?.credits).toBe(330)
    const canonical = file("canonical.wav", WAV_FIXTURES.canonical())
    expect(measureAudio({ path: canonical })?.durationSeconds).toBe(60)
  })
})
