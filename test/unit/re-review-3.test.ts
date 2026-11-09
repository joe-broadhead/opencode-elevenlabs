// Reproductions from the third re-review. Each one failed at 96db0ed and must pass after the fix. Since live reconcile
// 1 the plugin computes no price of its own — ElevenLabs' own `estimate_only` call is the only price, and no file on
// this machine is part of any call — so the blocks that measured audio to price it are re-expressed. Each says what it
// used to assert, and what now holds instead: the decoder rigour the reproductions won is still exactly what the saved
// line's duration is read with, and it is read for display and never for money.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  countValue,
  estimatePrice,
  generationsOf,
  Ledger,
  NOT_A_COUNT,
  PRICED_ARGUMENTS,
  priceObstacle,
  quoteCall,
  quoteCallSync,
  RESERVATION_MS,
  settlementOf,
  SPEND_PREFIX,
  SpendRefused,
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

const caps = (session: number | null = 100_000, daily: number | null = 100_000) => ({ sessionCreditCap: session, dailyCreditCap: daily })

/** A transcription call in the live schema's own argument names: the audio is a node in a flow, never a local file. */
const transcribeArgs = () => ({ model_id: "model_example", context: "a test", flow_id: "flow_example" })

/** A speech call in the live schema's own names. The spoken words go in `prompt`; there is no `text` argument. */
const speechArgs = (prompt: string) => ({ prompt, voice_id: "voice_example", model_id: "model_example", context: "a test" })

/**
 * A speech call of `credits` credits, with ElevenLabs' figure for exactly those arguments already on this ledger —
 * what an `estimate_only` call puts there. Remembered prices are fresh for ten minutes, so this is called beside each
 * use rather than once at the top of a test that moves the clock.
 */
const priceKnown = (ledger: Ledger, credits: number) => {
  const args = speechArgs("x".repeat(credits))
  ledger.rememberPrice("creative_generate_speech", args, { credits, basis: "exact", parts: [] })
  return args
}

/** The spending guard's refusal for a call it cannot price, through the path a script takes. */
const refusal = (tool: string, input: Record<string, unknown>) => {
  const ledger = new Ledger()
  try {
    quoteCallSync({ ledger, caps: () => caps() }, tool, input, { sessionID: "ses_a", agent: "build", messageID: "m1", id: "c1" })
    return undefined
  } catch (error) {
    return error as SpendRefused
  }
}

