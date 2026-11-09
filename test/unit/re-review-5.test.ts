// Reproductions from the fifth re-review. Each one failed at aa1e26c and must pass after the fix. Since live reconcile
// 1 the plugin computes no price of its own — ElevenLabs' own `estimate_only` call is the only price, and no file on
// this machine is part of any call — so the blocks built on measured audio and on the published rates are
// re-expressed. Each says what it used to assert, and what now holds instead.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  estimatePrice,
  Ledger,
  LEDGER_REFRESH_MS,
  PRICED_ARGUMENTS,
  priceObstacle,
  quoteCall,
  quoteCallSync,
} from "../../src/billing.js"
import { ALL_TOOLS, ESTIMATE_TOOLS, mustPrice, SPEND_ANY, SPEND_TOOLS } from "../../src/elevenlabs-tools.js"
import { durationOf, riffReadingWith } from "../../src/media/policy.js"
import { savedText } from "../../src/media/save.js"
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
/** A speech call in the live schema's own names. The spoken words go in `prompt`; there is no `text` argument. */
const speechArgs = (prompt: string) => ({ prompt, voice_id: "voice_example", model_id: "model_example", context: "a test" })
/** A transcription call in the live schema's own names. It names a node to read, never a file on this machine. */
const transcribeArgs = () => ({ flow_id: "flow_example", connect_from: "node_example", model_id: "model_example", context: "a test" })

