// Reproductions from the third re-review. Each one failed at 96db0ed and must pass after the fix.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Ledger, measureAudio, priceOf, quoteCallSync, SpendRefused, transcriptionPrice } from "../../src/billing.js"
import { buildMp4, buildWav, hostileChunkSize, WAV_FIXTURES, zeroSizeChunks } from "../fixtures/wav.js"

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

  test("a second `data` chunk is not added to the first", () => {
    expect(measureAudio({ path: paths.twoData })?.durationSeconds).toBe(1)
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
