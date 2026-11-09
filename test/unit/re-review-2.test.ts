// Reproductions from the second re-review. Each one failed at d107a11 and must pass after the fix.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MUSIC_MIN_MS, measureAudio, priceOf, RATES, transcriptionPrice } from "../../src/billing.js"
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
