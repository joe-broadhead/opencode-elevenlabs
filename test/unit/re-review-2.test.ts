// Reproductions from the second re-review. Each one failed at d107a11 and must pass after the fix.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Ledger, MUSIC_MIN_MS, measureAudio, priceOf, quoteCall, quoteCallSync, RATES, RESERVATION_MS, transcriptionPrice } from "../../src/billing.js"
import { shapersFor } from "../../src/host/tools-rpc.js"
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
    for (const name of ["canonical", "junkNumbers", "junkZeros", "fmt18", "fmt40", "understated", "overstated"] as const) {
      const price = transcriptionPrice({ path: paths[name] })
      expect({ name, credits: price?.credits }).toEqual({ name, credits: 330 })
    }
  })

  test("a stated data size cannot lower the price below the audio that is really there", () => {
    // d107a11 read the size field at offset 40 and priced 1 credit for a full minute of audio.
    expect(measureAudio({ path: paths.understated })?.durationSeconds).toBe(60)
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

  test("a URL is not a local file, so it is passed over rather than refused", () => {
    expect(transcriptionPrice({ path: long, audio_file: "https://example.test/clip.wav" })?.credits).toBe(330)
    // A URL on its own still leaves nothing measured, so there is still no price.
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
    for (const input of [{}, { duration_seconds: 0 }, { music_length_ms: 0 }, { prompt: "a waltz" }, { music_length_ms: "30000" }]) {
      expect(priceOf("creative_generate_music", input)).toBeUndefined()
    }
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
    shapers.result("creative_generate_speech", { output: { credits: 10 }, text: "" }, call)
    expect(ledger.daily()).toBe(4_510)
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
