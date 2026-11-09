import { describe, expect, test } from "bun:test"
import {
  actualCreditsOf,
  assertAffordable,
  clampGenerations,
  costLine,
  costValue,
  estimatePrice,
  GENERATION_DEFAULTS,
  generationsKeyOf,
  generationsOf,
  isEstimate,
  Ledger,
  quoteCall,
  quoteCallSync,
  remaining,
  settlementOf,
  SpendRefused,
  unknownArgument,
} from "../../src/billing.js"
import { mustPrice } from "../../src/elevenlabs-tools.js"
import { storageOver } from "../fixtures/store.js"

const caps = (session: number | null = 2000, daily: number | null = 10000) => ({ sessionCreditCap: session, dailyCreditCap: daily })
const spend = (sessionCredits = 0, dailyCredits = 0) => ({ sessionCredits, dailyCredits })
const call = (id = "call_1", sessionID = "ses_a") => ({ sessionID, agent: "build", messageID: "msg_a", id })

describe("prices from ElevenLabs' own estimate", () => {
  test("the reported figure is the batch total, and a fraction rounds up into the ledger", () => {
    // The figure a live estimate returned for four images: a batch total, fractional, about 190 a picture.
    const four = estimatePrice("creative_generate_image", { prompt: "a mug", generations_count: 4 }, { output: { credits: 761.5151418103446 } })!
    expect(four).toMatchObject({ credits: 762, basis: "exact" })
    expect(four.perGeneration).toBeCloseTo(190.37878545258615, 6)
    expect(four.parts.join(", ")).toBe("4 generations, estimated by ElevenLabs, rounded up from 761.5151418103446")
    const one = estimatePrice("creative_generate_image", { prompt: "a mug", generations_count: 1 }, { output: { credits: 500 } })!
    expect(one).toEqual({ credits: 500, basis: "exact", parts: ["1 generation", "estimated by ElevenLabs"], perGeneration: 500 })
    expect(estimatePrice("creative_generate_image", {}, { text: "no price here" })).toBeUndefined()
  })

  test("a call that names no count is divided by the server's own schema default", () => {
    // ElevenLabs runs four images and two speech takes when the call states nothing, so that is what the figure covers.
    expect(GENERATION_DEFAULTS.creative_generate_image).toBe(4)
    expect(GENERATION_DEFAULTS.creative_generate_speech).toBe(2)
    const images = estimatePrice("creative_generate_image", { prompt: "a mug" }, { output: { credits: 800 } })!
    expect(images).toMatchObject({ credits: 800, basis: "exact", perGeneration: 200 })
    expect(images.parts[0]).toBe("4 generations by default")
    const speech = estimatePrice("creative_generate_speech", { prompt: "hello", voice_id: "voice_example" }, { output: { credits: 60 } })!
    expect(speech).toMatchObject({ credits: 60, perGeneration: 30 })
  })

  test("a batch size nothing states leaves the total undivided, so nothing is clamped out of it", () => {
    // `creative_transcribe_audio` has no count at all, and the two flow tools declare one with no default.
    for (const tool of ["creative_transcribe_audio", "creative_generate_in_flow", "creative_run_flow_nodes"]) {
      const price = estimatePrice(tool, { flow_id: "flow_example" }, { output: { credits: 330 } })!
      expect({ tool, credits: price.credits, per: price.perGeneration }).toEqual({ tool, credits: 330, per: undefined })
    }
    // Stated, it divides as usual.
    expect(estimatePrice("creative_run_flow_nodes", { generations_count: 3 }, { output: { credits: 90 } })!.perGeneration).toBe(30)
  })

  test("transcription is priced from the estimate alone: no audio of the caller's is measured", () => {
    // A duration or a byte count the caller typed prices nothing, and neither does a file on disk (LIVE-RECONCILE-1).
    expect(estimatePrice("creative_transcribe_audio", { duration_seconds: 60 }, {})).toBeUndefined()
    expect(estimatePrice("creative_transcribe_audio", { connect_from: "node_example" }, { output: { flow_id: "flow_example" } })).toBeUndefined()
    expect(estimatePrice("creative_transcribe_audio", { connect_from: "node_example" }, { output: { credits: 42 } })).toMatchObject({ credits: 42, basis: "exact" })
  })

  test("an argument the live schema does not have is named, so the call is refused rather than priced around", () => {
    expect(unknownArgument("creative_generate_image", { prompt: "a mug", generations_count: 2 })).toBeUndefined()
    expect(unknownArgument("creative_generate_image", { prompt: "a mug", seed: 7 })).toContain("seed")
    // Speech takes a voice, image does not; each allowlist is its own tool's schema. Speech says what to say in
    // `prompt` like the rest of them, so a `text` argument is one the server would not read.
    expect(unknownArgument("creative_generate_speech", { prompt: "hi", voice_id: "voice_example" })).toBeUndefined()
    expect(unknownArgument("creative_generate_speech", { text: "hi" })).toContain("text")
    expect(unknownArgument("creative_generate_image", { prompt: "a mug", voice_id: "voice_example" })).toContain("voice_id")
    // A tool with no allowlist has no argument to object to: nothing prices it at all, which is a separate refusal.
    expect(unknownArgument("creative_design_voice", { voice_description: "warm" })).toBeUndefined()
  })

  test("a creative_ name the table does not price must be priced or refused, with no keyword list", () => {
    for (const name of ["creative_compose_music", "creative_sound_effects", "creative_generate_video", "creative_transcribe_audio", "creative_upscale"]) {
      expect({ name, priced: mustPrice(name) }).toEqual({ name, priced: true })
    }
    for (const name of ["creative_get_flow", "creative_list_voices", "agents_list", "agents_update"]) {
      expect({ name, priced: mustPrice(name) }).toEqual({ name, priced: false })
    }
  })

  test("generations are read from the one key the live schemas have, and the clamp writes back into it", () => {
    // The catalogue spells the count one way, so there is no alias to read: a count under any other name is an
    // argument the tool's own schema does not have, and the guard refuses the call rather than reading it.
    expect(generationsKeyOf({ generations_count: 4 })).toBe("generations_count")
    expect(generationsOf({ generations_count: 4 })).toBe(4)
    expect(generationsKeyOf({ variations: 4 })).toBeUndefined()
    expect(generationsOf({ variations: 4 })).toBeUndefined()
    expect(generationsOf({ generations_count: 0 })).toBeUndefined()
    const named: Record<string, unknown> = { prompt: "a mug", generations_count: 4 }
    expect(clampGenerations(named, 1)).toBe("generations_count")
    expect(named).toEqual({ prompt: "a mug", generations_count: 1 })
    const unnamed: Record<string, unknown> = { prompt: "a mug" }
    expect(clampGenerations(unnamed, 2)).toBe("generations_count")
    expect(unnamed).toEqual({ prompt: "a mug", generations_count: 2 })
  })

  test("a count no number can be read out of prices nothing, since it multiplies the whole call", () => {
    expect(estimatePrice("creative_generate_image", { generations_count: "lots" }, { output: { credits: 500 } })).toBeUndefined()
    // A numeric string states what it spells (RR3-9).
    expect(estimatePrice("creative_generate_image", { generations_count: "2" }, { output: { credits: 500 } })!.perGeneration).toBe(250)
  })

  test("a settlement believes a fraction, and rounds it up, since a live estimate is fractional", () => {
    // A reported figure above the reservation always raises, whole or not.
    expect(settlementOf({ output: { credits: 761.5151418103446 } }, 700, 10000)).toMatchObject({ credits: 762, attested: true })
    // One inside the band settles below, and still rounds up rather than down.
    expect(settlementOf({ output: { credits: 740.25 } }, 762, 10000)).toMatchObject({ credits: 741, attested: true })
    // Far below the reservation it is not read as this call's charge, so the hold stands.
    expect(settlementOf({ output: { credits: 1.5 } }, 762, 10000)).toMatchObject({ credits: 762, attested: false })
  })

  test("actual credits come from structured content, JSON text, a text part, or plain prose", () => {
    expect(actualCreditsOf({ output: { credits: 42 } })).toBe(42)
    expect(actualCreditsOf({ output: { usage: { estimated_credits: 7 } } })).toBe(7)
    expect(actualCreditsOf({ text: '{"cost":{"credit_cost":9}}' })).toBe(9)
    // The host's own result carries `content`, not `text` (DR-10).
    expect(actualCreditsOf({ content: [{ type: "text", text: "Charged 480 credits for this generation." }] })).toBe(480)
    expect(actualCreditsOf({ content: "Billed 1,200 credits." })).toBe(1200)
    expect(actualCreditsOf({ content: [{ type: "text", text: "Created a flow." }] })).toBeUndefined()
  })
})