describe("the decoder's reading is the only duration, and no duration is a price", () => {
  // This block used to assert a price per measured minute: a WAV read 60 seconds and cost 330 credits. Live,
  // `creative_transcribe_audio` takes `{connect_from, context, estimate_only, flow_id, model_id, view_state_id}` and
  // no file at all, so nothing on this machine prices anything. What the reproductions won is kept exactly where it
  // still matters: `durationOf` is what the save tool prints, and it reads a container the way a decoder does.

  test("a byte-rate field claiming ten times the real rate does not change the duration shown", async () => {
    // 96db0ed divided the audio by the `byteRate` field, so a full minute read as six seconds. The rate comes from the
    // sample rate, the channels and the bit depth, which is how a decoder computes it.
    expect(await durationOf(paths.inflatedByteRate)).toBe(60)
  })

  test("the duration an M4A states is shown, and prices nothing", async () => {
    // 96db0ed read `mvhd` and priced a minute from one unchecked field. The field is the file's own word, which is
    // good enough for a line of text about a file this plugin just saved and is not a number to spend against.
    const mp4 = file("clip.m4a", buildMp4(60))
    expect(await durationOf(mp4)).toBe(60)
    const refused = refusal("creative_transcribe_audio", { ...transcribeArgs(), path: mp4 })
    expect(refused?.code).toBe("PRICE_UNKNOWN")
    expect(refused?.message).toContain("ElevenLabs' own schema for this tool does not have")
  })

  test("no other container is measured, whatever it holds", async () => {
    const others = {
      "clip.mp3": Buffer.concat([Buffer.from("ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000"), Buffer.alloc(4_000, 0xff)]),
      "clip.opus": Buffer.concat([Buffer.from("OggS"), Buffer.alloc(4_000, 7)]),
      "clip.bin": Buffer.alloc(8_000, 3),
    }
    for (const [name, bytes] of Object.entries(others)) {
      expect({ name, measured: await durationOf(file(name, bytes)) }).toEqual({ name, measured: undefined })
    }
  })

  test("a WAV that is not a PCM stream is not measured either", async () => {
    // Format tag 0x0011 is IMA ADPCM: its `data` bytes are compressed, so dividing them by a PCM rate is not a length.
    const adpcm = file("adpcm.wav", buildWav({ seconds: 60, formatTag: 0x0011 }))
    expect(await durationOf(adpcm)).toBeUndefined()
  })

  test("fields outside the ranges a real PCM stream sits in are not a measurement", async () => {
    const outside = [
      { name: "rate-too-low", bytes: buildWav({ seconds: 1 }), patch: (wav: Buffer) => wav.writeUInt32LE(4_000, 24) },
      { name: "rate-too-high", bytes: buildWav({ seconds: 1 }), patch: (wav: Buffer) => wav.writeUInt32LE(384_000, 24) },
      { name: "no-channels", bytes: buildWav({ seconds: 1 }), patch: (wav: Buffer) => wav.writeUInt16LE(0, 22) },
      { name: "too-many-channels", bytes: buildWav({ seconds: 1 }), patch: (wav: Buffer) => wav.writeUInt16LE(16, 22) },
      { name: "odd-bit-depth", bytes: buildWav({ seconds: 1 }), patch: (wav: Buffer) => wav.writeUInt16LE(12, 34) },
    ]
    for (const { name, bytes, patch } of outside) {
      patch(bytes)
      expect({ name, measured: await durationOf(file(`${name}.wav`, bytes)) }).toEqual({ name, measured: undefined })
    }
  })

  test("a transcription is priced by ElevenLabs' estimate, so a perfect WAV beside it changes nothing", async () => {
    // The whole class the measuring belonged to is closed from the other end: whatever a file holds, the price comes
    // from the server or the call does not run.
    expect(await durationOf(paths.canonical)).toBe(60)
    expect(refusal("creative_transcribe_audio", transcribeArgs())?.code).toBe("PRICE_UNKNOWN")
    const ledger = new Ledger()
    const args = transcribeArgs()
    ledger.rememberPrice("creative_transcribe_audio", args, { credits: 330, basis: "exact", parts: ["estimated by ElevenLabs"] })
    const quoted = quoteCallSync({ ledger, caps: () => caps() }, "creative_transcribe_audio", args, { sessionID: "ses_a", agent: "build", messageID: "m1", id: "t1" })
    expect({ credits: quoted.price.credits, tracked: quoted.tracked }).toEqual({ credits: 330, tracked: true })
  })
})

