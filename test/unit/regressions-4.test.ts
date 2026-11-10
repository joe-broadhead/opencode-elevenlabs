// Regression tests for one review pass. Each one failed before its fix and must pass after it. to 
// were answered in the round before this one and keep their tests in `regressions-3.test.ts`. Since live reconcile 1
// the plugin computes no price of its own — ElevenLabs' own `estimate_only` call is the only price, and no file on
// this machine is part of any call — so the blocks built on the published rates and on measured audio are
// re-expressed. Each says what it used to assert, and what now holds instead.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ENDPOINT } from "../../src/constants.js"
import {
  countValue,
  estimatePrice,
  ESTIMATE_TOOLS,
  GENERATION_KEYS,
  generationsOf,
  Ledger,
  NOT_A_COUNT,
  PRICED_ARGUMENTS,
  priceObstacle,
  quoteCall,
  quoteCallSync,
  RESERVATION_MS,
  settlementOf,
} from "../../src/billing.js"
import { mustPrice, SPEND_TOOLS } from "../../src/elevenlabs-tools.js"
import { durationOf, riffReadingWith } from "../../src/media/policy.js"
import { buildWav, understatedThenJunk, WAV_FIXTURES } from "../fixtures/wav.js"
import { sharedStore } from "../fixtures/store.js"
import { createElevenlabsPlugin } from "../../src/plugin.js"
import { mcpEditor, pluginContext } from "./fake.js"

const skillsDir = mkdtempSync(join(tmpdir(), "elevenlabs-rr4-"))
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }))
const seam = { endpoint: ENDPOINT, skillsDir }

type Hook = (event: never) => Promise<void>
type Cost = { credits: number; basis: string; dailySpent: number }

/** A speech call in the live schema's own names. The spoken words go in `prompt`; there is no `text` argument. */
const speechArgs = (prompt: string) => ({ prompt, voice_id: "voice_example", model_id: "model_example", context: "a test" })

/** A transcription call in the live schema's own argument names: the audio is a node in a flow, never a local file. */
const transcribeArgs = () => ({ model_id: "model_example", context: "a test", flow_id: "flow_example" })

/**
 * The two spending hooks, on a context with the caps this test needs, and an ElevenLabs that answers an
 * `estimate_only` call with `credits`. `estimates` counts how many times it was asked.
 */
async function hooks(caps: { sessionCreditCap: number | null; dailyCreditCap: number | null }, credits = 1_500) {
  const { ctx, mcp, hookFns, toolList } = pluginContext(caps)
  const estimates: Record<string, unknown>[] = []
  toolList.push({
    id: "elevenlabs_creative_generate_speech",
    execute: async (input: unknown) => {
      estimates.push(input as Record<string, unknown>)
      return { output: { credits } }
    },
  })
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
  return { before, after, event, complete, estimates, cleanup: cleanup! }
}

const SPEECH = speechArgs("x".repeat(750)) // ElevenLabs' estimate for these arguments: 1,500 credits reserved.

