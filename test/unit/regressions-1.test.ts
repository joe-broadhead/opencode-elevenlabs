// Reproductions from the re-review. Each one failed on f864cf8 and must pass after the fix.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Ledger, quoteCall, quoteCallSync, SpendRefused, actualCreditsOf } from "../../src/billing.js"
import { creativeGuardSentence } from "../../src/elevenlabs-tools.js"
import { shapersFor } from "../../src/host/tools-rpc.js"
import { defaultRules, evaluate } from "../../src/permissions.js"
import type { Rule } from "../../src/permissions.js"
import { storageOver } from "../fixtures/store.js"

const repo = fileURLToPath(new URL("../..", import.meta.url))

const root = mkdtempSync(join(tmpdir(), "elevenlabs-rereview-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const caps = (session: number | null = 2000, daily: number | null = 10000) => ({ sessionCreditCap: session, dailyCreditCap: daily })
const call = (id = "c1", sessionID = "ses_a") => ({ sessionID, agent: "build", messageID: "m1", id })
const shape = (sessionID = "ses_a", action = "elevenlabs_creative_generate_speech") => ({ sessionID, agent: "build", action })
const allow = (action: string): Rule => ({ action, resource: "*", effect: "allow" })

const storage = () => {
  const stored = new Map<string, unknown>()
  return { stored, ...storageOver(stored) }
}

/** A speech call in the live schema's own argument names. The spoken words go in `prompt`, as every creative tool's do. */
const speechArgs = (prompt = "x".repeat(750)) => ({ prompt, voice_id: "voice_example", model_id: "model_example", context: "a test" })

/** What a restart reads: the whole store as it stands on disk, which the append-only ledger spreads over many keys. */
const coldCopy = (store: { stored: Map<string, unknown> }) => {
  const cold = storage()
  for (const [key, value] of store.stored) cold.stored.set(key, structuredClone(value))
  return cold
}

describe("a caller-typed number cannot set a price at all", () => {
  // The original reproductions were about a formula reading a number out of the arguments. Since live reconcile 1
  // there is no formula: ElevenLabs' own estimate is the only price, so a number the caller typed cannot set one —
  // high or low — and an argument the live schema does not have refuses the call outright.
  test("a duration, a byte count or a path prices nothing, and none of them is sent", async () => {
    for (const args of [{ duration_seconds: 0 }, { duration_seconds: 1, size_bytes: 50_000_000 }, { path: join(root, "clip.wav") }]) {
      const ledger = new Ledger()
      await expect(quoteCall({ ledger, caps: () => caps(100_000, 100_000) }, "creative_transcribe_audio", args, call("t"))).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
      expect(ledger.daily()).toBe(0)
      expect(() => shapersFor({ ledger: new Ledger(), caps: () => caps() }).input("creative_transcribe_audio", args, shape("ses_z", "elevenlabs_creative_transcribe_audio"))).toThrow("PRICE_UNKNOWN")
    }
  })

  test("a file on disk is never measured to price a call, whatever it holds", async () => {
    // A real minute of audio used to set the transcription price. Nothing reads it now: the only figure is the
    // server's, which prices what the flow will transcribe rather than what sits in this process's filesystem.
    const minute = join(root, "minute.wav")
    writeFileSync(minute, wavHeader(60))
    const ledger = new Ledger()
    await expect(quoteCall({ ledger, caps: () => caps(10_000, 10_000) }, "creative_transcribe_audio", { path: minute }, call("wav"))).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    expect(ledger.daily()).toBe(0)
  })

  test("a generation count that is not a number stops the call, since it multiplies whatever one costs", async () => {
    const ledger = new Ledger()
    const estimate = async () => ({ credits: 300, basis: "exact" as const, parts: [] })
    await expect(quoteCall({ ledger, caps: () => caps(), estimate }, "creative_generate_image", { prompt: "x", generations_count: "lots" }, call("n"))).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    expect(ledger.daily()).toBe(0)
  })
})

/** A RIFF/WAVE file holding `seconds` of audio, to show that having one changes no price. */
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
    // A price the ledger already holds for exactly these arguments is the one thing that lets such a name through,
    // and it is ElevenLabs' own figure rather than anything this plugin worked out.
    const ledger = new Ledger()
    ledger.rememberPrice("creative_upscale", { prompt: "x" }, { credits: 900, basis: "exact", parts: [] })
    const quoted = quoteCallSync({ ledger, caps: () => caps() }, "creative_upscale", { prompt: "x" }, call("upscale"))
    expect(quoted).toMatchObject({ tracked: true, price: { credits: 900 } })
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
    const args = speechArgs()
    ledger.rememberPrice("creative_generate_speech", args, { credits: 1500, basis: "exact", parts: [] })
    const shapers = shapersFor({ ledger, caps: () => caps(2000, 10_000) })
    const speech = shape()
    shapers.input("creative_generate_speech", { ...args }, speech)
    now += 10 * 60 * 1000 + 1
    // The remembered price has gone stale with the hold, so the second call cannot be priced either way: what must
    // hold is that the first call's credits are still counted, and a second 1,500 does not fit under 2,000.
    expect(() => shapers.input("creative_generate_speech", { ...args }, speech)).toThrow(SpendRefused)
    expect(ledger.spend("ses_a")).toEqual({ sessionCredits: 1500, dailyCredits: 1500 })
  })
})

describe("an estimate must not settle a paid hold", () => {
  test("the second shapeInput is refused, and an estimate figure cannot replace the paid charge", () => {
    const ledger = new Ledger()
    const args = speechArgs()
    ledger.rememberPrice("creative_generate_speech", args, { credits: 3000, basis: "exact", parts: [] })
    const shapers = shapersFor({ ledger, caps: () => caps(10_000, 10_000) })
    const speech = shape("ses_script")
    shapers.input("creative_generate_speech", { ...args }, speech)
    expect(ledger.spend("ses_script").sessionCredits).toBe(3000)
    // The estimate probe is free and unpriced, but it cannot reuse this call's id: one call, one hold.
    expect(() => shapers.input("creative_generate_speech", { ...args, estimate_only: true }, speech)).toThrow()
    shapers.result("creative_generate_speech", { output: { credits: 3000 }, text: "" }, speech)
    shapers.result("creative_generate_speech", { output: { credits: 10 }, text: "" }, speech)
    expect(ledger.spend("ses_script").sessionCredits).toBe(3000)
  })
})

describe("one daily cap in the store", () => {
  test("two ledgers on one storage share the cap, and a restart keeps the charge", async () => {
    const store = storage()
    const args = speechArgs("x".repeat(600))
    const first = new Ledger({ storage: store })
    const second = new Ledger({ storage: store })
    for (const ledger of [first, second]) ledger.rememberPrice("creative_generate_speech", args, { credits: 1200, basis: "exact", parts: [] })
    await first.hydrate()
    await second.hydrate()
    quoteCallSync({ ledger: first, caps: () => caps(2000, 2000) }, "creative_generate_speech", { ...args }, call("a", "ses_a"))
    expect(() => quoteCallSync({ ledger: second, caps: () => caps(2000, 2000) }, "creative_generate_speech", { ...args }, call("b", "ses_b"))).toThrow(SpendRefused)
    first.settle("a", "ses_a", 1200)
    await first.flush()
    const restarted = new Ledger({ storage: coldCopy(store) })
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
    const restarted = new Ledger({ storage: coldCopy(store) })
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
