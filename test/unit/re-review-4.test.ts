// Reproductions from the fourth re-review. Each one failed at 6c21964 and must pass after the fix. RR4-1 to RR4-4
// were answered in the round before this one and keep their tests in `re-review-3.test.ts`.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ENDPOINT } from "../../src/constants.js"
import { audioStamps, changedFile, countValue, ESTIMATE_TOOLS, mustPrice, estimatePrice, Ledger, measureAudio, NOT_A_COUNT, priceObstacle, priceOf, PRICED_ARGUMENTS, quoteCall, quoteCallSync, RATED_TOOLS, RESERVATION_MS, settlementOf, transcriptionPrice } from "../../src/billing.js"
import { buildWav, understatedThenJunk, WAV_FIXTURES } from "../fixtures/wav.js"
import { sharedStore } from "../fixtures/store.js"
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

describe("RR4-9 — a price is reserved only while the file it measured is still that file", () => {
  const root = mkdtempSync(join(tmpdir(), "elevenlabs-rr4-swap-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const caps = { sessionCreditCap: 100_000, dailyCreditCap: 100_000 }
  const call = (id = "c1") => ({ sessionID: "ses_a", agent: "build", messageID: "m1", id })

  /** A ledger that lets the file move in the one place the guard awaits: the store read before the hold. */
  class Swapping extends Ledger {
    readonly swap: () => void
    constructor(swap: () => void) {
      super()
      this.swap = swap
    }
    override refresh(): Promise<void> {
      this.swap()
      return super.refresh()
    }
  }

  test("a one-second file swapped for a sixty-second one is refused, not reserved at six credits", async () => {
    const path = join(root, "growing.wav")
    writeFileSync(path, buildWav({ seconds: 1 }))
    // The price the guard starts from, and the price the swapped-in file is really worth.
    expect(transcriptionPrice({ path })?.credits).toBe(6)
    const ledger = new Swapping(() => writeFileSync(path, WAV_FIXTURES.canonical()))
    await expect(quoteCall({ ledger, caps: () => caps }, "creative_transcribe_audio", { path }, call())).rejects.toMatchObject({
      code: "PRICE_UNKNOWN",
    })
    // At 6c21964 this resolved at 6 credits and held 6 against 330 credits of audio.
    expect(transcriptionPrice({ path })?.credits).toBe(330)
    // Nothing was held for a call that was never sent: the stamp is checked before the reservation, not after it.
    expect(ledger.reservation("c1")).toBeUndefined()
    expect(ledger.spend("ses_a")).toMatchObject({ sessionCredits: 0, dailyCredits: 0 })
  })

  test("a file deleted between the price and the hold is refused as well", async () => {
    const path = join(root, "vanishing.wav")
    writeFileSync(path, WAV_FIXTURES.canonical())
    const ledger = new Swapping(() => rmSync(path))
    await expect(quoteCall({ ledger, caps: () => caps }, "creative_transcribe_audio", { path }, call("c2")).then(() => "reserved")).rejects.toMatchObject({
      code: "PRICE_UNKNOWN",
    })
    expect(ledger.spend("ses_a").dailyCredits).toBe(0)
  })

  test("a file that holds still is priced and reserved as before", async () => {
    const path = join(root, "still.wav")
    writeFileSync(path, WAV_FIXTURES.canonical())
    const ledger = new Ledger()
    const { price } = await quoteCall({ ledger, caps: () => caps }, "creative_transcribe_audio", { path }, call("c3"))
    expect(price.credits).toBe(330)
    expect(ledger.reservation("c3")?.credits).toBe(330)
  })

  test("a stamp is the file, not its name: its bytes, its times and the inode it lives on", () => {
    const path = join(root, "stamped.wav")
    writeFileSync(path, buildWav({ seconds: 1 }))
    const first = audioStamps({ path })
    expect([...first.keys()]).toEqual([path])
    expect(changedFile(first, audioStamps({ path }))).toBeUndefined()
    // Same name, different file: a rewrite at another length, and then the same length at another inode.
    writeFileSync(path, WAV_FIXTURES.canonical())
    expect(changedFile(first, audioStamps({ path }))).toContain("stamped.wav changed after it was measured")
    const second = audioStamps({ path })
    rmSync(path)
    writeFileSync(path, WAV_FIXTURES.canonical())
    expect(changedFile(second, audioStamps({ path }))).toContain("changed after it was measured")
    // A file that is gone, and a second file named between the two readings, are both changes.
    expect(changedFile(second, new Map())).toContain("changed after it was measured")
    expect(changedFile(new Map(), second)).toContain("was named after the price was taken")
    // Nothing local is named by a URL or an empty string, so neither is stamped.
    expect(audioStamps({ path: "https://example.test/a.wav" }).size).toBe(0)
    expect(audioStamps({ path: "", file: undefined }).size).toBe(0)
  })
})

describe("RR4-10 — the cap's real cross-process bound, and the sentence three files print", () => {
  const DAILY = 10_000
  const caps = { sessionCreditCap: null, dailyCreditCap: DAILY }
  // 1,500 characters at 1 credit each, two takes: 3,000 credits a call, which is the review's figure.
  const args = () => ({ text: "x".repeat(1_500) })
  const call = (id: string) => ({ sessionID: "ses_a", agent: "build", messageID: "m1", id })
  const admitted = (results: PromiseSettledResult<unknown>[]) => results.filter((result) => result.status === "fulfilled").length

  test("a call is 3,000 credits, so three fit under the cap and a fourth does not, in one OpenCode", async () => {
    const ledger = new Ledger()
    expect(priceOf("creative_generate_speech", args())?.credits).toBe(3_000)
    for (const id of ["a", "b", "c"]) await quoteCall({ ledger, caps: () => caps }, "creative_generate_speech", args(), call(id))
    await expect(quoteCall({ ledger, caps: () => caps }, "creative_generate_speech", args(), call("d"))).rejects.toMatchObject({ code: "SPEND_CAP_REACHED" })
    expect(ledger.daily()).toBe(9_000)
  })

  test("eight OpenCodes deciding together cross the cap by seven reservations, not by one", async () => {
    const store = sharedStore()
    // The last state a cap admits from: one call's room left. Every OpenCode below reads it and every one of them fits.
    const seed = new Ledger({ storage: store.handle(), writerId: "seed" })
    await seed.hydrate()
    seed.record("ses_a", DAILY - 3_000)
    await seed.flush()

    const ledgers = [...Array(8)].map((_, index) => new Ledger({ storage: store.handle(), writerId: `w${index}` }))
    await Promise.all(ledgers.map((ledger) => ledger.hydrate()))
    const burst = await Promise.allSettled(
      ledgers.map((ledger, index) => quoteCall({ ledger, caps: () => caps }, "creative_generate_speech", args(), call(`burst${index}`))),
    )
    expect(admitted(burst)).toBe(8)
    await Promise.all(ledgers.map((ledger) => ledger.flush()))

    // 7,000 of room, eight calls of 3,000: 31,000 against a cap of 10,000. The overshoot is 21,000 — seven
    // reservations, one for each OpenCode past the first — and the old sentence promised at most one.
    const reader = new Ledger({ storage: store.handle(), writerId: "reader" })
    await reader.hydrate()
    expect(reader.daily()).toBe(DAILY - 3_000 + 8 * 3_000)
    expect(reader.daily() - DAILY).toBe(7 * 3_000)

    // It does not compound: every one of them now reads a book over the cap, so the next round admits nothing.
    const second = await Promise.allSettled(
      ledgers.map((ledger, index) => quoteCall({ ledger, caps: () => caps }, "creative_generate_speech", args(), call(`again${index}`))),
    )
    expect(admitted(second)).toBe(0)
    expect(second.every((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "SPEND_CAP_REACHED")).toBe(true)
  })

  test("the bound depends on overlap: the same eight, one after another, spend exactly what fits", async () => {
    const store = sharedStore()
    const ledgers = [...Array(8)].map((_, index) => new Ledger({ storage: store.handle(), writerId: `s${index}` }))
    await Promise.all(ledgers.map((ledger) => ledger.hydrate()))
    let admits = 0
    for (const [index, ledger] of ledgers.entries()) {
      await ledger.flush()
      try {
        await quoteCall({ ledger, caps: () => caps }, "creative_generate_speech", args(), call(`serial${index}`))
        admits++
        await ledger.flush()
      } catch {
        // Refused, which is the point: a call that waits for the one before it sees it.
      }
    }
    expect(admits).toBe(3)
  })

  test("a Code Mode call cannot read the store first, so each OpenCode admits a cap of its own", async () => {
    const store = sharedStore()
    const ledgers = [...Array(3)].map((_, index) => new Ledger({ storage: store.handle(), writerId: `c${index}` }))
    await Promise.all(ledgers.map((ledger) => ledger.hydrate()))
    // The shaper path is synchronous by the shared contract: it decides from what this OpenCode last read, and these
    // three read at startup. Each refuses its own fourth call and knows nothing of the other two's nine.
    for (const [index, ledger] of ledgers.entries()) {
      for (const id of ["a", "b", "c"]) quoteCallSync({ ledger, caps: () => caps }, "creative_generate_speech", args(), call(`${index}${id}`))
      expect(() => quoteCallSync({ ledger, caps: () => caps }, "creative_generate_speech", args(), call(`${index}d`))).toThrow("SPEND_CAP_REACHED")
      expect(ledger.daily()).toBe(9_000)
    }
    await Promise.all(ledgers.map((ledger) => ledger.flush()))
    const reader = new Ledger({ storage: store.handle(), writerId: "reader" })
    await reader.hydrate()
    expect(reader.daily()).toBe(27_000)
  })
})

describe("RR4-12 — a refusal names the argument that caused it, and never denies a rate the plugin prints", () => {
  const caps = () => ({ sessionCreditCap: 50_000, dailyCreditCap: 50_000 })
  /** The refusal a script sees, through the real guard. */
  const refused = (tool: string, input: Record<string, unknown>) => {
    try {
      quoteCallSync({ ledger: new Ledger(), caps }, tool, input, { sessionID: "ses_a", agent: "build", messageID: "m1", id: "c1" })
      return undefined
    } catch (error) {
      return error as { code: string; message: string; nextStep: string }
    }
  }

  test("the review's music call names its length field and offers the fix music really has", () => {
    // At 6c21964: "has no published credit price and no remembered estimate", then a route to `estimate_only` that
    // music does not take. Music is 900 credits a minute, published, and `ESTIMATE_TOOLS` has never held it.
    const error = refused("creative_generate_music", { music_length_ms: "abc", duration_seconds: 300 })
    expect(error?.code).toBe("PRICE_UNKNOWN")
    expect(error?.message).toContain('"music_length_ms" states a length no number can be read out of')
    expect(error?.message).toContain("has a published credit rate")
    expect(error?.message).not.toContain("no published credit price")
    expect(error?.nextStep).toContain('"music_length_ms" in milliseconds')
    expect(error?.nextStep).not.toContain("estimate_only")
  })

  test("every branch that gives up on a price names the argument it gave up on", () => {
    const obstacles: [string, Record<string, unknown>, string][] = [
      ["creative_generate_music", { prompt: "jazz" }, 'no argument states how much music to generate ("music_length_ms", "duration_seconds", "duration" or "composition_plan")'],
      ["creative_generate_music", { composition_plan: { sections: [{ name: "intro" }] } }, '"composition_plan" states no section length this plugin can read'],
      ["creative_generate_music", { duration: "soon" }, '"duration" states a length no number can be read out of'],
      ["creative_generate_speech", { text: 7 }, '"text" holds something that is not text'],
      ["creative_generate_speech", {}, 'no argument holds the text to speak ("text", "script" or "message")'],
      ["creative_generate_speech", { script: "" }, '"script" is empty, so there is nothing to price'],
      ["creative_generate_speech", { text: "hello", takes: "many" }, '"takes" states a take count no number can be read out of'],
      ["creative_generate_sound_effect", { prompt: "a door", variations: "lots" }, '"variations" states a generation count no number can be read out of'],
      ["creative_generate_music", { music_length_ms: 30_000, num_outputs: "three" }, '"num_outputs" states a generation count no number can be read out of'],
    ]
    for (const [tool, input, obstacle] of obstacles) {
      const error = refused(tool, input)
      expect(`${tool}: ${error?.message}`).toContain(obstacle)
      // `priceObstacle` is what the refusal quotes, so the two cannot drift apart.
      expect(priceObstacle(tool, input)).toBe(obstacle)
    }
  })

  test("a tool with a published rate is never told it has none, and one without keeps the estimate route", () => {
    // The aliases in the price table are names the guard never sees; the gate is `mustPrice`.
    for (const tool of [...RATED_TOOLS.keys()].filter(mustPrice)) {
      // A count no number can be read out of stops every one of them, so each refuses for the same reason: the rate
      // is stated and the estimate route is not offered where it does not exist.
      const error = refused(tool, { generations: "many" })
      expect(error?.code).toBe("PRICE_UNKNOWN")
      expect(`${tool}: ${error?.message}`).not.toContain("no published credit price")
      if (!ESTIMATE_TOOLS.includes(tool)) expect(`${tool}: ${error?.nextStep}`).not.toContain("estimate_only")
    }
    // Image is the other half of the rule: no rate here at all, so the wording and the estimate route both stand.
    const image = refused("creative_generate_image", { prompt: "a cat" })
    expect(image?.message).toContain("has no published credit price and no remembered estimate")
    expect(image?.nextStep).toContain('"estimate_only": true')
    expect(RATED_TOOLS.has("creative_generate_image")).toBe(false)
  })

  test("every priced tool is either one this plugin rates or one the server estimates for it", () => {
    for (const tool of PRICED_ARGUMENTS.keys()) expect(RATED_TOOLS.has(tool) || ESTIMATE_TOOLS.includes(tool)).toBe(true)
    // And a rated tool really is priced from the rate, not from an estimate that happens to be remembered.
    expect(priceOf("creative_generate_music", { music_length_ms: 60_000 })?.credits).toBe(900)
    expect(priceOf("creative_generate_sound_effect", { prompt: "a door" })?.credits).toBe(200)
  })
})
