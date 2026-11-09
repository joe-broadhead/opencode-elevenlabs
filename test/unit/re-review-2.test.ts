// Reproductions from the second re-review. Each one failed at d107a11 and must pass after the fix.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Ledger,
  LEDGER_KEY,
  MUSIC_MIN_MS,
  measureAudio,
  priceOf,
  quoteCall,
  quoteCallSync,
  RATES,
  RESERVATION_MS,
  settlementOf,
  SpendRefused,
  transcriptionPrice,
} from "../../src/billing.js"
import { REGIONS } from "../../src/constants.js"
import { mustPrice } from "../../src/elevenlabs-tools.js"
import { shapersFor } from "../../src/host/tools-rpc.js"
import { otherElevenlabsServers, toolOf } from "../../src/plugin.js"
import { buildStatus, formatStatus } from "../../src/status.js"
import { brokenRiff, buildWav, WAV_FIXTURES } from "../fixtures/wav.js"

const root = mkdtempSync(join(tmpdir(), "elevenlabs-rr2-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Writes a fixture to its own file and returns the path. */
const wav = (name: string, bytes: Buffer) => {
  const path = join(root, `${name}.wav`)
  writeFileSync(path, bytes)
  return path
}

const paths = Object.fromEntries(Object.entries(WAV_FIXTURES).map(([name, build]) => [name, wav(name, build())])) as Record<
  keyof typeof WAV_FIXTURES,
  string
>

describe("RR2-1 — the file sets the price, not one header field", () => {
  test("a 60-second file prices at 330 whatever its chunk layout", () => {
    // Every one of these is an ordinary file: a JUNK pad before `fmt `, a `fmt ` of 18 or 40 bytes, and a `data`
    // size field that understates or overstates the audio behind it.
    for (const name of ["canonical", "junkNumbers", "junkZeros", "fmt18", "fmt40", "overstated"] as const) {
      const price = transcriptionPrice({ path: paths[name] })
      expect({ name, credits: price?.credits }).toEqual({ name, credits: 330 })
    }
  })

  test("the audio is the `data` chunk's own bytes, clamped to the bytes that really follow", () => {
    // Since RR3-1 the price is what a decoder reads: the `data` chunk states how many bytes of audio it holds, and
    // bytes past that are a chunk the walk never reached, not audio. `understated` therefore prices the eighth of a
    // second its header declares, where this test used to assert the full minute written behind it.
    expect(measureAudio({ path: paths.understated })?.durationSeconds).toBe(0.125)
    expect(transcriptionPrice({ path: paths.understated })?.credits).toBe(1)
    // A pad before `fmt ` is still just a pad: the audio behind a truthful header is measured in full.
    expect(measureAudio({ path: paths.junkNumbers })?.durationSeconds).toBe(60)
  })

  test("a stated data size cannot raise the price above it either", () => {
    // Ten claimed minutes over one real one: the header is clamped to the bytes that follow it, so no 3,300-credit
    // refusal, and a `fmt ` of 18 bytes is not read as 174,066 seconds.
    expect(measureAudio({ path: paths.overstated })?.durationSeconds).toBe(60)
    expect(measureAudio({ path: paths.fmt18 })?.durationSeconds).toBe(60)
  })

  test("a truncated file is priced at the audio it still holds, not at the length its header claims", () => {
    expect(measureAudio({ path: paths.truncated })?.durationSeconds).toBe(30)
    expect(transcriptionPrice({ path: paths.truncated })?.credits).toBe(165)
  })

  test("a file the parser cannot walk is not measured, so it is not priced", () => {
    const broken = wav("broken", brokenRiff())
    expect(measureAudio({ path: broken })).toBeUndefined()
    expect(transcriptionPrice({ path: broken })).toBeUndefined()
    expect(priceOf("creative_transcribe_audio", { path: broken })).toBeUndefined()
  })
})

describe("RR2-2 — every argument that names a local file is measured", () => {
  const short = wav("one-second", buildWav({ seconds: 1 }))
  const long = paths.canonical

  test("the longest file sets the price, whichever key holds it and in whichever order", () => {
    // d107a11 measured the first name in its own fixed list and priced 6 credits for a call carrying a full minute.
    const pairs: Record<string, unknown>[] = [
      { path: short, file: long },
      { file: long, path: short },
      { audio_file: long, path: short },
      { path: short, audio_file: long },
      { input_file: long, file_path: short },
      { file_path: short, input_file: long },
    ]
    for (const input of pairs) {
      expect({ keys: Object.keys(input).join("+"), credits: transcriptionPrice(input)?.credits }).toEqual({
        keys: Object.keys(input).join("+"),
        credits: 330,
      })
    }
  })

  test("a named file that cannot be measured makes the whole call PRICE_UNKNOWN", () => {
    // The server may read the argument the plugin ignored, so a price that covers only one of two files is no price.
    expect(measureAudio({ path: long, file: join(root, "absent.wav") })).toBeUndefined()
    expect(transcriptionPrice({ file: join(root, "absent.wav"), path: long })).toBeUndefined()
    expect(measureAudio({ path: long, audio_file: wav("broken-second", brokenRiff()) })).toBeUndefined()
  })

  test("a URL is audio this plugin cannot measure, so it refuses the call", () => {
    // Since RR3-2 a URL is not passed over: the server fetches it and the bill covers it, so a price that counts only
    // the local file is no price at all. This test used to assert the 330 credits of the local file alone.
    expect(transcriptionPrice({ path: long, audio_file: "https://example.test/clip.wav" })).toBeUndefined()
    expect(transcriptionPrice({ audio_file: "https://example.test/clip.wav" })).toBeUndefined()
  })
})

describe("RR2-3 — music is priced at the longest length it states, and never below the minimum", () => {
  test("two stated lengths price the longer, in either key order", () => {
    // d107a11 read `music_length_ms` first and let it win unconditionally: 30 ms beat 300 s and cost 1 credit.
    for (const input of [
      { music_length_ms: 30, duration_seconds: 300 },
      { duration_seconds: 300, music_length_ms: 30 },
      { music_length_ms: 300_000, duration: 10 },
      { duration: 10, duration_seconds: 300, music_length_ms: 30 },
    ]) {
      expect({ keys: Object.keys(input).join("+"), credits: priceOf("creative_generate_music", input)?.credits }).toEqual({
        keys: Object.keys(input).join("+"),
        credits: 4_500,
      })
    }
  })

  test("a request under three seconds is priced at three seconds, not at a fraction of one", () => {
    // 3,000 ms is the least `music_length_ms` the published Music reference accepts, so it is the least a call
    // can generate: 45 credits at 900 a minute.
    const floor = Math.ceil((MUSIC_MIN_MS / 60_000) * RATES.musicPerMinute)
    expect(floor).toBe(45)
    for (const input of [{ music_length_ms: 1 }, { music_length_ms: 2_999 }, { duration_seconds: 0.4 }, { duration: 1 }]) {
      expect({ asked: Object.values(input)[0], credits: priceOf("creative_generate_music", input)?.credits }).toEqual({
        asked: Object.values(input)[0],
        credits: floor,
      })
    }
    expect(priceOf("creative_generate_music", { music_length_ms: 3_000 })?.credits).toBe(floor)
    // The floor is a floor and not a cap: a longer call is still priced at its own length.
    expect(priceOf("creative_generate_music", { music_length_ms: 60_000 })?.credits).toBe(RATES.musicPerMinute)
  })

  test("a length stated as zero, or not stated at all, is still PRICE_UNKNOWN", () => {
    // Zero leaves the length to the server's own default, which this plugin cannot know and must not price.
    for (const input of [{}, { duration_seconds: 0 }, { music_length_ms: 0 }, { prompt: "a waltz" }]) {
      expect(priceOf("creative_generate_music", input)).toBeUndefined()
    }
    // A numeric string is not "no length": since RR3-9 it is read as the number it spells, which is 450 credits here.
    expect(priceOf("creative_generate_music", { music_length_ms: "30000" })?.credits).toBe(450)
    // But a zero beside a real length does not drag the price down to nothing.
    expect(priceOf("creative_compose_music", { music_length_ms: 0, duration_seconds: 300 })?.credits).toBe(4_500)
  })
})

describe("RR2-4 — a late result cannot settle the call that replaced it", () => {
  const caps = () => ({ sessionCreditCap: 100_000, dailyCreditCap: 100_000 })
  const shape = (sessionID = "ses_a", action = "elevenlabs_creative_generate_speech") => ({ sessionID, agent: "build", action })
  /** A speech call of `credits` credits: one character is one credit, and the bound is two takes. */
  const speech = (credits: number) => ({ text: "x".repeat(credits / RATES.speechTakes) })

  /** A reserves `a` credits and never returns; ten minutes on, it is charged and B reserves `b`. */
  const abandonedThenNext = (a: number, b: number) => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    const shapers = shapersFor({ ledger, caps })
    const call = shape()
    shapers.input("creative_generate_speech", speech(a), call)
    now += RESERVATION_MS + 1
    expect(ledger.daily()).toBe(a)
    shapers.input("creative_generate_speech", speech(b), call)
    expect(ledger.daily()).toBe(a + b)
    return { ledger, shapers, call, advance: (ms: number) => void (now += ms) }
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
    // The orphan is gone, so the next call is an ordinary one: its own attested figure settles it.
    shapers.input("creative_generate_speech", speech(2_000), call)
    shapers.result("creative_generate_speech", { output: { credits: 500 }, text: "" }, call)
    expect(ledger.daily()).toBe(5_000)
  })

  test("with nothing in flight, a late result is still ignored", () => {
    const { ledger, shapers, call } = abandonedThenNext(1_500, 3_000)
    shapers.result("creative_generate_speech", { output: { credits: 3_000 }, text: "" }, call)
    shapers.result("creative_generate_speech", { output: { credits: 1 }, text: "" }, call)
    shapers.result("creative_generate_speech", { output: { credits: 1 }, text: "" }, call)
    expect(ledger.daily()).toBe(4_500)
  })
})

