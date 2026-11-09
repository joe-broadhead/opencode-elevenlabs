// Reproductions from the second re-review. Each one failed at d107a11 and must pass after the fix. Since live
// reconcile 1 the plugin computes no price of its own — ElevenLabs' own `estimate_only` call is the only price — so
// the three pricing reproductions (to) are re-expressed against what stands in the formula's place. Each
// says what it used to assert, and what now holds instead.
import { describe, expect, test } from "bun:test"
import {
  estimatePrice,
  Ledger,
  LEDGER_KEY,
  quoteCall,
  quoteCallSync,
  RESERVATION_MS,
  settlementOf,
  SpendRefused,
} from "../../src/billing.js"
import { REGIONS } from "../../src/constants.js"
import { ALL_TOOLS, mustPrice, priced } from "../../src/elevenlabs-tools.js"
import { shapersFor } from "../../src/host/tools-rpc.js"
import { sharedStore, storageOver } from "../fixtures/store.js"
import { otherElevenlabsServers, toolOf } from "../../src/plugin.js"
import { buildStatus, formatStatus } from "../../src/status.js"

const caps = (session: number | null = 100_000, daily: number | null = 100_000) => ({ sessionCreditCap: session, dailyCreditCap: daily })
const call = (id = "c1", sessionID = "ses_a") => ({ sessionID, agent: "build", messageID: "m1", id })

/** A transcription call in the live schema's own argument names: the audio is a node in a flow, never a local file. */
const transcribeArgs = () => ({ model_id: "model_example", context: "a test", flow_id: "flow_example" })

/** A speech call in the live schema's own names. The spoken words go in `prompt`; there is no `text` argument. */
const speechArgs = (prompt: string) => ({ prompt, voice_id: "voice_example", model_id: "model_example", context: "a test" })

/**
 * A speech call of `credits` credits, with ElevenLabs' figure for exactly those arguments already in this ledger — what
 * an `estimate_only` call puts there. Remembered prices are fresh for ten minutes, so this is called beside each use.
 */
const priceKnown = (ledger: Ledger, credits: number) => {
  const args = speechArgs("x".repeat(credits))
  ledger.rememberPrice("creative_generate_speech", args, { credits, basis: "exact", parts: [] })
  return args
}

/** The refusal a priced call raised, for asserting the words it gives the caller. */
const refusal = async (run: Promise<unknown>) => {
  const outcome = await run.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(outcome).toBeInstanceOf(SpendRefused)
  return outcome as SpendRefused
}

/** An estimate seam that answers every call with the same figure, and counts how many times ElevenLabs was asked. */
const estimator = (credits: number) => {
  const asked: string[] = []
  const estimate = async (tool: string, input: Record<string, unknown>) => {
    asked.push(tool)
    return estimatePrice(tool, input, { output: { credits } })
  }
  return { estimate, asked }
}

describe("a file on disk sets no price, because no file is part of the call", () => {
  // This block used to measure WAV files: a minute of audio was 330 credits, and the reproduction was about reading
  // the audio behind a header rather than the header's own number. Live, `creative_transcribe_audio` takes no file at
  // all — `{connect_from, context, estimate_only, flow_id, model_id, view_state_id}` — so the audio is a node in the
  // workspace, its length is ElevenLabs' to know, and the price comes back from the server or the call does not run.

  test("a transcription is priced by ElevenLabs' own estimate, not by anything on this machine", async () => {
    const ledger = new Ledger()
    const { estimate, asked } = estimator(330)
    const { price, tracked } = await quoteCall({ ledger, caps: () => caps(), estimate }, "creative_transcribe_audio", transcribeArgs(), call("t"))
    expect({ credits: price.credits, basis: price.basis, tracked, asked }).toEqual({ credits: 330, basis: "exact", tracked: true, asked: ["creative_transcribe_audio"] })
    expect(price.parts).toContain("estimated by ElevenLabs")
    // No count in the schema, so there is no per-generation figure to divide a batch into, and nothing to clamp.
    expect(price.perGeneration).toBeUndefined()
    expect(ledger.daily()).toBe(330)
  })

  test("an argument naming a local file is refused, whatever the file holds", async () => {
    // A path is not in ElevenLabs' schema, so nothing it points at — a real minute, a truncated file, a broken RIFF —
    // can price the call, and the server would be pricing arguments it does not understand. It never gets asked.
    for (const extra of [{ path: "clip.wav" }, { audio_file: "clip.wav" }, { file: "clip.wav" }, { duration_seconds: 60 }]) {
      const ledger = new Ledger()
      const { estimate, asked } = estimator(330)
      const refused = quoteCall({ ledger, caps: () => caps(), estimate }, "creative_transcribe_audio", { ...transcribeArgs(), ...extra }, call("t"))
      await expect(refused).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
      expect({ key: Object.keys(extra)[0], asked, daily: ledger.daily() }).toEqual({ key: Object.keys(extra)[0], asked: [], daily: 0 })
    }
  })

  test("the refusal names the argument and the next step is the estimate the caller can run", async () => {
    const ledger = new Ledger()
    const failure = await refusal(quoteCall({ ledger, caps: () => caps() }, "creative_transcribe_audio", { ...transcribeArgs(), path: "clip.wav" }, call("t")))
    expect(failure.message).toContain(`"path" is an argument ElevenLabs' own schema for this tool does not have`)
    expect(failure.nextStep).toContain(`"estimate_only": true`)
    expect(priced("creative_transcribe_audio")).toBe(true)
  })
})

