// Reproductions from the fifth re-review. Each one failed at aa1e26c and must pass after the fix.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Ledger, measureAudio, quoteCallSync, transcriptionPrice } from "../../src/billing.js"
import { riffReadingWith } from "../../src/media/policy.js"
import { buildWav, oneFmtChunk, trailingSecondFmt, twoFmtChunks, unreadableSecondFmt } from "../fixtures/wav.js"

const root = mkdtempSync(join(tmpdir(), "elevenlabs-rr5-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const file = (name: string, bytes: Buffer) => {
  const path = join(root, name)
  writeFileSync(path, bytes)
  return path
}

describe("RR5-1 — a WAV with more than one `fmt ` chunk is not measured", () => {
  const caps = { sessionCreditCap: 1_000_000, dailyCreditCap: 1_000_000 }
  /** What `creative_transcribe_audio` costs for one file under a cap, or the error refusing to price it. */
  const quote = (path: string) => {
    try {
      return quoteCallSync({ ledger: new Ledger(), caps: () => caps }, "creative_transcribe_audio", { path }, { sessionID: "ses_a", agent: "build", messageID: "m1", id: "c1" })
    } catch (error) {
      return error as { code?: string }
    }
  }

  test("the review's two-`fmt ` file is refused, and the same audio under one `fmt ` still prices", () => {
    // Both files hold the same 80,000 bytes of 8 kHz mono 8-bit audio: ten seconds, 55 credits. At aa1e26c the first
    // `fmt ` won, and its 80,000 bytes/s read those ten seconds as one — 6 credits for the same audio, with a cost
    // line reading "0 minutes of audio, measured". A decoder honouring the last `fmt ` reads the ten.
    const two = file("two-fmt.wav", twoFmtChunks())
    const one = file("one-fmt.wav", oneFmtChunk())
    expect(measureAudio({ path: two })).toBeUndefined()
    expect(transcriptionPrice({ path: two })).toBeUndefined()
    expect(quote(two)).toMatchObject({ code: "PRICE_UNKNOWN" })
    // The single-`fmt ` file is untouched: ten seconds measured, and the sixty-second file still prices at 330.
    expect(measureAudio({ path: one })?.durationSeconds).toBe(10)
    expect(transcriptionPrice({ path: one })?.credits).toBe(55)
    expect(quote(one)).toMatchObject({ tracked: true, price: { credits: 55 } })
    expect(quote(file("canonical.wav", buildWav({ seconds: 60 })))).toMatchObject({ tracked: true, price: { credits: 330 } })
  })

  test("the ordering that over-reads is refused too, and so is a `fmt ` after the audio", () => {
    // Taking the last would be safe for `fast first` and wrong for `fast last`; taking the slowest rate cannot
    // under-price but still invents a reading. One ambiguity, one answer: neither file has a length this plugin
    // knows, wherever the second chunk sits — including after `data`, where RR4-7 looks for a second `data`.
    for (const [name, bytes] of [
      ["two-fmt-reversed.wav", twoFmtChunks("fast last")],
      ["trailing-fmt.wav", trailingSecondFmt()],
    ] as const) {
      const path = file(name, bytes)
      expect(measureAudio({ path })).toBeUndefined()
      expect(quote(path)).toMatchObject({ code: "PRICE_UNKNOWN" })
    }
  })

  test("a second `fmt ` this plugin cannot read still counts", () => {
    // The count is of `fmt ` chunks, not of ones that parse: a decoder that takes the short chunk as the live format
    // disagrees with this one about the whole file, which is the disagreement the rule is about.
    const path = file("unreadable-second-fmt.wav", unreadableSecondFmt())
    expect(measureAudio({ path })).toBeUndefined()
    expect(quote(path)).toMatchObject({ code: "PRICE_UNKNOWN" })
  })

  test("one `fmt ` still measures whatever is written around it", () => {
    // The rule reaches a second `fmt ` and nothing else. A `JUNK` pad, a 40-byte WAVE_FORMAT_EXTENSIBLE chunk and
    // 100 kB of trailing artwork are all ordinary, and all of them keep the reading the rounds before this gave them.
    const reading = (bytes: Buffer) => riffReadingWith((offset, length) => bytes.subarray(offset, offset + length), bytes.length)
    expect(reading(buildWav({ seconds: 60, fmtSize: 40 }))).toMatchObject({ seconds: 60 })
    expect(reading(buildWav({ seconds: 60, before: [{ id: "JUNK", bytes: 28, fill: "numbers" }] }))).toMatchObject({ seconds: 60 })
    expect(reading(buildWav({ seconds: 1, after: [{ id: "LIST", bytes: 100_000, fill: "numbers" }] }))).toMatchObject({ seconds: 1 })
    expect(reading(oneFmtChunk())).toEqual({ seconds: 10, stated: 10, toTheEnd: 10, understated: false })
  })
})