describe("RR2-5 — two locations on one data directory", () => {
  const caps = () => ({ sessionCreditCap: 2_000, dailyCreditCap: 2_000 })
  const guardCall = (id: string) => ({ sessionID: "ses_a", agent: "build", messageID: "m1", id })
  const speech = { text: "x".repeat(600) }

  /** One backing store, handed out as a fresh storage object each time: another location, or another OpenCode. */
  const sharedStore = () => {
    const stored = new Map<string, unknown>()
    return {
      stored,
      handle: () => ({
        get: async (key: string) => stored.get(key) as never,
        set: async (key: string, value: unknown) => {
          await Promise.resolve()
          stored.set(key, value)
        },
      }),
    }
  }

  test("a charge that settled is never dropped by the other writer's merge", async () => {
    // d107a11: both writers read an empty record, both set their own, and the store kept 1,200 of the 2,400 that
    // was spent. The lost charge overstated the owner's remaining budget from then on.
    const store = sharedStore()
    const first = new Ledger({ storage: store.handle() })
    const second = new Ledger({ storage: store.handle() })
    await Promise.all([first.hydrate(), second.hydrate()])
    await Promise.all([first.reserve("a", "ses_a", 1_200, caps()), second.reserve("b", "ses_a", 1_200, caps())])
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
    const first = new Ledger({ storage: store.handle() })
    const second = new Ledger({ storage: store.handle() })
    await Promise.all([first.hydrate(), second.hydrate()])
    await quoteCall({ ledger: first, caps }, "creative_generate_speech", speech, guardCall("a"))
    await first.flush()
    await expect(quoteCall({ ledger: second, caps }, "creative_generate_speech", speech, guardCall("b"))).rejects.toMatchObject({
      code: "SPEND_CAP_REACHED",
    })
  })

  test("the hold is in the store before the call is dispatched, so a crash cannot lose it", async () => {
    const store = sharedStore()
    const ledger = new Ledger({ storage: store.handle() })
    await ledger.hydrate()
    await quoteCall({ ledger, caps }, "creative_generate_speech", speech, guardCall("a"))
    // The process dies here, with the generation already running. A restart reads only what the store holds.
    const restarted = new Ledger({ storage: store.handle() })
    await restarted.hydrate()
    expect(restarted.daily()).toBe(1_200)
  })

  test("the synchronous path still writes its hold, one tick behind the dispatch", async () => {
    // The residual RR2-5 leaves open: the shared shaper contract is synchronous, so the script path cannot await the
    // store before the call goes out. SECURITY.md and the README say so.
    const store = sharedStore()
    const ledger = new Ledger({ storage: store.handle() })
    await ledger.hydrate()
    quoteCallSync({ ledger, caps }, "creative_generate_speech", speech, guardCall("a"))
    await ledger.flush()
    const restarted = new Ledger({ storage: store.handle() })
    await restarted.hydrate()
    expect(restarted.daily()).toBe(1_200)
  })
})