describe("an argument the price does not cover is PRICE_UNKNOWN", () => {
  // This block used to be about a local file beside a URL: the plugin priced the second it could measure and let the
  // server fetch a two-hour recording for free. The rule it won — an argument whose effect on the bill is unknown is
  // never priced around — is now the whole of how arguments are checked, held against ElevenLabs' own live schemas.

  test("a link the estimate was never sent is not a price for the call", () => {
    for (const name of ["cloud_storage_url", "audio_url", "source_url", "url", "path", "reference_audio"]) {
      const refused = refusal("creative_transcribe_audio", { ...transcribeArgs(), [name]: "https://example.test/two-hours.wav" })
      expect({ name, code: refused?.code }).toEqual({ name, code: "PRICE_UNKNOWN" })
      expect(refused?.message).toContain(`"${name}" is an argument ElevenLabs' own schema for this tool does not have`)
    }
  })

  test("an argument whose effect on the bill is unknown refuses the call while a cap is on", () => {
    // `transcript_edit` is documented as a 30% surcharge billed for at least ten seconds. It is not in the live
    // schema, and the documented options that used to be passed over — `diarize`, `language_code`, `num_speakers` —
    // are not either: this tool's own arguments are the six the schema declares, and anything else is unknown.
    for (const extra of [{ transcript_edit: true }, { diarize: true }, { language_code: "en" }, { num_speakers: 2 }]) {
      const refused = refusal("creative_transcribe_audio", { ...transcribeArgs(), ...extra })
      expect({ extra, code: refused?.code }).toEqual({ extra, code: "PRICE_UNKNOWN" })
    }
    // The six the schema does declare price from the server's own figure, with no complaint about any of them.
    const ledger = new Ledger()
    const args = { connect_from: "node_example", context: "a test", flow_id: "flow_example", model_id: "model_example", view_state_id: "view_example" }
    ledger.rememberPrice("creative_transcribe_audio", args, { credits: 6, basis: "exact", parts: [] })
    expect(quoteCallSync({ ledger, caps: () => caps() }, "creative_transcribe_audio", args, { sessionID: "ses_a", agent: "build", messageID: "m1", id: "t2" }).price.credits).toBe(6)
  })

  test("a link in any priced tool's arguments refuses it, not just a transcription's", () => {
    for (const [tool, args] of [
      ["creative_generate_speech", { ...speechArgs("hello"), voice_url: "https://example.test/voice.wav" }],
      ["creative_generate_image", { prompt: "a cat", model_id: "model_example", context: "a test", reference_image_url: "https://example.test/ref.png" }],
    ] as const) {
      expect({ tool, code: refusal(tool, { ...args })?.code }).toEqual({ tool, code: "PRICE_UNKNOWN" })
    }
    // Without it the same calls are priced from a figure ElevenLabs gave for exactly those arguments.
    const ledger = new Ledger()
    const call = { sessionID: "ses_a", agent: "build", messageID: "m1", id: "s1" }
    expect(quoteCallSync({ ledger, caps: () => caps() }, "creative_generate_speech", priceKnown(ledger, 10), call).price.credits).toBe(10)
  })

  test("a tool with no estimate at all is refused whatever it carries, and says so", () => {
    // `creative_design_voice` renders three previews and `agents_run_tests` holds conversations; neither accepts
    // `estimate_only`, so there is no figure to ask for and the next step is the cap, not a probe.
    for (const tool of ["creative_design_voice", "agents_run_tests"]) {
      const refused = refusal(tool, { context: "a test" })
      expect({ tool, code: refused?.code }).toEqual({ tool, code: "PRICE_UNKNOWN" })
      expect(refused?.message).toContain('does not accept "estimate_only"')
      expect(refused?.nextStep).not.toContain("estimate_only")
    }
  })
})

describe("a `data` chunk past the first read is still reached", () => {
  test("100 kB of metadata before the audio does not stop the file being read", async () => {
    // 96db0ed read 64 kB and gave up, so an ordinary broadcast export had no duration on its saved line at all.
    expect(statSync(paths.bigMeta).size).toBeGreaterThan(64 * 1024)
    expect(await durationOf(paths.bigMeta)).toBe(60)
  })
})

describe("chunks after `data` are metadata, not audio", () => {
  test("artwork after the audio is not read as audio", async () => {
    // 96db0ed measured every byte after the `data` header, so 100 kB of artwork read as twelve more seconds.
    expect(await durationOf(paths.trailing)).toBe(1)
  })

  test("a second `data` chunk is not added to the first, and is not measured at all", async () => {
    // corrects the second half of this: a second `data` chunk is not metadata either, and which one a decoder
    // reads is not settled, so the file is unmeasured rather than read as the first chunk's second.
    expect(await durationOf(paths.twoData)).toBeUndefined()
  })
})

describe("a short `data` size does not shrink the reading", () => {
  // Correcting "the stated size, clamped to what follows" read a truncated or still-being-written file as a
  // fraction of its audio. The audio is every byte after `data`, and the stated size is believed only where a
  // well-formed chunk begins exactly at its end.
  test("junk after an understated `data` size is audio and is counted", async () => {
    expect(await durationOf(file("understated-then-junk.wav", understatedThenJunk()))).toBe(60)
  })

  test("a printable id with a size that cannot fit the file is not a chunk", async () => {
    expect(await durationOf(file("understated-then-fake.wav", understatedThenFakeHeader()))).toBe(60)
  })

  test("a real chunk at the stated end still ends the audio", async () => {
    // The other half of the rule, which asserts: a trailing chunk announces itself exactly there. A second
    // `data` announces itself the same way and is refused instead, under.
    expect(await durationOf(paths.trailing)).toBe(1)
    expect(await durationOf(paths.twoData)).toBeUndefined()
  })

  test("a `data` size that overstates the audio is still clamped to what follows", async () => {
    expect(await durationOf(paths.overstated)).toBe(60)
    expect(await durationOf(paths.truncated)).toBe(30)
  })
})