describe("the caps", () => {
  test("a price that fits runs, and one that does not is refused with what is left", () => {
    expect(() => assertAffordable({ tool: "creative_generate_speech", price: { credits: 100, basis: "exact", parts: [] }, caps: caps(), spend: spend() })).not.toThrow()
    expect(() => assertAffordable({ tool: "creative_generate_speech", price: { credits: 2100, basis: "exact", parts: [] }, caps: caps(), spend: spend() })).toThrow(SpendRefused)
    try {
      assertAffordable({ tool: "creative_generate_video", price: { credits: 2100, basis: "at-most", parts: [] }, caps: caps(), spend: spend(100, 500) })
    } catch (error) {
      const refusal = error as SpendRefused
      expect(refusal.code).toBe("SPEND_CAP_REACHED")
      expect(refusal.message).toContain("at most 2,100 credits")
      expect(refusal.message).toContain("1,900 of 2,000 credits left")
      expect(refusal.nextStep).toContain("sessionCreditCap")
    }
  })

  test("a null cap is unlimited, and the tighter of the two decides", () => {
    expect(remaining(caps(null, null), spend(5000, 5000)).available).toBe(Number.POSITIVE_INFINITY)
    expect(remaining(caps(100, 500), spend(90, 0)).available).toBe(10)
    expect(remaining(caps(500, 100), spend(0, 95)).available).toBe(5)
  })

  test("the cost line says at most when it is a bound, and the structured cost carries the caps", () => {
    expect(costLine({ credits: 1200, basis: "at-most", parts: ["600 characters", "2 takes"] }, spend(0, 1200), caps())).toBe(
      "Credits: at most 1,200 (600 characters, 2 takes); 1,200 of 10,000 credits today.",
    )
    expect(costLine({ credits: 7, basis: "exact", parts: [] }, spend(0, 7), caps(null, null))).toBe("Credits: 7; 7 credits today.")
    expect(costValue({ credits: 7, basis: "exact", parts: [] }, spend(7, 7), caps())).toEqual({ credits: 7, basis: "exact", sessionSpent: 7, dailySpent: 7, sessionCap: 2000, dailyCap: 10000 })
  })
})