describe("RR2-6 — an estimate with no money behind it cannot block a method for ever", () => {
  const caps = () => ({ sessionCreditCap: 100_000, dailyCreditCap: 100_000 })
  const shape = (sessionID = "ses_a", action = "elevenlabs_creative_generate_speech") => ({ sessionID, agent: "build", action })
  const paid = { text: "x".repeat(750) }

  /** An estimate_only shapeInput whose result never arrives: an upstream error, a timeout, a cancelled script. */
  const abandonedEstimate = () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    const shapers = shapersFor({ ledger, caps })
    const call = shape()
    shapers.input("creative_generate_speech", { text: "hi", estimate_only: true }, call)
    return { ledger, shapers, call, advance: (ms: number) => void (now += ms) }
  }

  test("a paid call of that method is refused while the estimate could still return, and admitted once it cannot", () => {
    // d107a11 refused it at once, after 11 minutes and after 25 hours: the estimate flight was never forgiven.
    const { ledger, shapers, call, advance } = abandonedEstimate()
    expect(() => shapers.input("creative_generate_speech", paid, call)).toThrow(SpendRefused)
    advance(RESERVATION_MS + 1)
    shapers.input("creative_generate_speech", paid, call)
    expect(ledger.spend("ses_a").sessionCredits).toBe(1_500)
  })

  test("the refusal's next step can be carried out", () => {
    const { shapers, call } = abandonedEstimate()
    try {
      shapers.input("creative_generate_speech", paid, call)
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
    shapers.input("creative_generate_speech", paid, call)
    expect(ledger.spend("ses_a").sessionCredits).toBe(1_500)
    shapers.result("creative_generate_speech", { output: { credits: 1 }, text: "" }, call)
    expect(ledger.spend("ses_a").sessionCredits).toBe(1_500)
    shapers.result("creative_generate_speech", { output: { credits: 1 }, text: "" }, call)
    expect(ledger.spend("ses_a").sessionCredits).toBe(1_500)
  })

  test("an estimate that does return still settles nothing and still frees the method", () => {
    const { ledger, shapers, call } = abandonedEstimate()
    shapers.result("creative_generate_speech", { output: { credits: 42 }, text: "" }, call)
    shapers.input("creative_generate_speech", paid, call)
    expect(ledger.spend("ses_a").sessionCredits).toBe(1_500)
  })
})

