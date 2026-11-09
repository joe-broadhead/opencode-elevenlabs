// Reproductions from the re-review. Each one failed on f864cf8 and must pass after the fix.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Ledger, priceOf, quoteCall, quoteCallSync, SpendRefused, actualCreditsOf, RATES } from "../../src/billing.js"
import { creativeGuardSentence } from "../../src/elevenlabs-tools.js"
import { shapersFor } from "../../src/host/tools-rpc.js"
import { defaultRules, evaluate } from "../../src/permissions.js"
import type { Rule } from "../../src/permissions.js"

const repo = fileURLToPath(new URL("../..", import.meta.url))

const root = mkdtempSync(join(tmpdir(), "elevenlabs-rereview-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const caps = (session: number | null = 2000, daily: number | null = 10000) => ({ sessionCreditCap: session, dailyCreditCap: daily })
const call = (id = "c1", sessionID = "ses_a") => ({ sessionID, agent: "build", messageID: "m1", id })
const shape = (sessionID = "ses_a", action = "elevenlabs_creative_generate_speech") => ({ sessionID, agent: "build", action })
const allow = (action: string): Rule => ({ action, resource: "*", effect: "allow" })

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

describe("a caller-typed number cannot set a low price", () => {
  test("duration_seconds 0 is not sent, and duration 1 plus 50 MB is not priced as 1 second", async () => {
    const zero = new Ledger()
    await expect(quoteCall({ ledger: zero, caps: () => caps() }, "creative_transcribe_audio", { duration_seconds: 0 }, call("z"))).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    expect(zero.daily()).toBe(0)
    expect(() => shapersFor({ ledger: new Ledger(), caps: () => caps() }).input("creative_transcribe_audio", { duration_seconds: 0 }, shape("ses_z", "elevenlabs_creative_transcribe_audio"))).toThrow("PRICE_UNKNOWN")

    const args = { duration_seconds: 1, size_bytes: 50_000_000 }
    expect(priceOf("creative_transcribe_audio", args)?.credits).not.toBe(6)
    const large = new Ledger()
    await expect(quoteCall({ ledger: large, caps: () => caps(100_000, 100_000) }, "creative_transcribe_audio", args, call("big"))).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    expect(large.daily()).toBe(0)
  })

  test("music at duration 0 is refused, and speech takes 1 does not undercut the two-take price", async () => {
    const music = new Ledger()
    expect(priceOf("creative_generate_music", { duration_seconds: 0 })).toBeUndefined()
    await expect(quoteCall({ ledger: music, caps: () => caps() }, "creative_generate_music", { duration_seconds: 0 }, call("m"))).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    expect(music.daily()).toBe(0)

    expect(priceOf("creative_generate_speech", { text: "x".repeat(600), takes: 1 })?.credits).toBe(1200)
    const speech = quoteCallSync({ ledger: new Ledger(), caps: () => caps() }, "creative_generate_speech", { text: "x".repeat(600), takes: 1 }, call("s"))
    expect(speech.price.credits).toBe(1200)
    expect(speech.price.credits).toBe(600 * RATES.speechTakes)
  })

  test("a measured file sets the price, a stated duration can only raise it, and an unreadable container is refused", async () => {
    const minute = join(root, "minute.wav")
    writeFileSync(minute, wavHeader(60))
    expect(priceOf("creative_transcribe_audio", { path: minute, duration_seconds: 1 })?.credits).toBe(RATES.sttPerMinute)
    expect(priceOf("creative_transcribe_audio", { path: minute, duration_seconds: 120 })?.credits).toBe(RATES.sttPerMinute * 2)
    const ledger = new Ledger()
    const quoted = quoteCallSync({ ledger, caps: () => caps(10_000, 10_000) }, "creative_transcribe_audio", { path: minute, duration_seconds: 1 }, call("wav"))
    expect(quoted.price.credits).toBe(RATES.sttPerMinute)
    expect(quoted.tracked).toBe(true)

    const ogg = join(root, "clip.ogg")
    writeFileSync(ogg, Buffer.from("OggS"))
    expect(priceOf("creative_transcribe_audio", { path: ogg, duration_seconds: 1, size_bytes: 7_200_000 })).toBeUndefined()
    await expect(quoteCall({ ledger: new Ledger(), caps: () => caps() }, "creative_transcribe_audio", { path: ogg, duration_seconds: 1, size_bytes: 7_200_000 }, call("ogg"))).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
  })
})

/**
 * A RIFF/WAVE file holding `seconds` of audio. The body is required: since RR2-1 the price comes from the bytes that
 * follow the `data` chunk, so a bare 44-byte header states a duration it does not have and is not measured.
 */
function wavHeader(seconds: number, byteRate = 16_000) {
  const dataBytes = byteRate * seconds
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(byteRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(1, 32)
  header.writeUInt16LE(8, 34)
  header.write("data", 36)
  header.writeUInt32LE(dataBytes, 40)
  return Buffer.concat([header, Buffer.alloc(dataBytes, 7)])
}

describe("a creative_ name the table does not price is refused on both paths", () => {
  const names = ["creative_upscale", "creative_remix", "creative_voice_clone", "creative_isolate", "creative_enhance", "creative_extend"]

  test("each is PRICE_UNKNOWN before dispatch, and tracked is never false", async () => {
    for (const name of names) {
      const ledger = new Ledger()
      const outcome = await quoteCall({ ledger, caps: () => caps() }, name, { prompt: "x" }, call(name)).then(
        (quote) => quote,
        (error: unknown) => error,
      )
      expect(outcome).toMatchObject({ code: "PRICE_UNKNOWN" })
      expect((outcome as { tracked?: boolean }).tracked).not.toBe(false)
      expect(ledger.daily()).toBe(0)
      const shapers = shapersFor({ ledger: new Ledger(), caps: () => caps() })
      expect(() => shapers.input(name, { prompt: "x" }, shape("ses_a", `elevenlabs_${name}`))).toThrow("PRICE_UNKNOWN")
    }
    const music = quoteCallSync({ ledger: new Ledger(), caps: () => caps() }, "creative_compose_music", { duration_seconds: 60 }, call("compose"))
    expect(music.tracked).toBe(true)
    expect(music.price.credits).toBe(900)
    const effects = quoteCallSync({ ledger: new Ledger(), caps: () => caps() }, "creative_sound_effects", {}, call("sfx"))
    expect(effects.tracked).toBe(true)
    expect(effects.price.credits).toBe(200)
    expect(readFileSync(join(repo, "README.md"), "utf8")).toContain(creativeGuardSentence())
  })
})

describe("a hold lasts for the call, and a failure does not forget a charge", () => {
  test("an expired hold is settled, so a second reserve cannot spend the same budget", () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    ledger.reserve("c1", "ses_a", 1500, caps(2000, 10_000))
    now += 10 * 60 * 1000 + 1
    expect(() => ledger.reserve("c2", "ses_a", 1500, caps(2000, 10_000))).toThrow(SpendRefused)
    expect(ledger.spend("ses_a")).toEqual({ sessionCredits: 1500, dailyCredits: 1500 })
  })

  test("release on an error does not let a retry of 1,500 pass", () => {
    const ledger = new Ledger()
    ledger.reserve("c1", "ses_a", 1500, caps(2000, 10_000))
    ledger.release("c1")
    expect(() => ledger.reserve("c2", "ses_a", 1500, caps(2000, 10_000))).toThrow(SpendRefused)
    expect(ledger.daily()).toBe(1500)
  })

  test("an RPC shapeInput whose call never returns is still charged after 10 minutes", () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    const shapers = shapersFor({ ledger, caps: () => caps(2000, 10_000) })
    const speech = shape()
    shapers.input("creative_generate_speech", { text: "x".repeat(750) }, speech)
    now += 10 * 60 * 1000 + 1
    expect(() => shapers.input("creative_generate_speech", { text: "x".repeat(750) }, speech)).toThrow(SpendRefused)
    expect(ledger.spend("ses_a")).toEqual({ sessionCredits: 1500, dailyCredits: 1500 })
  })
})

describe("an estimate must not settle a paid hold", () => {
  test("the second shapeInput is refused, and an estimate figure cannot replace the paid charge", () => {
    const ledger = new Ledger()
    const shapers = shapersFor({ ledger, caps: () => caps(10_000, 10_000) })
    const speech = shape("ses_script")
    shapers.input("creative_generate_speech", { text: "x".repeat(1500) }, speech)
    expect(ledger.spend("ses_script").sessionCredits).toBe(3000)
    expect(() => shapers.input("creative_generate_speech", { text: "hi", estimate_only: true }, speech)).toThrow()
    shapers.result("creative_generate_speech", { output: { credits: 3000 }, text: "" }, speech)
    shapers.result("creative_generate_speech", { output: { credits: 10 }, text: "" }, speech)
    expect(ledger.spend("ses_script").sessionCredits).toBe(3000)
  })
})

describe("one daily cap in the store", () => {
  test("two ledgers on one storage share the cap, and a restart keeps the charge", async () => {
    const store = storage()
    const first = new Ledger({ storage: store })
    const second = new Ledger({ storage: store })
    await first.hydrate()
    await second.hydrate()
    quoteCallSync({ ledger: first, caps: () => caps(2000, 2000) }, "creative_generate_speech", { text: "x".repeat(600) }, call("a", "ses_a"))
    expect(() => quoteCallSync({ ledger: second, caps: () => caps(2000, 2000) }, "creative_generate_speech", { text: "x".repeat(600) }, call("b", "ses_b"))).toThrow(SpendRefused)
    first.settle("a", "ses_a", 1200)
    await first.flush()
    const saved = structuredClone(store.stored.get("spend.ledger"))
    const cold = storage()
    cold.stored.set("spend.ledger", saved)
    const restarted = new Ledger({ storage: cold })
    await restarted.hydrate()
    expect(restarted.daily()).toBe(1200)
    expect(restarted.session("ses_a")).toBe(1200)
    expect(restarted.session("ses_b")).toBe(0)
  })

  test("two charges from two ledgers both survive in the store", async () => {
    const store = storage()
    const first = new Ledger({ storage: store })
    const second = new Ledger({ storage: store })
    await first.hydrate()
    await second.hydrate()
    first.record("ses_a", 100)
    second.record("ses_b", 250)
    await first.flush()
    await second.flush()
    const cold = storage()
    cold.stored.set("spend.ledger", structuredClone(store.stored.get("spend.ledger")))
    const restarted = new Ledger({ storage: cold })
    await restarted.hydrate()
    expect(restarted.daily()).toBe(350)
    expect(restarted.session("ses_a")).toBe(100)
    expect(restarted.session("ses_b")).toBe(250)
  })
})

describe("pruning must not drop an in-window charge", () => {
  test("a thousand later records do not erase an earlier charge", () => {
    const ledger = new Ledger()
    ledger.record("ses_a", 9000)
    for (let index = 0; index < 1000; index++) ledger.record("ses_a", 1)
    expect(ledger.daily()).toBe(10_000)
    expect(() => ledger.reserve("more", "ses_a", 9000, caps(100_000, 10_000))).toThrow(SpendRefused)
  })
})

describe("a result cannot settle below the reservation", () => {
  test("a prose first match and a nested zero keep the reservation, and a higher figure may replace it", () => {
    const prose = new Ledger()
    prose.reserve("c1", "ses_a", 4800, caps(10_000, 10_000))
    prose.settle("c1", "ses_a", actualCreditsOf({ text: "This preview used 1 credit. Charged 4800 credits." }) ?? 0)
    expect(prose.daily()).toBe(4800)

    const nested = new Ledger()
    nested.reserve("c1", "ses_a", 1500, caps(10_000, 10_000))
    nested.settle("c1", "ses_a", actualCreditsOf({ output: { usage: { credit: 0 } } }) ?? 0)
    expect(nested.daily()).toBe(1500)
    expect(() => nested.reserve("c2", "ses_a", 1500, caps(2000, 10_000))).toThrow(SpendRefused)

    const higher = new Ledger()
    higher.reserve("c1", "ses_a", 1500, caps(10_000, 10_000))
    higher.settle("c1", "ses_a", 2000)
    expect(higher.daily()).toBe(2000)
  })
})

describe("conversation denies ignore case and do not catch a priced tool", () => {
  test("a mixed-case conversation name is denied, and a generation is not", () => {
    const rules = [allow("*"), ...defaultRules("all", "off")]
    expect(evaluate(rules, "elevenlabs_Agents_Get_Conversation")).toBe("deny")
    expect(evaluate(rules, "elevenlabs_agents_get_call")).toBe("deny")
    expect(evaluate(rules, "elevenlabs_agents_list_calls")).toBe("deny")
    expect(evaluate(rules, "elevenlabs_agents_export_history")).toBe("deny")
    for (const tool of ["creative_generate_speech", "creative_transcribe_audio", "creative_list_voices", "creative_compose_music", "agents_get", "agents_get_link"]) {
      expect({ tool, effect: evaluate(rules, `elevenlabs_${tool}`) }).toEqual({ tool, effect: "allow" })
    }
  })
})