describe("every argument is held against ElevenLabs' own schema, not against a list of file names", () => {
  // The original: the plugin measured the first file name in a fixed list of its own, so a call carrying a minute of
  // audio under a name further down the list was priced at a second's worth. There is no list of its own now: the
  // allowlist is the live schema, and the first argument outside it stops the call, whichever name it has.

  test("a file under any of the old names refuses, in whichever order it is sent", async () => {
    const pairs: Record<string, unknown>[] = [
      { path: "a.wav", file: "b.wav" },
      { file: "b.wav", path: "a.wav" },
      { audio_file: "b.wav", path: "a.wav" },
      { input_file: "b.wav", file_path: "a.wav" },
      { file_path: "a.wav", input_file: "b.wav" },
    ]
    for (const extra of pairs) {
      const ledger = new Ledger()
      const { estimate, asked } = estimator(330)
      const refused = quoteCall({ ledger, caps: () => caps(), estimate }, "creative_transcribe_audio", { ...transcribeArgs(), ...extra }, call("t"))
      await expect(refused).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
      expect({ keys: Object.keys(extra).join("+"), asked }).toEqual({ keys: Object.keys(extra).join("+"), asked: [] })
    }
  })

  test("a URL is audio this plugin cannot price either, so it refuses rather than pricing around it", async () => {
    const ledger = new Ledger()
    await expect(
      quoteCall({ ledger, caps: () => caps() }, "creative_transcribe_audio", { ...transcribeArgs(), audio_file: "https://example.test/clip.wav" }, call("t")),
    ).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    expect(ledger.daily()).toBe(0)
  })

  test("the script path refuses the same arguments, even holding a price for the rest of them", () => {
    // A remembered estimate covers the arguments it was fetched for. One more argument is one more thing the bill may
    // turn on, so the price this ledger holds cannot carry the call past the check.
    const ledger = new Ledger()
    const args = transcribeArgs()
    ledger.rememberPrice("creative_transcribe_audio", args, { credits: 330, basis: "exact", parts: [] })
    expect(quoteCallSync({ ledger, caps: () => caps() }, "creative_transcribe_audio", { ...args }, call("a")).price.credits).toBe(330)
    expect(() => quoteCallSync({ ledger, caps: () => caps() }, "creative_transcribe_audio", { ...args, path: "a.wav" }, call("b"))).toThrow(SpendRefused)
  })
})

