import { describe, expect, test } from "bun:test"
import {
  actualCreditsOf,
  assertAffordable,
  clampGenerations,
  costLine,
  costValue,
  estimatePrice,
  generationsKeyOf,
  generationsOf,
  isEstimate,
  Ledger,
  priceOf,
  quoteCall,
  quoteCallSync,
  RATES,
  remaining,
  SpendRefused,
  transcriptionPrice,
} from "../../src/billing.js"
import { spendShaped } from "../../src/elevenlabs-tools.js"

const caps = (session: number | null = 2000, daily: number | null = 10000) => ({ sessionCreditCap: session, dailyCreditCap: daily })
const spend = (sessionCredits = 0, dailyCredits = 0) => ({ sessionCredits, dailyCredits })
const call = (id = "call_1", sessionID = "ses_a") => ({ sessionID, agent: "build", messageID: "msg_a", id })

describe("prices from ElevenLabs' published rates", () => {
  test("speech is characters times the takes, and is a bound rather than an exact figure", () => {
    expect(priceOf("creative_generate_speech", { text: "a".repeat(600) })).toEqual({ credits: 1200, basis: "at-most", parts: ["600 characters", "2 takes"] })
    expect(RATES.speechPerCharacter).toBe(1)
    expect(priceOf("creative_generate_speech", { text: "hi", takes: 1 })).toMatchObject({ credits: 2, parts: ["2 characters", "1 take"] })
    expect(priceOf("creative_generate_speech", {})).toBeUndefined()
  })

  test("music takes minutes, in seconds or milliseconds, and sound effects take generations", () => {
    expect(priceOf("creative_generate_music", { duration_seconds: 120 })).toMatchObject({ credits: 1800 })
    expect(priceOf("creative_generate_music", { music_length_ms: 60_000 })).toMatchObject({ credits: 900 })
    expect(priceOf("creative_generate_sound_effect", { generations_count: 2 })).toMatchObject({ credits: 400 })
    expect(priceOf("creative_generate_music", {})).toBeUndefined()
  })

  test("speech to text is 330 credits a minute, from a stated duration or a bound from the file size", () => {
    expect(priceOf("creative_transcribe_audio", { duration_seconds: 60 })).toMatchObject({ credits: RATES.sttPerMinute, basis: "at-most" })
    expect(priceOf("creative_transcribe_audio", { duration_ms: 30_000 })).toMatchObject({ credits: 165 })
    const bounded = transcriptionPrice({ size_bytes: 4_000 * 60 })!
    expect(bounded.credits).toBe(RATES.sttPerMinute)
    expect(bounded.parts.join(" ")).toContain("from 240,000 bytes")
    // Nothing states or bounds the length: no price, and the guard refuses rather than guessing.
    expect(priceOf("creative_transcribe_audio", { connect_from: "node_1" })).toBeUndefined()
  })

  test("image and video have no formula: ElevenLabs' estimate is the only price", () => {
    for (const tool of ["creative_generate_image", "creative_generate_video", "creative_edit_image"]) {
      expect(priceOf(tool, { prompt: "a mug", generations_count: 4 })).toBeUndefined()
    }
    expect(priceOf("agents_list", {})).toBeUndefined()
  })

  test("a tool the table does not know is still spend-shaped when its name is, so it cannot run unguarded", () => {
    for (const name of ["creative_generate_dubbing", "creative_compose_music", "creative_sound_effects", "creative_generate_video", "creative_transcribe_audio"]) {
      expect({ name, shaped: spendShaped(name) }).toEqual({ name, shaped: true })
    }
    for (const name of ["creative_get_flow", "creative_list_voices", "agents_list", "agents_update"]) {
      expect({ name, shaped: spendShaped(name) }).toEqual({ name, shaped: false })
    }
  })

  test("generations are read from any alias, and the clamp writes back into the one the caller used", () => {
    expect(generationsKeyOf({ variations: 4 })).toBe("variations")
    expect(generationsOf({ variations: 4 })).toBe(4)
    expect(generationsOf({ generations_count: 0 })).toBeUndefined()
    const aliased: Record<string, unknown> = { prompt: "a mug", variations: 4 }
    expect(clampGenerations(aliased, 1)).toBe("variations")
    expect(aliased).toEqual({ prompt: "a mug", variations: 1 })
    const unnamed: Record<string, unknown> = { prompt: "a mug" }
    expect(clampGenerations(unnamed, 2)).toBe("generations_count")
    expect(unnamed).toEqual({ prompt: "a mug", generations_count: 2 })
  })

  test("an estimate's total becomes a per-generation price, and is a bound once it is divided", () => {
    const one = estimatePrice({ generations_count: 1 }, { output: { credits: 500 } })!
    expect(one).toMatchObject({ credits: 500, basis: "exact", perGeneration: 500 })
    const four = estimatePrice({ generations_count: 4 }, { output: { credits: 4000 } })!
    expect(four).toMatchObject({ credits: 4000, basis: "at-most", perGeneration: 1000 })
    expect(four.parts.join(" ")).toContain("estimated by ElevenLabs")
    expect(estimatePrice({}, { text: "no price here" })).toBeUndefined()
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
    return {
      stored,
      get: async (key: string) => stored.get(key) as never,
      set: async (key: string, value: unknown) => void stored.set(key, value),
      remove: async () => {},
      scan: async () => ({ entries: [] as never[] }),
    }
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
    const saved = store.stored.get("spend.ledger") as { at: number; credits: number; sessionID: string }[]
    expect(saved.every((entry) => typeof entry.sessionID === "string")).toBe(true)

    // A reload in the same window keeps both totals, the session's included (DR-9).
    const reopened = new Ledger({ storage: store, now: () => 1_000_500 })
    await reopened.hydrate()
    expect(reopened.spend("ses_a")).toEqual({ sessionCredits: 500, dailyCredits: 550 })

    // A day later the record is gone.
    now += 24 * 60 * 60 * 1000 + 1
    expect(ledger.daily()).toBe(0)
  })

  test("serialises its writes, so two charges at once cannot lose one", async () => {
    const written: unknown[] = []
    const slow = {
      get: async () => undefined,
      set: async (_key: string, value: unknown) => {
        await Bun.sleep(5)
        written.push(value)
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
    const final = written.at(-1) as { credits: number }[]
    expect(final.reduce((sum, entry) => sum + entry.credits, 0)).toBe(60)
    expect(ledger.daily()).toBe(60)
  })

  test("a reservation counts against the budget until it settles or is released", () => {
    const ledger = new Ledger()
    ledger.reserve("c1", "ses_a", 1200, caps())
    expect(ledger.spend("ses_a")).toEqual({ sessionCredits: 1200, dailyCredits: 1200 })
    // The second call cannot also fit.
    expect(() => ledger.reserve("c2", "ses_a", 1200, caps())).toThrow(SpendRefused)
    // Settling at the actual figure replaces the hold.
    expect(ledger.settle("c1", "ses_a", 1000)).toEqual({ sessionCredits: 1000, dailyCredits: 1000 })
    // A released hold frees the budget again.
    ledger.reserve("c3", "ses_a", 1000, caps())
    ledger.release("c3")
    expect(ledger.spend("ses_a")).toEqual({ sessionCredits: 1000, dailyCredits: 1000 })
  })

  test("a reservation nothing settles expires, so a dead call cannot hold a budget for ever", () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    ledger.reserve("c1", "ses_a", 900, caps())
    now += 11 * 60 * 1000
    expect(ledger.spend("ses_a")).toEqual({ sessionCredits: 0, dailyCredits: 0 })
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
  test("prices from the table, reserves, and refuses the second of two parallel calls", async () => {
    const ledger = new Ledger()
    const guard = { ledger, caps: () => caps(2000, 10000) }
    // DR-1: two calls that start together, 1,200 each against 2,000. Exactly one may pass.
    const results = await Promise.allSettled([
      quoteCall(guard, "creative_generate_speech", { text: "x".repeat(600) }, call("c1")),
      quoteCall(guard, "creative_generate_speech", { text: "x".repeat(600) }, call("c2")),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult
    expect((refused.reason as SpendRefused).code).toBe("SPEND_CAP_REACHED")
    expect(ledger.spend("ses_a")).toEqual({ sessionCredits: 1200, dailyCredits: 1200 })
  })

  test("the synchronous form reserves the same way, for the script path", () => {
    const ledger = new Ledger()
    const guard = { ledger, caps: () => caps(2000, 10000) }
    expect(quoteCallSync(guard, "creative_generate_speech", { text: "x".repeat(600) }, call("c1")).price.credits).toBe(1200)
    expect(() => quoteCallSync(guard, "creative_generate_speech", { text: "x".repeat(600) }, call("c2"))).toThrow(SpendRefused)
  })

  test("clamps a request to what the budget affords, in the key the caller used", async () => {
    const ledger = new Ledger()
    const estimate = async (_tool: string, input: Record<string, unknown>) => estimatePrice(input, { output: { credits: 4000 } })
    const aliased: Record<string, unknown> = { prompt: "a mug", variations: 4 }
    const { price } = await quoteCall({ ledger, caps: () => caps(2000, 10000), estimate }, "creative_generate_image", aliased, call())
    expect(aliased).toEqual({ prompt: "a mug", variations: 2 })
    expect(price.credits).toBe(2000)
    expect(price.basis).toBe("at-most")
  })

  test("asks ElevenLabs once for an image, and never retries a failed estimate", async () => {
    const ledger = new Ledger()
    let asked = 0
    const failing = async () => (asked++, undefined)
    await expect(quoteCall({ ledger, caps: () => caps(), estimate: failing }, "creative_generate_image", { prompt: "x" }, call())).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    expect(asked).toBe(1)
    const succeeding = async () => (asked++, { credits: 500, basis: "exact" as const, parts: [] })
    await quoteCall({ ledger, caps: () => caps(), estimate: succeeding }, "creative_generate_video", { prompt: "y" }, call("c2"))
    expect(asked).toBe(2)
  })

  test("a tool it cannot price is refused with a next step that works, and never guesses", async () => {
    const ledger = new Ledger()
    // `creative_edit_image` is not attested as accepting estimate_only, so its next step is the one that always works.
    try {
      await quoteCall({ ledger, caps: () => caps() }, "creative_edit_image", { prompt: "x" }, call())
    } catch (error) {
      const refusal = error as SpendRefused
      expect(refusal.code).toBe("PRICE_UNKNOWN")
      expect(refusal.nextStep).toContain("both")
      expect(refusal.nextStep).toContain("null")
    }
    // An estimable tool is told to ask ElevenLabs first.
    try {
      await quoteCall({ ledger, caps: () => caps() }, "creative_generate_video", { prompt: "x" }, call())
    } catch (error) {
      expect((error as SpendRefused).nextStep).toContain("estimate_only")
    }
    // A remembered price is enough.
    ledger.rememberPrice("creative_edit_image", { prompt: "x" }, { credits: 300, basis: "exact", parts: [] })
    expect((await quoteCall({ ledger, caps: () => caps() }, "creative_edit_image", { prompt: "x" }, call())).price.credits).toBe(300)
  })

  test("both caps off runs a billed call unpriced, and an estimate call is never charged", async () => {
    const ledger = new Ledger()
    expect((await quoteCall({ ledger, caps: () => caps(null, null) }, "creative_generate_video", { prompt: "x" }, call())).tracked).toBe(false)
    expect(await quoteCall({ ledger, caps: () => caps() }, "creative_generate_image", { prompt: "x", estimate_only: true }, call())).toMatchObject({ price: { credits: 0 }, tracked: false })
    expect(isEstimate({ estimate_only: true })).toBe(true)
    expect(isEstimate({ estimateOnly: true })).toBe(true)
    expect(isEstimate({})).toBe(false)
  })

  test("a read is never priced, and a billed read is", async () => {
    const ledger = new Ledger()
    expect((await quoteCall({ ledger, caps: () => caps() }, "agents_list", {}, call())).price.credits).toBe(0)
    const quoted = await quoteCall({ ledger, caps: () => caps() }, "creative_transcribe_audio", { duration_seconds: 60 }, call("t1"))
    expect(quoted.price.credits).toBe(RATES.sttPerMinute)
    expect(quoted.tracked).toBe(true)
  })
})