describe("the ledger", () => {
  const storage = () => {
    const stored = new Map<string, unknown>()
    return { stored, ...storageOver(stored) }
  }

  test("records amounts, times and the session, prunes past 24 hours, and survives through storage", async () => {
    let now = 1_000_000
    const store = storage()
    const ledger = new Ledger({ storage: store, now: () => now })
    await ledger.hydrate()
    ledger.record("ses_a", 300)
    ledger.record("ses_a", 200)
    ledger.record("ses_b", 50)
    await ledger.flush()
    expect(ledger.spend("ses_a")).toEqual({ sessionCredits: 500, dailyCredits: 550 })
    // Since RR3-4 each charge is its own key, so the store holds three of them, each naming its session.
    const saved = [...store.stored].filter(([key]) => key.startsWith("spend/")).map(([, value]) => value as { at: number; credits: number; sessionID: string })
    expect(saved.length).toBe(3)
    expect(saved.every((entry) => typeof entry.sessionID === "string" && typeof entry.at === "number")).toBe(true)

    // A reload in the same window keeps both totals, the session's included (DR-9).
    const reopened = new Ledger({ storage: store, now: () => 1_000_500 })
    await reopened.hydrate()
    expect(reopened.spend("ses_a")).toEqual({ sessionCredits: 500, dailyCredits: 550 })

    // A day later the record is gone.
    now += 24 * 60 * 60 * 1000 + 1
    expect(ledger.daily()).toBe(0)
  })

  test("serialises its writes, so two charges at once cannot lose one", async () => {
    const written = new Map<string, unknown>()
    const slow = {
      get: async () => undefined,
      set: async (key: string, value: unknown) => {
        await Bun.sleep(5)
        written.set(key, value)
      },
      remove: async () => {},
      scan: async () => ({ entries: [] as never[] }),
    }
    const ledger = new Ledger({ storage: slow as never })
    await ledger.hydrate()
    ledger.record("a", 10)
    ledger.record("a", 20)
    ledger.record("a", 30)
    await ledger.flush()
    // Since RR3-4 the three charges are three keys, so one slow write cannot overtake another and drop it.
    const charges = [...written.values()] as Array<{ credits: number }>
    expect(charges.length).toBe(3)
    expect(charges.reduce((sum, entry) => sum + entry.credits, 0)).toBe(60)
    expect(ledger.daily()).toBe(60)
  })

  test("a reservation counts against the budget until it settles or is released", () => {
    const ledger = new Ledger()
    ledger.reserve("c1", "ses_a", 1200, caps())
    expect(ledger.spend("ses_a")).toEqual({ sessionCredits: 1200, dailyCredits: 1200 })
    // The second call cannot also fit.
    expect(() => ledger.reserve("c2", "ses_a", 1200, caps())).toThrow(SpendRefused)
    // A figure below the reservation does not free the difference. A higher one replaces it.
    expect(ledger.settle("c1", "ses_a", 1000)).toEqual({ sessionCredits: 1200, dailyCredits: 1200 })
    expect(ledger.settle("c1", "ses_a", 1300)).toEqual({ sessionCredits: 1300, dailyCredits: 1300 })
    // A failure settles the reserved price. It does not free the budget.
    ledger.reserve("c3", "ses_a", 100, caps())
    ledger.release("c3")
    expect(ledger.spend("ses_a")).toEqual({ sessionCredits: 1400, dailyCredits: 1400 })
  })

  test("a reservation nothing settles is charged at the reserved price, not dropped", () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    ledger.reserve("c1", "ses_a", 900, caps())
    now += 11 * 60 * 1000
    expect(ledger.spend("ses_a")).toEqual({ sessionCredits: 900, dailyCredits: 900 })
  })

  test("remembers an estimate against exactly those arguments, and forgets it after ten minutes", () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    const args = { prompt: "a mug", generations_count: 1 }
    ledger.rememberPrice("creative_generate_image", args, { credits: 250, basis: "exact", parts: [] })
    expect(ledger.rememberedPrice("creative_generate_image", args)?.credits).toBe(250)
    expect(ledger.rememberedPrice("creative_generate_image", { prompt: "a boat" })).toBeUndefined()
    now = 10 * 60 * 1000 + 1
    expect(ledger.rememberedPrice("creative_generate_image", args)).toBeUndefined()
  })
})