describe("RR5-1 — a WAV with more than one `fmt ` chunk is not measured", () => {
  // This block used to end in a price: the two-`fmt ` file was refused for want of a length, and the single-`fmt `
  // file next to it was billed at 55 credits for its ten seconds. Transcription is priced from ElevenLabs' own
  // estimate now and from nothing else, so what is left of the finding is the reading itself — the duration
  // `save_media` prints beside a saved file, which is a line in a message and never a price.
  const reading = (bytes: Buffer) => riffReadingWith((offset, length) => bytes.subarray(offset, offset + length), bytes.length)

  test("the review's two-`fmt ` file still has no duration, and the same audio under one `fmt ` still reads", async () => {
    // At aa1e26c the first `fmt ` won and its 80,000 bytes/s read ten seconds of audio as one. Two `fmt ` chunks are
    // two decoders' answers, so neither is printed; one `fmt ` reads the ten seconds it really holds.
    expect(await durationOf(file("two-fmt.wav", twoFmtChunks()))).toBeUndefined()
    expect(await durationOf(file("one-fmt.wav", oneFmtChunk()))).toBe(10)
    expect(await durationOf(file("canonical.wav", buildWav({ seconds: 60 })))).toBe(60)
  })

  test("the ordering that over-reads is left unmeasured too, and so is a `fmt ` after the audio", async () => {
    // Taking the last would be safe for `fast first` and wrong for `fast last`; taking the slowest rate cannot
    // under-read but still invents a reading. One ambiguity, one answer: neither file has a length this plugin
    // prints, wherever the second chunk sits — including after `data`, where RR4-7 looks for a second `data`.
    for (const [name, bytes] of [
      ["two-fmt-reversed.wav", twoFmtChunks("fast last")],
      ["trailing-fmt.wav", trailingSecondFmt()],
      ["unreadable-second-fmt.wav", unreadableSecondFmt()],
    ] as const) {
      expect({ name, seconds: await durationOf(file(name, bytes)) }).toEqual({ name, seconds: undefined })
    }
  })

  test("one `fmt ` still measures whatever is written around it", () => {
    // The rule reaches a second `fmt ` and nothing else. A `JUNK` pad, a 40-byte WAVE_FORMAT_EXTENSIBLE chunk and
    // 100 kB of trailing artwork are all ordinary, and all of them keep the reading the rounds before this gave them.
    expect(reading(buildWav({ seconds: 60, fmtSize: 40 }))).toMatchObject({ seconds: 60 })
    expect(reading(buildWav({ seconds: 60, before: [{ id: "JUNK", bytes: 28, fill: "numbers" }] }))).toMatchObject({ seconds: 60 })
    expect(reading(buildWav({ seconds: 1, after: [{ id: "LIST", bytes: 100_000, fill: "numbers" }] }))).toMatchObject({ seconds: 1 })
    expect(reading(oneFmtChunk())).toEqual({ seconds: 10, stated: 10, toTheEnd: 10, understated: false })
  })

  test("no reading of any file reaches a price, whichever way it reads", () => {
    // The point of the re-expression: the ambiguity above used to decide money. A transcription call that names a
    // file at all is refused for naming an argument the live tool does not have, measurable or not — and the refusal
    // is the same for the file that reads cleanly as for the one that does not.
    for (const name of ["two-fmt.wav", "one-fmt.wav"]) {
      const args = { ...transcribeArgs(), path: join(root, name) }
      expect({ name, obstacle: priceObstacle("creative_transcribe_audio", args) }).toEqual({
        name,
        obstacle: '"path" is an argument ElevenLabs\' own schema for this tool does not have, so its effect on the bill is unknown',
      })
    }
    // The live schema for the tool names no file argument of any spelling: it transcribes a node in a flow.
    expect([...PRICED_ARGUMENTS.get("creative_transcribe_audio")!].sort()).toEqual(["connect_from", "context", "estimate_only", "flow_id", "model_id", "view_state_id"])
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
  const PRICED = [...new Set([...PRICED_ARGUMENTS.keys(), ...ESTIMATE_TOOLS, ...SPEND_ANY])]

  test("every name in every price-related list is priced or refused under a cap, never untracked", () => {
    // At aa1e26c `text_to_speech` and `speech_to_text` were in the rate table, in `PRICED_ARGUMENTS` and in the
    // allowlist table the owner reads, and the gate knew neither: both returned `tracked: false` — no reservation, no
    // charge, no cost line, with both caps on. The live catalogue has no such tools, and the rate table is gone, so
    // the lists that remain are the live ones; the rule they have to keep is the same one.
    for (const tool of PRICED) {
      expect({ tool, gated: mustPrice(tool) }).toEqual({ tool, gated: true })
      // Nothing has been estimated, so a cap refuses every one of them rather than letting any through untracked.
      expect({ tool, ...outcome(tool, { context: "a test" }) }).toEqual({ tool, refused: "PRICE_UNKNOWN" })
    }
  })

  test("the lists and the gate cannot drift apart, in either direction", () => {
    // An allowlist for a tool the gate does not price would be an allowlist nothing reads; a spending tool the gate
    // lets through would be a hole in the caps.
    for (const tool of PRICED_ARGUMENTS.keys()) expect({ tool, estimable: ESTIMATE_TOOLS.includes(tool), spends: SPEND_ANY.includes(tool) }).toEqual({ tool, estimable: true, spends: true })
    for (const tool of SPEND_TOOLS) expect({ tool, gated: mustPrice(tool) }).toEqual({ tool, gated: true })
    // The names the gate holds with no allowlist are the spending tools ElevenLabs gives no estimate: a cap refuses
    // them outright, because there is no figure to check one against before they run.
    expect(ALL_TOOLS.filter(mustPrice).filter((tool) => !PRICED_ARGUMENTS.has(tool)).sort()).toEqual([
      "agents_compute_kb_rag_index",
      "agents_query_knowledge_base_rag",
      "agents_run_tests",
      "creative_create_brand_kit_from_website",
      "creative_design_voice",
    ])
    expect(outcome("creative_design_voice", { voice_description: "a warm narrator" })).toEqual({ refused: "PRICE_UNKNOWN" })
  })

  test("case is folded on the gate as it is everywhere else, so no spelling is the weaker one", () => {
    // RR2-8, which the live names made easy to lose: the catalogue is lower-case, and a caller that shouts is still
    // making the same paid call.
    expect(mustPrice("Creative_Generate_Speech")).toBe(true)
    expect(outcome("CREATIVE_GENERATE_SPEECH", speechArgs("hello"))).toEqual({ refused: "PRICE_UNKNOWN" })
    const ledger = new Ledger()
    ledger.rememberPrice("creative_generate_speech", speechArgs("hello"), { credits: 500, basis: "exact", parts: [] })
    const quoted = quoteCallSync({ ledger, caps: () => caps }, "Creative_Generate_Speech", speechArgs("hello"), { sessionID: "ses_a", agent: "build", messageID: "m1", id: "c9" })
    expect({ tracked: quoted.tracked, credits: quoted.price.credits }).toEqual({ tracked: true, credits: 500 })
  })
})

describe("RR5-3 — a book that decides is never older than one call", () => {
  const DAILY = 10_000
  const caps = { sessionCreditCap: null, dailyCreditCap: DAILY }
  // The review's figure, from ElevenLabs' own estimate rather than from a rate: 3,000 credits a call.
  const args = () => speechArgs("x".repeat(1_500))
  const price = { credits: 3_000, basis: "exact" as const, parts: ["estimated by ElevenLabs"] }
  const call = (id: string) => ({ sessionID: "ses_a", agent: "build", messageID: "m1", id })
  /** A ledger holding ElevenLabs' estimate for these arguments, as a probe minutes ago would have left it. */
  const priced = (input?: ConstructorParameters<typeof Ledger>[0]) => {
    const ledger = input === undefined ? new Ledger() : new Ledger(input)
    ledger.rememberPrice("creative_generate_speech", args(), price)
    return ledger
  }
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
    const a = priced({ storage: store.handle(), writerId: "a" })
    const b = priced({ storage: store.handle(), writerId: "b" })
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
    const a = priced({ storage: store.handle(), writerId: "a" })
    const b = priced({ storage: store.handle(), writerId: "b" })
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
    const ledger = priced({ storage: stalled as never, writerId: "s" })
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

describe("RR5-4 — an argument is read once, and that one reading is the one that is priced", () => {
  // This block used to be about a local audio path: the guard read `audio_path` five times and kept no copy, so an
  // argument that answered with a cheap file while it was measured and a dear one while it was dispatched put a
  // 3,300-credit call through on a 6-credit hold. Nothing on this machine is measured now, so the shape that made it
  // possible is gone — but the general rule it stood for is not, and it is now ElevenLabs that holds the reading: the
  // estimate answers for the arguments it was sent, and those are the arguments that go out.
  const caps = { sessionCreditCap: 1_000_000, dailyCreditCap: 1_000_000 }
  const call = (id: string) => ({ sessionID: "ses_a", agent: "build", messageID: "m1", id })
  /** An arguments object whose `prompt` answers differently each time it is read. */
  const flipping = () => {
    const reads = { count: 0 }
    const args: Record<string, unknown> = { voice_id: "voice_example", model_id: "model_example", context: "a test" }
    Object.defineProperty(args, "prompt", {
      get: () => {
        reads.count++
        return reads.count <= 1 ? "one word" : "x".repeat(100_000)
      },
      enumerable: true,
      configurable: true,
    })
    return { args, reads }
  }

  test("the estimate is asked with the arguments the call carries, and the price it answers is the price held", async () => {
    // One estimate, one price, one dispatch: whatever the arguments do when they are read again, the figure on the
    // ledger is the one ElevenLabs gave for what it was sent, and this plugin invents nothing between the two.
    const sent: Record<string, unknown>[] = []
    const ledger = new Ledger()
    const estimate = async (tool: string, input: Record<string, unknown>) => {
      sent.push({ ...input })
      return estimatePrice(tool, input, { output: { credits: 500 } })
    }
    const { args } = flipping()
    const quoted = await quoteCall({ ledger, caps: () => caps, estimate }, "creative_generate_speech", args, call("m1"))
    expect(sent.length).toBe(1)
    expect(quoted).toMatchObject({ tracked: true, price: { credits: 500 } })
    expect(ledger.daily()).toBe(500)
  })

  test("a second call for the same arguments reuses the first estimate instead of creating a second flow", async () => {
    // Every estimate creates a flow and a node in the owner's workspace, so asking twice for the same arguments
    // leaves a second flow behind to say what the first already said. The remembered figure is ElevenLabs' own.
    let asked = 0
    const ledger = new Ledger()
    const estimate = async (tool: string, input: Record<string, unknown>) => {
      asked++
      return estimatePrice(tool, input, { output: { credits: 400 } })
    }
    const input = { ledger, caps: () => caps, estimate }
    await quoteCall(input, "creative_generate_speech", speechArgs("hello"), call("m1"))
    await quoteCall(input, "creative_generate_speech", speechArgs("hello"), call("m2"))
    expect(asked).toBe(1)
    expect(ledger.daily()).toBe(800)
    // Different arguments are a different call, and are estimated on their own.
    await quoteCall(input, "creative_generate_speech", speechArgs("goodbye"), call("m3"))
    expect(asked).toBe(2)
  })

  test("a path argument of any spelling is refused by name, on both paths, and nothing is held", async () => {
    // The old reproduction's argument, under the live schemas: `audio_path` is not an argument any live creative tool
    // has, so a call carrying one is refused before an estimate is asked for, and no flow is created for it.
    let asked = 0
    const estimate = async () => {
      asked++
      return undefined
    }
    for (const key of ["audio_path", "path", "file"]) {
      const ledger = new Ledger()
      const args = { ...transcribeArgs(), [key]: "a.wav" }
      expect(() => quoteCallSync({ ledger, caps: () => caps }, "creative_transcribe_audio", args, call("s1")), key).toThrow("PRICE_UNKNOWN")
      await expect(quoteCall({ ledger, caps: () => caps, estimate }, "creative_transcribe_audio", args, call("m1"))).rejects.toMatchObject({
        code: "PRICE_UNKNOWN",
        message: expect.stringContaining(`"${key}"`),
      })
      expect(ledger.daily(), key).toBe(0)
    }
    expect(asked).toBe(0)
  })
})

describe("RR5-5 — a charge keeps the session that reserved it", () => {
  const caps = { sessionCreditCap: 2_000, dailyCreditCap: 10_000 }

  test("a result delivered under a second session does not move the charge out of the first", async () => {
    // The review's reproduction. At aa1e26c `settle` took `sessionID` from its caller, so a repeat of the same entry
    // id under another session rewrote the row: the daily total stayed right, so no money was lost, but ses_a fell to
    // zero and was handed its whole session cap back, and ses_b carried a charge for a call it never made.
    const ledger = new Ledger()
    await ledger.reserve("c1", "ses_a", 1_500, caps)
    ledger.settle("c1", "ses_a", 1_500)
    expect(ledger.spend("ses_a").sessionCredits).toBe(1_500)

    const after = ledger.settle("c1", "ses_b", 4_000)
    expect(ledger.daily()).toBe(4_000)
    expect(ledger.spend("ses_a").sessionCredits).toBe(4_000)
    expect(ledger.spend("ses_b").sessionCredits).toBe(0)
    // The cost line is drawn from what `settle` returns, so it reports the budget the charge came out of.
    expect(after).toEqual({ sessionCredits: 4_000, dailyCredits: 4_000 })
  })

  test("the session argument still opens a row for a call this ledger has no reservation for", () => {
    // The argument is not ignored: with no row to take a session from, it is the only thing that says whose call this
    // was. `release` and both hooks pass the row's own session, so this is the case where it is read.
    const ledger = new Ledger()
    expect(ledger.settle("fresh", "ses_c", 700)).toEqual({ sessionCredits: 700, dailyCredits: 700 })
    expect(ledger.spend("ses_c").sessionCredits).toBe(700)
  })

  test("a failure settles the hold against the session that took it", async () => {
    // `release` reads the row's session already; after the fix it could pass anything and the row would not move.
    const ledger = new Ledger()
    await ledger.reserve("c2", "ses_a", 900, caps)
    ledger.release("c2")
    expect(ledger.spend("ses_a").sessionCredits).toBe(900)
    expect(ledger.spend("ses_b").sessionCredits).toBe(0)
  })
})

describe("RR5-6 — a line states what it counted, in the unit it is really in", () => {
  // This block used to be about measured audio: a six-credit file described as "0 minutes of audio, measured", and a
  // sixty-second one as "1 minutes". No duration is priced now, so the rule moved to the two places a count still
  // reaches a person — the cost line's batch, and the length `save_media` prints beside a file it saved.
  const batch = (input: Record<string, unknown>, credits: number) =>
    estimatePrice("creative_generate_speech", { ...speechArgs("hello"), ...input }, { output: { credits } })?.parts.join(", ")

  test("one generation is singular, and several are plural", () => {
    expect(batch({ generations_count: 1 }, 190)).toBe("1 generation, estimated by ElevenLabs")
    expect(batch({ generations_count: 4 }, 760)).toBe("4 generations, estimated by ElevenLabs")
  })

  test("a batch nobody asked for says so, so the count cannot be read as the caller's own", () => {
    // Speech runs two takes when a call names no count: the figure was divided by a number the caller never wrote,
    // and the line says where it came from.
    expect(batch({}, 380)).toBe("2 generations by default, estimated by ElevenLabs")
  })

  test("a fractional figure is rounded up, and the line says what it was rounded from", () => {
    // ElevenLabs' own estimates come back fractional — 761.5151418103446 for four images. The ledger holds whole
    // credits, so the figure rounds up and the line carries the server's own number for anyone reconciling a bill.
    const priced = estimatePrice("creative_generate_image", { prompt: "a mug", model_id: "model_example", context: "a test" }, { output: { credits: 761.5151418103446 } })
    expect(priced?.credits).toBe(762)
    expect(priced?.parts.join(", ")).toBe("4 generations by default, estimated by ElevenLabs, rounded up from 761.5151418103446")
  })

  test("a batch size nothing says is left out of the line rather than guessed at", () => {
    // Two live tools declare the count with no default, so a call that names none gives nothing to divide by. The
    // line reports the server's figure and claims no unit for it.
    const priced = estimatePrice("creative_run_flow_nodes", { flow_id: "flow_example", context: "a test" }, { output: { credits: 500 } })
    expect({ credits: priced?.credits, perGeneration: priced?.perGeneration }).toEqual({ credits: 500, perGeneration: undefined })
    expect(priced?.parts.join(", ")).toBe("estimated by ElevenLabs")
  })

  test("the saved-file line states a length it really read, and nothing when it read none", () => {
    // `save_media`'s duration is the one measurement left in the plugin, and it is a line in a message: it appears
    // when the file reads cleanly and is absent when it does not, and either way no money turns on it.
    const sha256 = "0".repeat(64)
    expect(savedText({ path: "a.wav", bytes: 2_048, mime: "audio/wav", sha256, durationSeconds: 60 })).toBe("Saved audio/wav to a.wav (2 KB, 60 s).")
    expect(savedText({ path: "a.wav", bytes: 2_048, mime: "audio/wav", sha256 })).toBe("Saved audio/wav to a.wav (2 KB).")
  })
})
