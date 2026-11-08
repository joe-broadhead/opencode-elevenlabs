import { describe, expect, test } from "bun:test"
import {
  actualCreditsOf,
  assertAffordable,
  costLine,
  costValue,
  estimatePrice,
  generationsOf,
  isEstimate,
  Ledger,
  priceCall,
  priceOf,
  RATES,
  remaining,
  SpendRefused,
} from "../../src/billing.js"

const caps = (session: number | null = 2000, daily: number | null = 10000) => ({ sessionCreditCap: session, dailyCreditCap: daily })
const spend = (sessionCredits = 0, dailyCredits = 0) => ({ sessionCredits, dailyCredits })

describe("prices from ElevenLabs' published rates", () => {
  test("speech is characters times the two takes, and is a bound rather than an exact figure", () => {
    const price = priceOf("creative_generate_speech", { text: "a".repeat(600) })!
    expect(price).toEqual({ credits: 1200, basis: "at-most", parts: ["600 characters", "2 takes"] })
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

  test("image and video have no formula, so they have no price here: ElevenLabs' estimate is the only one", () => {
    for (const tool of ["creative_generate_image", "creative_generate_video", "creative_edit_image"]) {
      expect(priceOf(tool, { prompt: "a mug", generations_count: 4 })).toBeUndefined()
    }
    expect(priceOf("agents_list", {})).toBeUndefined()
  })

  test("generationsOf reads every name the vendor skills use, and the estimate flag is exact", () => {
    expect(generationsOf({ generations_count: 2 })).toBe(2)
    expect(generationsOf({ variations: 4 })).toBe(4)
    expect(generationsOf({})).toBeUndefined()
    expect(generationsOf({ generations_count: 0 })).toBeUndefined()
    expect(isEstimate({ estimate_only: true })).toBe(true)
    expect(isEstimate({ estimateOnly: true })).toBe(true)
    expect(isEstimate({})).toBe(false)
  })

  test("an estimate's total becomes a per-generation price, so a request can be clamped", () => {
    const price = estimatePrice({ generations_count: 4 }, { output: { credits: 4000 } })!
    expect(price).toMatchObject({ credits: 4000, basis: "exact", perGeneration: 1000 })
    expect(estimatePrice({}, { text: "no price here" })).toBeUndefined()
  })

  test("actual credits come from structured content first, then from JSON text, and never from a guess", () => {
    expect(actualCreditsOf({ output: { credits: 42 } })).toBe(42)
    expect(actualCreditsOf({ output: { usage: { estimated_credits: 7 } } })).toBe(7)
    expect(actualCreditsOf({ text: '{"cost":{"credit_cost":9}}' })).toBe(9)
    expect(actualCreditsOf({ text: "Created a flow." })).toBeUndefined()
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
      expect(refusal.message).toContain("9,500 of 10,000 credits left")
      expect(refusal.nextStep).toContain('sessionCreditCap')
    }
  })

  test("a null cap is unlimited, and the tighter of the two decides", () => {
    expect(remaining(caps(null, null), spend(5000, 5000))).toEqual({ session: Number.POSITIVE_INFINITY, daily: Number.POSITIVE_INFINITY, available: Number.POSITIVE_INFINITY })
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
  test("records amounts and times, prunes past 24 hours, and survives through storage", async () => {
    let now = 1_000_000
    const stored = new Map<string, unknown>()
    const storage = { get: async (key: string) => stored.get(key) as never, set: async (key: string, value: unknown) => void stored.set(key, value), remove: async () => {}, scan: async () => ({ entries: [] }) }
    const ledger = new Ledger({ storage, now: () => now })
    await ledger.hydrate()
    expect(ledger.daily()).toBe(0)
    ledger.record("ses_a", 300)
    ledger.record("ses_a", 200)
    expect(ledger.spend("ses_a")).toEqual({ sessionCredits: 500, dailyCredits: 500 })
    await Promise.resolve()
    const saved = stored.get("spend.ledger") as { at: number; credits: number }[]
    expect(saved.every((entry) => typeof entry.at === "number" && typeof entry.credits === "number")).toBe(true)
    // A day later the record is gone.
    now += 24 * 60 * 60 * 1000 + 1
    expect(ledger.daily()).toBe(0)
    // A fresh instance reads what was stored, for the window it is in.
    const reopened = new Ledger({ storage, now: () => saved[0]!.at + 1000 })
    await reopened.hydrate()
    expect(reopened.daily()).toBe(500)
  })

  test("remembers an estimate against exactly those arguments, and forgets it after ten minutes", () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    const args = { prompt: "a mug", generations_count: 1 }
    ledger.rememberPrice("creative_generate_image", args, { credits: 250, basis: "exact", parts: [] })
    expect(ledger.rememberedPrice("creative_generate_image", args)?.credits).toBe(250)
    // A different prompt is a different price.
    expect(ledger.rememberedPrice("creative_generate_image", { prompt: "a boat" })).toBeUndefined()
    now = 10 * 60 * 1000 + 1
    expect(ledger.rememberedPrice("creative_generate_image", args)).toBeUndefined()
  })

  test("reset forgets the totals, for the tests", () => {
    const ledger = new Ledger()
    ledger.record("s", 10)
    ledger.reset()
    expect(ledger.spend("s")).toEqual({ sessionCredits: 0, dailyCredits: 0 })
  })
})

describe("priceCall", () => {
  const call = { sessionID: "ses_a", agent: "build", messageID: "msg_a" }

  test("uses the table where it can, without asking ElevenLabs", async () => {
    const ledger = new Ledger()
    let asked = 0
    const price = await priceCall({ ledger, caps: () => caps(), estimate: async () => (asked++, undefined) }, "creative_generate_speech", { text: "abc" }, call)
    expect(price.credits).toBe(6)
    expect(asked).toBe(0)
  })

  test("asks ElevenLabs for an image, remembers the price, and clamps the request to the cap", async () => {
    const ledger = new Ledger()
    const estimate = async (_tool: string, input: Record<string, unknown>) => estimatePrice(input, { output: { credits: 4000 } })
    const args: Record<string, unknown> = { prompt: "a mug", generations_count: 4 }
    const price = await priceCall({ ledger, caps: () => caps(2000, 10000), estimate }, "creative_generate_image", args, call)
    // Four cost 4,000; 2,000 buys two, and the request is cut to what it can pay for.
    expect(args.generations_count).toBe(2)
    expect(price.credits).toBe(2000)
    expect(ledger.rememberedPrice("creative_generate_image", args)?.credits).toBe(2000)
  })

  test("refuses rather than guess when there is no price and no estimate", async () => {
    const ledger = new Ledger()
    await expect(priceCall({ ledger, caps: () => caps() }, "creative_generate_image", { prompt: "a mug" }, call)).rejects.toMatchObject({ code: "ESTIMATE_REQUIRED" })
    // A tool with no estimate support either: same refusal, and its next step says so.
    await expect(priceCall({ ledger, caps: () => caps() }, "creative_edit_image", { prompt: "x" }, call)).rejects.toThrow("estimate_only")
  })

  test("an estimate that comes back priceless is a refusal, never a free run", async () => {
    const ledger = new Ledger()
    let asked = 0
    const estimate = async () => (asked++, undefined)
    await expect(priceCall({ ledger, caps: () => caps(), estimate }, "creative_generate_video", { prompt: "x" }, call)).rejects.toMatchObject({ code: "ESTIMATE_REQUIRED" })
    // It did ask ElevenLabs, and took no price from the refusal.
    expect(asked).toBe(1)
    expect(ledger.rememberedPrice("creative_generate_video", { prompt: "x" })).toBeUndefined()
  })

  test("both caps off runs a billed call unpriced, and an estimate call is never charged", async () => {
    const ledger = new Ledger()
    const unpriced = await priceCall({ ledger, caps: () => caps(null, null) }, "creative_generate_video", { prompt: "x" }, call)
    expect(unpriced.credits).toBe(0)
    expect(await priceCall({ ledger, caps: () => caps() }, "creative_generate_image", { prompt: "x", estimate_only: true }, call)).toEqual({ credits: 0, basis: "exact", parts: [] })
  })

  test("a read is never priced", async () => {
    const ledger = new Ledger()
    expect(await priceCall({ ledger, caps: () => caps() }, "agents_list", {}, call)).toEqual({ credits: 0, basis: "exact", parts: [] })
  })
})