describe("a number a call states is read as the number it spells", () => {
  // This block used to be about `music_length_ms`, a field the live catalogue has no tool for: a numeric string was
  // dropped and a smaller number won, so a call priced 1 credit instead of 450. The field that multiplies a bill now
  // is the generation count, and it is read the same way — because an estimate answers for the batch the arguments
  // ask for, and a count read as absent would price a batch of four at the price of one.

  test("a numeric string states the count it spells", () => {
    for (const [value, expected] of [["4", 4], [" 4 ", 4], [4, 4], ["12", 12]] as const) {
      expect({ value, count: countValue(value) }).toEqual({ value, count: expected })
      expect({ value, asked: generationsOf({ generations_count: value }) }).toEqual({ value, asked: expected })
    }
    // The figure the server returns covers exactly that batch, so the per-generation share divides by it.
    const priced = estimatePrice("creative_generate_image", { generations_count: "4" }, { output: { credits: 761.5151418103446 } })
    expect({ credits: priced?.credits, perGeneration: priced?.perGeneration }).toEqual({ credits: 762, perGeneration: 761.5151418103446 / 4 })
    expect(priced?.parts).toContain("4 generations")
  })

  test("a count no number can be read out of is PRICE_UNKNOWN, not a count that is not there", () => {
    for (const value of ["about four", "", true, {}, [], "4x"]) {
      expect({ value, count: countValue(value) }).toEqual({ value, count: NOT_A_COUNT })
      expect({ value, obstacle: priceObstacle("creative_generate_speech", { ...speechArgs("hello"), generations_count: value }) }).toEqual({
        value,
        obstacle: '"generations_count" states a generation count no number can be read out of',
      })
    }
    const refused = refusal("creative_generate_speech", { ...speechArgs("hello"), generations_count: "about four" })
    expect(refused?.code).toBe("PRICE_UNKNOWN")
    // Even with ElevenLabs' own figure already on the ledger: an unreadable count multiplies it by an unknown.
    const ledger = new Ledger()
    const args = { ...speechArgs("hello"), generations_count: "about four" }
    ledger.rememberPrice("creative_generate_speech", args, { credits: 10, basis: "exact", parts: [] })
    expect(() => quoteCallSync({ ledger, caps: () => caps() }, "creative_generate_speech", args, { sessionID: "ses_a", agent: "build", messageID: "m1", id: "g1" })).toThrow(SpendRefused)
  })

  test("a count a call does not state is the server's own default, and is named as one", () => {
    expect(generationsOf(speechArgs("hello"))).toBeUndefined()
    // Speech generates two takes unless a call says otherwise, so a figure with no count covers two.
    const priced = estimatePrice("creative_generate_speech", speechArgs("hello"), { output: { credits: 100 } })
    expect({ credits: priced?.credits, perGeneration: priced?.perGeneration }).toEqual({ credits: 100, perGeneration: 50 })
    expect(priced?.parts).toContain("2 generations by default")
    // A tool whose schema names no default has no batch size to divide by, so nothing is divided and nothing clamped.
    const flow = estimatePrice("creative_run_flow_nodes", { flow_id: "flow_example", context: "a test" }, { output: { credits: 100 } })
    expect({ credits: flow?.credits, perGeneration: flow?.perGeneration }).toEqual({ credits: 100, perGeneration: undefined })
  })
})

