// Reproductions from the second re-review. Each one failed at d107a11 and must pass after the fix.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { measureAudio, priceOf, transcriptionPrice } from "../../src/billing.js"
import { brokenRiff, WAV_FIXTURES } from "../fixtures/wav.js"

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