describe("RR2-7 — an attested figure may lower a reservation only when it reads as this call's charge", () => {
  const result = (output: Record<string, unknown>) => ({ output, text: "" })

  test("a fraction of a credit never lowers a reservation", () => {
    // d107a11 settled 0.5 against 3,000 reserved. Credits are whole; a fraction is a rate the plugin misread.
    const settled = settlementOf(result({ credits: 0.5 }), 3_000)
    expect(settled).toMatchObject({ credits: 3_000, attested: false })
    expect(settled.note).toContain("not a whole number")
  })

  test("a figure orders of magnitude below the reservation never lowers it", () => {
    // This is how 3,000 credits became 1.
    for (const credits of [1, 2, 29]) {
      const settled = settlementOf(result({ credits }), 3_000)
      expect({ credits, settled: settled.credits, attested: settled.attested }).toEqual({ credits, settled: 3_000, attested: false })
      expect(settled.note).toContain("too far below")
    }
    // Within a hundredfold it is a charge this call could have: it is honoured, as the design intends.
    expect(settlementOf(result({ credits: 30 }), 3_000)).toEqual({ credits: 30, attested: true })
    expect(settlementOf(result({ total_credits: 1_500 }), 3_000)).toEqual({ credits: 1_500, attested: true })
    // And a higher figure still replaces the reservation, whatever its size.
    expect(settlementOf(result({ credits: 48_000 }), 3_000)).toEqual({ credits: 48_000, attested: true })
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
    const shapers = shapersFor({ ledger, caps: () => ({ sessionCreditCap: 100_000, dailyCreditCap: 100_000 }) })
    const call = { sessionID: "ses_a", agent: "build", action: "elevenlabs_creative_generate_speech" }
    shapers.input("creative_generate_speech", { text: "x".repeat(1_500) }, call)
    const settled = shapers.result("creative_generate_speech", { output: { credits: 1 }, text: "" }, call)
    expect(ledger.spend("ses_a").sessionCredits).toBe(3_000)
    expect(settled.text).toContain("too far below")
  })
})