describe("on the script path a result raises a charge and never lowers one", () => {
  const shape = (action = "elevenlabs_creative_generate_speech") => ({ sessionID: "ses_a", agent: "build", action })

  test("a late result from an abandoned call cannot settle the call in flight now", () => {
    // 96db0ed: A's honest-looking late figure of 30 settled C's live 3,000-credit hold and the day read 4,530
    // against a true 7,500 — 2,970 credits of a call that ran, gone from the cap.
    let now = 0
    const ledger = new Ledger({ now: () => now })
    const shapers = shapersFor({ ledger, caps: () => caps() })
    const call = shape()
    shapers.input("creative_generate_speech", priceKnown(ledger, 1_500), call)
    now += RESERVATION_MS + 1
    shapers.input("creative_generate_speech", priceKnown(ledger, 3_000), call)
    expect(ledger.daily()).toBe(4_500)
    shapers.result("creative_generate_speech", { output: { credits: 3_000 }, text: "" }, call)
    expect(ledger.daily()).toBe(4_500)
    shapers.input("creative_generate_speech", priceKnown(ledger, 3_000), call)
    expect(ledger.daily()).toBe(7_500)
    shapers.result("creative_generate_speech", { output: { credits: 30 }, text: "" }, call)
    expect(ledger.daily()).toBe(7_500)
  })

  test("no figure lowers a charge on this path, in or out of the band", () => {
    // An expired hold was charged at its reservation when it expired, so a late answer to it changes nothing; and a
    // figure this path cannot pair with a call may only ever raise.
    for (const figure of [1, 30, 1_500, 2_999, 0.5, 0]) {
      const ledger = new Ledger({ now: () => 0 })
      const shapers = shapersFor({ ledger, caps: () => caps() })
      const call = shape()
      shapers.input("creative_generate_speech", priceKnown(ledger, 3_000), call)
      shapers.result("creative_generate_speech", { output: { credits: figure }, text: "" }, call)
      expect({ figure, daily: ledger.daily() }).toEqual({ figure, daily: 3_000 })
    }
  })

  test("a figure above the reservation still raises it, and the cost line says when one did not", () => {
    const ledger = new Ledger()
    const shapers = shapersFor({ ledger, caps: () => caps() })
    const call = shape()
    shapers.input("creative_generate_speech", priceKnown(ledger, 3_000), call)
    const raised = shapers.result("creative_generate_speech", { output: { credits: 4_000 }, text: "" }, call)
    expect(ledger.daily()).toBe(4_000)
    expect(raised.text).toContain("4,000")
    shapers.input("creative_generate_speech", priceKnown(ledger, 3_000), call)
    const outOfBand = shapers.result("creative_generate_speech", { output: { credits: 30 }, text: "" }, call)
    expect(ledger.daily()).toBe(7_000)
    expect(outOfBand.text).toContain("too far below to be this call's charge")
    // A figure the band would have accepted still does not lower a charge here, and the line says why.
    shapers.input("creative_generate_speech", priceKnown(ledger, 3_000), call)
    const inBand = shapers.result("creative_generate_speech", { output: { credits: 1_500 }, text: "" }, call)
    expect(ledger.daily()).toBe(10_000)
    expect(inBand.text).toContain("cannot tell apart from another call's")
  })
})

describe("a reported figure lowers a charge only from close under the reservation", () => {
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

  test("a fraction inside the band settles at the credit above it", () => {
    // ElevenLabs' own figures are fractional — the measured estimate was 761.5151418103446 — so a settlement reads a
    // non-integer as a real charge and rounds up rather than treating it as nothing to attest.
    expect(settlementOf({ output: { credits: 2_999.4 } }, reserved)).toEqual({ credits: 3_000, attested: true })
    expect(settlementOf({ output: { credits: 761.5151418103446 } }, 700).credits).toBe(762)
  })
})

describe("a higher figure always raises the charge, clamped at the day's cap", () => {
  const reserved = 3_000

  // Correcting 's upper bound: keeping the reservation when a figure is more than ten times it ignores a real
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
    const shapers = shapersFor({ ledger, caps: () => caps() })
    const call = { sessionID: "ses_a", agent: "build", action: "elevenlabs_creative_generate_speech" }
    shapers.input("creative_generate_speech", priceKnown(ledger, 1_500), call)
    const settled = shapers.result("creative_generate_speech", { output: { credits: Number.MAX_SAFE_INTEGER }, text: "" }, call)
    expect(ledger.daily()).toBe(100_000)
    expect(settled.text).toContain("more than ten times")
    // Every later call in the window is refused for the cap, not for its price: ElevenLabs' figure is on the ledger.
    expect(() => shapers.input("creative_generate_speech", priceKnown(ledger, 1_500), call)).toThrow(/SPEND_CAP_REACHED/)
    now += 25 * HOUR
    expect(() => shapers.input("creative_generate_speech", priceKnown(ledger, 1_500), call)).not.toThrow()
  })
})