describe("a recorded charge never goes down after its first settlement", () => {
  test("a result delivered again for a call already charged is ignored unless it is higher", async () => {
    const { before, complete, event, cleanup } = await hooks({ sessionCreditCap: 1_000_000, dailyCreditCap: 1_000_000 })
    await before(event("c1", SPEECH) as never)
    // The first result reports nothing, so the reservation is the charge. At 6c21964 the two results after it each
    // overwrote that charge downwards — 1,500 -> 30 -> 1 — because the hook had forgotten what it reserved and read
    // its floor as zero, and `settle` let an attested figure past the floor it did have.
    expect(await complete("c1", SPEECH, {})).toMatchObject({ credits: 1_500, basis: "exact", dailySpent: 1_500 })
    const second = await complete("c1", SPEECH, { credits: 30 })
    const third = await complete("c1", SPEECH, { credits: 1 })
    expect([second.dailySpent, third.dailySpent]).toEqual([1_500, 1_500])
    // Not 30 and not 1: the first settlement recorded 1,500, and a repeat may only raise it. The lowest the sequence
    // can reach is the 30 it reported, and it does not reach even that.
    for (const cost of [second, third]) expect(cost.dailySpent).toBeGreaterThanOrEqual(30)
    expect(second.credits).toBe(1_500)
    // A repeat that is higher is still a raise.
    expect((await complete("c1", SPEECH, { credits: 4_000 })).dailySpent).toBe(4_000)
    await cleanup()
  })

  test("a one-credit completion replayed after every call does not buy a second call", async () => {
    // The review's reproduction: a 5,000 daily cap at 1,500 a call admits three calls, and at 6c21964 replaying a
    // 1-credit result after each emptied the ledger and admitted 200 — 300,000 credits against a 5,000 cap.
    const { before, complete, event, estimates, cleanup } = await hooks({ sessionCreditCap: 5_000, dailyCreditCap: 5_000 })
    let admitted = 0
    let refused: unknown
    for (let call = 0; call < 200; call += 1) {
      const id = `c${call}`
      try {
        await before(event(id, SPEECH) as never)
      } catch (error) {
        refused = error
        break
      }
      admitted += 1
      await complete(id, SPEECH, {})
      await complete(id, SPEECH, { credits: 1 })
    }
    expect(admitted).toBe(3)
    expect(refused).toMatchObject({ code: "SPEND_CAP_REACHED" })
    // Every estimate creates a flow and a node in the owner's workspace, so the same arguments are estimated once and
    // the figure is remembered for the calls that follow.
    expect(estimates.length).toBe(1)
    expect(estimates[0]).toMatchObject({ ...SPEECH, estimate_only: true })
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

describe("a count multiplies the price, for every priced tool", () => {
  // This block used to multiply a published rate by a count: 600 characters was 1,200 credits and ten generations
  // 12,000. There is no published rate now, and the count works from the other end — ElevenLabs' estimate answers for
  // the batch the arguments ask for, so the count is what the figure has to be divided by to get a unit, and a count
  // nothing can be read out of makes the whole figure meaningless.
  const caps = { sessionCreditCap: 50_000, dailyCreditCap: 50_000 }
  const call = (id = "c1") => ({ sessionID: "ses_a", agent: "build", messageID: "m1", id })
  const speech = (extra: Record<string, unknown> = {}) => ({ ...speechArgs("x".repeat(600)), ...extra })
  /** An estimate seam answering every call with the same batch total, and counting what it was asked. */
  const estimator = (credits: number) => {
    const asked: Record<string, unknown>[] = []
    return {
      asked,
      estimate: async (tool: string, input: Record<string, unknown>) => {
        asked.push(input)
        return estimatePrice(tool, input, { output: { credits } })
      },
    }
  }

  test("the figure is the batch total, and the count is what divides it into a unit", () => {
    // At 6c21964 the count was computed and then read only by sound effects; here it decides what the server's own
    // figure covered.
    const priced = estimatePrice("creative_generate_speech", speech({ generations_count: 4 }), { output: { credits: 4_800 } })
    expect({ credits: priced?.credits, perGeneration: priced?.perGeneration }).toEqual({ credits: 4_800, perGeneration: 1_200 })
    // The cost line says what it divided by, so an owner reading it can check the figure.
    expect(priced?.parts.join(", ")).toContain("4 generations")
    // The four other spellings that block once read as counts — `generations`, `variations`, `num_generations`,
    // `num_outputs` — are in no live schema. None of them is read as a count now, and a call that sends one is
    // refused as an argument the tool does not have rather than priced around.
    expect(GENERATION_KEYS).toEqual(["generations_count"])
    for (const key of ["generations", "variations", "num_generations", "num_outputs"]) {
      expect({ key, counted: generationsOf({ [key]: 7 }) }).toEqual({ key, counted: undefined })
      expect({ key, obstacle: priceObstacle("creative_generate_speech", { ...speechArgs("hi"), [key]: 7 }) }).toEqual({
        key,
        obstacle: `"${key}" is an argument ElevenLabs' own schema for this tool does not have, so its effect on the bill is unknown`,
      })
    }
  })

  test("a batch the budget cannot afford is cut to what it can, in the one count key", async () => {
    // The old answer was a refusal, because a published rate gave no unit to cut to. An estimate does: the batch is
    // clamped to the generations the budget affords, and the figure says `at-most`, because a share of a batch total
    // is this plugin's arithmetic and not the server's word.
    const ledger = new Ledger()
    const { estimate } = estimator(4_000)
    const args: Record<string, unknown> = { prompt: "a mug", model_id: "model_example", context: "a test", generations_count: 4 }
    const { price } = await quoteCall({ ledger, caps: () => ({ sessionCreditCap: 3_000, dailyCreditCap: 50_000 }), estimate }, "creative_generate_image", args, call())
    expect(args).toEqual({ prompt: "a mug", model_id: "model_example", context: "a test", generations_count: 3 })
    expect({ credits: price.credits, basis: price.basis }).toEqual({ credits: 3_000, basis: "at-most" })
    expect(price.parts.join(", ")).toContain("3 generations, at ElevenLabs' estimate")
  })

  test("a batch whose first generation does not fit is refused on both guard paths", async () => {
    // 500,000 credits over 4 generations is 125,000 a take, against a 50,000 budget: there is no count the budget
    // affords, so the clamp cannot save the call and the reservation refuses it.
    const big = estimator(500_000)
    await expect(
      quoteCall({ ledger: new Ledger(), caps: () => caps, estimate: big.estimate }, "creative_generate_speech", speech({ generations_count: 4 }), call()),
    ).rejects.toMatchObject({ code: "SPEND_CAP_REACHED" })
    // The script path has no estimate to await, so it works from the figure a probe already put on this ledger.
    const ledger = new Ledger()
    const args = speech({ generations_count: 4 })
    ledger.rememberPrice("creative_generate_speech", args, { credits: 500_000, basis: "exact", parts: [], perGeneration: 125_000 })
    expect(() => quoteCallSync({ ledger, caps: () => caps }, "creative_generate_speech", args, call())).toThrow("SPEND_CAP_REACHED")
  })

  test("a count is read as the number it spells, and one nothing can be read out of refuses the call", () => {
    expect(countValue("4")).toBe(4)
    expect(countValue(4)).toBe(4)
    expect(countValue(0)).toBeUndefined()
    expect(countValue(undefined)).toBeUndefined()
    expect(countValue("a few")).toBe(NOT_A_COUNT)
    expect(countValue({})).toBe(NOT_A_COUNT)
    // A string count divides the batch, as a numeric field is read as the number it spells.
    expect(estimatePrice("creative_generate_speech", speech({ generations_count: "4" }), { output: { credits: 4_800 } })?.perGeneration).toBe(1_200)
    // Prose in a count field is a multiplier this plugin does not know: PRICE_UNKNOWN, not a price that assumes one.
    expect(estimatePrice("creative_generate_speech", speech({ generations_count: "a few" }), { output: { credits: 1_000 } })).toBeUndefined()
    expect(() => quoteCallSync({ ledger: new Ledger(), caps: () => caps }, "creative_generate_speech", speech({ generations_count: "a few" }), call())).toThrow("PRICE_UNKNOWN")
  })

  test("a figure this ledger already holds does not carry a call past an unreadable count", async () => {
    // The check is in the guard and not only inside `estimatePrice`, so a price remembered for other arguments cannot
    // be spent against a call whose batch size is unknown.
    const ledger = new Ledger()
    const args = speech({ generations_count: "a few" })
    ledger.rememberPrice("creative_generate_speech", args, { credits: 10, basis: "exact", parts: [] })
    const { estimate, asked } = estimator(10)
    await expect(quoteCall({ ledger, caps: () => caps, estimate }, "creative_generate_speech", args, call())).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    // And ElevenLabs was never asked for a figure that could not have meant anything.
    expect(asked.length).toBe(0)
  })
})

describe("a WAV with more than one `data` chunk is not measured", () => {
  // This block used to end in a refused price. Nothing prices a file now, so what is left is the reading itself: the
  // duration the save tool prints is absent where decoders disagree, rather than being one decoder's answer.
  const root = mkdtempSync(join(tmpdir(), "elevenlabs-rr4-wav-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const file = (name: string, bytes: Buffer) => {
    const path = join(root, name)
    writeFileSync(path, bytes)
    return path
  }

  test("the review's two-data.wav has no duration rather than its first second", async () => {
    // At 6c21964 the second `data` chunk was read as metadata: 1 second, against the 60 seconds CoreAudio reads out
    // of the same file. Python's `wave` agrees with the 1; nothing settles which is right, so neither is printed.
    expect(await durationOf(file("two-data.wav", WAV_FIXTURES.twoData()))).toBeUndefined()
  })

  test("the reversed file, and one with metadata between the two chunks, read the same way", async () => {
    for (const name of ["twoDataReversed", "twoDataAfterMeta"] as const) {
      expect({ name, seconds: await durationOf(file(`${name}.wav`, WAV_FIXTURES[name]())) }).toEqual({ name, seconds: undefined })
    }
  })

  test("one `data` chunk still measures, whatever follows it or how short its size field is", async () => {
    // The rule reaches a second `data` chunk and nothing else: a trailing `LIST` is still metadata, and a stated size
    // that understates the audio still reads every byte that follows it.
    expect(await durationOf(file("trailing.wav", WAV_FIXTURES.trailing()))).toBe(1)
    expect(await durationOf(file("understated-then-junk.wav", understatedThenJunk()))).toBe(60)
    expect(await durationOf(file("canonical.wav", WAV_FIXTURES.canonical()))).toBe(60)
  })
})

describe("a price holds only while it is still this call's price", () => {
  // This block used to swap a file under the guard between the measurement and the hold: a one-second WAV priced at
  // 6 credits, replaced by sixty seconds before the reservation landed. The live `creative_transcribe_audio` takes
  // `{connect_from, context, estimate_only, flow_id, model_id, view_state_id}` and no file at all, so there is no
  // file to swap and the stamping it needed is gone. What remains is the same rule in the place it now lives: a
  // remembered figure is ElevenLabs' answer for exactly these arguments, minutes old at most.
  const caps = { sessionCreditCap: 100_000, dailyCreditCap: 100_000 }
  const call = (id = "c1") => ({ sessionID: "ses_a", agent: "build", messageID: "m1", id })

  test("naming a local file does not price a transcription, it refuses it", () => {
    const root = mkdtempSync(join(tmpdir(), "elevenlabs-rr4-swap-"))
    const path = join(root, "growing.wav")
    writeFileSync(path, buildWav({ seconds: 1 }))
    const ledger = new Ledger()
    expect(() => quoteCallSync({ ledger, caps: () => caps }, "creative_transcribe_audio", { ...transcribeArgs(), path }, call())).toThrow("PRICE_UNKNOWN")
    expect(ledger.spend("ses_a")).toMatchObject({ sessionCredits: 0, dailyCredits: 0 })
    rmSync(root, { recursive: true, force: true })
  })

  test("a remembered figure prices the call it was fetched for, and ages out after ten minutes", () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    const args = transcribeArgs()
    ledger.rememberPrice("creative_transcribe_audio", args, { credits: 330, basis: "exact", parts: [] })
    expect(quoteCallSync({ ledger, caps: () => caps }, "creative_transcribe_audio", args, call()).price.credits).toBe(330)
    // Past the window it is not a price any more, and the call is refused rather than run on a stale figure.
    now += RESERVATION_MS + 1
    expect(() => quoteCallSync({ ledger, caps: () => caps }, "creative_transcribe_audio", args, call("c2"))).toThrow("PRICE_UNKNOWN")
  })

  test("a figure fetched for other arguments does not price this call", () => {
    const ledger = new Ledger()
    ledger.rememberPrice("creative_transcribe_audio", transcribeArgs(), { credits: 6, basis: "exact", parts: [] })
    // One argument different is a different call, and ElevenLabs priced the other one.
    expect(() =>
      quoteCallSync({ ledger, caps: () => caps }, "creative_transcribe_audio", { ...transcribeArgs(), model_id: "other_example" }, call("c3")),
    ).toThrow("PRICE_UNKNOWN")
    // The probe itself carries `estimate_only`, and the paid call does not: that one difference is not a difference.
    const ledger2 = new Ledger()
    ledger2.rememberPrice("creative_transcribe_audio", { ...transcribeArgs(), estimate_only: true }, { credits: 6, basis: "exact", parts: [] })
    expect(quoteCallSync({ ledger: ledger2, caps: () => caps }, "creative_transcribe_audio", transcribeArgs(), call("c4")).price.credits).toBe(6)
  })
})

describe("the cap's real cross-process bound, and the sentence three files print", () => {
  const DAILY = 10_000
  const caps = { sessionCreditCap: null, dailyCreditCap: DAILY }
  // ElevenLabs' estimate for these arguments: 3,000 credits a call, which is the review's figure.
  const args = () => speechArgs("x".repeat(1_500))
  const call = (id: string) => ({ sessionID: "ses_a", agent: "build", messageID: "m1", id })
  const admitted = (results: PromiseSettledResult<unknown>[]) => results.filter((result) => result.status === "fulfilled").length
  /** The ledger with ElevenLabs' figure for those arguments already on it, as an `estimate_only` call leaves it. */
  const priced = (ledger: Ledger) => {
    ledger.rememberPrice("creative_generate_speech", args(), { credits: 3_000, basis: "exact", parts: [] })
    return ledger
  }

  test("a call is 3,000 credits, so three fit under the cap and a fourth does not, in one OpenCode", async () => {
    const ledger = priced(new Ledger())
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

    const ledgers = [...Array(8)].map((_, index) => priced(new Ledger({ storage: store.handle(), writerId: `w${index}` })))
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
    const ledgers = [...Array(8)].map((_, index) => priced(new Ledger({ storage: store.handle(), writerId: `s${index}` })))
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

  test("a Code Mode call cannot read the store first, so a burst decides from what this OpenCode last read", async () => {
    const store = sharedStore()
    const ledgers = [...Array(3)].map((_, index) => priced(new Ledger({ storage: store.handle(), writerId: `c${index}` })))
    await Promise.all(ledgers.map((ledger) => ledger.hydrate()))
    // The shaper path is synchronous by the shared contract: it decides from what this OpenCode last read, and these
    // three read at startup. Each refuses its own fourth call and, inside its burst, knows nothing of the other two's
    // nine. That burst is as far as it goes: reads the store behind each call and on a timer, so the book is
    // one call old rather than as old as the process, and `regressions-5.test.ts` holds that bound.
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

describe("a refusal names what it can and claims nothing it cannot", () => {
  // The review's finding was a refusal that named the wrong cause and then offered a route the tool did not have:
  // music was told it had "no published credit price" and sent to `estimate_only`, which music never accepted. The
  // published rates are gone, so the first half of that is gone with them; the rule that remains is the one that
  // mattered — a refusal names the obstacle this plugin can really see, and offers only a route the tool has.
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

  test("every obstacle the plugin can name is the one the refusal quotes", () => {
    const obstacles: [string, Record<string, unknown>, string][] = [
      ["creative_generate_speech", { ...speechArgs("hello"), takes: 2 }, '"takes" is an argument ElevenLabs\' own schema for this tool does not have, so its effect on the bill is unknown'],
      ["creative_generate_speech", { ...speechArgs("hello"), generations: "many" }, '"generations" is an argument ElevenLabs\' own schema for this tool does not have, so its effect on the bill is unknown'],
      ["creative_generate_speech", { ...speechArgs("hello"), generations_count: "many" }, '"generations_count" states a generation count no number can be read out of'],
      ["creative_transcribe_audio", { ...transcribeArgs(), path: "a.wav" }, '"path" is an argument ElevenLabs\' own schema for this tool does not have, so its effect on the bill is unknown'],
      ["creative_run_flow_nodes", { flow_id: "flow_example", context: "a test", num_outputs: "three" }, '"num_outputs" is an argument ElevenLabs\' own schema for this tool does not have, so its effect on the bill is unknown'],
    ]
    for (const [tool, input, obstacle] of obstacles) {
      const error = refused(tool, input)
      expect(`${tool}: ${error?.message}`).toContain(obstacle)
      // `priceObstacle` is what the refusal quotes, so the two cannot drift apart.
      expect(priceObstacle(tool, input)).toBe(obstacle)
    }
  })

  test("a call with no obstacle at all is refused for want of a figure, and names none", () => {
    // Nothing is wrong with these arguments; ElevenLabs has simply not been asked yet. A refusal that blamed an
    // argument here would send the caller after a fault that is not there ('s real finding).
    const error = refused("creative_generate_speech", speechArgs("hello"))
    expect(error?.code).toBe("PRICE_UNKNOWN")
    expect(error?.message).toContain("creative_generate_speech could not be priced from ElevenLabs' own estimate, so the cap cannot be checked before it runs.")
    // Nothing is quoted after that sentence: no argument is named, and no count is blamed.
    expect(error?.message).not.toContain("is an argument")
    expect(error?.message).not.toContain("states a generation count")
    expect(priceObstacle("creative_generate_speech", speechArgs("hello"))).toBeUndefined()
  })

  test("the estimate route is offered to every tool that has one, and to no tool that does not", () => {
    for (const tool of SPEND_TOOLS.filter(mustPrice)) {
      const error = refused(tool, { context: "a test" })
      expect({ tool, code: error?.code }).toEqual({ tool, code: "PRICE_UNKNOWN" })
      if (ESTIMATE_TOOLS.includes(tool)) {
        expect(`${tool}: ${error?.message}`).toContain("could not be priced from ElevenLabs' own estimate")
        expect(`${tool}: ${error?.nextStep}`).toContain('"estimate_only": true')
      } else {
        // `creative_design_voice` renders three previews and `agents_run_tests` holds conversations: no estimate, so
        // the one next step that always works is turning the caps off.
        expect(`${tool}: ${error?.message}`).toContain('does not accept "estimate_only"')
        expect(`${tool}: ${error?.nextStep}`).not.toContain("estimate_only")
      }
      // No refusal claims a rate this plugin does not publish any more.
      expect(`${tool}: ${error?.message}`).not.toContain("published credit")
    }
  })

  test("every tool with an argument allowlist is one ElevenLabs estimates for", () => {
    for (const tool of PRICED_ARGUMENTS.keys()) expect({ tool, estimable: ESTIMATE_TOOLS.includes(tool) }).toEqual({ tool, estimable: true })
    // And every estimable tool has one, so no priced call reaches an estimate with an argument nothing checked.
    for (const tool of ESTIMATE_TOOLS) expect({ tool, allowlisted: PRICED_ARGUMENTS.has(tool) }).toEqual({ tool, allowlisted: true })
  })
})

describe("the reading a duration was taken at is named, not assumed", () => {
  // This block used to be about a price: the cost line had to name which of a WAV's two readings it billed, because
  // a 55x bill turned on it. No file prices anything now, so the naming is what it always should have been — a line
  // of text about a file the save tool has just written, which an owner's own player may read differently.
  const root = mkdtempSync(join(tmpdir(), "elevenlabs-rr4-8-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const file = (name: string, bytes: Buffer) => {
    const path = join(root, name)
    writeFileSync(path, bytes)
    return path
  }
  /** The same reader the save tool uses, over a buffer, so the two readings can be compared without a file. */
  const reading = (bytes: Buffer) => riffReadingWith((offset, length) => bytes.subarray(offset, offset + length), bytes.length)

  test("a `data` size that understates the file gives two readings, and the longer is reported", async () => {
    // 8 kHz mono 8-bit: the `data` header states 8,000 bytes, one second, and 480,000 follow it. `afinfo` and
    // Python's `wave` both read the stated second. This walk reports the sixty that are there, and says it did.
    const both = reading(understatedThenJunk())
    expect(both).toEqual({ seconds: 60, stated: 1, toTheEnd: 60, understated: true })
    expect(both!.seconds).toBe(both!.toTheEnd)
    expect(await durationOf(file("understated-then-junk.wav", understatedThenJunk()))).toBe(60)
  })

  test("a file that does not disagree with itself says nothing about a reading", async () => {
    for (const [name, build] of [
      // The ordinary file: the stated size is the audio, and both readings are the same.
      ["canonical", WAV_FIXTURES.canonical],
      // A real trailing chunk begins where the stated size ends, so the stated size is believed and is not understated.
      ["trailing", WAV_FIXTURES.trailing],
      // An overstated size is clamped to the bytes that follow, which is the shorter reading, not the longer.
      ["overstated", WAV_FIXTURES.overstated],
    ] as const) {
      const path = file(`${name}.wav`, build())
      const both = reading(build())
      expect(`${name}: ${both?.understated}`).toBe(`${name}: false`)
      expect(`${name}: ${both?.seconds}`).toBe(`${name}: ${await durationOf(path)}`)
    }
    // The clamp really is the short one: sixty seconds of audio under a size field claiming ten minutes.
    expect(reading(WAV_FIXTURES.overstated())).toEqual({ seconds: 60, stated: 60, toTheEnd: 60, understated: false })
    // And a real trailing chunk keeps the stated reading even though far more of the file follows `data`.
    expect(reading(WAV_FIXTURES.trailing())).toEqual({ seconds: 1, stated: 1, toTheEnd: 13.501, understated: false })
  })

  test("the comment claims nothing about what the server bills, because nothing here bills from a file", () => {
    // The comment wraps, so the prose is read with its line breaks and leading asterisks taken out.
    const policy = readFileSync(new URL("../../src/media/policy.ts", import.meta.url), "utf8").replace(/\s+\*\s+/g, " ").replace(/\s+/g, " ")
    // At 6c21964 this asserted "the server reads to the end of what it is sent", which no decoder to hand does and
    // nothing here has measured. Live reconcile 1 then took the whole question out of the plugin: the comment names
    // the decoders that were tried, and says plainly that this figure prices nothing.
    expect(policy).not.toContain("the server reads to the end of what it is sent")
    expect(policy).not.toContain("which one the server bills")
    expect(policy).toContain("Nothing here prices anything.")
    expect(policy).toContain("afinfo")
    expect(policy).toContain("Python's `wave`")
    expect(policy).toContain("This figure is never a price.")
  })
})