describe("quoteCall", () => {
  /** An estimate that answers like the live server: one batch total for the arguments it is sent. */
  const estimator = (credits: number) => async (tool: string, input: Record<string, unknown>) => estimatePrice(tool, input, { output: { credits } })

  test("prices from ElevenLabs' estimate, reserves, and refuses the second of two parallel calls", async () => {
    const ledger = new Ledger()
    const guard = { ledger, caps: () => caps(2000, 10000), estimate: estimator(1200) }
    // DR-1: two calls that start together, 1,200 each against 2,000. Exactly one may pass.
    const results = await Promise.allSettled([
      quoteCall(guard, "creative_generate_speech", { prompt: "x".repeat(600) }, call("c1")),
      quoteCall(guard, "creative_generate_speech", { prompt: "y".repeat(600) }, call("c2")),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult
    expect((refused.reason as SpendRefused).code).toBe("SPEND_CAP_REACHED")
    expect(ledger.spend("ses_a")).toEqual({ sessionCredits: 1200, dailyCredits: 1200 })
  })

  test("the synchronous form reserves the same way, from a price the ledger already remembers", () => {
    const ledger = new Ledger()
    const guard = { ledger, caps: () => caps(2000, 10000) }
    const args = { prompt: "x".repeat(600) }
    // The script path cannot await an estimate, so a script sends `estimate_only` itself and the price is remembered.
    ledger.rememberPrice("creative_generate_speech", args, { credits: 1200, basis: "exact", parts: [] })
    expect(quoteCallSync(guard, "creative_generate_speech", args, call("c1")).price.credits).toBe(1200)
    expect(() => quoteCallSync(guard, "creative_generate_speech", args, call("c2"))).toThrow(SpendRefused)
    // With nothing remembered it refuses rather than guesses.
    expect(() => quoteCallSync(guard, "creative_generate_speech", { prompt: "new" }, call("c3"))).toThrow(SpendRefused)
  })

  test("clamps a request to what the budget affords, in the key the caller used", async () => {
    const ledger = new Ledger()
    // 4,000 for the batch of four the call asks for: 1,000 a generation, so 2,000 buys two.
    const aliased: Record<string, unknown> = { prompt: "a mug", generations_count: 4 }
    const { price } = await quoteCall({ ledger, caps: () => caps(2000, 10000), estimate: estimator(4000) }, "creative_generate_image", aliased, call())
    expect(aliased).toEqual({ prompt: "a mug", generations_count: 2 })
    expect(price.credits).toBe(2000)
    expect(price.basis).toBe("at-most")
  })

  test("asks ElevenLabs once, and never retries a failed estimate", async () => {
    const ledger = new Ledger()
    let asked = 0
    const failing = async () => (asked++, undefined)
    await expect(quoteCall({ ledger, caps: () => caps(), estimate: failing }, "creative_generate_image", { prompt: "x" }, call())).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    expect(asked).toBe(1)
    const succeeding = async () => (asked++, { credits: 500, basis: "exact" as const, parts: [] })
    await quoteCall({ ledger, caps: () => caps(), estimate: succeeding }, "creative_generate_video", { prompt: "y" }, call("c2"))
    expect(asked).toBe(2)
  })

  test("a price it remembers is used before a second estimate, which would leave a second flow behind", async () => {
    const ledger = new Ledger()
    let asked = 0
    const estimate = async (tool: string, input: Record<string, unknown>) => (asked++, estimatePrice(tool, input, { output: { credits: 300 } }))
    const args = { prompt: "a mug", generations_count: 1 }
    expect((await quoteCall({ ledger, caps: () => caps(), estimate }, "creative_generate_image", { ...args }, call("c1"))).price.credits).toBe(300)
    expect((await quoteCall({ ledger, caps: () => caps(), estimate }, "creative_generate_image", { ...args }, call("c2"))).price.credits).toBe(300)
    expect(asked).toBe(1)
  })

  test("a tool it cannot price is refused with a next step that works, and never guesses", async () => {
    const ledger = new Ledger()
    // `creative_design_voice` has no `estimate_only` at all, so its next step is the one that always works.
    try {
      await quoteCall({ ledger, caps: () => caps() }, "creative_design_voice", { voice_description: "warm", text: "hi", language: "en" }, call())
      throw new Error("expected a refusal")
    } catch (error) {
      const refusal = error as SpendRefused
      expect(refusal.code).toBe("PRICE_UNKNOWN")
      expect(refusal.message).toContain('does not accept "estimate_only"')
      expect(refusal.nextStep).toContain("both")
      expect(refusal.nextStep).toContain("null")
      expect(refusal.nextStep).not.toContain("estimate_only")
    }
    // An estimable tool with no estimate to hand is told to ask ElevenLabs first.
    try {
      await quoteCall({ ledger, caps: () => caps() }, "creative_generate_video", { prompt: "x" }, call("c2"))
      throw new Error("expected a refusal")
    } catch (error) {
      expect((error as SpendRefused).nextStep).toContain("estimate_only")
    }
    // A remembered price is enough.
    ledger.rememberPrice("creative_edit_image", { prompt: "x" }, { credits: 300, basis: "exact", parts: [] })
    expect((await quoteCall({ ledger, caps: () => caps() }, "creative_edit_image", { prompt: "x" }, call("c3"))).price.credits).toBe(300)
  })

  test("an argument the live schema does not have is refused before any estimate is asked for", async () => {
    const ledger = new Ledger()
    let asked = 0
    const estimate = async (tool: string, input: Record<string, unknown>) => (asked++, estimatePrice(tool, input, { output: { credits: 300 } }))
    const guard = { ledger, caps: () => caps(), estimate }
    await expect(quoteCall(guard, "creative_generate_image", { prompt: "x", seed: 7 }, call())).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    // Nothing was sent: the refusal costs no flow in the workspace.
    expect(asked).toBe(0)
  })

  test("both caps off runs a billed call unpriced, and an estimate call is never charged", async () => {
    const ledger = new Ledger()
    expect((await quoteCall({ ledger, caps: () => caps(null, null) }, "creative_generate_video", { prompt: "x" }, call())).tracked).toBe(false)
    expect(await quoteCall({ ledger, caps: () => caps() }, "creative_generate_image", { prompt: "x", estimate_only: true }, call())).toMatchObject({ price: { credits: 0 }, tracked: false })
    expect(isEstimate("creative_generate_image", { estimate_only: true })).toBe(true)
    // Only the schema's own spelling, on a tool whose schema really has the flag: anything else is a word the server
    // ignores, and reading it as an estimate would let a paid call through unpriced.
    expect(isEstimate("creative_generate_image", { estimateOnly: true })).toBe(false)
    expect(isEstimate("creative_design_voice", { estimate_only: true })).toBe(false)
    expect(isEstimate("creative_generate_image", {})).toBe(false)
  })

  test("a read is never priced, and a transcription is", async () => {
    const ledger = new Ledger()
    expect((await quoteCall({ ledger, caps: () => caps() }, "agents_list", {}, call())).price.credits).toBe(0)
    await expect(quoteCall({ ledger, caps: () => caps() }, "creative_transcribe_audio", { connect_from: "node_example" }, call("t1"))).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    const estimate = estimator(330)
    expect((await quoteCall({ ledger, caps: () => caps(), estimate }, "creative_transcribe_audio", { connect_from: "node_example" }, call("t2"))).price.credits).toBe(330)
  })
})