describe("a length the caller types prices nothing at all", () => {
  // The original: `music_length_ms` and `duration_seconds` fed a per-minute formula, 30 ms beat 300 s, and a request
  // under three seconds had to be floored at the shortest run the server accepts. The live catalogue has no music
  // tool, and no number in the arguments sets a price any more: a `creative_` name this table does not classify is
  // priced by its own estimate or refused.

  test("the music names are not in the live catalogue, and are still guarded by their shape", async () => {
    for (const name of ["creative_generate_music", "creative_compose_music", "creative_generate_sound_effect"]) {
      expect({ name, listed: ALL_TOOLS.includes(name), priced: mustPrice(name) }).toEqual({ name, listed: false, priced: true })
    }
  })

  test("no stated length prices such a call, high, low or zero", async () => {
    for (const args of [{ music_length_ms: 30, duration_seconds: 300 }, { music_length_ms: 300_000 }, { music_length_ms: 1 }, { duration_seconds: 0 }, {}]) {
      const ledger = new Ledger()
      const { estimate, asked } = estimator(4_500)
      await expect(quoteCall({ ledger, caps: () => caps(), estimate }, "creative_generate_music", args, call("m"))).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
      // Not in `ESTIMATE_TOOLS`, so ElevenLabs is not asked for a price it has no flag to give.
      expect({ args: Object.keys(args).join("+"), asked, daily: ledger.daily() }).toEqual({ args: Object.keys(args).join("+"), asked: [], daily: 0 })
    }
  })

  test("the refusal for a tool with no estimate says so, and its next step is the caps", async () => {
    // A tool this table classifies as spending, whose live schema declares no `estimate_only`: the refusal names the
    // flag it does not accept, because there is a schema here to say so.
    const failure = await refusal(quoteCall({ ledger: new Ledger(), caps: () => caps() }, "creative_design_voice", { voice_description: "a warm alto" }, call("m")))
    expect(failure.message).toContain(`does not accept "estimate_only"`)
    expect(failure.nextStep).toContain(`Set both "sessionCreditCap" and "dailyCreditCap" to null`)
    // A name the table does not classify at all gets the other shape: nothing here knows whether it spends.
    const unknown = await refusal(quoteCall({ ledger: new Ledger(), caps: () => caps() }, "creative_generate_music", { music_length_ms: 300_000 }, call("m")))
    expect(unknown.message).toContain("is not in this plugin's tool table")
    expect(unknown.nextStep).toContain("wait for a release that classifies it")
    // And with both caps off there is nothing to price either against, so each runs untracked rather than refused.
    for (const name of ["creative_design_voice", "creative_generate_music"]) {
      const untracked = await quoteCall({ ledger: new Ledger(), caps: () => caps(null, null) }, name, { music_length_ms: 300_000 }, call("m"))
      expect({ name, tracked: untracked.tracked }).toEqual({ name, tracked: false })
    }
  })
})

describe("a late result cannot settle the call that replaced it", () => {
  const shape = (sessionID = "ses_a", action = "elevenlabs_creative_generate_speech") => ({ sessionID, agent: "build", action })

  /** A reserves `a` credits and never returns; ten minutes on, it is charged and B reserves `b`. */
  const abandonedThenNext = (a: number, b: number) => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    const shapers = shapersFor({ ledger, caps })
    const slot = shape()
    shapers.input("creative_generate_speech", priceKnown(ledger, a), slot)
    now += RESERVATION_MS + 1
    expect(ledger.daily()).toBe(a)
    shapers.input("creative_generate_speech", priceKnown(ledger, b), slot)
    expect(ledger.daily()).toBe(a + b)
    return { ledger, shapers, call: slot, advance: (ms: number) => void (now += ms) }
  }

  test("the abandoned call's late result does not free the live call's budget", () => {
    // d107a11: A's result settled B's 3,000-credit hold at the 1 credit it attested, and the day read 1,501.
    const { ledger, shapers, call } = abandonedThenNext(1_500, 3_000)
    shapers.result("creative_generate_speech", { output: { credits: 1 }, text: "" }, call)
    expect(ledger.daily()).toBe(4_500)
    shapers.result("creative_generate_speech", { output: { credits: 3_000 }, text: "" }, call)
    expect(ledger.daily()).toBe(4_500)
  })

  test("the live call's own result settles it, and the abandoned one's cannot reopen it", () => {
    // The other order: B answers first, then A's stray figure of 1 arrives against a slot with no flight left.
    const { ledger, shapers, call } = abandonedThenNext(1_500, 3_000)
    shapers.result("creative_generate_speech", { output: { credits: 3_000 }, text: "" }, call)
    expect(ledger.daily()).toBe(4_500)
    shapers.result("creative_generate_speech", { output: { credits: 1 }, text: "" }, call)
    expect(ledger.daily()).toBe(4_500)
  })

  test("a call admitted beside an abandoned one is never settled below what it reserved", () => {
    // Whichever of the two results arrives, 3,000 was reserved for a call that ran: the figure may raise it only.
    for (const figure of [1, 2, 0.5]) {
      const { ledger, shapers, call } = abandonedThenNext(1_500, 3_000)
      shapers.result("creative_generate_speech", { output: { credits: figure }, text: "" }, call)
      shapers.result("creative_generate_speech", { output: { credits: figure }, text: "" }, call)
      expect({ figure, daily: ledger.daily() }).toEqual({ figure, daily: 4_500 })
    }
    const raised = abandonedThenNext(1_500, 3_000)
    raised.shapers.result("creative_generate_speech", { output: { credits: 4_000 }, text: "" }, raised.call)
    raised.shapers.result("creative_generate_speech", { output: { credits: 4_000 }, text: "" }, raised.call)
    expect(raised.ledger.daily()).toBe(5_500)
  })

  test("a stray result that never arrives does not make the slot conservative for ever", () => {
    const { ledger, shapers, call, advance } = abandonedThenNext(1_500, 3_000)
    shapers.result("creative_generate_speech", { output: { credits: 3_000 }, text: "" }, call)
    advance(RESERVATION_MS + 1)
    // Nothing is held against the slot, so the next call is an ordinary one, settled by its own result. Since a
    // result may only raise a charge, so the 500 it attests leaves the 2,000 it reserved standing.
    shapers.input("creative_generate_speech", priceKnown(ledger, 2_000), call)
    shapers.result("creative_generate_speech", { output: { credits: 500 }, text: "" }, call)
    expect(ledger.daily()).toBe(6_500)
    // A figure above the reservation still lands, which is what shows the slot is not stuck being conservative.
    shapers.input("creative_generate_speech", priceKnown(ledger, 2_000), call)
    shapers.result("creative_generate_speech", { output: { credits: 4_000 }, text: "" }, call)
    expect(ledger.daily()).toBe(10_500)
  })

  test("with nothing in flight, a late result is still ignored", () => {
    const { ledger, shapers, call } = abandonedThenNext(1_500, 3_000)
    shapers.result("creative_generate_speech", { output: { credits: 3_000 }, text: "" }, call)
    shapers.result("creative_generate_speech", { output: { credits: 1 }, text: "" }, call)
    shapers.result("creative_generate_speech", { output: { credits: 1 }, text: "" }, call)
    expect(ledger.daily()).toBe(4_500)
  })
})