describe("RR2-8 — the money gate folds case, as the permission gate does", () => {
  test("a creative_ name in another case is priced or refused, never sent unpriced", () => {
    // d107a11 answered false for every one of these, so the guard returned before pricing and the call was sent.
    for (const name of ["Creative_Upscale", "Creative_Generate_Speech", "CREATIVE_GENERATE_SPEECH", "creative_Edit_Image"]) {
      expect({ name, priced: mustPrice(name) }).toEqual({ name, priced: true })
    }
    // The exemptions fold with it: a classified non-spending creative name does not become a refusal in another case.
    for (const name of ["CREATIVE_GET_FLOW", "Creative_Create_Flow", "AGENTS_LIST"]) {
      expect({ name, priced: mustPrice(name) }).toEqual({ name, priced: false })
    }
  })

  test("a known name in another case is priced from the table, not refused as unknown", () => {
    const input = { text: "x".repeat(1_500) }
    const lower = priceOf("creative_generate_speech", input)
    expect(lower?.credits).toBe(3_000)
    for (const name of ["Creative_Generate_Speech", "CREATIVE_GENERATE_SPEECH"]) {
      expect({ name, price: priceOf(name, input) }).toEqual({ name, price: lower })
    }
  })

  test("the money path reserves for a mixed-case call, as it does for the lowercase one", () => {
    const ledger = new Ledger({ now: () => 0 })
    const shapers = shapersFor({ ledger, caps: () => ({ sessionCreditCap: 100_000, dailyCreditCap: 100_000 }) })
    const call = { sessionID: "ses_a", agent: "build", action: "elevenlabs_Creative_Generate_Speech" }
    // At d107a11 this reserved nothing at all: the call went out and the session spent 0.
    shapers.input("Creative_Generate_Speech", { text: "x".repeat(1_500) }, call)
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

describe("RR2-9 — folded credits age from when they were spent", () => {
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
  })

  test("what is left over is one hour of it, not a day", () => {
    const { ledger, advance } = overflowed()
    // The hour a folded charge joined is kept while any minute of it is still in the window, so a bucket outlives its
    // newest charge by up to an hour. One credit of the 23h hour, never the thousand of t0's.
    advance(47 * HOUR + 59 * 60 * 1_000)
    expect(ledger.daily()).toBe(1)
  })

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
    const storage = { get: async (key: string) => store.get(key) as never, set: async (key: string, value: unknown) => void store.set(key, value) }
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
    const second = new Ledger({ storage: { get: storage.get, set: storage.set }, now: () => now })
    await second.hydrate()
    expect(second.daily()).toBe(207)
    expect(second.spend("ses_b").sessionCredits).toBe(200)
    now = 26 * HOUR + 1
    expect(second.daily()).toBe(7)
    expect(second.daily()).toBe(ledger.daily())
  })
})
