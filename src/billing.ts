import { randomUUID } from "node:crypto"
import { closeSync, openSync, readSync, statSync } from "node:fs"
import type { Plugin } from "@opencode/plugin"
import { elevenlabsError, type PluginCode } from "./constants.js"
import { ESTIMATE_TOOLS, mustPrice, priced, spends } from "./elevenlabs-tools.js"
import { durationIn } from "./media/policy.js"
import type { CreditCap } from "./options.js"

/**
 * ElevenLabs' published credit costs, from elevenlabs.io/pricing. Speech to Text is billed per minute, which is why a
 * transcription is priced like a generation: it spends, even though it changes nothing.
 */
export const RATES = {
  /** Text to Speech: 1 credit per character. */
  speechPerCharacter: 1,
  /** Speech returns two takes by default, and each is charged: the figure is therefore a bound, not an exact price. */
  speechTakes: 2,
  /** Speech to Text: 330 credits per minute. */
  sttPerMinute: 330,
  /** Music: 900 credits per minute. */
  musicPerMinute: 900,
  /** Sound effects: 200 credits per generation. */
  sfxPerGeneration: 200,
  /**
   * 32 kbit/s. Not a safe floor: Opus and other speech codecs sit under it, so a byte bound at this rate under-prices
   * a file whose container duration cannot be read. Such a file is refused rather than priced from its size.
   */
  audioBytesPerSecond: 4_000,
} as const

/**
 * The most a call can cost, and how the figure was reached. `at-most` is a bound; `exact` is what ElevenLabs' own
 * estimate returned, or what a result reported.
 */
export interface Price {
  readonly credits: number
  readonly basis: "exact" | "at-most"
  /** The parts, for the cost line: "1,200 characters, 2 takes". */
  readonly parts: readonly string[]
  /** What one variation costs, when the tool takes a generation count: used to clamp the request to the budget. */
  readonly perGeneration?: number
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined)
const field = (input: Record<string, unknown>, names: readonly string[]) => {
  for (const name of names) {
    const value = input[name]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}
const whole = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined)
const count = (value: number) => value.toLocaleString("en-US")

/** The generation-count keys a generating call may use, in the order the plugin writes one back. */
export const GENERATION_KEYS = ["generations_count", "generations", "variations", "num_generations"] as const

/**
 * The key the caller used for its generation count, or `undefined` when it named none. One helper for every path, so a
 * clamp never writes a second key beside the first (DR-6).
 */
export const generationsKeyOf = (input: Record<string, unknown>): (typeof GENERATION_KEYS)[number] | undefined =>
  GENERATION_KEYS.find((key) => input[key] !== undefined)

/** The `generations_count` a generating call asks for, when it names one. */
export const generationsOf = (input: Record<string, unknown>) => {
  const key = generationsKeyOf(input)
  return key === undefined ? undefined : whole(input[key])
}

/** Writes the clamped count into the key the caller used, creating `generations_count` only when it used none. */
export function clampGenerations(input: Record<string, unknown>, allowed: number): string {
  const key = generationsKeyOf(input) ?? "generations_count"
  input[key] = allowed
  return key
}

/**
 * The credits a call costs, from its arguments and ElevenLabs' published formula. Undefined when the formula does not
 * cover the tool, when the computed price is 0, or when a transcription's file cannot be measured. A number the caller
 * typed may raise a measured price. It cannot set one, and it cannot lower one.
 */
export function priceOf(tool: string, input: Record<string, unknown>): Price | undefined {
  const generations = generationsOf(input) ?? 1
  if (tool === "creative_generate_speech" || tool === "creative_speech" || tool === "text_to_speech") {
    const text = field(input, ["text", "script", "message"])
    if (typeof text !== "string") return undefined
    // The server is not attested to honour `takes`. Two takes is the bound until a live call proves otherwise. A
    // caller figure below two must not halve the price; a higher one may raise it.
    const takes = Math.max(whole(field(input, ["takes", "num_takes"])) ?? 0, RATES.speechTakes)
    const characters = Array.from(text).length
    if (characters === 0) return undefined
    const credits = Math.ceil(characters * RATES.speechPerCharacter * takes)
    if (!(credits > 0)) return undefined
    return {
      credits,
      basis: "at-most",
      parts: [`${count(characters)} ${characters === 1 ? "character" : "characters"}`, `${takes} ${takes === 1 ? "take" : "takes"}`],
    }
  }
  if (tool === "creative_transcribe_audio" || tool === "speech_to_text" || tool === "creative_transcription") {
    return transcriptionPrice(input)
  }
  if (tool === "creative_generate_music" || tool === "creative_compose_music") {
    const stated = musicLengthsMs(input)
    // No length at all is the server's own default, which this plugin cannot know: PRICE_UNKNOWN, not a guess.
    if (stated.length === 0) return undefined
    // A caller number may raise a price and may not lower one (RR-1). A call that states a length twice may generate
    // the longer of them, so the longer is what it is priced at, whichever key holds it and in whichever order.
    const asked = Math.max(...stated)
    const milliseconds = Math.max(asked, MUSIC_MIN_MS)
    const minutes = milliseconds / 60_000
    const credits = Math.ceil(minutes * RATES.musicPerMinute)
    if (!(credits > 0)) return undefined
    const parts = [milliseconds < 60_000 ? `${Math.round(milliseconds / 100) / 10} seconds` : `${Math.round(minutes * 10) / 10} minutes`]
    if (milliseconds > asked) parts.push(`${MUSIC_MIN_MS / 1_000} second minimum`)
    return { credits, basis: "at-most", parts }
  }
  if (tool === "creative_generate_sound_effect" || tool === "creative_sound_effects") {
    const credits = RATES.sfxPerGeneration * generations
    if (!(credits > 0)) return undefined
    return { credits, basis: "at-most", parts: [`${generations} ${generations === 1 ? "generation" : "generations"} at ${RATES.sfxPerGeneration} credits`] }
  }
  return undefined
}