describe("two locations on one data directory", () => {
  const small = () => ({ sessionCreditCap: 2_000, dailyCreditCap: 2_000 })
  const guardCall = (id: string) => ({ sessionID: "ses_a", agent: "build", messageID: "m1", id })
  const SPEECH = speechArgs("x".repeat(600))
  /** ElevenLabs' figure for exactly these arguments, as an `estimate_only` call leaves it. */
  const knowing = (ledger: Ledger) => (ledger.rememberPrice("creative_generate_speech", SPEECH, { credits: 1_200, basis: "exact", parts: [] }), ledger)

  test("a charge that settled is never dropped by the other writer's merge", async () => {
    // d107a11: both writers read an empty record, both set their own, and the store kept 1,200 of the 2,400 that
    // was spent. The lost charge overstated the owner's remaining budget from then on.
    const store = sharedStore()
    const first = new Ledger({ storage: store.handle() })
    const second = new Ledger({ storage: store.handle() })
    await Promise.all([first.hydrate(), second.hydrate()])
    await Promise.all([first.reserve("a", "ses_a", 1_200, small()), second.reserve("b", "ses_a", 1_200, small())])
    first.settle("a", "ses_a", 1_200)
    second.settle("b", "ses_a", 1_200)
    await Promise.all([first.flush(), second.flush()])
    const restarted = new Ledger({ storage: store.handle() })
    await restarted.hydrate()
    expect(restarted.daily()).toBe(2_400)
  })

  test("a path that can await decides from the store, so the second location is refused", async () => {
    // d107a11 decided from this process's memory alone: the second location saw nothing and spent the cap again.
    const store = sharedStore()
    const first = knowing(new Ledger({ storage: store.handle() }))
    const second = knowing(new Ledger({ storage: store.handle() }))
    await Promise.all([first.hydrate(), second.hydrate()])
    await quoteCall({ ledger: first, caps: small }, "creative_generate_speech", { ...SPEECH }, guardCall("a"))
    await first.flush()
    await expect(quoteCall({ ledger: second, caps: small }, "creative_generate_speech", { ...SPEECH }, guardCall("b"))).rejects.toMatchObject({
      code: "SPEND_CAP_REACHED",
    })
  })

  test("the hold is in the store before the call is dispatched, so a crash cannot lose it", async () => {
    const store = sharedStore()
    const ledger = knowing(new Ledger({ storage: store.handle() }))
    await ledger.hydrate()
    await quoteCall({ ledger, caps: small }, "creative_generate_speech", { ...SPEECH }, guardCall("a"))
    // The process dies here, with the generation already running. A restart reads only what the store holds.
    const restarted = new Ledger({ storage: store.handle() })
    await restarted.hydrate()
    expect(restarted.daily()).toBe(1_200)
  })

  test("the synchronous path still writes its hold, one tick behind the dispatch", async () => {
    // The residual leaves open: the shared shaper contract is synchronous, so the script path cannot await the
    // store before the call goes out. SECURITY.md and the README say so.
    const store = sharedStore()
    const ledger = knowing(new Ledger({ storage: store.handle() }))
    await ledger.hydrate()
    quoteCallSync({ ledger, caps: small }, "creative_generate_speech", { ...SPEECH }, guardCall("a"))
    await ledger.flush()
    const restarted = new Ledger({ storage: store.handle() })
    await restarted.hydrate()
    expect(restarted.daily()).toBe(1_200)
  })
})

