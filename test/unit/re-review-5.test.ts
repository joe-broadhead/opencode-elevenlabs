// Reproductions from the fifth re-review. Each one failed at aa1e26c and must pass after the fix.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { freezeAudioPaths, Ledger, LEDGER_REFRESH_MS, measureAudio, PRICED_ARGUMENTS, priceOf, quoteCall, quoteCallSync, RATED_TOOLS, transcriptionPrice } from "../../src/billing.js"
import { ALL_TOOLS, mustPrice, PRICED_NAMES, SPEND_ANY } from "../../src/elevenlabs-tools.js"
import { riffReadingWith } from "../../src/media/policy.js"
import { createElevenlabsPlugin } from "../../src/plugin.js"
import { ENDPOINT } from "../../src/constants.js"
import { sharedStore } from "../fixtures/store.js"
import { mcpEditor, pluginContext } from "./fake.js"
import { buildWav, oneFmtChunk, trailingSecondFmt, twoFmtChunks, unreadableSecondFmt } from "../fixtures/wav.js"

const root = mkdtempSync(join(tmpdir(), "elevenlabs-rr5-"))
const skillsDir = mkdtempSync(join(tmpdir(), "elevenlabs-rr5-skills-"))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(skillsDir, { recursive: true, force: true })
})
const seam = { endpoint: ENDPOINT, skillsDir }
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

describe("RR5-2 — one list decides what is priced", () => {
  const caps = { sessionCreditCap: 10_000, dailyCreditCap: 10_000 }
  /** What the gate does with one call under a cap: a tracked price, an untracked pass, or a refusal. */
  const outcome = (tool: string, input: Record<string, unknown>) => {
    try {
      const quoted = quoteCallSync({ ledger: new Ledger(), caps: () => caps }, tool, input, { sessionID: "ses_a", agent: "build", messageID: "m1", id: "c1" })
      return { tracked: quoted.tracked, credits: quoted.price.credits }
    } catch (error) {
      return { refused: (error as { code?: string }).code }
    }
  }
  /** Every name any price-related list names: the gate holds all of them or the owner's caps have a hole in them. */
  const PRICED = [...new Set([...PRICED_ARGUMENTS.keys(), ...RATED_TOOLS.keys(), ...Object.values(PRICED_NAMES).flat(), ...SPEND_ANY])]

  test("every name in every price-related list is priced or refused under a cap, never untracked", () => {
    // At aa1e26c `text_to_speech` and `speech_to_text` were in `RATED_TOOLS`, in `PRICED_ARGUMENTS` and in the
    // allowlist table the owner reads, and the gate knew neither: both returned `tracked: false` — no reservation, no
    // charge, no cost line, with both caps on. They are ElevenLabs' own canonical names for the two most-used tools.
    expect(PRICED).toContain("text_to_speech")
    expect(PRICED).toContain("speech_to_text")
    for (const tool of PRICED) {
      expect({ tool, gated: mustPrice(tool) }).toEqual({ tool, gated: true })
      // A count no number can be read out of cannot be priced for any of them — including sound effects, whose bare
      // `{}` is priceable — so one call shape asks every name the same question.
      expect({ tool, ...outcome(tool, { generations: "many" }) }).toEqual({ tool, refused: "PRICE_UNKNOWN" })
    }
  })

  test("the canonical names price exactly what the names beside them price", () => {
    // The review's pairs: the same arguments on each, caps on.
    const text = { text: "x".repeat(750) } // 750 characters at two takes: 1,500 credits.
    const path = file("rr5-2.wav", buildWav({ seconds: 10 }))
    for (const [one, other, input, credits] of [
      ["creative_generate_speech", "text_to_speech", text, 1_500],
      ["creative_transcribe_audio", "speech_to_text", { path }, 55],
    ] as const) {
      expect({ tool: one, ...outcome(one, input) }).toEqual({ tool: one, tracked: true, credits })
      expect({ tool: other, ...outcome(other, input) }).toEqual({ tool: other, tracked: true, credits })
    }
    // Case is folded on the gate as it is on the price table, so neither is the weaker of the two (RR2-8).
    expect(outcome("Text_To_Speech", text)).toEqual({ tracked: true, credits: 1_500 })
  })

  test("the gate, the rate table and the allowlists cannot drift apart", () => {
    for (const tool of RATED_TOOLS.keys()) expect({ tool, allowlisted: PRICED_ARGUMENTS.has(tool) }).toEqual({ tool, allowlisted: true })
    for (const tool of Object.values(PRICED_NAMES).flat()) expect({ tool, spends: SPEND_ANY.includes(tool) }).toEqual({ tool, spends: true })
    // The one name the gate holds with no allowlist, which is safe: nothing prices it, so a cap refuses it outright
    // unless an estimate the caller fetched prices it.
    expect(ALL_TOOLS.filter(mustPrice).filter((tool) => !PRICED_ARGUMENTS.has(tool))).toEqual(["creative_edit_image"])
    expect(outcome("creative_edit_image", { prompt: "a cat" })).toEqual({ refused: "PRICE_UNKNOWN" })
  })
})