/**
 * ElevenLabs' shortest music generation, and so the least a music call can cost: 45 credits at 900 a minute. The
 * published API reference for Music gives `music_length_ms` a range of 3000 to 600000 on both `compose` and
 * `compose-detailed`, so a call asking for less than three seconds still generates three. It is a floor on the price,
 * never a cap: a longer request is priced at its own length.
 */
export const MUSIC_MIN_MS = 3_000

/**
 * Every length a music call states, in milliseconds. One call may carry both `music_length_ms` and `duration_seconds`,
 * and the keys of an object have no order the caller controls, so all of them are collected rather than the first.
 * A zero or a negative states nothing: it leaves the length to the server, which is PRICE_UNKNOWN, not three seconds.
 */
const musicLengthsMs = (input: Record<string, unknown>): number[] => {
  const stated = [number(input["music_length_ms"])]
  for (const name of ["duration_seconds", "duration"] as const) {
    const seconds = number(input[name])
    stated.push(seconds === undefined ? undefined : seconds * 1_000)
  }
  return stated.filter((value): value is number => value !== undefined && value > 0)
}

/** Argument names that may hold the audio file a transcription is about to send. A URL is not one of them. */
const AUDIO_PATHS = ["path", "file", "file_path", "audio_path", "filename", "audio_file", "input_file"] as const

/**
 * The file a transcription is about to send, measured here. A RIFF/WAVE file is measured against its own bytes, so no
 * single header field can set the price: the chunks are walked for `fmt ` and `data`, and a `data` size that
 * understates or overstates the audio behind it is clamped to the bytes that really follow it. A format whose header
 * states no duration is not measured at all: pricing it from a byte floor would under-price Opus, which sits under
 * 32 kbit/s.
 */
export function measureAudio(input: Record<string, unknown>): { readonly durationSeconds: number } | undefined {
  let longest: number | undefined
  // The fixed list is walked, not the caller's keys, so two names for two files give one price whichever order they
  // are written in. Every one of them is measured: the server may read the argument this plugin passed over.
  for (const name of AUDIO_PATHS) {
    const value = input[name]
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) continue
    // A URL names no local file. Nothing here can measure it, and nothing here claims to.
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) continue
    const measured = measureFile(value)
    // A named file this plugin cannot measure is one the call may still send: a price covering the rest is no price.
    if (measured === undefined) return undefined
    if (longest === undefined || measured > longest) longest = measured
  }
  return longest === undefined ? undefined : { durationSeconds: longest }
}

/** One local file's duration, or undefined when it cannot be read or its container states nothing measurable. */
function measureFile(path: string): number | undefined {
  let fd: number | undefined
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size <= 0) return undefined
    fd = openSync(path, "r")
    const head = Buffer.alloc(Math.min(stat.size, 64 * 1024))
    const read = readSync(fd, head, 0, head.length, 0)
    // The whole file's size is what bounds a RIFF `data` header, so it is passed with the head that was read.
    const durationSeconds = durationIn(head.subarray(0, read), stat.size)
    return durationSeconds !== undefined && durationSeconds > 0 ? durationSeconds : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Speech to Text, from the container duration of the file about to be sent. A duration the caller typed may raise that
 * price. It cannot lower it, it cannot win over the measured duration, and it cannot set a price when the file cannot
 * be measured. A price of 0 is not a price.
 */
export function transcriptionPrice(input: Record<string, unknown>): Price | undefined {
  const measured = measureAudio(input)
  if (measured === undefined) return undefined
  const statedMs = number(field(input, ["duration_ms", "audio_duration_ms"]))
  const statedSeconds = number(field(input, ["duration_seconds", "duration", "audio_duration_seconds"]))
  const stated = statedMs !== undefined ? statedMs / 1000 : statedSeconds
  // The measured duration is the floor. A stated duration may only raise it.
  const seconds = stated !== undefined && stated > measured.durationSeconds ? stated : measured.durationSeconds
  if (!(seconds > 0)) return undefined
  const credits = Math.ceil((seconds / 60) * RATES.sttPerMinute)
  if (!(credits > 0)) return undefined
  const parts = [`${Math.round((measured.durationSeconds / 60) * 10) / 10} minutes of audio, measured`]
  if (stated !== undefined && stated > measured.durationSeconds) parts.push(`caller duration raised the bound to ${Math.round((seconds / 60) * 10) / 10} minutes`)
  return { credits, basis: "at-most", parts }
}