describe("an estimate with no money behind it cannot block a method for ever", () => {
  const shape = (sessionID = "ses_a", action = "elevenlabs_creative_generate_speech") => ({ sessionID, agent: "build", action })

  /** An estimate_only shapeInput whose result never arrives: an upstream error, a timeout, a cancelled script. */
  const abandonedEstimate = () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    const shapers = shapersFor({ ledger, caps })
    const slot = shape()
    shapers.input("creative_generate_speech", { ...speechArgs("hi"), estimate_only: true }, slot)
    return { ledger, shapers, call: slot, advance: (ms: number) => void (now += ms) }
  }

  test("a paid call of that method is refused while the estimate could still return, and admitted once it cannot", () => {
    // d107a11 refused it at once, after 11 minutes and after 25 hours: the estimate flight was never forgiven.
    const { ledger, shapers, call, advance } = abandonedEstimate()
    expect(() => shapers.input("creative_generate_speech", priceKnown(ledger, 1_500), call)).toThrow(SpendRefused)
    advance(RESERVATION_MS + 1)
    shapers.input("creative_generate_speech", priceKnown(ledger, 1_500), call)
    expect(ledger.spend("ses_a").sessionCredits).toBe(1_500)
  })

  test("the refusal's next step can be carried out", () => {
    const { ledger, shapers, call } = abandonedEstimate()
    try {
      shapers.input("creative_generate_speech", priceKnown(ledger, 1_500), call)
      throw new Error("expected a refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(SpendRefused)
      // "Wait for that call to finish" was a step that could never be taken: the flight outlived every call.
      expect((error as SpendRefused).nextStep).toContain("ten-minute reservation")
    }
  })

  test("the abandoned estimate's late result cannot settle the paid call that replaced it", () => {
    const { ledger, shapers, call, advance } = abandonedEstimate()
    advance(RESERVATION_MS + 1)
    shapers.input("creative_generate_speech", priceKnown(ledger, 1_500), call)
    expect(ledger.spend("ses_a").sessionCredits).toBe(1_500)
    shapers.result("creative_generate_speech", { output: { credits: 1 }, text: "" }, call)
    expect(ledger.spend("ses_a").sessionCredits).toBe(1_500)
    shapers.result("creative_generate_speech", { output: { credits: 1 }, text: "" }, call)
    expect(ledger.spend("ses_a").sessionCredits).toBe(1_500)
  })

  test("an estimate that does return settles nothing, frees the method, and prices the call that follows", () => {
    // The estimate's own figure is what the paid call is then priced at: on the script path that is the whole of the
    // next step the refusal gives, so the two calls must meet. They differ by `estimate_only` alone, which the price
    // key leaves out.
    const { ledger, shapers, call } = abandonedEstimate()
    shapers.result("creative_generate_speech", { output: { credits: 42 }, text: "" }, call)
    expect(ledger.daily()).toBe(0)
    shapers.input("creative_generate_speech", speechArgs("hi"), call)
    expect(ledger.spend("ses_a").sessionCredits).toBe(42)
  })
})