describe("RR5-3 — a book that decides is never older than one call", () => {
  const DAILY = 10_000
  const caps = { sessionCreditCap: null, dailyCreditCap: DAILY }
  // 1,500 characters at 1 credit each, two takes: 3,000 credits a call, the review's figure.
  const args = () => ({ text: "x".repeat(1_500) })
  const call = (id: string) => ({ sessionID: "ses_a", agent: "build", messageID: "m1", id })
  /** One Code Mode call through the synchronous path: true when it was admitted. */
  const spend = (ledger: Ledger, id: string) => {
    try {
      quoteCallSync({ ledger, caps: () => caps }, "creative_generate_speech", args(), call(id))
      return true
    } catch {
      return false
    }
  }
  /** Lets every write and every read this round started finish, as the gap between two real calls does. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))
  /** What a cold reader — the next OpenCode to start — finds in the store. */
  const stored = async (store: ReturnType<typeof sharedStore>) => {
    const cold = new Ledger({ storage: store.handle(), writerId: "cold" })
    await cold.hydrate()
    return cold.daily()
  }

  test("an OpenCode that spent nothing while another spent the cap admits no call of its own", async () => {
    // The review's second reproduction. At aa1e26c `a` decided from its setup read for the whole life of the process:
    // `b` spent the cap, `a`'s book still said 0, and `a` admitted 8,000 more — 18,000 against a 10,000 cap, with no
    // instant of simultaneity anywhere. A process that only reads never writes, so nothing behind a call can help it;
    // the timer `plugin.ts` starts is what reads for it, and `catchUp` is what that timer calls.
    const store = sharedStore()
    const a = new Ledger({ storage: store.handle(), writerId: "a" })
    const b = new Ledger({ storage: store.handle(), writerId: "b" })
    await Promise.all([a.hydrate(), b.hydrate()])
    for (const id of ["b1", "b2", "b3"]) expect(spend(b, id)).toBe(true)
    expect(spend(b, "b4")).toBe(false)
    await b.flush()
    expect(await stored(store)).toBe(9_000)

    a.catchUp()
    await settle()
    expect(a.daily()).toBe(9_000)
    expect(spend(a, "a1")).toBe(false)
    expect(() => quoteCallSync({ ledger: a, caps: () => caps }, "creative_generate_speech", args(), call("a2"))).toThrow("SPEND_CAP_REACHED")
    expect(await stored(store)).toBe(9_000)
  })

  test("two OpenCodes spending in turn cross the cap by one reservation, not by a whole cap", async () => {
    // The ordinary two-process case, which overshot by a whole cap at aa1e26c: each admitted its own 9,000 for 18,000
    // against a 10,000 cap. Neither waits for the other — they take turns, as two scripts on one machine do — so the
    // read fired behind each call is what they see one another through. What is left is the documented crossing: the
    // two of them decide together once, so the overshoot is one call's reservation, for the one OpenCode past the
    // first, and it does not compound — the round after it, both refuse.
    const store = sharedStore()
    const a = new Ledger({ storage: store.handle(), writerId: "a" })
    const b = new Ledger({ storage: store.handle(), writerId: "b" })
    await Promise.all([a.hydrate(), b.hydrate()])
    let admitted = 0
    let lastRoundAdmitted = 0
    for (let round = 0; round < 8; round++) {
      lastRoundAdmitted = 0
      for (const [name, ledger] of [["a", a], ["b", b]] as const) if (spend(ledger, `${name}${round}`)) lastRoundAdmitted += 3_000
      admitted += lastRoundAdmitted
      await settle()
    }
    await Promise.all([a.flush(), b.flush()])
    // Three calls of 3,000 fit under 10,000; a fourth was admitted, and that fourth is the whole of the crossing.
    expect(admitted).toBe(12_000)
    expect(admitted - 9_000).toBe(3_000)
    expect(lastRoundAdmitted).toBe(0)
    expect(await stored(store)).toBe(12_000)
  })

  test("the read behind a call is not waited for, so the call itself stays synchronous", () => {
    // DR-1: the shaper contract gives this path no await before dispatch, and the fix may not buy its bound with one.
    // `catchUp` starts the read and returns; a store that never answers must not stall or fail a call.
    const stalled = {
      get: async () => undefined as never,
      set: async () => {},
      remove: async () => {},
      scan: () => new Promise<never>(() => {}),
    }
    const ledger = new Ledger({ storage: stalled as never, writerId: "s" })
    expect(ledger.catchUp()).toBeUndefined()
    const started = Date.now()
    expect(spend(ledger, "s1")).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(ledger.daily()).toBe(3_000)
  })

  test("the plugin reads the store on an unref'd timer and stops it when it is disposed", async () => {
    // The timer is the half of the fix that bounds a process making no calls at all. It must not hold the process
    // open and must not outlive the plugin, so setup unrefs it and the cleanup function clears it.
    const timers: { ms: number | undefined; unrefs: number; cleared: boolean }[] = []
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    const scans: unknown[] = []
    const { ctx, mcp } = pluginContext({ sessionCreditCap: null, dailyCreditCap: DAILY })
    const storage = ctx.storage as { scan: (options: unknown) => Promise<unknown> }
    const realScan = storage.scan.bind(storage)
    storage.scan = async (options: unknown) => {
      scans.push(options)
      return realScan(options)
    }
    let tick: (() => void) | undefined
    globalThis.setInterval = ((handler: () => void, ms?: number) => {
      const entry = { ms, unrefs: 0, cleared: false }
      timers.push(entry)
      tick = handler
      return { unref: () => void entry.unrefs++, entry } as never
    }) as never
    globalThis.clearInterval = ((handle: { entry?: { cleared: boolean } }) => {
      if (handle?.entry) handle.entry.cleared = true
    }) as never
    try {
      const cleanup = await createElevenlabsPlugin(seam).setup(ctx)
      mcp.run(mcpEditor().editor)
      expect(timers).toEqual([{ ms: LEDGER_REFRESH_MS, unrefs: 1, cleared: false }])
      // Five seconds, and the three documents say "every five seconds": they move together or not at all.
      expect(LEDGER_REFRESH_MS).toBe(5_000)
      const before = scans.length
      tick?.()
      await new Promise((resolve) => realSet(resolve, 5))
      expect(scans.length).toBeGreaterThan(before)
      await cleanup!()
      expect(timers[0]?.cleared).toBe(true)
    } finally {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    }
  })
})