/**
 * The credits a result reports, when it reports any. Undefined means the figure is not known and is never invented.
 * The host's own `Tool.Result` carries `output` and `content`, not `text`, so both are read here (DR-10).
 */
export function actualCreditsOf(result: { readonly output?: unknown; readonly text?: string; readonly content?: unknown }): number | undefined {
  const fromOutput = creditsIn(result.output)
  if (fromOutput !== undefined) return fromOutput
  for (const text of textsOf(result)) {
    const parsed = parseJson(text)
    if (parsed !== undefined) {
      const found = creditsIn(parsed)
      if (found !== undefined) return found
    }
    const said = creditsInProse(text)
    if (said !== undefined) return said
  }
  return undefined
}

/**
 * Top-level charge fields a result may attest. A nested `credit: 0` is not one of them, and neither is prose. Only an
 * attested positive figure may settle below the reserved price.
 */
const ATTESTED_CREDIT_KEYS = new Set(["credits", "credits_used", "credits_charged", "billed_credits", "credit_cost", "total_credits"])

export function attestedCreditsOf(result: { readonly output?: unknown }): number | undefined {
  const output = result.output
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    if (!ATTESTED_CREDIT_KEYS.has(key.toLowerCase())) continue
    const credits = number(value)
    if (credits !== undefined && credits > 0) return credits
  }
  return undefined
}

/**
 * The figure a completed call is settled at. Never below the reserved price unless one attested field says so. A prose
 * match and a zero keep the reservation. A higher figure, attested or not, may replace it.
 */
export function settlementOf(result: { readonly output?: unknown; readonly text?: string; readonly content?: unknown }, reserved: number): { readonly credits: number; readonly attested: boolean } {
  const attested = attestedCreditsOf(result)
  if (attested !== undefined) return { credits: attested, attested: true }
  const parsed = actualCreditsOf(result)
  if (parsed !== undefined && parsed > reserved) return { credits: parsed, attested: false }
  return { credits: reserved, attested: false }
}

/** The text parts of a host tool result, whichever shape the content has. */
export function textsOf(result: { readonly text?: string; readonly content?: unknown }): string[] {
  if (typeof result.text === "string") return [result.text]
  const content = result.content
  if (typeof content === "string") return [content]
  if (Array.isArray(content)) return content.flatMap((part) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []))
  return []
}

/**
 * The largest credit figure a text-only result states. The first match is not the charge: "used 1 credit" can precede
 * "Charged 4800 credits". A zero is not a figure.
 */
function creditsInProse(text: string): number | undefined {
  const pattern = /\b(?:charged|cost|used|billed)\b[^\d]{0,20}([\d,]{1,12})\s*credits?\b/gi
  let best: number | undefined
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]!.replaceAll(",", ""))
    if (Number.isFinite(value) && value > 0 && (best === undefined || value > best)) best = value
  }
  return best
}

const CREDIT_KEYS = /^(?:estimated?_|total_|billed_)?credits?(?:_cost|_used|_charged)?$/i