describe("an attested figure may lower a reservation only when it reads as this call's charge", () => {
  const result = (output: Record<string, unknown>) => ({ output, text: "" })

  test("a fraction of a credit is a real figure, and settles at the credit above it", () => {
    // d107a11 settled 0.5 against 3,000 reserved, which is how 3,000 credits became 1 — and that is still refused
    // below. What changed at live reconcile 1 is the reason: ElevenLabs' own figures are fractional (an image
    // estimate came back 761.5151418103446 credits), so a fraction is no longer evidence the plugin misread a rate.
    // Inside the band it settles, rounded up, because the ledger counts whole credits.
    const settled = settlementOf(result({ credits: 0.5 }), 3_000)
    expect(settled).toMatchObject({ credits: 3_000, attested: false })
    expect(settled.note).toContain("too far below")
    expect(settlementOf(result({ credits: 761.5151418103446 }), 1_000)).toEqual({ credits: 762, attested: true })
    expect(settlementOf(result({ credits: 2_999.2 }), 3_000)).toEqual({ credits: 3_000, attested: true })
  })

  test("a figure orders of magnitude below the reservation never lowers it", () => {
    for (const credits of [1, 2, 29, 299]) {
      const settled = settlementOf(result({ credits }), 3_000)
      expect({ credits, settled: settled.credits, attested: settled.attested }).toEqual({ credits, settled: 3_000, attested: false })
      expect(settled.note).toContain("too far below")
    }
    // Since a tenth of the hold is the lowest figure that can settle a 3,000-credit reservation.
    expect(settlementOf(result({ credits: 300 }), 3_000)).toEqual({ credits: 300, attested: true })
    expect(settlementOf(result({ total_credits: 1_500 }), 3_000)).toEqual({ credits: 1_500, attested: true })
    // Raising is not bounded the same way: since a higher figure is always the charge, flagged past tenfold.
    expect(settlementOf(result({ credits: 30_000 }), 3_000)).toEqual({ credits: 30_000, attested: true })
    const far = settlementOf(result({ credits: 48_000 }), 3_000)
    expect(far).toMatchObject({ credits: 48_000, attested: true })
    expect(far.note).toContain("more than ten times")
  })

  test("credit_cost is no longer read as a charge", () => {
    // It reads as readily as a per-unit rate, and no live call has been seen to carry a charge in it.
    expect(settlementOf(result({ credit_cost: 0.5 }), 3_000)).toEqual({ credits: 3_000, attested: false })
    expect(settlementOf(result({ credit_cost: 1 }), 3_000)).toEqual({ credits: 3_000, attested: false })
    // The fields that do name this call's charge still work.
    for (const key of ["credits", "credits_used", "credits_charged", "billed_credits", "total_credits"]) {
      expect({ key, ...settlementOf(result({ [key]: 2_000 }), 3_000) }).toEqual({ key, credits: 2_000, attested: true })
    }
  })

  test("the cost line says the reservation stands, rather than reporting a figure it refused", () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    const shapers = shapersFor({ ledger, caps })
    const call = { sessionID: "ses_a", agent: "build", action: "elevenlabs_creative_generate_speech" }
    shapers.input("creative_generate_speech", priceKnown(ledger, 3_000), call)
    const settled = shapers.result("creative_generate_speech", { output: { credits: 1 }, text: "" }, call)
    expect(ledger.spend("ses_a").sessionCredits).toBe(3_000)
    expect(settled.text).toContain("too far below")
  })
})

