// Reproductions from the third re-review. Each one failed at 96db0ed and must pass after the fix.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  Ledger,
  measureAudio,
  PRICED_ARGUMENTS,
  priceOf,
  quoteCall,
  quoteCallSync,
  RATES,
  RESERVATION_MS,
  settlementOf,
  SPEND_PREFIX,
  SpendRefused,
  transcriptionPrice,
} from "../../src/billing.js"
import { shapersFor } from "../../src/host/tools-rpc.js"
import { durationOf } from "../../src/media/policy.js"
import { saveMedia, savedText } from "../../src/media/save.js"
import { sharedStore, storageOver } from "../fixtures/store.js"
import { buildMp4, buildWav, hostileChunkSize, understatedThenFakeHeader, understatedThenJunk, WAV_FIXTURES, zeroSizeChunks } from "../fixtures/wav.js"

const HOUR = 60 * 60 * 1_000
const ROOT = fileURLToPath(new URL("../..", import.meta.url))

const root = mkdtempSync(join(tmpdir(), "elevenlabs-rr3-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const file = (name: string, bytes: Buffer) => {
  const path = join(root, name)
  writeFileSync(path, bytes)
  return path
}

const paths = Object.fromEntries(Object.entries(WAV_FIXTURES).map(([name, build]) => [name, file(`${name}.wav`, build())])) as Record<
  keyof typeof WAV_FIXTURES,
  string
>

/** The spending guard's refusal for a call it cannot price, through the path a script takes. */
const refusal = (tool: string, input: Record<string, unknown>) => {
  const ledger = new Ledger()
  const caps = () => ({ sessionCreditCap: 100_000, dailyCreditCap: 100_000 })
  try {
    quoteCallSync({ ledger, caps }, tool, input, { sessionID: "ses_a", agent: "build", messageID: "m1", id: "c1" })
    return undefined
  } catch (error) {
    return error as SpendRefused
  }
}

describe("RR3-1 — the price is what a decoder reads, and nothing else is measured", () => {
  test("a byte-rate field claiming ten times the real rate does not change the price", () => {
    // 96db0ed divided the audio by the `byteRate` field, so this file priced 33 credits for a full minute. The rate
    // now comes from the sample rate, the channels and the bit depth, which is how a decoder computes it.
    expect(measureAudio({ path: paths.inflatedByteRate })?.durationSeconds).toBe(60)
    expect(transcriptionPrice({ path: paths.inflatedByteRate })?.credits).toBe(330)
  })

  test("an MP4 states a duration this plugin cannot check, so it is refused rather than priced", () => {
    // 96db0ed read `mvhd` and priced a minute from one unchecked field; an M4A's real length is behind a codec.
    const mp4 = file("clip.m4a", buildMp4(60))
    expect(measureAudio({ path: mp4 })).toBeUndefined()
    expect(transcriptionPrice({ path: mp4 })).toBeUndefined()
    const refused = refusal("creative_transcribe_audio", { path: mp4 })
    expect(refused?.code).toBe("PRICE_UNKNOWN")
    expect(refused?.nextStep).toContain("PCM WAV")
  })

  test("no other container is measured, whatever it holds", () => {
    const others = {
      "clip.mp3": Buffer.concat([Buffer.from("ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000"), Buffer.alloc(4_000, 0xff)]),
      "clip.opus": Buffer.concat([Buffer.from("OggS"), Buffer.alloc(4_000, 7)]),
      "clip.bin": Buffer.alloc(8_000, 3),
    }
    for (const [name, bytes] of Object.entries(others)) {
      expect({ name, measured: measureAudio({ path: file(name, bytes) }) }).toEqual({ name, measured: undefined })
    }
  })

  test("a WAV that is not a PCM stream is not measured either", () => {
    // Format tag 0x0011 is IMA ADPCM: its `data` bytes are compressed, so dividing them by a PCM rate is not a length.
    const adpcm = file("adpcm.wav", buildWav({ seconds: 60, formatTag: 0x0011 }))
    expect(measureAudio({ path: adpcm })).toBeUndefined()
  })

  test("fields outside the ranges a real PCM stream sits in are not a measurement", () => {
    const outside = [
      { name: "rate-too-low", bytes: buildWav({ seconds: 1 }), patch: (wav: Buffer) => wav.writeUInt32LE(4_000, 24) },
      { name: "rate-too-high", bytes: buildWav({ seconds: 1 }), patch: (wav: Buffer) => wav.writeUInt32LE(384_000, 24) },
      { name: "no-channels", bytes: buildWav({ seconds: 1 }), patch: (wav: Buffer) => wav.writeUInt16LE(0, 22) },
      { name: "too-many-channels", bytes: buildWav({ seconds: 1 }), patch: (wav: Buffer) => wav.writeUInt16LE(16, 22) },
      { name: "odd-bit-depth", bytes: buildWav({ seconds: 1 }), patch: (wav: Buffer) => wav.writeUInt16LE(12, 34) },
    ]
    for (const { name, bytes, patch } of outside) {
      patch(bytes)
      expect({ name, measured: measureAudio({ path: file(`${name}.wav`, bytes) }) }).toEqual({ name, measured: undefined })
    }
  })
})

describe("RR3-2 / RR3-7 — an argument the price does not cover is PRICE_UNKNOWN", () => {
  const short = file("one-second.wav", buildWav({ seconds: 1 }))

  test("a local file beside a URL is not a price for the call", () => {
    // 96db0ed priced this at the one second it could see and let the server fetch a two-hour recording for free.
    for (const name of ["cloud_storage_url", "audio_url", "source_url", "url"]) {
      const input = { path: short, [name]: "https://example.test/two-hours.wav" }
      expect({ name, price: transcriptionPrice(input) }).toEqual({ name, price: undefined })
      expect({ name, code: refusal("creative_transcribe_audio", input)?.code }).toEqual({ name, code: "PRICE_UNKNOWN" })
    }
  })

  test("a local file under a name the pricing does not read is refused as well", () => {
    const other = file("sixty.wav", buildWav({ seconds: 60 }))
    const refused = refusal("creative_transcribe_audio", { path: short, reference_audio: other })
    expect(refused?.code).toBe("PRICE_UNKNOWN")
  })

  test("an argument whose effect on the bill is unknown refuses the call while a cap is on", () => {
    // `transcript_edit` is documented as a 30% surcharge billed for at least ten seconds: a price this plugin does
    // not compute, so it is not one it may pass over.
    expect(transcriptionPrice({ path: short, transcript_edit: true })).toBeUndefined()
    expect(refusal("creative_transcribe_audio", { path: short, transcript_edit: true })?.code).toBe("PRICE_UNKNOWN")
    // The documented options that change nothing about the length billed still price.
    expect(transcriptionPrice({ path: short, diarize: true, language_code: "en", num_speakers: 2 })?.credits).toBe(6)
  })

  test("a URL in any priced tool's arguments refuses it, not just a transcription's", () => {
    expect(priceOf("creative_generate_speech", { text: "hello", voice_url: "https://example.test/voice.wav" })).toBeUndefined()
    expect(priceOf("creative_generate_music", { music_length_ms: 60_000, reference: "https://example.test/ref.wav" })).toBeUndefined()
    // Without it, the same calls price as they always did.
    expect(priceOf("creative_generate_speech", { text: "hello" })?.credits).toBe(10)
    expect(priceOf("creative_generate_music", { music_length_ms: 60_000 })?.credits).toBe(900)
  })
})

describe("RR3-6 — a `data` chunk past the first read is still reached", () => {
  test("100 kB of metadata before the audio does not stop the file being priced", () => {
    // 96db0ed read 64 kB and gave up, so an ordinary broadcast export could not be transcribed under a cap at all.
    expect(statSync(paths.bigMeta).size).toBeGreaterThan(64 * 1024)
    expect(measureAudio({ path: paths.bigMeta })?.durationSeconds).toBe(60)
    expect(transcriptionPrice({ path: paths.bigMeta })?.credits).toBe(330)
  })
})

describe("RR3-7 — chunks after `data` are metadata, not audio", () => {
  test("artwork after the audio is not billed as audio", () => {
    // 96db0ed measured every byte after the `data` header, so 100 kB of artwork read as twelve more seconds.
    expect(measureAudio({ path: paths.trailing })?.durationSeconds).toBe(1)
    expect(transcriptionPrice({ path: paths.trailing })?.credits).toBe(6)
  })

  test("a second `data` chunk is not added to the first, and is not measured at all", () => {
    // RR4-7 corrects the second half of this: a second `data` chunk is not metadata either, and which one a decoder
    // reads is not settled, so the file is unmeasured rather than read as the first chunk's second.
    expect(measureAudio({ path: paths.twoData })).toBeUndefined()
  })
})

describe("RR4-1 — a short `data` size does not shrink the price", () => {
  // Correcting RR3-1: "the stated size, clamped to what follows" read a truncated or still-being-written file as a
  // fraction of its audio, which under-counts the cap. The audio is every byte after `data`, and the stated size is
  // believed only where a well-formed chunk begins exactly at its end.
  test("junk after an understated `data` size is audio and is billed", () => {
    const path = file("understated-then-junk.wav", understatedThenJunk())
    expect(measureAudio({ path })?.durationSeconds).toBe(60)
    expect(transcriptionPrice({ path })?.credits).toBe(330)
  })

  test("a printable id with a size that cannot fit the file is not a chunk", () => {
    const path = file("understated-then-fake.wav", understatedThenFakeHeader())
    expect(measureAudio({ path })?.durationSeconds).toBe(60)
    expect(transcriptionPrice({ path })?.credits).toBe(330)
  })

  test("a real chunk at the stated end still ends the audio", () => {
    // The other half of the rule, which RR3-7 asserts: a trailing chunk announces itself exactly there. A second
    // `data` announces itself the same way and is refused instead, under RR4-7.
    expect(measureAudio({ path: paths.trailing })?.durationSeconds).toBe(1)
    expect(measureAudio({ path: paths.twoData })).toBeUndefined()
  })

  test("a `data` size that overstates the audio is still clamped to what follows", () => {
    expect(measureAudio({ path: paths.overstated })?.durationSeconds).toBe(60)
    expect(measureAudio({ path: paths.truncated })?.durationSeconds).toBe(30)
  })
})

describe("RR3-9 — a length field is read as the number it spells", () => {
  test("a numeric string sets the price it states", () => {
    // 96db0ed dropped the string and let a smaller number win, so this call priced 1 credit instead of 450.
    expect(priceOf("creative_generate_music", { music_length_ms: "30000" })?.credits).toBe(450)
    expect(priceOf("creative_generate_music", { music_length_ms: 30, duration_seconds: "300" })?.credits).toBe(4_500)
    expect(priceOf("creative_generate_music", { music_length_ms: " 60000 " })?.credits).toBe(900)
  })

  test("a length no number can be read out of is PRICE_UNKNOWN, not a length that is not there", () => {
    for (const value of ["about a minute", "", true, {}, [], "30s"]) {
      expect({ value, price: priceOf("creative_generate_music", { music_length_ms: value }) }).toEqual({ value, price: undefined })
    }
    // Beside a real length, it is still the whole call that cannot be priced.
    expect(priceOf("creative_generate_music", { music_length_ms: "a minute", duration_seconds: 300 })).toBeUndefined()
  })

  test("a transcription's stated duration is read the same way", () => {
    const short = file("stated.wav", buildWav({ seconds: 1 }))
    expect(transcriptionPrice({ path: short, duration_seconds: "60" })?.credits).toBe(330)
    expect(transcriptionPrice({ path: short, duration_seconds: "a minute" })).toBeUndefined()
  })
})

describe("RR3-3 — on the script path a result raises a charge and never lowers one", () => {
  const caps = () => ({ sessionCreditCap: 100_000, dailyCreditCap: 100_000 })
  const shape = (action = "elevenlabs_creative_generate_speech") => ({ sessionID: "ses_a", agent: "build", action })
  /** A speech call of `credits` credits: one character is one credit, and the bound is two takes. */
  const speech = (credits: number) => ({ text: "x".repeat(credits / RATES.speechTakes) })

  test("a late result from an abandoned call cannot settle the call in flight now", () => {
    // 96db0ed: A's honest-looking late figure of 30 settled C's live 3,000-credit hold and the day read 4,530
    // against a true 7,500 — 2,970 credits of a call that ran, gone from the cap.
    let now = 0
    const ledger = new Ledger({ now: () => now })
    const shapers = shapersFor({ ledger, caps })
    const call = shape()
    shapers.input("creative_generate_speech", speech(1_500), call)
    now += RESERVATION_MS + 1
    shapers.input("creative_generate_speech", speech(3_000), call)
    expect(ledger.daily()).toBe(4_500)
    shapers.result("creative_generate_speech", { output: { credits: 3_000 }, text: "" }, call)
    expect(ledger.daily()).toBe(4_500)
    shapers.input("creative_generate_speech", speech(3_000), call)
    expect(ledger.daily()).toBe(7_500)
    shapers.result("creative_generate_speech", { output: { credits: 30 }, text: "" }, call)
    expect(ledger.daily()).toBe(7_500)
  })

  test("no figure lowers a charge on this path, in or out of the band", () => {
    // An expired hold was charged at its reservation when it expired, so a late answer to it changes nothing; and a
    // figure this path cannot pair with a call may only ever raise.
    for (const figure of [1, 30, 1_500, 2_999, 0.5, 0]) {
      let now = 0
      const ledger = new Ledger({ now: () => now })
      const shapers = shapersFor({ ledger, caps })
      const call = shape()
      shapers.input("creative_generate_speech", speech(3_000), call)
      shapers.result("creative_generate_speech", { output: { credits: figure }, text: "" }, call)
      expect({ figure, daily: ledger.daily() }).toEqual({ figure, daily: 3_000 })
    }
  })

  test("a figure above the reservation still raises it, and the cost line says when one did not", () => {
    const ledger = new Ledger()
    const shapers = shapersFor({ ledger, caps })
    const call = shape()
    shapers.input("creative_generate_speech", speech(3_000), call)
    const raised = shapers.result("creative_generate_speech", { output: { credits: 4_000 }, text: "" }, call)
    expect(ledger.daily()).toBe(4_000)
    expect(raised.text).toContain("4,000")
    shapers.input("creative_generate_speech", speech(3_000), call)
    const outOfBand = shapers.result("creative_generate_speech", { output: { credits: 30 }, text: "" }, call)
    expect(ledger.daily()).toBe(7_000)
    expect(outOfBand.text).toContain("too far below to be this call's charge")
    // A figure the band would have accepted still does not lower a charge here, and the line says why.
    shapers.input("creative_generate_speech", speech(3_000), call)
    const inBand = shapers.result("creative_generate_speech", { output: { credits: 1_500 }, text: "" }, call)
    expect(ledger.daily()).toBe(10_000)
    expect(inBand.text).toContain("cannot tell apart from another call's")
  })
})

describe("RR3-8 — a reported figure lowers a charge only from close under the reservation", () => {
  const reserved = 3_000
  const settle = (credits: unknown) => settlementOf({ output: { credits } }, reserved)

  test("a figure far below the reservation is not this call's charge", () => {
    // 96db0ed accepted a hundredth of the reservation: 30 against 3,000 settled at 30, a 99% discount on the
    // server's word alone.
    for (const credits of [0.5, 1, 29, 30, 299]) {
      expect({ credits, settled: settle(credits).credits }).toEqual({ credits, settled: reserved })
    }
    expect(settle(29).note).toContain("too far below")
  })

  test("a tenth of the reservation and up settles, above and below it", () => {
    for (const [credits, expected] of [[300, 300], [1_500, 1_500], [3_000, 3_000], [12_000, 12_000], [30_000, 30_000]] as const) {
      expect({ credits, settled: settle(credits).credits }).toEqual({ credits, settled: expected })
    }
    expect(settle(300).attested).toBe(true)
  })
})

describe("RR4-2 — a higher figure always raises the charge, clamped at the day's cap", () => {
  const reserved = 3_000
  const caps = () => ({ sessionCreditCap: 100_000, dailyCreditCap: 100_000 })

  // Correcting RR3-8's upper bound: keeping the reservation when a figure is more than ten times it ignores a real
  // charge the plugin under-reserved, and the cap under-counts by the whole difference. A raise is now always the
  // charge; the day's cap bounds what one absurd figure can do to a single window.
  test("a figure far above the reservation is charged, and the cost line says it was", () => {
    for (const credits of [30_001, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      const settled = settlementOf({ output: { credits } }, reserved)
      expect({ credits, settled: settled.credits, attested: settled.attested }).toEqual({ credits, settled: credits, attested: true })
      expect(settled.note).toContain("more than ten times")
    }
    // Ten times and under is an ordinary raise and carries no note.
    expect(settlementOf({ output: { credits: 30_000 } }, reserved)).toEqual({ credits: 30_000, attested: true })
  })

  test("the day's cap is the ceiling, so an absurd figure spends one window at most", () => {
    const settled = settlementOf({ output: { credits: Number.MAX_SAFE_INTEGER } }, reserved, 100_000)
    expect(settled.credits).toBe(100_000)
    expect(settled.note).toContain("the day's cap of 100,000")
    // Nothing that is not a finite figure is read as one, so no such value reaches the clamp.
    expect(settlementOf({ output: { credits: Number.POSITIVE_INFINITY } }, reserved, 100_000).credits).toBe(reserved)
    // Credits are whole, so a raise that arrives as a fraction rounds up rather than down.
    expect(settlementOf({ output: { credits: 3_000.4 } }, reserved).credits).toBe(3_001)
  })

  test("a figure under a key nothing attests raises the charge too", () => {
    expect(settlementOf({ output: { usage: { credits_cost: 1_000_000_000 } } }, reserved, 100_000).credits).toBe(100_000)
    expect(settlementOf({ text: "Charged 1000000000 credits" }, reserved).credits).toBe(1_000_000_000)
    expect(settlementOf({ text: "Charged 4,000 credits" }, reserved).credits).toBe(4_000)
  })

  test("an absurd figure blocks the window and nothing more", () => {
    let now = 0
    const ledger = new Ledger({ now: () => now })
    const shapers = shapersFor({ ledger, caps })
    const call = { sessionID: "ses_a", agent: "build", action: "elevenlabs_creative_generate_speech" }
    shapers.input("creative_generate_speech", { text: "x".repeat(1_500) }, call)
    const settled = shapers.result("creative_generate_speech", { output: { credits: Number.MAX_SAFE_INTEGER }, text: "" }, call)
    expect(ledger.daily()).toBe(100_000)
    expect(settled.text).toContain("more than ten times")
    // Every later call in the window is refused, and the window rolling frees it again.
    expect(() => shapers.input("creative_generate_speech", { text: "x".repeat(1_500) }, call)).toThrow(/SPEND_CAP_REACHED/)
    now += 25 * HOUR
    expect(() => shapers.input("creative_generate_speech", { text: "x".repeat(1_500) }, call)).not.toThrow()
  })
})

describe("RR4-3 — every priced tool has an argument allowlist, and a composition plan has a length", () => {
  const noCaps = (tool: string, input: Record<string, unknown>) => {
    const ledger = new Ledger()
    const caps = () => ({ sessionCreditCap: null, dailyCreditCap: null })
    return quoteCallSync({ ledger, caps }, tool, input, { sessionID: "ses_a", agent: "build", messageID: "m1", id: "c2" })
  }

  const section = (durationMs: number) => ({ section_name: "part", positive_local_styles: ["warm"], duration_ms: durationMs })

  /** One priced call per family, each carrying one argument no allowlist has. */
  const UNKNOWN_ARGUMENT_CALLS = [
    ["creative_generate_speech", { text: "hello", pronunciation_dictionary_locators: ["x"] }],
    ["creative_generate_music", { music_length_ms: 30_000, loop_count: 4 }],
    ["creative_generate_image", { prompt: "a cat", reference_image_url_count: 2 }],
  ] as const

  test("a plan with no length field is priced at the sum of its sections", () => {
    // A plan of two and a half minutes beside a ten-second `music_length_ms` priced at 150 credits, not 2,250: the
    // length field was read and the plan, which is the music the server generates and bills, was not. A plan with no
    // length field at all was refused, so this call could not run under a cap however honest it was.
    const plan = { positive_global_styles: ["ambient"], sections: [section(90_000), section(60_000)] }
    expect(priceOf("creative_compose_music", { composition_plan: plan })).toMatchObject({ credits: 2_250 })
    // A stated length does not lower the plan's own sum, and a longer stated length wins over it.
    expect(priceOf("creative_compose_music", { composition_plan: plan, music_length_ms: 10_000 })?.credits).toBe(2_250)
    expect(priceOf("creative_compose_music", { composition_plan: plan, music_length_ms: 300_000 })?.credits).toBe(4_500)
  })

  test("a plan whose durations cannot be read is not priced at all", () => {
    for (const plan of [{ sections: [] }, { sections: [{ section_name: "part" }] }, { sections: [section(30_000), { duration_ms: "soon" }] }, "a plan", { sections: {} }] as const) {
      expect({ plan, price: priceOf("creative_compose_music", { composition_plan: plan }) }).toEqual({ plan, price: undefined })
    }
    expect(refusal("creative_compose_music", { composition_plan: { sections: [{ section_name: "part" }] } })?.code).toBe("PRICE_UNKNOWN")
  })

  test("an argument the pricing does not understand refuses the call while a cap is on", () => {
    // Both of these were priced as if the argument were not there: 10 credits and 450, against a bill neither the
    // plugin nor the owner knows the shape of.
    for (const [tool, input] of UNKNOWN_ARGUMENT_CALLS.filter(([tool]) => tool !== "creative_generate_image")) {
      const refused = refusal(tool, { ...input })
      expect({ tool, code: refused?.code }).toEqual({ tool, code: "PRICE_UNKNOWN" })
      expect(refused?.message).toContain("whose effect on the bill this plugin does not know")
    }
    // The same arguments without the unknown one are priced as they always were.
    expect(priceOf("creative_generate_speech", { text: "hello" })?.credits).toBe(10)
    expect(priceOf("creative_generate_music", { music_length_ms: 30_000 })?.credits).toBe(450)
  })

  test("the server's own estimate does not price around an unknown argument either", async () => {
    // Image has no published price, so the model path asks ElevenLabs to price the call. The estimate answers for the
    // arguments it is sent, and this is one whose effect nothing here knows, so it is not sent at all.
    const ledger = new Ledger()
    const caps = () => ({ sessionCreditCap: 100_000, dailyCreditCap: 100_000 })
    let asked = 0
    const estimate = async () => {
      asked += 1
      return { credits: 60, basis: "exact" as const, parts: ["ElevenLabs' estimate"] }
    }
    const call = { sessionID: "ses_a", agent: "build", messageID: "m1", id: "c3" }
    const refused = await quoteCall({ ledger, caps, estimate }, "creative_generate_image", { prompt: "a cat", reference_image_url_count: 2 }, call).then(
      () => undefined,
      (error: unknown) => error as SpendRefused,
    )
    expect({ code: refused?.code, asked }).toEqual({ code: "PRICE_UNKNOWN", asked: 0 })
    // Without it the estimate prices the call, as it always did.
    const quoted = await quoteCall({ ledger, caps, estimate }, "creative_generate_image", { prompt: "a cat" }, { ...call, id: "c4" })
    expect({ credits: quoted.price.credits, asked }).toEqual({ credits: 60, asked: 1 })
  })

  test("the same calls run with both caps off", () => {
    // A cap is what makes an unknown argument a refusal: with no cap there is no bound to be wrong about.
    for (const [tool, input] of UNKNOWN_ARGUMENT_CALLS) {
      const quote = noCaps(tool, { ...input })
      expect({ tool, tracked: quote.tracked }).toEqual({ tool, tracked: false })
    }
  })

  test("every allowlist is written down in the architecture guide", () => {
    const guide = readFileSync(join(ROOT, "docs/architecture.md"), "utf8")
    for (const [tool, allowed] of PRICED_ARGUMENTS) {
      expect({ tool, listed: guide.includes(tool) }).toEqual({ tool, listed: true })
      for (const argument of allowed) expect({ tool, argument, listed: guide.includes(`\`${argument}\``) }).toEqual({ tool, argument, listed: true })
    }
    // And the live checklist carries the step that keeps them honest.
    expect(readFileSync(join(ROOT, "test/fixtures/README.md"), "utf8")).toContain("confirm each priced tool's real argument names")
  })
})

describe("RR4-4 — a saved M4A says how long it is, and that figure is never a price", () => {
  // Ruling A took the `mvhd` read out of the pricing, and with it the duration the save tool printed for every
  // container but a WAV: an M4A, which is what ElevenLabs returns, saved with no length at all. The figure is the
  // file's own word, so it comes back for the saved line only, through a walk bounded by the file's bytes.
  const saveOf = async (name: string, bytes: Buffer) => {
    const fetchImpl = (async () => new Response(bytes, { headers: { "content-type": "audio/mp4" } })) as unknown as typeof fetch
    return saveMedia({ url: "https://files.elevenlabsusercontent.com/clip", name }, {
      root: join(root, "saved"),
      maxBytes: 8 * 1024 * 1024,
      hosts: ["elevenlabsusercontent.com"],
      overwrite: true,
      fetch: fetchImpl,
    })
  }

  test("the saved line carries the duration an M4A states", async () => {
    const saved = await saveOf("voiceover", buildMp4(60))
    expect(saved.durationSeconds).toBe(60)
    expect(savedText(saved)).toContain("60 s")
    // A WAV is still measured from its own bytes, not from anything it states.
    expect(await durationOf(file("two.wav", buildWav({ seconds: 2 })))).toBe(2)
  })

  test("a duration the file's own bytes could not hold is not shown", async () => {
    // The walk is bounded by the file: 3,000 seconds in a file of a few kilobytes is a figure the file chose.
    const saved = await saveOf("liar", buildMp4(3_000, 1))
    expect(saved.durationSeconds).toBeUndefined()
    expect(savedText(saved)).not.toContain(" s)")
  })

  test("nothing priced reads the figure, so an M4A is still refused under a cap", async () => {
    const m4a = file("priced.m4a", buildMp4(60))
    expect(await durationOf(m4a)).toBe(60)
    // The same file, through every path that prices a call.
    expect(measureAudio({ path: m4a })).toBeUndefined()
    expect(transcriptionPrice({ path: m4a })).toBeUndefined()
    expect(refusal("creative_transcribe_audio", { path: m4a })?.code).toBe("PRICE_UNKNOWN")
  })
})

describe("RR3-10 — two spellings of one method are one flight", () => {
  test("a mixed-case name does not open a second priced call beside the first", () => {
    // 96db0ed admitted all three at once — 1,500 / 3,000 / 4,500 — where one is the rule.
    const ledger = new Ledger()
    const shapers = shapersFor({ ledger, caps: () => ({ sessionCreditCap: 100_000, dailyCreditCap: 100_000 }) })
    const call = { sessionID: "ses_a", agent: "build", action: "elevenlabs_creative_generate_speech" }
    shapers.input("creative_generate_speech", { text: "x".repeat(750) }, call)
    for (const name of ["Creative_Generate_Speech", "CREATIVE_GENERATE_SPEECH"]) {
      expect(() => shapers.input(name, { text: "x".repeat(750) }, call)).toThrow(SpendRefused)
    }
    expect(ledger.daily()).toBe(1_500)
    // And the result of either spelling settles the one flight that is open.
    shapers.result("CREATIVE_GENERATE_SPEECH", { output: { credits: 1_500 }, text: "" }, call)
    expect(ledger.daily()).toBe(1_500)
    shapers.input("Creative_Generate_Speech", { text: "x".repeat(750) }, call)
    expect(ledger.daily()).toBe(3_000)
  })
})

describe("RR3-1 — a hostile file neither hangs nor reads past its own end", () => {
  test("a chunk size claiming four gigabytes is refused, and quickly", () => {
    const hostile = file("hostile.wav", hostileChunkSize())
    const started = performance.now()
    expect(measureAudio({ path: hostile })).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test("thousands of zero-size chunks terminate", () => {
    const many = file("zero-chunks.wav", zeroSizeChunks(5_000))
    const started = performance.now()
    expect(measureAudio({ path: many })?.durationSeconds).toBe(1)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe("RR3-4 — one key per record, one writer per key, so no settled charge is lost", () => {
  const caps = { sessionCreditCap: 100_000, dailyCreditCap: 100_000 }

  /** A store whose writes wait until the test lets each one through, so two writers' order can be chosen. */
  const gatedStore = () => {
    const stored = new Map<string, unknown>()
    const waiting = new Map<string, Array<() => void>>()
    return {
      stored,
      handle: (who: string) => {
        const base = storageOver(stored)
        const gate = () =>
          new Promise<void>((resolve) => {
            const queue = waiting.get(who) ?? []
            queue.push(resolve)
            waiting.set(who, queue)
          })
        return {
          ...base,
          set: async (key: string, value: unknown) => {
            await gate()
            await base.set(key, value)
          },
          remove: async (key: string) => {
            await gate()
            await base.remove(key)
          },
        }
      },
      /** Lets one of that writer's waiting writes land. False when it has none waiting. */
      release: async (who: string) => {
        const next = waiting.get(who)?.shift()
        if (!next) return false
        next()
        await Bun.sleep(0)
        return true
      },
    }
  }

  test("two writers' settled charges both survive, in all sixteen write orderings", async () => {
    // 96db0ed: each writer read the record, merged its own rows in and set the whole thing back, then checked only
    // that its own rows had landed. In four of these orderings the store kept 500 of the 1,200 that was spent, and no
    // later flush and no cold restart recovered it.
    for (let order = 0; order < 16; order++) {
      const store = gatedStore()
      const a = new Ledger({ storage: store.handle("A"), writerId: "A", now: () => 0 })
      const b = new Ledger({ storage: store.handle("B"), writerId: "B", now: () => 0 })
      await Promise.all([a.hydrate(), b.hydrate()])
      const writes = [a.reserve("a1", "ses_a", 500, caps), b.reserve("b1", "ses_a", 700, caps)]
      a.settle("a1", "ses_a", 500)
      b.settle("b1", "ses_a", 700)
      await Bun.sleep(0)
      for (let step = 0; step < 4; step++) {
        const first = ((order >> step) & 1) === 1 ? "B" : "A"
        if (!(await store.release(first))) await store.release(first === "A" ? "B" : "A")
      }
      await Promise.all(writes)
      await Promise.all([a.flush(), b.flush()])
      const keys = [...store.stored.keys()].filter((key) => key.startsWith(SPEND_PREFIX))
      expect({ order, keys: keys.length }).toEqual({ order, keys: 2 })
      const restarted = new Ledger({ storage: store.handle("C"), writerId: "C", now: () => 0 })
      await restarted.hydrate()
      expect({ order, daily: restarted.daily() }).toEqual({ order, daily: 1_200 })
    }
  })

  test("a hold whose key never reaches the store refuses the call rather than spending", async () => {
    const stored = new Map<string, unknown>()
    const storage = { ...storageOver(stored), set: async () => void (await Promise.reject(new Error("disk full"))) }
    const ledger = new Ledger({ storage, now: () => 0 })
    await ledger.hydrate()
    await expect(
      quoteCall({ ledger, caps: () => caps }, "creative_generate_speech", { text: "x".repeat(600) }, { sessionID: "ses_a", agent: "build", messageID: "m1", id: "a" }),
    ).rejects.toMatchObject({ code: "SPEND_CAP_REACHED" })
    // The hold came back out of memory with it, so a refused call does not eat the budget either.
    expect(ledger.daily()).toBe(0)
  })

  test("a day of charges leaves a bounded number of keys, read over as many pages as it takes", async () => {
    const store = sharedStore()
    let now = 0
    const ledger = new Ledger({ storage: store.handle(), writerId: "A", now: () => now })
    await ledger.hydrate()
    for (let hour = 0; hour < 24; hour++) {
      now = hour * HOUR
      for (let i = 0; i < 100; i++) ledger.record("ses_a", 1, now)
    }
    await ledger.flush()
    const keys = [...store.stored.keys()].filter((key) => key.startsWith(SPEND_PREFIX))
    // 2,400 charges, of which the newest 1,000 keep their own key; the other 1,400 are 14 hours of folded totals.
    expect(keys.length).toBe(1_014)
    expect(ledger.daily()).toBe(2_400)
    // More keys than one scan page, so a reader that stopped at the first page would lose the rest.
    const restarted = new Ledger({ storage: store.handle(), writerId: "B", now: () => now })
    await restarted.hydrate()
    expect(restarted.daily()).toBe(2_400)
    // 2,400 records and two full hydrations over 1,014 keys: real work, and bun's five-second default is not enough
    // for it on a loaded machine. The bound this asserts is a key count, not a duration.
  }, 30_000)
})

describe("RR3-5 — two writers' folded hours are summed, never taken one over the other", () => {
  test("two busy locations on one data directory keep every folded credit", async () => {
    // 96db0ed merged a bucket both books held with Math.max, so half the folded credits vanished: the store held
    // 1,000 of the 2,000 folded, and the two locations read 11,000 and 21,000 against a truth of 22,000.
    const store = sharedStore()
    const now = () => 0
    const a = new Ledger({ storage: store.handle(), writerId: "A", now })
    const b = new Ledger({ storage: store.handle(), writerId: "B", now })
    await Promise.all([a.hydrate(), b.hydrate()])
    // One session, so both books fold the same hour: the bucket the old merge collapsed.
    for (let i = 0; i < 1_100; i++) a.record("ses_a", 10, 0)
    await a.flush()
    for (let i = 0; i < 1_100; i++) b.record("ses_a", 10, 0)
    await b.flush()
    await Promise.all([a.refresh(), b.refresh()])
    expect([a.daily(), b.daily()]).toEqual([22_000, 22_000])
    expect(a.session("ses_a")).toBe(22_000)
    // Each writer folded its own hour under its own key, so the two totals are there to be added.
    const hours = [...store.stored.keys()].filter((key) => key.startsWith(`${SPEND_PREFIX}A/h/`) || key.startsWith(`${SPEND_PREFIX}B/h/`))
    expect(hours.length).toBe(2)
    const restarted = new Ledger({ storage: store.handle(), writerId: "C", now })
    await restarted.hydrate()
    expect(restarted.daily()).toBe(22_000)
  })

  test("a hold, a charge and a folded hour each age out on their own clock", async () => {
    const store = sharedStore()
    let now = 5 * HOUR
    const ledger = new Ledger({ storage: store.handle(), writerId: "A", now: () => now })
    await ledger.hydrate()
    await ledger.reserve("h", "ses_a", 100, { sessionCreditCap: 100_000, dailyCreditCap: 100_000 })
    ledger.record("ses_a", 50, 5 * HOUR)
    // An expired hold is the charge it reserved, and it ages from when it was taken, not from when it expired.
    now = 5 * HOUR + RESERVATION_MS + 1
    expect(ledger.daily()).toBe(150)
    now = 29 * HOUR
    expect(ledger.daily()).toBe(150)
    now = 29 * HOUR + 1
    expect(ledger.daily()).toBe(0)
    await ledger.flush()
    // Past the window the keys are gone, which is the only thing that removes one.
    expect([...store.stored.keys()].filter((key) => key.startsWith(SPEND_PREFIX)).length).toBe(0)
  })

  test("a folded hour read from another writer ages on that hour, not on when it was read", async () => {
    const store = sharedStore()
    let now = 0
    const a = new Ledger({ storage: store.handle(), writerId: "A", now: () => now })
    await a.hydrate()
    for (let i = 0; i < 1_100; i++) a.record("ses_a", 10, 0)
    await a.flush()
    const b = new Ledger({ storage: store.handle(), writerId: "B", now: () => now })
    await b.hydrate()
    expect(b.daily()).toBe(11_000)
    // Hour 0 is kept while any minute of it is inside the window, and goes an hour after the charges it holds would.
    now = 24 * HOUR + 59 * 60 * 1_000
    expect(b.daily()).toBe(1_000)
    now = 25 * HOUR + 1
    expect(b.daily()).toBe(0)
  })
})

describe("RR3-4/RR3-5 — the documented residual is what the ledger now does", () => {
  // The review struck the old claims: they said a merge kept every row, which it did not. These clauses are what the
  // append-only ledger actually guarantees, and the three documents the user reads must carry them word for word, so a
  // later change cannot leave a stronger sentence behind. RR4-10 corrected the middle clause, which gave the
  // two-process case as the general rule, and added the Code Mode one; the bound itself is proved in
  // `re-review-4.test.ts`.
  const RESIDUAL =
    "within one OpenCode the caps are exact; OpenCodes deciding at the same instant cross a cap by at most one call's reservation for each one past the first, so eight of them at 3,000 credits a call can spend 31,000 against a 10,000 cap; a Code Mode call cannot read the store before it decides, so an OpenCode that has read nothing since it started admits a whole cap of its own; a settled charge is never lost"

  for (const file of ["README.md", "SECURITY.md", "docs/architecture.md"]) {
    test(`${file} states the residual exactly`, () => {
      const prose = readFileSync(join(ROOT, file), "utf8").replace(/\*\*/g, "").replace(/\s+/g, " ")
      expect(prose).toContain(RESIDUAL)
      // The claim RR4-10 found: the two-process case, printed as the bound every reader sizes a cap from.
      expect(prose).not.toContain("exceed a cap by at most one call's reservation;")
    })

    test(`${file} no longer claims a merge keeps every row`, () => {
      const prose = readFileSync(join(ROOT, file), "utf8")
      expect(prose).not.toMatch(/another writer's merge|re-read, merge|re-reads, merges/)
    })
  }
})