/** Walks a few levels of a JSON value for a credits figure. A number under `credits`, `credit_cost`, `estimated_credits`. */
function creditsIn(value: unknown, depth = 0): number | undefined {
  if (depth > 4 || value === null || typeof value !== "object") return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = creditsIn(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (CREDIT_KEYS.test(key)) {
      const credits = number(item)
      // A nested 0 is not a charge. It must not mask a later figure, and it must not free a reservation.
      if (credits !== undefined && credits > 0) return credits
    }
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    if (item !== null && typeof item === "object") {
      const found = creditsIn(item, depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  const start = trimmed.search(/[[{]/)
  if (start === -1) return undefined
  try {
    return JSON.parse(trimmed.slice(start))
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The ledger. Amounts, times and the session they belong to, in the plugin's own storage, so a reload, a restart or a
// scheduled script cannot reset a cap. A reservation is held from before a call is sent until its result settles, so
// two calls that start together cannot both fit one budget (DR-1). Reservations live in that record, and every writer
// re-reads and merges before it sets, so two ledgers on one storage share one cap. Two machines do not: the store
// cannot see them.
// ---------------------------------------------------------------------------------------------------------------

export const LEDGER_KEY = "spend.ledger"
const WINDOW_MS = 24 * 60 * 60 * 1000
/** A hold still open after this is settled at the reserved price. Ten minutes is inside a long video; expiry must not free the budget. */
export const RESERVATION_MS = 10 * 60 * 1000
/** The detail log is bounded. An in-window charge that no longer fits is folded into a total prune cannot shrink. */
const MAX_ENTRIES = 1_000

interface Entry {
  /** When the credits were spent, in epoch milliseconds. */
  at: number
  credits: number
  /** The session that spent them, so a reload restores its total too (DR-9). */
  sessionID: string
  /** Stable across a rewrite, so a merge does not record the same charge twice. */
  id: string
}

interface Hold {
  sessionID: string
  credits: number
  at: number
}

/** Credits still inside the window that were folded out of the detail log. `at` is the newest folded charge. */
interface Rolled {
  at: number
  credits: number
  sessionID: string
}

interface Book {
  entries: Entry[]
  holds: Map<string, Hold>
  rolled: Rolled[]
  /** Ids moved into `rolled`, so a re-read of an older record cannot put them back. */
  folded: Set<string>
  chain: Promise<void>
}

interface StoredLedger {
  entries: Entry[]
  holds: Array<Hold & { id: string }>
  rolled: Rolled[]
}

/** One book per storage object, so two Ledger instances in this process see each other's holds without waiting. */
const books = new WeakMap<object, Book>()

const emptyBook = (): Book => ({ entries: [], holds: new Map(), rolled: [], folded: new Set(), chain: Promise.resolve() })

const bookFor = (storage: object): Book => {
  const found = books.get(storage)
  if (found) return found
  const book = emptyBook()
  books.set(storage, book)
  return book
}

export interface Spend {
  readonly sessionCredits: number
  readonly dailyCredits: number
}

export interface Caps {
  readonly sessionCreditCap: CreditCap
  readonly dailyCreditCap: CreditCap
}

type Storage = Pick<Plugin.Context["storage"], "get" | "set">

export interface LedgerInput {
  readonly storage?: Storage
  readonly now?: () => number
}

/** The ledger both paths share: the model's hooks and a script's shapers reserve, settle and record the same totals. */
export class Ledger {
  private readonly local = emptyBook()
  private readonly remembered = new Map<string, { price: Price; at: number }>()
  /** This ledger's clock, public so a caller that ages its own bookkeeping ages it on the same clock the holds use. */
  readonly now: () => number
  private storage: Storage | undefined
  private hydrated: Promise<void> | undefined
  private writing: Promise<void> = Promise.resolve()

  constructor(input: LedgerInput = {}) {
    this.storage = input.storage
    this.now = input.now ?? (() => Date.now())
  }

  /** The book this ledger writes. Two instances on one storage object share it. */
  private book(): Book {
    return this.storage ? bookFor(this.storage) : this.local
  }

  /** Reads the stored ledger once, merging into the shared book. A storage failure leaves the totals as they are. */
  hydrate(): Promise<void> {
    this.hydrated ??= this.enqueue(async (book) => {
      if (!this.storage) return
      unionInto(book, parseStored(await this.storage.get(LEDGER_KEY)), this.now())
    })
    return this.hydrated
  }

  /** The credits spent in the last 24 hours, reservations and folded totals included. */
  daily(): number {
    this.prune()
    return total(this.book(), undefined)
  }

  session(sessionID: string): number {
    this.prune()
    return total(this.book(), sessionID)
  }

  spend(sessionID: string): Spend {
    return { sessionCredits: this.session(sessionID), dailyCredits: this.daily() }
  }

  /**
   * Holds `credits` for a call before it is sent, and refuses when it does not fit. Nothing awaits between the check and
   * the hold, so two calls that start together cannot both pass: the second sees the first's reservation, including one
   * held by another ledger on the same storage.
   */
  reserve(id: string, sessionID: string, credits: number, caps: Caps) {
    if (!(credits > 0)) {
      throw new SpendRefused("PRICE_UNKNOWN", "a priced call cannot be reserved at zero credits.", "Price the call from its file or its published rate, or set both caps to null.")
    }
    this.prune()
    const spend = this.spend(sessionID)
    const left = remaining(caps, spend).available
    if (credits > left) {
      throw new SpendRefused(
        "SPEND_CAP_REACHED",
        `this call would spend ${count(credits)} credits, and ${capText(caps, spend)}.`,
        RAISE,
      )
    }
    this.book().holds.set(id, { sessionID, credits, at: this.now() })
    void this.persist()
  }

  /** The reservation a call holds, if any. */
  reservation(id: string) {
    return this.book().holds.get(id)
  }

  /**
   * Turns a reservation into a recorded charge. Never below the reserved price unless `attested` is set: a zero, a
   * missing result or a prose figure must not free the budget. A higher figure replaces the settlement.
   */
  settle(id: string, sessionID: string, credits: number, attested = false): Spend {
    const book = this.book()
    const held = book.holds.get(id)
    book.holds.delete(id)
    const existing = book.entries.find((entry) => entry.id === id)
    const floor = Math.max(held?.credits ?? 0, existing?.credits ?? 0)
    const charge = credits > floor ? credits : attested && credits > 0 ? credits : floor
    if (existing) {
      if (charge > 0 && charge !== existing.credits) {
        existing.credits = charge
        void this.persist()
      }
      return this.spend(sessionID)
    }
    if (charge > 0) {
      book.entries.push({ at: held?.at ?? this.now(), credits: charge, sessionID, id })
      this.prune()
      void this.persist()
    }
    return this.spend(sessionID)
  }

  /** A failure settles the reserved price. It does not free the budget: a billed error and a free one look the same. */
  release(id: string) {
    const held = this.book().holds.get(id)
    if (!held) return
    this.settle(id, held.sessionID, held.credits)
  }

  /** Records a completed call. The memory total moves at once; the stored copy follows, one write at a time. */
  record(sessionID: string, credits: number, at = this.now()): Spend {
    if (credits > 0) {
      this.book().entries.push({ at, credits, sessionID, id: randomUUID() })
      this.prune()
      void this.persist()
    }
    return this.spend(sessionID)
  }

  /** Remembers a price the server itself gave for one tool, so a later call with the same arguments can be priced. */
  rememberPrice(tool: string, input: Record<string, unknown>, price: Price) {
    this.remembered.set(keyOf(tool, input), { price, at: this.now() })
  }

  /** The remembered price for exactly these arguments, if it is still fresh. */
  rememberedPrice(tool: string, input: Record<string, unknown>): Price | undefined {
    const found = this.remembered.get(keyOf(tool, input))
    if (!found) return undefined
    return this.now() - found.at > 10 * 60 * 1000 ? undefined : found.price
  }

  /** Forgets everything. The tests use it. */
  reset() {
    const book = this.book()
    book.entries = []
    book.holds.clear()
    book.rolled = []
    book.folded.clear()
    this.remembered.clear()
  }

  /**
   * Drops entries past the window. An expired hold is settled at the reserved price, not deleted. An in-window charge
   * that would be sliced off the detail log is folded into a total instead.
   */
  private prune() {
    const book = this.book()
    const now = this.now()
    let changed = false
    for (const [id, held] of [...book.holds]) {
      if (held.at >= now - RESERVATION_MS) continue
      book.holds.delete(id)
      const existing = book.entries.find((entry) => entry.id === id)
      if (existing) {
        if (held.credits > existing.credits) existing.credits = held.credits
      } else book.entries.push({ at: held.at, credits: held.credits, sessionID: held.sessionID, id })
      changed = true
    }
    const inWindow = book.entries.filter((entry) => entry.at >= now - WINDOW_MS)
    if (inWindow.length !== book.entries.length) changed = true
    book.entries = inWindow
    const rolled = book.rolled.filter((item) => item.at >= now - WINDOW_MS)
    if (rolled.length !== book.rolled.length) changed = true
    book.rolled = rolled
    if (book.entries.length > MAX_ENTRIES) {
      for (const entry of book.entries.slice(0, book.entries.length - MAX_ENTRIES)) fold(book, entry)
      book.entries = book.entries.slice(-MAX_ENTRIES)
      changed = true
    }
    if (changed) void this.persist()
  }

  /**
   * Re-reads and merges before set, on one chain per storage, so two writers cannot drop each other's charges or holds.
   */
  private persist(): Promise<void> {
    return this.enqueue(async (book) => {
      if (!this.storage) return
      unionInto(book, parseStored(await this.storage.get(LEDGER_KEY)), this.now())
      await this.storage.set(LEDGER_KEY, serialize(book))
    })
  }

  /** Serialises a read-modify-write on this storage. A ledger with no storage runs the work at once. */
  private enqueue(work: (book: Book) => Promise<void>): Promise<void> {
    const book = this.book()
    if (!this.storage) {
      const run = book.chain.then(() => work(book)).then(() => undefined, () => undefined)
      book.chain = run
      this.writing = run
      return run
    }
    const run = book.chain.then(async () => {
      try {
        await work(book)
      } catch {
        // The in-memory total still bounds this process; a storage failure must not fail a generation that already ran.
      }
    })
    book.chain = run
    this.writing = run
    return run
  }

  /** Waits for the writes in flight. The tests use it. */
  flush(): Promise<void> {
    return this.writing
  }
}

const total = (book: Book, sessionID: string | undefined) => {
  const own = (item: { sessionID: string }) => sessionID === undefined || item.sessionID === sessionID
  const spent = book.entries.reduce((sum, entry) => sum + (own(entry) ? entry.credits : 0), 0)
  const folded = book.rolled.reduce((sum, item) => sum + (own(item) ? item.credits : 0), 0)
  const reserved = [...book.holds.values()].reduce((sum, held) => sum + (own(held) ? held.credits : 0), 0)
  return spent + folded + reserved
}

const fold = (book: Book, entry: Entry) => {
  book.folded.add(entry.id)
  const existing = book.rolled.find((item) => item.sessionID === entry.sessionID)
  if (!existing) book.rolled.push({ at: entry.at, credits: entry.credits, sessionID: entry.sessionID })
  else {
    existing.credits += entry.credits
    if (entry.at > existing.at) existing.at = entry.at
  }
}

const serialize = (book: Book) => ({
  entries: book.entries.map((entry) => ({ at: entry.at, credits: entry.credits, sessionID: entry.sessionID, id: entry.id })),
  holds: [...book.holds].map(([id, held]) => ({ id, at: held.at, credits: held.credits, sessionID: held.sessionID })),
  rolled: book.rolled.map((item) => ({ at: item.at, credits: item.credits, sessionID: item.sessionID })),
})

const parseStored = (stored: unknown): StoredLedger => {
  if (Array.isArray(stored)) return { entries: parseEntries(stored), holds: [], rolled: [] }
  if (stored === null || typeof stored !== "object") return { entries: [], holds: [], rolled: [] }
  const record = stored as Record<string, unknown>
  return { entries: parseEntries(record.entries), holds: parseHolds(record.holds), rolled: parseRolled(record.rolled) }
}

const parseEntries = (value: unknown): Entry[] =>
  Array.isArray(value)
    ? value.flatMap((item, index) => {
        if (item === null || typeof item !== "object") return []
        const entry = item as Record<string, unknown>
        if (typeof entry.at !== "number" || typeof entry.credits !== "number" || typeof entry.sessionID !== "string") return []
        const id = typeof entry.id === "string" ? entry.id : `${entry.at}:${entry.credits}:${entry.sessionID}:${index}`
        return [{ at: entry.at, credits: entry.credits, sessionID: entry.sessionID, id }]
      })
    : []

const parseHolds = (value: unknown): StoredLedger["holds"] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (item === null || typeof item !== "object") return []
        const hold = item as Record<string, unknown>
        return typeof hold.id === "string" && typeof hold.at === "number" && typeof hold.credits === "number" && typeof hold.sessionID === "string"
          ? [{ id: hold.id, at: hold.at, credits: hold.credits, sessionID: hold.sessionID }]
          : []
      })
    : []

const parseRolled = (value: unknown): Rolled[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (item === null || typeof item !== "object") return []
        const rolled = item as Record<string, unknown>
        return typeof rolled.at === "number" && typeof rolled.credits === "number" && typeof rolled.sessionID === "string"
          ? [{ at: rolled.at, credits: rolled.credits, sessionID: rolled.sessionID }]
          : []
      })
    : []

/** Adds what storage has and this book does not. Never restores a folded charge, an expired row, or a settled hold. */
function unionInto(book: Book, stored: StoredLedger, now: number) {
  for (const entry of stored.entries) {
    if (entry.at < now - WINDOW_MS || book.folded.has(entry.id)) continue
    const existing = book.entries.find((item) => item.id === entry.id)
    if (!existing) book.entries.push(entry)
    else if (entry.credits > existing.credits) existing.credits = entry.credits
  }
  for (const hold of stored.holds) {
    if (book.entries.some((entry) => entry.id === hold.id) || book.folded.has(hold.id)) {
      book.holds.delete(hold.id)
      continue
    }
    if (hold.at < now - RESERVATION_MS) {
      book.entries.push({ at: hold.at, credits: hold.credits, sessionID: hold.sessionID, id: hold.id })
      continue
    }
    if (!book.holds.has(hold.id)) book.holds.set(hold.id, { sessionID: hold.sessionID, credits: hold.credits, at: hold.at })
  }
  for (const rolled of stored.rolled) {
    if (rolled.at < now - WINDOW_MS) continue
    const existing = book.rolled.find((item) => item.sessionID === rolled.sessionID)
    if (!existing) book.rolled.push({ ...rolled })
    else {
      existing.credits = Math.max(existing.credits, rolled.credits)
      if (rolled.at > existing.at) existing.at = rolled.at
    }
  }
}

/** A call's price key: the tool and its arguments, so a different prompt is a different price. */
const keyOf = (tool: string, input: Record<string, unknown>) => {
  const { estimate_only: _ignored, ...rest } = input
  return `${tool}\u0000${stable(rest)}`
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`
}

// ---------------------------------------------------------------------------------------------------------------
// The guard: what runs before a billed call, and the line every billed result carries.
// ---------------------------------------------------------------------------------------------------------------

export class SpendRefused extends Error {
  readonly code: Extract<PluginCode, "SPEND_CAP_REACHED" | "PRICE_UNKNOWN">
  readonly nextStep: string

  constructor(code: Extract<PluginCode, "SPEND_CAP_REACHED" | "PRICE_UNKNOWN">, message: string, nextStep: string) {
    super(`${code}: ${message} Next step: ${nextStep}`)
    this.name = "SpendRefused"
    this.code = code
    this.nextStep = nextStep
  }
}

export interface AffordInput {
  readonly tool: string
  readonly price: Price
  readonly caps: Caps
  readonly spend: Spend
}

/** What is left, and whether the price fits. Null caps are unlimited. */
export function remaining(caps: Caps, spend: Spend) {
  const session = caps.sessionCreditCap === null ? Number.POSITIVE_INFINITY : Math.max(0, caps.sessionCreditCap - spend.sessionCredits)
  const daily = caps.dailyCreditCap === null ? Number.POSITIVE_INFINITY : Math.max(0, caps.dailyCreditCap - spend.dailyCredits)
  return { session, daily, available: Math.min(session, daily) }
}

const capText = (caps: Caps, spend: Spend) => {
  const part = (label: string, cap: CreditCap, spent: number) =>
    cap === null ? `${label} has no cap` : `${label} has ${count(Math.max(0, cap - spent))} of ${count(cap)} credits left`
  return `${part("this session", caps.sessionCreditCap, spend.sessionCredits)} and ${part("the last 24 hours", caps.dailyCreditCap, spend.dailyCredits)}`
}

const RAISE = `Raise "sessionCreditCap" or "dailyCreditCap" in this plugin's options, set either to null for no cap, or wait for the 24-hour window to roll.`

/** Refuses a call whose price does not fit the caps. Nothing is sent to ElevenLabs. */
export function assertAffordable({ tool, price, caps, spend }: AffordInput) {
  if (price.credits <= remaining(caps, spend).available) return
  throw new SpendRefused(
    "SPEND_CAP_REACHED",
    `${tool} would spend ${price.basis === "at-most" ? "at most " : ""}${count(price.credits)} credits, and ${capText(caps, spend)}.`,
    RAISE,
  )
}

/** One line the model can repeat, with the figure it can trust and the day's total. */
export function costLine(price: Price, spend: Spend, caps: Caps) {
  const exact = price.basis === "exact" ? "" : "at most "
  const basis = price.parts.length ? ` (${price.parts.join(", ")})` : ""
  const today = caps.dailyCreditCap === null ? `${count(spend.dailyCredits)} credits today` : `${count(spend.dailyCredits)} of ${count(caps.dailyCreditCap)} credits today`
  return `Credits: ${exact}${count(price.credits)}${basis}; ${today}.`
}

/** The structured `cost` a result carries beside its output. */
export function costValue(price: Price, spend: Spend, caps: Caps) {
  return {
    credits: price.credits,
    basis: price.basis,
    sessionSpent: spend.sessionCredits,
    dailySpent: spend.dailyCredits,
    sessionCap: caps.sessionCreditCap,
    dailyCap: caps.dailyCreditCap,
  }
}

/** Appends a line to an MCP result's content, whether the content is text or parts. */
export function appendLine(result: { content?: unknown }, line: string) {
  const content = result.content
  if (typeof content === "string") result.content = `${content}\n${line}`
  else (result as { content?: unknown }).content = [...(Array.isArray(content) ? content : []), { type: "text", text: line }]
}

/**
 * Parses an `estimate_only` result for its price. Whether the estimate costs nothing, and whether its figure is the
 * batch total or one generation, are unverified until the live reconcile (DR-4): the figure is therefore `at-most`
 * when it is divided across generations, and the docs say so.
 */
export function estimatePrice(input: Record<string, unknown>, result: { readonly output?: unknown; readonly text?: string; readonly content?: unknown }): Price | undefined {
  const total = actualCreditsOf(result)
  if (total === undefined) return undefined
  const generations = generationsOf(input) ?? 1
  const perGeneration = generations > 1 ? total / generations : total
  return {
    credits: total,
    // ElevenLabs' own estimate, not a bill: a bound until the reconcile proves the unit.
    basis: generations > 1 ? "at-most" : "exact",
    parts: [`${generations} ${generations === 1 ? "generation" : "generations"}, estimated by ElevenLabs`],
    perGeneration,
  }
}

/** True when a call is the free `estimate_only` probe, which is never priced, capped or charged. */
export const isEstimate = (input: Record<string, unknown>) => input.estimate_only === true || input.estimateOnly === true

/** The layer between a hook and the plugin: what the model path and the script path both ask. */
export interface GuardCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  /** The call's own id, which its reservation is held under until it settles. */
  readonly id: string
}

export interface GuardInput {
  readonly ledger: Ledger
  readonly caps: () => Caps
  /** The server's own estimate, for a tool that accepts `estimate_only`. Only the model path can await it. */
  readonly estimate?: (tool: string, input: Record<string, unknown>, call: GuardCall) => Promise<Price | undefined>
}

export interface Quote {
  readonly price: Price
  /** False when both caps are off, so nothing was reserved and nothing will be charged. */
  readonly tracked: boolean
}

/**
 * Prices a call, clamps its generation count, and reserves the price before it is sent. The reservation is what makes a
 * parallel turn safe: the check and the hold happen with no await between them.
 *
 * The model path awaits a real `estimate_only` call for image and video, once, and remembers the price for the arguments;
 * the script path is synchronous and can only use the table or a price the script itself fetched. Both refuse rather
 * than guess.
 */
export async function quoteCall(input: GuardInput, tool: string, args: Record<string, unknown>, call: GuardCall): Promise<Quote> {
  return quote(input, tool, args, true, call)
}

/** The synchronous form, for a path that cannot await: the tools RPC's shapers. */
export function quoteCallSync(input: Omit<GuardInput, "estimate">, tool: string, args: Record<string, unknown>, call: GuardCall): Quote {
  return quoteSync(input, tool, args, call)
}

const isTranscription = (tool: string) => tool === "creative_transcribe_audio" || tool === "speech_to_text" || tool === "creative_transcription"

async function quote(context: GuardInput, tool: string, args: Record<string, unknown>, mayEstimate: boolean, call: GuardCall): Promise<Quote> {
  if (isEstimate(args) || !mustPrice(tool)) return { price: { credits: 0, basis: "exact", parts: [] }, tracked: false }
  const caps = context.caps()
  if (caps.sessionCreditCap === null && caps.dailyCreditCap === null) {
    return { price: priceOf(tool, args) ?? { credits: 0, basis: "at-most", parts: ["cost not tracked: both caps are off"] }, tracked: false }
  }
  let price = priceOf(tool, args)
  if (price === undefined && mayEstimate && priced(tool) && context.estimate) {
    price = await context.estimate(tool, args, call)
    if (price) context.ledger.rememberPrice(tool, args, price)
  }
  price ??= context.ledger.rememberedPrice(tool, args)
  if (price === undefined || !(price.credits > 0)) throw unknownPrice(tool, priced(tool))
  price = clamp(price, caps, args, context.ledger.spend(call.sessionID))
  context.ledger.reserve(call.id, call.sessionID, price.credits, caps)
  await context.ledger.flush()
  return { price, tracked: true }
}

function quoteSync(context: Omit<GuardInput, "estimate">, tool: string, args: Record<string, unknown>, call: GuardCall): Quote {
  if (isEstimate(args) || !mustPrice(tool)) return { price: { credits: 0, basis: "exact", parts: [] }, tracked: false }
  const caps = context.caps()
  if (caps.sessionCreditCap === null && caps.dailyCreditCap === null) {
    return { price: priceOf(tool, args) ?? { credits: 0, basis: "at-most", parts: ["cost not tracked: both caps are off"] }, tracked: false }
  }
  let price = priceOf(tool, args) ?? context.ledger.rememberedPrice(tool, args)
  if (price === undefined || !(price.credits > 0)) throw unknownPrice(tool, priced(tool))
  price = clamp(price, caps, args, context.ledger.spend(call.sessionID))
  context.ledger.reserve(call.id, call.sessionID, price.credits, caps)
  return { price, tracked: true }
}

/** Cuts a request for more variations than the budget affords to what it can pay for, and prices what will run. */
function clamp(price: Price, caps: Caps, args: Record<string, unknown>, spend: Spend): Price {
  const generations = generationsOf(args)
  if (price.perGeneration === undefined || generations === undefined || generations <= 1) return price
  const left = remaining(caps, spend).available
  const allowed = Math.max(1, Math.min(generations, Math.floor(left / price.perGeneration)))
  if (allowed >= generations) return price
  clampGenerations(args, allowed)
  return { ...price, credits: price.perGeneration * allowed, basis: "at-most", parts: [`${allowed} ${allowed === 1 ? "generation" : "generations"}, at ElevenLabs' estimate`] }
}

/**
 * The refusal for a call nothing can price. A tool the plugin may price with the server's estimate says so; one whose
 * schema is not attested is offered the one next step that always works, turning both caps off (DR-5).
 */
function unknownPrice(tool: string, estimable: boolean) {
  if (isTranscription(tool)) {
    return new SpendRefused(
      "PRICE_UNKNOWN",
      `${tool} cannot be priced from the file about to be sent, so the cap cannot be checked before it runs.`,
      `Pass the audio as a local file whose container states a duration (WAV or MP4/M4A). A duration you type cannot set the price. Or set both caps to null to run it unpriced.`,
    )
  }
  return new SpendRefused(
    "PRICE_UNKNOWN",
    `${tool} has no published credit price and no remembered estimate, so the cap cannot be checked before it runs.`,
    estimable
      ? `Call ${tool} once with "estimate_only": true and the same arguments to get its price, then call it again; or set both caps to null to run it unpriced.`
      : `This plugin does not know whether ${tool} accepts "estimate_only". Set both "sessionCreditCap" and "dailyCreditCap" to null to run it unpriced, or price it from another call's estimate.`,
  )
}

/** The error a refused call raises, for a caller that has no code of its own. */
export const spendError = (code: Extract<PluginCode, "SPEND_CAP_REACHED" | "PRICE_UNKNOWN">, message: string, nextStep: string) =>
  elevenlabsError(code, message, nextStep)

export { ESTIMATE_TOOLS, mustPrice, spends }