describe("the money gate folds case, as the permission gate does", () => {
  test("a creative_ name in another case is priced or refused, never sent unpriced", () => {
    // d107a11 answered false for every one of these, so the guard returned before pricing and the call was sent.
    for (const name of ["Creative_Upscale", "Creative_Generate_Speech", "CREATIVE_GENERATE_SPEECH", "creative_Edit_Image"]) {
      expect({ name, priced: mustPrice(name) }).toEqual({ name, priced: true })
    }
    // The exemption folds with it too: a name this table classifies as something that cannot spend runs unpriced in
    // any case. `Creative_Upscale` above is in neither half — it is not a live name at all — so it is priced as an
    // unknown rather than exempted by its prefix.
    for (const name of ["CREATIVE_GET_FLOW", "Creative_Create_Flow", "AGENTS_LIST", "Get_More_Tools"]) {
      expect({ name, priced: mustPrice(name) }).toEqual({ name, priced: false })
    }
  })

  test("a name in another case is offered its own estimate, and priced from it", async () => {
    // The price source folds case too: a tool whose live schema has `estimate_only` is estimable in any case, and the
    // figure an estimate left under the lowercase name prices the call that arrives in another.
    const input = speechArgs("x".repeat(1_500))
    for (const name of ["Creative_Generate_Speech", "CREATIVE_GENERATE_SPEECH"]) {
      expect({ name, estimable: priced(name) }).toEqual({ name, estimable: true })
      const ledger = new Ledger()
      ledger.rememberPrice("creative_generate_speech", input, { credits: 3_000, basis: "exact", parts: [] })
      const { price } = await quoteCall({ ledger, caps: () => caps() }, name, { ...input }, call(name))
      expect({ name, credits: price.credits }).toEqual({ name, credits: 3_000 })
    }
  })

  test("the money path reserves for a mixed-case call, as it does for the lowercase one", () => {
    const ledger = new Ledger({ now: () => 0 })
    const shapers = shapersFor({ ledger, caps })
    const call = { sessionID: "ses_a", agent: "build", action: "elevenlabs_Creative_Generate_Speech" }
    // At d107a11 this reserved nothing at all: the call went out and the session spent 0.
    shapers.input("Creative_Generate_Speech", priceKnown(ledger, 3_000), call)
    expect(ledger.spend("ses_a").sessionCredits).toBe(3_000)
  })

  test("the prefix folds case, and only this plugin's own entry is stripped", () => {
    expect(toolOf("elevenlabs_creative_generate_speech")).toBe("creative_generate_speech")
    // d107a11 returned undefined for both of these, so both hooks returned before the guard.
    expect(toolOf("ELEVENLABS_creative_generate_speech")).toBe("creative_generate_speech")
    expect(toolOf("elevenlabs_Creative_Generate_Speech")).toBe("creative_generate_speech")
    // A second entry under another name is a different server to OpenCode: the caps do not reach it, and status says so.
    expect(toolOf("elevenlabs2_creative_generate_speech")).toBeUndefined()
    expect(toolOf("notelevenlabs_creative_generate_speech")).toBeUndefined()
  })

  test("a second entry at ElevenLabs' address is found, and never changed", () => {
    const remote = (url: string) => ({ type: "remote", url })
    const entries = [
      ["elevenlabs", remote(REGIONS.global)],
      ["elevenlabs2", remote(REGIONS.eu)],
      ["voice", remote(`${REGIONS.us}?token=secret`)],
      ["other", remote("https://example.com/mcp")],
      ["local", { type: "local" }],
      ["bad name!", remote(REGIONS.global)],
    ] as const
    expect(otherElevenlabsServers(entries)).toEqual(["elevenlabs2", "voice"])
  })

  test("status names the second entry and offers to remove it, while a cap is on", () => {
    const facts = {
      host: { version: "2.2.6", range: ">=2.2.3 <2.3.0", tested: true },
      server: { status: "connected" as const },
      source: { type: "plugin" as const, url: REGIONS.global },
      tools: ["creative_generate_speech"],
      spend: { dailyCredits: 0, sessionCap: 2_000, dailyCap: 10_000 },
    }
    const named = formatStatus(buildStatus({ ...facts, otherServers: ["elevenlabs2"] }))
    expect(named).toContain("mcp.servers.elevenlabs2 also points at ElevenLabs and is outside these caps")
    expect(named).toContain("Next step: mcp.servers.elevenlabs2 also points at ElevenLabs, and this plugin's credit caps do not bind calls to it.")
    expect(formatStatus(buildStatus(facts))).toContain("Next step: Nothing to do.")
    // With no cap there is nothing to be outside of, so it is named without becoming the next step.
    const uncapped = buildStatus({ ...facts, otherServers: ["elevenlabs2", "voice"], spend: { dailyCredits: 0, sessionCap: null, dailyCap: null } })
    expect(formatStatus(uncapped)).toContain("mcp.servers.elevenlabs2 and mcp.servers.voice also point at ElevenLabs and are outside these caps")
    expect(uncapped.nextStep).toBe("Nothing to do.")
  })
})