describe("every priced tool has an argument allowlist, taken from its own live schema", () => {
  // This block used to carry a second half about a composition plan's length: `creative_compose_music` is not in the
  // live catalogue at all, and no live tool prices by a duration, so that half is gone. The first half is now checked
  // against ElevenLabs' own schemas rather than against this plugin's idea of each tool's arguments.
  const noCaps = (tool: string, input: Record<string, unknown>) => {
    const ledger = new Ledger()
    return quoteCallSync({ ledger, caps: () => caps(null, null) }, tool, input, { sessionID: "ses_a", agent: "build", messageID: "m1", id: "c2" })
  }

  /** One priced call per family, each carrying one argument its live schema does not declare. */
  const UNKNOWN_ARGUMENT_CALLS = [
    ["creative_generate_speech", { ...speechArgs("hello"), pronunciation_dictionary_locators: ["x"] }],
    ["creative_generate_image", { prompt: "a cat", model_id: "model_example", context: "a test", reference_image_url_count: 2 }],
    ["creative_generate_video", { prompt: "a cat", model_id: "model_example", context: "a test", loop_count: 4 }],
  ] as const

  test("an argument the schema does not declare refuses the call while a cap is on", () => {
    for (const [tool, input] of UNKNOWN_ARGUMENT_CALLS) {
      const refused = refusal(tool, { ...input })
      expect({ tool, code: refused?.code }).toEqual({ tool, code: "PRICE_UNKNOWN" })
      expect(refused?.message).toContain("is an argument ElevenLabs' own schema for this tool does not have")
    }
  })

  test("the server's own estimate does not price around an unknown argument either", async () => {
    // The estimate answers for the arguments it is sent, and this is one whose effect nothing here knows, so it is
    // not sent at all — one fewer flow left behind in the workspace for a call that is going to be refused.
    const ledger = new Ledger()
    let asked = 0
    const estimate = async (tool: string, input: Record<string, unknown>) => {
      asked += 1
      return estimatePrice(tool, input, { output: { credits: 60 } })
    }
    const call = { sessionID: "ses_a", agent: "build", messageID: "m1", id: "c3" }
    const refused = await quoteCall(
      { ledger, caps: () => caps(), estimate },
      "creative_generate_image",
      { prompt: "a cat", model_id: "model_example", context: "a test", reference_image_url_count: 2 },
      call,
    ).then(
      () => undefined,
      (error: unknown) => error as SpendRefused,
    )
    expect({ code: refused?.code, asked }).toEqual({ code: "PRICE_UNKNOWN", asked: 0 })
    // Without it the estimate prices the call, once, and the figure is remembered for the paid call that follows.
    const quoted = await quoteCall({ ledger, caps: () => caps(), estimate }, "creative_generate_image", { prompt: "a cat", model_id: "model_example", context: "a test" }, { ...call, id: "c4" })
    expect({ credits: quoted.price.credits, asked }).toEqual({ credits: 60, asked: 1 })
    const again = await quoteCall({ ledger, caps: () => caps(), estimate }, "creative_generate_image", { prompt: "a cat", model_id: "model_example", context: "a test" }, { ...call, id: "c5" })
    expect({ credits: again.price.credits, asked }).toEqual({ credits: 60, asked: 1 })
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

describe("a saved M4A says how long it is, and that figure is never a price", () => {
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

  test("nothing priced reads the figure, so a file named in a call is still refused under a cap", async () => {
    const m4a = file("priced.m4a", buildMp4(60))
    expect(await durationOf(m4a)).toBe(60)
    // The same file, through the path that prices a call: it is an argument the schema does not have, not a length.
    const refused = refusal("creative_transcribe_audio", { ...transcribeArgs(), path: m4a })
    expect(refused?.code).toBe("PRICE_UNKNOWN")
    expect(refused?.message).toContain('"path" is an argument ElevenLabs\' own schema for this tool does not have')
  })
})

describe("two spellings of one method are one flight, and one price", () => {
  test("a mixed-case name does not open a second priced call beside the first", () => {
    // 96db0ed admitted all three at once — 1,500 / 3,000 / 4,500 — where one is the rule.
    const ledger = new Ledger()
    const shapers = shapersFor({ ledger, caps: () => caps() })
    const call = { sessionID: "ses_a", agent: "build", action: "elevenlabs_creative_generate_speech" }
    shapers.input("creative_generate_speech", priceKnown(ledger, 750), call)
    for (const name of ["Creative_Generate_Speech", "CREATIVE_GENERATE_SPEECH"]) {
      expect(() => shapers.input(name, priceKnown(ledger, 750), call)).toThrow(SpendRefused)
    }
    expect(ledger.daily()).toBe(750)
    // And the result of either spelling settles the one flight that is open.
    shapers.result("CREATIVE_GENERATE_SPEECH", { output: { credits: 750 }, text: "" }, call)
    expect(ledger.daily()).toBe(750)
    shapers.input("Creative_Generate_Speech", priceKnown(ledger, 750), call)
    expect(ledger.daily()).toBe(1_500)
  })

  test("an estimate taken under one spelling prices the paid call under another", () => {
    // The money gate folds the name, so the remembered price has to fold it too: a script that probes
    // `creative_generate_speech` and then calls `Creative_Generate_Speech` is making one call, priced once.
    const ledger = new Ledger()
    const args = speechArgs("hello")
    ledger.rememberPrice("creative_generate_speech", { ...args, estimate_only: true }, { credits: 40, basis: "exact", parts: [] })
    const quoted = quoteCallSync({ ledger, caps: () => caps() }, "CREATIVE_GENERATE_SPEECH", args, { sessionID: "ses_a", agent: "build", messageID: "m1", id: "f1" })
    expect(quoted.price.credits).toBe(40)
  })
})

describe("a hostile file neither hangs nor reads past its own end", () => {
  test("a chunk size claiming four gigabytes is refused, and quickly", async () => {
    const hostile = file("hostile.wav", hostileChunkSize())
    const started = performance.now()
    expect(await durationOf(hostile)).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test("thousands of zero-size chunks terminate", async () => {
    const many = file("zero-chunks.wav", zeroSizeChunks(5_000))
    const started = performance.now()
    expect(await durationOf(many)).toBe(1)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe("one key per record, one writer per key, so no settled charge is lost", () => {
  const limits = { sessionCreditCap: 100_000, dailyCreditCap: 100_000 }

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
      const writes = [a.reserve("a1", "ses_a", 500, limits), b.reserve("b1", "ses_a", 700, limits)]
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
      quoteCall({ ledger, caps: () => limits }, "creative_generate_speech", priceKnown(ledger, 600), { sessionID: "ses_a", agent: "build", messageID: "m1", id: "a" }),
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

describe("two writers' folded hours are summed, never taken one over the other", () => {
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

describe("the documented residual is what the ledger now does", () => {
  // The review struck the old claims: they said a merge kept every row, which it did not. These clauses are what the
  // append-only ledger actually guarantees, and the three documents the user reads must carry them word for word, so a
  // later change cannot leave a stronger sentence behind. corrected the middle clause, which gave the
  // two-process case as the general rule, and added the Code Mode one; then bounded that one — the ledger reads
  // the store behind every call and on a timer — so the sentence states a staleness instead of a whole cap. The
  // crossing is proved in `re-review-4.test.ts` and the staleness in `re-review-5.test.ts`.
  const RESIDUAL =
    "within one OpenCode the caps are exact; across OpenCodes a cap is crossed by at most one call's reservation for each one deciding before its read of the others' holds lands, so eight of them at 3,000 credits a call can spend 31,000 against a 10,000 cap; every OpenCode reads the store behind each call it admits and every five seconds besides, so none decides on a book older than that; a settled charge is never lost"

  for (const file of ["README.md", "SECURITY.md", "docs/architecture.md"]) {
    test(`${file} states the residual exactly`, () => {
      const prose = readFileSync(join(ROOT, file), "utf8").replace(/\*\*/g, "").replace(/\s+/g, " ")
      expect(prose).toContain(RESIDUAL)
      // The claim found: the two-process case, printed as the bound every reader sizes a cap from.
      expect(prose).not.toContain("exceed a cap by at most one call's reservation;")
      // And the one removed: a process whose book never moved again, which is no longer what happens.
      expect(prose).not.toContain("admits a whole cap of its own")
    })

    test(`${file} no longer claims a merge keeps every row`, () => {
      const prose = readFileSync(join(ROOT, file), "utf8")
      expect(prose).not.toMatch(/another writer's merge|re-read, merge|re-reads, merges/)
    })
  }
})