describe("RR5-4 — an audio path is read once, and that one reading is the one that is sent", () => {
  const caps = { sessionCreditCap: 1_000_000, dailyCreditCap: 1_000_000 }
  // The review's two files: one second of audio, and ten minutes of it.
  const cheap = file("rr5-4-cheap.wav", buildWav({ seconds: 1 }))
  const dear = file("rr5-4-dear.wav", buildWav({ seconds: 600 }))
  const call = (id: string) => ({ sessionID: "ses_a", agent: "build", messageID: "m1", id })
  /** The review's arguments object: `audio_path` answers with the cheap file for `flip` reads and the dear one after. */
  const flipping = (flip: number) => {
    const reads = { count: 0 }
    const args: Record<string, unknown> = {}
    Object.defineProperty(args, "audio_path", {
      get: () => {
        reads.count++
        return reads.count <= flip ? cheap : dear
      },
      enumerable: true,
      configurable: true,
    })
    return { args, reads }
  }

  test("the review's baseline: the two files are worth 6 and 3,300 credits", () => {
    expect(priceOf("creative_transcribe_audio", { audio_path: cheap })?.credits).toBe(6)
    expect(priceOf("creative_transcribe_audio", { audio_path: dear })?.credits).toBe(3_300)
  })

  for (const flip of [1, 2, 3, 4, 5, 6]) {
    test(`a path that flips after ${flip} reads is priced at the file the call then names, on both paths`, async () => {
      // At aa1e26c the guard read `audio_path` five times and kept no copy, so "flip after 5 reads" was priced at 6
      // credits and the dear file went out: a 3,300-credit call held at 6. The four earlier flips were refused by
      // RR4-9's stamps, which can only ever see the disk — the file never moved here, the argument did. The reading
      // is now written back over the argument, so the measurement, both stampings and the dispatcher all see the one
      // string, and the getter is called exactly once whatever it had planned to do next.
      const sync = flipping(flip)
      const quoted = quoteCallSync({ ledger: new Ledger(), caps: () => caps }, "creative_transcribe_audio", sync.args, call("s1"))
      expect(sync.args["audio_path"]).toBe(cheap)
      expect(sync.reads.count).toBe(1)
      expect(quoted).toMatchObject({ tracked: true, price: { credits: 6 } })

      const model = flipping(flip)
      const ledger = new Ledger()
      const result = await quoteCall({ ledger, caps: () => caps }, "creative_transcribe_audio", model.args, call("m1"))
      expect(model.args["audio_path"]).toBe(cheap)
      expect(model.reads.count).toBe(1)
      expect(result).toMatchObject({ tracked: true, price: { credits: 6 } })
      // The hold is the price of the file the call now names, and no later read can make it the other one.
      expect(ledger.daily()).toBe(6)
    })
  }

  test("a path the guard cannot pin is refused by name, on both paths, and nothing is held", async () => {
    // What the guard cannot write back it cannot price: an argument that keeps its own answer after the write would
    // be measured at one file and sent at another, which is the whole of RR5-4. Both shapes are refused by name.
    /** A getter the guard may read but may not replace. */
    const sealed = () => {
      const args: Record<string, unknown> = {}
      let reads = 0
      Object.defineProperty(args, "audio_path", { get: () => (reads++ === 0 ? cheap : dear), enumerable: true, configurable: false })
      return args
    }
    /** An object that reports a plain string, takes the write, and goes on answering with whatever it likes. */
    const slippery = () => {
      let reads = 0
      return new Proxy({ audio_path: cheap } as Record<string, unknown>, {
        get: (target, key) => (key === "audio_path" ? (reads++ % 2 === 0 ? cheap : dear) : Reflect.get(target, key)),
        defineProperty: () => true,
      })
    }
    for (const [name, make] of [["a getter that cannot be redefined", sealed], ["an object that drops the write", slippery]] as const) {
      const ledger = new Ledger()
      expect(() => quoteCallSync({ ledger, caps: () => caps }, "creative_transcribe_audio", make(), call("s1")), name).toThrow("PRICE_UNKNOWN")
      await expect(quoteCall({ ledger, caps: () => caps }, "creative_transcribe_audio", make(), call("m1"))).rejects.toMatchObject({
        code: "PRICE_UNKNOWN",
        message: expect.stringContaining(`"audio_path"`),
      })
      expect(ledger.daily(), name).toBe(0)
    }
  })

  test("an argument that is already one string is left exactly as it was", () => {
    // The ordinary call, which is every call either shipped path makes: both hand the guard a JSON-parsed object, and
    // `JSON.parse` writes plain values. A frozen object is one reading by the language's own rule, so it is skipped
    // rather than refused.
    const args: Record<string, unknown> = { audio_path: cheap, model_id: "scribe_v1" }
    expect(freezeAudioPaths(args)).toBeUndefined()
    expect(args).toEqual({ audio_path: cheap, model_id: "scribe_v1" })
    expect(freezeAudioPaths(Object.freeze({ audio_path: cheap }) as Record<string, unknown>)).toBeUndefined()
    expect(freezeAudioPaths({ text: "nothing audio here" })).toBeUndefined()
  })
})