describe("folded credits age from when they were spent", () => {
  const HOUR = 60 * 60 * 1_000

  /** A ledger whose detail log has just overflowed: 1,000 charges at t0, then 1,001 an hour-aligned 23 hours later. */
  const overflowed = () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    for (let i = 0; i < 1_000; i++) ledger.record("ses_a", 1, 0)
    now = 23 * HOUR
    for (let i = 0; i < 1_001; i++) ledger.record("ses_a", 1, now)
    return { ledger, advance: (to: number) => void (now = to) }
  }

  test("a charge that aged out stops counting, whatever newer charge shares its total", () => {
    const { ledger, advance } = overflowed()
    // 2,001 charges of one credit, and the fold has taken t0's 1,000 rows plus one of the new ones.
    expect(ledger.daily()).toBe(2_001)
    advance(26 * HOUR)
    // d107a11 answered 2,001 here: t0's thousand credits were folded into a total stamped 23h, so they aged from there
    // and stayed for another day. Only the 1,001 spent at 23h are still inside the window.
    expect(ledger.daily()).toBe(1_001)
    expect(ledger.spend("ses_a").sessionCredits).toBe(1_001)
    advance(49 * HOUR)
    expect(ledger.daily()).toBe(0)
    // `overflowed` builds 2,001 charges to make the detail log spill into folded totals. That is real work, and on
    // a loaded machine it runs past bun's five-second default; what this asserts is a credit figure, not a duration.
  }, 30_000)

  test("what is left over is one hour of it, not a day", () => {
    const { ledger, advance } = overflowed()
    // The hour a folded charge joined is kept while any minute of it is still in the window, so a bucket outlives its
    // newest charge by up to an hour. One credit of the 23h hour, never the thousand of t0's.
    advance(47 * HOUR + 59 * 60 * 1_000)
    expect(ledger.daily()).toBe(1)
  }, 30_000)

  test("each session and each hour folds into its own total", () => {
    let now = 3 * HOUR
    const ledger = new Ledger({ now: () => now })
    // 1,600 charges of one credit, 400 in each of four hours, alternating between two sessions. The detail log holds
    // the last 1,000, so the first 600 are folded: all 400 of hour 0, and 200 of hour 1.
    for (let i = 0; i < 1_600; i++) ledger.record(i % 2 === 0 ? "ses_a" : "ses_b", 1, Math.floor(i / 400) * HOUR)
    expect(ledger.daily()).toBe(1_600)
    expect(ledger.spend("ses_a").sessionCredits).toBe(800)
    // d107a11 folded all 600 into one total per session, stamped with the newest charge's time, so none of them aged
    // out until hour 1's clock ran down. Hour 0's 400 go first, on their own hour.
    now = 25 * HOUR + 1
    expect(ledger.daily()).toBe(1_000)
    expect(ledger.spend("ses_a").sessionCredits).toBe(500)
    expect(ledger.spend("ses_b").sessionCredits).toBe(500)
    // Then hour 1's folded 200, an hour later, leaving the two hours still in the detail log.
    now = 26 * HOUR + 1
    expect(ledger.daily()).toBe(400)
    now = 28 * HOUR
    expect(ledger.daily()).toBe(0)
    expect(ledger.spend("ses_b").sessionCredits).toBe(0)
  })

  test("a folded total keeps its own hour through the store", async () => {
    const store = new Map<string, unknown>()
    const storage = storageOver(store)
    store.set(LEDGER_KEY, {
      entries: [],
      holds: [],
      // One bucket in hour 0, and a total written before the buckets, stamped half past hour 1.
      rolled: [
        { at: 0, credits: 400, sessionID: "ses_a" },
        { at: HOUR + 30 * 60 * 1_000, credits: 200, sessionID: "ses_b" },
      ],
    })
    let now = 3 * HOUR
    const ledger = new Ledger({ storage, now: () => now })
    await ledger.hydrate()
    ledger.record("ses_a", 7, 3 * HOUR)
    await ledger.flush()
    expect(ledger.daily()).toBe(607)
    now = 25 * HOUR + 45 * 60 * 1_000
    // Hour 0's total has aged out. The one stamped mid-hour was read back as hour 1's bucket, so it is kept while any
    // minute of that hour is in the window: d107a11 aged it from 01:30 and had already dropped it here. Rounding down
    // only ever lengthens the window a stored total had, which is the side a cap must err on.
    expect(ledger.daily()).toBe(207)
    // A separate storage object is a separate book: this ledger starts empty and learns the buckets from the store.
    const second = new Ledger({ storage: storageOver(store), now: () => now })
    await second.hydrate()
    expect(second.daily()).toBe(207)
    expect(second.spend("ses_b").sessionCredits).toBe(200)
    now = 26 * HOUR + 1
    expect(second.daily()).toBe(7)
    expect(second.daily()).toBe(ledger.daily())
  })
})
