import { randomUUID } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { elevenlabsError, type PluginCode } from "./constants.js"
import { ESTIMATE_TOOLS, known, mustPrice, priced, spends } from "./elevenlabs-tools.js"
import type { CreditCap } from "./options.js"

/**
 * The most a call can cost, and how the figure was reached. `at-most` is a bound; `exact` is what ElevenLabs' own
 * estimate returned for exactly these arguments, or what a result reported.
 *
 * Every price here comes from ElevenLabs' own estimate: the same tool, the same arguments and `estimate_only: true`.
 * The plugin computes no price of its own. Published per-character and per-minute rates priced tools this server does
 * not have — it generates into a flow, with a model the caller names out of an enum of a hundred — and a formula that
 * cannot see which model runs is not a bound on anything (LIVE-RECONCILE-1).
 */
export interface Price {
  readonly credits: number
  readonly basis: "exact" | "at-most"
  /** The parts, for the cost line: "4 generations, estimated by ElevenLabs". */
  readonly parts: readonly string[]
  /** What one variation costs, when the tool takes a generation count: used to clamp the request to the budget. */
  readonly perGeneration?: number
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined)
const count = (value: number) => value.toLocaleString("en-US")

/**
 * The generation-count key. The live catalogue spells it one way — `generations_count`, on the six creative tools that
 * batch — so there is one key to read, one to clamp and one to write back; test/unit/live-schema.test.ts holds this
 * list against the live schemas in both directions. A count under any other name is an argument the tool's own schema
 * does not have, and is refused before it is ever priced rather than read as a count the server would ignore.
 */
export const GENERATION_KEYS = ["generations_count"] as const

/**
 * What ElevenLabs generates when a call names no count: the `default` its own live schema gives `generations_count`.
 * An estimate answers for the batch the arguments ask for, so this is the divisor that turns one into a per-generation
 * figure, and the reason a speech call that names no count is priced at two takes rather than one.
 *
 * `creative_generate_in_flow` and `creative_run_flow_nodes` declare the field with no default, and
 * `creative_transcribe_audio` has no count at all: for those the batch size is unknown unless the call states it, so
 * nothing is divided and nothing is clamped. test/unit/live-schema.test.ts holds these figures against the live
 * schemas.
 */
export const GENERATION_DEFAULTS: Readonly<Record<string, number>> = {
  creative_edit_image: 4,
  creative_generate_image: 4,
  creative_generate_speech: 2,
  creative_generate_video: 1,
}

/** A count field holding something no number can be read out of. The whole call's price multiplies by it. */
export const NOT_A_COUNT = Symbol("not a count")

/**
 * The count a field states. A caller that wrote `"4"` asked for four, so a numeric string is read as the number it
 * spells rather than passed over, which would price the call as if the field were not there, for counts.
 * Anything a number cannot be read out of is a multiplier this plugin cannot know, and so is PRICE_UNKNOWN. A zero or
 * a negative states nothing and leaves the count to the server, which is its own schema default.
 */
export const countValue = (value: unknown): number | undefined | typeof NOT_A_COUNT => {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : Number.NaN
  if (!Number.isFinite(parsed)) return NOT_A_COUNT
  return parsed >= 1 ? parsed : undefined
}

/**
 * The key the caller used for its generation count, or `undefined` when it named none. One helper for every path, so
 * the price, the clamp and the cost line all read the same field.
 */
export const generationsKeyOf = (input: Record<string, unknown>): string | undefined => GENERATION_KEYS.find((key) => input[key] !== undefined)

/**
 * The generations a call asks for, when it names any. `NOT_A_COUNT` when the field holds something no number can be
 * read out of: the batch total multiplies by the count, so a count nothing can be read out of leaves no figure about
 * the call that means anything.
 */
export const generationsOf = (input: Record<string, unknown>): number | undefined | typeof NOT_A_COUNT => {
  for (const key of GENERATION_KEYS) {
    const value = countValue(input[key])
    if (value !== undefined) return value
  }
  return undefined
}

/** Writes the clamped count into the key the caller used, or into the live one when it named none. */
export function clampGenerations(input: Record<string, unknown>, allowed: number): string {
  const key = generationsKeyOf(input) ?? GENERATION_KEYS[0]
  input[key] = allowed
  return key
}

/**
 * Every argument name each priced tool's own live schema declares, by tool. An estimate answers for the arguments it
 * is sent, so an argument the schema does not have is one whose effect on the bill nothing here knows — and sending it
 * to the estimate would not price it either, because the server would be pricing a call it does not understand. Such a
 * call is refused PRICE_UNKNOWN while a cap is on, rather than priced as if the argument were not there.
 *
 * These are copies of the live schemas, taken on 2026-11-09; `test/unit/live-schema.test.ts` holds every one of them
 * against `test/fixtures/live-tools.json`, so an argument ElevenLabs adds upstream fails the suite rather than
 * reaching a paid call unpriced. `docs/architecture.md` lists them for the reader.
 *
 * Only the seven tools that accept `estimate_only` are here. The other two spending tools — `creative_design_voice`
 * and `agents_run_tests` — have no estimate at all, so nothing prices them and a cap refuses them whatever they carry.
 */
export const PRICED_ARGUMENTS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ["creative_edit_image", new Set(["connect_from", "context", "estimate_only", "flow_id", "generations_count", "model_id", "prompt"])],
  ["creative_generate_image", new Set(["connect_from", "context", "estimate_only", "flow_id", "generations_count", "model_id", "prompt"])],
  [
    "creative_generate_in_flow",
    new Set(["connect_from", "context", "estimate_only", "flow_id", "generations_count", "model_id", "node_type", "prompt", "view_state_id", "voice_id"]),
  ],
  ["creative_generate_speech", new Set(["context", "estimate_only", "flow_id", "generations_count", "model_id", "prompt", "view_state_id", "voice_id"])],
  ["creative_generate_video", new Set(["connect_from", "context", "estimate_only", "flow_id", "generations_count", "model_id", "prompt"])],
  ["creative_run_flow_nodes", new Set(["context", "estimate_only", "flow_id", "generations_count", "node_ids"])],
  ["creative_transcribe_audio", new Set(["connect_from", "context", "estimate_only", "flow_id", "model_id", "view_state_id"])],
])

/** The first argument a priced call carries that its tool's allowlist does not have, in words the caller can act on. */
export function unknownArgument(name: string, input: Record<string, unknown>): string | undefined {
  const allowed = PRICED_ARGUMENTS.get(name.toLowerCase())
  if (allowed === undefined) return undefined
  const unknown = Object.keys(input).find((argument) => !allowed.has(argument))
  return unknown === undefined ? undefined : `"${unknown}" is an argument ElevenLabs' own schema for this tool does not have, so its effect on the bill is unknown`
}

/**
 * The credits a result reports, when it reports any. Undefined means the figure is not known and is never invented.
 * The host's own `Tool.Result` carries `output` and `content`, not `text`, so both are read here.
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
 * attested positive figure may settle below the reserved price. Each name here says *this call's charge*:
 * `credit_cost` is not one of them, because it reads as readily as a per-unit rate, and until the live reconcile
 * observes it carrying a charge, a rate that lowered a reservation would be the plugin's own parse error.
 */
const ATTESTED_CREDIT_KEYS = new Set(["credits", "credits_used", "credits_charged", "billed_credits", "total_credits"])

/**
 * How far below the reservation a reported figure may sit and still be read as this call's charge. A result that
 * reports 1 credit against 3,000 reserved is not this call's charge in any pricing this plugin knows — it is a count,
 * a rate, or another call's figure — and freeing a budget on a field the plugin may have read wrong is the one
 * mistake an owner pays for twice. Below the bound the reservation stands and the cost line says why.
 *
 * A tenth is what ElevenLabs' own published prices span below a reservation: a bound computed from two takes settles
 * at one, and a generation count the server clamped settles below. There is no bound above it; see `raiseTo`.
 */
const ATTESTED_MIN_RATIO = 10

/** A raise more than this many times the reservation is still charged, and the cost line says it was. */
const RAISE_NOTE_RATIO = 10

/** One object's own attested figure: a named key, at this level, positive. No prose, no walk into what it contains. */
function attestedIn(value: unknown): number | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!ATTESTED_CREDIT_KEYS.has(key.toLowerCase())) continue
    const credits = number(item)
    if (credits !== undefined && credits > 0) return credits
  }
  return undefined
}

export function attestedCreditsOf(result: { readonly output?: unknown }): number | undefined {
  return attestedIn(result.output)
}

/**
 * The figure an `estimate_only` result states, read under the rules settlement reads a charge under: the same
 * five named keys, at a named level, positive, in a fixed order — no prose, and no walk down four levels of whatever
 * the server returned.
 *
 * `estimate.credits` is read first because that is the field the live result uses: the pass-1 estimate for four
 * images came back as `{"estimate": {"credits": 761.5151418103446}}` (LIVE-RECONCILE-1). The top level is read next,
 * for a server that states the figure without the wrapper.
 *
 * The figure sets the reservation, and where no later figure is seen it sets the charge, so it is at least as
 * load-bearing as one that may settle below a reservation; it was being read more loosely than that one. A figure
 * this parser does not find leaves the call with no price, which a cap turns into `PRICE_UNKNOWN` — a refusal, not a
 * guess.
 */
export function estimatedCreditsOf(result: { readonly output?: unknown; readonly text?: string; readonly content?: unknown }): number | undefined {
  for (const value of [result.output, ...textsOf(result).map((text) => parseJson(text))]) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue
    const nested = attestedIn((value as Record<string, unknown>).estimate)
    if (nested !== undefined) return nested
    const top = attestedIn(value)
    if (top !== undefined) return top
  }
  return undefined
}

/**
 * The figure a completed call is settled at. A higher figure always raises the charge, whatever its size, clamped at
 * the day's cap. A lower one is believed only when an attested field states it and it reads as this call's charge; a
 * prose match, a zero and a missing result all keep the reservation.
 *
 * `held` says what `reserved` is: a live hold, which one attested figure inside the band may settle below, or a
 * charge this call has already been recorded at, which nothing lowers. A second result for one call is a repeat, not
 * a correction — the plugin cannot tell which of the two figures the server meant — so the higher one stands.
 */
export function settlementOf(
  result: { readonly output?: unknown; readonly text?: string; readonly content?: unknown },
  reserved: number,
  dailyCap: CreditCap = null,
  held: "hold" | "charge" = "hold",
): { readonly credits: number; readonly attested: boolean; readonly note?: string } {
  const attested = attestedCreditsOf(result)
  if (attested !== undefined) {
    if (attested > reserved) return { ...raiseTo(attested, reserved, dailyCap), attested: true }
    if (held === "charge") {
      return { credits: reserved, attested: false, note: `the result reported ${count(attested)} against ${count(reserved)} already charged for this call, so the recorded charge stands` }
    }
    // Lowering a reservation is the one thing a figure the plugin may have misread can do with the owner's money, so
    // it has to look like a charge for this call: not orders of magnitude below the hold.
    if (attested * ATTESTED_MIN_RATIO < reserved) {
      return { credits: reserved, attested: false, note: `the result reported ${count(attested)} against ${count(reserved)} reserved, too far below to be this call's charge, so the reserved price stands` }
    }
    // ElevenLabs' own figures are fractional — an image estimate came back 761.5151418103446 credits — so a charge
    // need not be a whole number, and a rule that kept the reservation for every non-integer would ignore the server's
    // own word on the ordinary case. Credits are whole in the ledger, so the fraction rounds up: the over-priced side.
    return { credits: Math.ceil(attested), attested: true }
  }
  const parsed = actualCreditsOf(result)
  if (parsed !== undefined && parsed > reserved) return { ...raiseTo(parsed, reserved, dailyCap), attested: false }
  return { credits: reserved, attested: false }
}

/**
 * The charge a figure above the reservation settles at. A higher figure is always charged: whatever the plugin makes
 * of it, the server says this call cost that much, and a ceiling that kept the reservation instead is a cap that
 * under-counts real money. The clamp is the day's cap, so the worst an absurd figure can do is spend one window's
 * budget and refuse every later call until the window rolls — rather than poison a 24-hour total with a number no
 * real call could reach. Credits are whole, so a fraction rounds up — the over-priced side again. Any raise of more
 * than ten times is charged all the same, and said aloud in the cost line, so the owner sees it for what it is.
 *
 * `reported` is finite and not negative: nothing else is read as a figure in the first place.
 */
function raiseTo(reported: number, reserved: number, dailyCap: CreditCap): { readonly credits: number; readonly note?: string } {
  const ceiling = Math.ceil(reported)
  const credits = Math.max(reserved, dailyCap === null ? ceiling : Math.min(ceiling, dailyCap))
  if (ceiling <= reserved * RAISE_NOTE_RATIO) return { credits }
  const capped = credits < ceiling ? `, charged at the day's cap of ${count(credits)}` : ""
  return { credits, note: `the result reported ${count(ceiling)} against ${count(reserved)} reserved${capped}, more than ten times the reserved price` }
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
// two calls that start together cannot both fit one budget.
//
// The store is append-only and single-writer per key. Every hold and every charge is its own key,
// `spend/<writerId>/<entryId>`, where `writerId` names one plugin instance; only that instance rewrites the keys it
// created. Totals are a scan of `spend/` and a sum. Nothing merges two writers' views of one record, nothing takes the
// larger of two figures, and no writer reads a shared record, changes it and writes it back, so no write can drop
// another writer's charge. Detail keys older than the newest thousand fold into that writer's own hourly totals,
// `spend/<writerId>/h/<hour>`, which are summed across writers because no two writers share an hour's key.
//
// Within one process the caps are exact; two calls started at the same instant in two processes can exceed a cap by at
// most one call's reservation; a settled charge is never lost.
// ---------------------------------------------------------------------------------------------------------------

/** The single record this plugin wrote before the ledger became append-only. Read and counted, never written again. */
export const LEDGER_KEY = "spend.ledger"
/** Every ledger key sits under this prefix, so one scan reads the whole book. `spend.ledger` sorts before it. */
export const SPEND_PREFIX = "spend/"
const WINDOW_MS = 24 * 60 * 60 * 1000
/** A hold still open after this is settled at the reserved price. Ten minutes is inside a long video; expiry must not free the budget. */
export const RESERVATION_MS = 10 * 60 * 1000
/**
 * How often a plugin instance reads the store on its own, with no call to prompt it. This is what bounds a process
 * that is idle, or whose calls all refuse, and so writes nothing and never refreshes behind itself: without it a
 * book decides from its startup read for the process's whole life, and an OpenCode started this morning admits a
 * fresh cap this evening. Five seconds is one `scan` of `spend/`, the same read setup already does.
 */
export const LEDGER_REFRESH_MS = 5_000
/** The detail keys one writer keeps. An in-window charge past that folds into an hour's total, which never shrinks. */
const MAX_ENTRIES = 1_000
/**
 * How finely a folded total keeps its time. A folded charge loses its own timestamp, so it ages with the hour
 * it joined: one key per hour bounds the over-count at one hour, where one key per session bounded it at a day.
 */
const BUCKET_MS = 60 * 60 * 1000
/** The hour a charge belongs to, as the start of that hour. Folded credits age from here. */
const bucketOf = (at: number) => Math.floor(at / BUCKET_MS) * BUCKET_MS
/** Keys per scan page. The store clamps this to 1,000, and one writer's day is far fewer keys than one page. */
const SCAN_LIMIT = 1_000
/** A bound on the scan loop, so a store that keeps offering another page cannot hang a call that is about to run. */
const MAX_SCAN_PAGES = 64

/**
 * One call's key: a hold while it is in flight, the charge it settled at afterwards. Both count the same against a
 * cap, so a hold that expires, or one belonging to a writer that went away, is never a budget this plugin frees.
 */
interface Row {
  kind: "hold" | "charge"
  /** When the credits were reserved or spent, in epoch milliseconds. A row ages from here. */
  at: number
  credits: number
  /** The session that spent them, so a reload restores its total too. */
  sessionID: string
}

/** One writer's folded hour: what its detail rows for that hour came to, per session. It ages from `at`. */
interface Folded {
  at: number
  bySession: Map<string, number>
}

/** What the pre-append-only record still contributes. Counted while it is in the window; never written. */
interface Legacy {
  rows: Array<{ at: number; credits: number; sessionID: string; hourly: boolean }>
}

interface Book {
  /** This book's name in the store. Every key it writes starts with it, and no other book writes those keys. */
  writerId: string
  /** The rows this book owns, by entry id. Only it rewrites them, and only it folds them. */
  own: Map<string, Row>
  /** The hours this book has folded, by the hour they belong to. */
  folded: Map<number, Map<string, number>>
  /** What the last scan read under every other writer's row keys, by full key. Counted, never rewritten. */
  others: Map<string, Row>
  /** The other writers' folded hours, by full key. Summed with this book's: no two writers share an hour's key. */
  otherFolded: Map<string, Folded>
  legacy: Legacy
  chain: Promise<void>
}

/** One book per storage object, so two Ledger instances in this process see each other's holds without waiting. */
const books = new WeakMap<object, Book>()

const emptyBook = (writerId: string): Book => ({
  writerId,
  own: new Map(),
  folded: new Map(),
  others: new Map(),
  otherFolded: new Map(),
  legacy: { rows: [] },
  chain: Promise.resolve(),
})

const bookFor = (storage: object, writerId: string): Book => {
  const found = books.get(storage)
  if (found) return found
  const book = emptyBook(writerId)
  books.set(storage, book)
  return book
}

/** A row key and an hour key for this writer. An entry id never contains a slash, so the two shapes cannot collide. */
const rowKey = (writerId: string, entryId: string) => `${SPEND_PREFIX}${writerId}/${entryId}`
const hourKey = (writerId: string, hour: number) => `${SPEND_PREFIX}${writerId}/h/${hour}`

/** Reads a scanned key back: which writer wrote it, and which hour it totals when it is an hour key. */
function keyParts(key: string): { writerId: string; hour?: number } | undefined {
  if (!key.startsWith(SPEND_PREFIX)) return undefined
  const rest = key.slice(SPEND_PREFIX.length)
  const slash = rest.indexOf("/")
  if (slash <= 0 || slash === rest.length - 1) return undefined
  const writerId = rest.slice(0, slash)
  const tail = rest.slice(slash + 1)
  if (!tail.startsWith("h/")) return { writerId }
  const hour = Number(tail.slice(2))
  return Number.isSafeInteger(hour) ? { writerId, hour } : undefined
}

export interface Spend {
  readonly sessionCredits: number
  readonly dailyCredits: number
}

export interface Caps {
  readonly sessionCreditCap: CreditCap
  readonly dailyCreditCap: CreditCap
}

type Storage = Pick<Plugin.Context["storage"], "get" | "set" | "remove" | "scan">

export interface LedgerInput {
  readonly storage?: Storage
  readonly now?: () => number
  /**
   * The name this book writes its keys under. One is generated per storage object, so two locations and two OpenCode
   * processes never share one; a test sets it to stage two writers it can name.
   */
  readonly writerId?: string
}

/** The ledger both paths share: the model's hooks and a script's shapers reserve, settle and record the same totals. */
export class Ledger {
  private readonly local: Book
  private readonly writerId: string
  private readonly remembered = new Map<string, { price: Price; at: number }>()
  /** This ledger's clock, public so a caller that ages its own bookkeeping ages it on the same clock the holds use. */
  readonly now: () => number
  private storage: Storage | undefined
  private hydrated: Promise<void> | undefined
  private writing: Promise<void> = Promise.resolve()

  constructor(input: LedgerInput = {}) {
    this.storage = input.storage
    this.now = input.now ?? (() => Date.now())
    this.writerId = input.writerId ?? randomUUID()
    this.local = emptyBook(this.writerId)
  }

  /** The book this ledger writes. Two instances on one storage object share it, and share its writer name. */
  private book(): Book {
    return this.storage ? bookFor(this.storage, this.writerId) : this.local
  }

  /** Reads the store once. A storage failure leaves the totals as they are. */
  hydrate(): Promise<void> {
    this.hydrated ??= this.refresh()
    return this.hydrated
  }

  /**
   * Starts a read of the store and does not wait for it, so the next decision this ledger makes sees what the other
   * OpenCodes had written by now. The synchronous path cannot await before it dispatches, so it bounds its
   * own staleness behind itself instead of in front: a book that decides is then at most one call old, rather than
   * as old as the process. A storage failure leaves the book as it is, exactly as `hydrate` does.
   */
  catchUp(): void {
    void this.refresh().catch(() => undefined)
  }

  /**
   * Scans `spend/` and rebuilds what the other writers hold, so a decision about to be made sees every charge and hold
   * already in the store. This book's own rows are never read back: it is their only writer, and its memory is ahead
   * of the store by at most the write in flight.
   */
  refresh(): Promise<void> {
    const book = this.book()
    return this.enqueue(async () => {
      const storage = this.storage
      if (!storage) return
      const others = new Map<string, Row>()
      const otherFolded = new Map<string, Folded>()
      let after: string | undefined
      for (let page = 0; page < MAX_SCAN_PAGES; page++) {
        const result = await storage.scan({ prefix: SPEND_PREFIX, after, limit: SCAN_LIMIT })
        for (const entry of result.entries) {
          const parts = keyParts(entry.key)
          if (!parts || parts.writerId === book.writerId) continue
          if (parts.hour === undefined) {
            const row = parseRow(entry.value)
            if (row) others.set(entry.key, row)
            continue
          }
          const bySession = parseHour(entry.value)
          if (bySession) otherFolded.set(entry.key, { at: parts.hour, bySession })
        }
        if (result.next === undefined || result.entries.length === 0) break
        after = result.next
      }
      book.others = others
      book.otherFolded = otherFolded
      book.legacy = parseLegacy(await storage.get(LEDGER_KEY))
    })
  }

  /** The credits spent in the last 24 hours, reservations and folded totals included. */
  daily(): number {
    this.prune()
    return total(this.book(), undefined, this.now())
  }

  session(sessionID: string): number {
    this.prune()
    return total(this.book(), sessionID, this.now())
  }

  spend(sessionID: string): Spend {
    return { sessionCredits: this.session(sessionID), dailyCredits: this.daily() }
  }

  /**
   * Holds `credits` for a call before it is sent, and refuses when it does not fit. Nothing awaits between the check
   * and the hold, so two calls that start together in this process cannot both pass: the second sees the first's
   * reservation, including one held by another ledger on the same storage. The returned promise is the hold's
   * own key reaching the store; a caller that can await it does so before the call is dispatched, and a write that
   * fails takes the hold back out of memory and refuses the call rather than spend against a cap it cannot keep.
   */
  reserve(id: string, sessionID: string, credits: number, caps: Caps): Promise<void> {
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
    const book = this.book()
    const row: Row = { kind: "hold", at: this.now(), credits, sessionID }
    book.own.set(id, row)
    return this.writeRow(book, id, row, () => {
      if (book.own.get(id) === row) book.own.delete(id)
    })
  }

  /** The reservation a call holds, if any. */
  reservation(id: string) {
    const row = this.book().own.get(id)
    return row?.kind === "hold" ? row : undefined
  }

  /**
   * What this ledger has for one call, a live hold or a recorded charge. A caller settling a result reads its floor
   * from here rather than from its own memory of the reservation, which a second result finds already spent.
   */
  recorded(id: string): { readonly kind: "hold" | "charge"; readonly credits: number } | undefined {
    const row = this.book().own.get(id)
    return row === undefined ? undefined : { kind: row.kind, credits: row.credits }
  }

  /**
   * Turns a reservation into a recorded charge, on the hold's own key. A recorded charge only ever rises. The first
   * settlement of a live hold may lower it — an attested figure, inside the band, is the server saying this call cost
   * less than the bound — and every settlement after that may only raise it: a repeated or duplicated result is
   * ignored unless it is higher. The floor is this row's own figure, not the caller's idea of what was reserved,
   * because by the time a second result arrives the hold may already be a charge, settled here or converted by
   * `prune` at minute ten, and a caller reading `reservation` then sees nothing and would offer zero.
   */
  settle(id: string, sessionID: string, credits: number, attested = false): Spend {
    const book = this.book()
    const held = book.own.get(id)
    const floor = held?.credits ?? 0
    // A charge keeps the session that reserved it, the same way it keeps that row's own figure as its floor.
    // The argument opens a row that does not exist yet and does nothing else: a result delivered under a second
    // session would otherwise move the charge there and hand the first session its whole session cap back.
    const owner = held?.sessionID ?? sessionID
    // The band is checked here as well as in `settlementOf`, because here the row's own figure is known.
    const lowerable = held?.kind === "hold" && attested && credits > 0 && credits * ATTESTED_MIN_RATIO >= floor
    const charge = credits > floor || lowerable ? credits : floor
    if (charge > 0 && !(held?.kind === "charge" && held.credits === charge)) {
      const row: Row = { kind: "charge", at: held?.at ?? this.now(), credits: charge, sessionID: owner }
      book.own.set(id, row)
      this.store(this.writeRow(book, id, row))
    } else if (charge <= 0 && held) {
      book.own.delete(id)
      this.store(this.removeKey(book, rowKey(book.writerId, id)))
    }
    this.prune()
    // The cost line is drawn from this, so it reports the budget the charge actually came out of.
    return this.spend(owner)
  }

  /** A failure settles the reserved price. It does not free the budget: a billed error and a free one look the same. */
  release(id: string) {
    const held = this.reservation(id)
    if (!held) return
    this.settle(id, held.sessionID, held.credits)
  }

  /** Records a completed call. The memory total moves at once; its own key follows, one write at a time. */
  record(sessionID: string, credits: number, at = this.now()): Spend {
    if (credits > 0) {
      const book = this.book()
      const id = randomUUID()
      const row: Row = { kind: "charge", at, credits, sessionID }
      book.own.set(id, row)
      this.store(this.writeRow(book, id, row))
      this.prune()
    }
    return this.spend(sessionID)
  }

  /** Remembers a price the server itself gave for one tool, so a later call with the same arguments can be priced. */
  rememberPrice(tool: string, input: Record<string, unknown>, price: Price) {
    // Swept here as well as in `prune`, because a session that only ever estimates never settles or records anything,
    // and this is the one place that grows.
    this.forgetStaleEstimates()
    this.remembered.set(keyOf(tool, input), { price, at: this.now() })
  }

  /** The remembered price for exactly these arguments, if it is still fresh. */
  rememberedPrice(tool: string, input: Record<string, unknown>): Price | undefined {
    const found = this.remembered.get(keyOf(tool, input))
    if (!found) return undefined
    return this.now() - found.at > RESERVATION_MS ? undefined : found.price
  }

  /**
   * Drops the estimates that can no longer price anything. `rememberedPrice` already refuses to return one past its
   * ten minutes, so this frees memory rather than changing an answer — but the key it holds is the tool name plus the
   * stable JSON of every argument, which means the whole prompt. A cache with an expiry drops what expired, on the
   * same sweep that ages everything else, and this plugin does not keep prompt text it can no longer use.
   */
  private forgetStaleEstimates(now = this.now()) {
    for (const [key, held] of [...this.remembered]) {
      if (now - held.at > RESERVATION_MS) this.remembered.delete(key)
    }
  }

  /** Forgets everything this book holds in memory. The tests use it. */
  reset() {
    const book = this.book()
    book.own.clear()
    book.folded.clear()
    book.others.clear()
    book.otherFolded.clear()
    book.legacy = { rows: [] }
    this.remembered.clear()
  }

  /**
   * Ages the book. An expired hold becomes the charge it reserved, on its own key. A row past the window loses its
   * key, which is the one thing that removes a key: a key inside the window is only ever rewritten by its own writer,
   * or folded, and a fold writes the hour's total before it removes the detail it came from.
   */
  private prune() {
    const book = this.book()
    const now = this.now()
    const horizon = now - WINDOW_MS
    this.forgetStaleEstimates(now)
    for (const [id, row] of [...book.own]) {
      if (row.at < horizon) {
        book.own.delete(id)
        this.store(this.removeKey(book, rowKey(book.writerId, id)))
        continue
      }
      if (row.kind === "hold" && row.at < now - RESERVATION_MS) {
        const charge: Row = { kind: "charge", at: row.at, credits: row.credits, sessionID: row.sessionID }
        book.own.set(id, charge)
        this.store(this.writeRow(book, id, charge))
      }
    }
    for (const hour of [...book.folded.keys()]) {
      if (hour + BUCKET_MS >= horizon) continue
      book.folded.delete(hour)
      this.store(this.removeKey(book, hourKey(book.writerId, hour)))
    }
    // Another writer's key is never rewritten, but once it is past the window it holds nothing any cap counts, and
    // leaving it would grow the scan without bound across restarts, each of which is a new writer.
    for (const [key, row] of [...book.others]) {
      if (row.at >= horizon) continue
      book.others.delete(key)
      this.store(this.removeKey(book, key))
    }
    for (const [key, folded] of [...book.otherFolded]) {
      if (folded.at + BUCKET_MS >= horizon) continue
      book.otherFolded.delete(key)
      this.store(this.removeKey(book, key))
    }
    if (book.legacy.rows.length > 0) {
      const live = book.legacy.rows.filter((row) => (row.hourly ? row.at + BUCKET_MS >= horizon : row.at >= horizon))
      if (live.length === 0) {
        book.legacy = { rows: [] }
        this.store(this.removeKey(book, LEDGER_KEY))
      } else book.legacy = { rows: live }
    }
    const excess = book.own.size - MAX_ENTRIES
    if (excess <= 0) return
    const settled = [...book.own].filter(([, row]) => row.kind === "charge").sort((a, b) => a[1].at - b[1].at)
    const hours = new Set<number>()
    const detail: string[] = []
    for (const [id, row] of settled.slice(0, excess)) {
      const hour = bucketOf(row.at)
      const bySession = book.folded.get(hour) ?? new Map<string, number>()
      bySession.set(row.sessionID, (bySession.get(row.sessionID) ?? 0) + row.credits)
      book.folded.set(hour, bySession)
      book.own.delete(id)
      hours.add(hour)
      detail.push(rowKey(book.writerId, id))
    }
    this.store(this.writeFold(book, hours, detail))
  }

  /**
   * Writes the hours a fold touched, then removes the detail keys they now hold, as one piece of work on the chain.
   * That order is deliberate: a crash between the two can only count a charge twice, which refuses more calls, never
   * fewer. The other order would lose one.
   */
  private writeFold(book: Book, hours: Set<number>, detail: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      const storage = this.storage
      if (!storage) return
      for (const hour of hours) {
        const bySession = book.folded.get(hour)
        if (bySession) await storage.set(hourKey(book.writerId, hour), { at: hour, sessions: Object.fromEntries(bySession) })
      }
      for (const key of detail) await storage.remove(key)
    })
  }

  /** Writes one row's own key. No other writer touches it, so there is nothing to merge and nothing to read back. */
  private writeRow(book: Book, id: string, row: Row, undo?: () => void): Promise<void> {
    return this.enqueue(async () => {
      const storage = this.storage
      if (!storage) return
      try {
        await storage.set(rowKey(book.writerId, id), { kind: row.kind, at: row.at, credits: row.credits, sessionID: row.sessionID })
      } catch (error) {
        undo?.()
        throw error
      }
    }, undo !== undefined)
  }

  private removeKey(_book: Book, key: string): Promise<void> {
    return this.enqueue(async () => {
      await this.storage?.remove(key)
    })
  }

  /**
   * Runs one piece of storage work, in order, on the chain this book shares. A failure is swallowed unless the caller
   * asked to hear about it: the in-memory total still bounds this process, and a write that failed after a generation
   * already ran must not turn into an error the caller sees instead of its result.
   */
  private enqueue(work: () => Promise<void>, raise = false): Promise<void> {
    const book = this.book()
    const run = book.chain.then(work)
    book.chain = run.then(
      () => undefined,
      () => undefined,
    )
    this.writing = book.chain
    if (!raise) return book.chain
    return run.catch((error: unknown) => {
      throw new SpendRefused(
        "SPEND_CAP_REACHED",
        `this call's reservation could not be written to the plugin's storage (${message(error)}), so the call was refused rather than spent against a cap this plugin could no longer keep.`,
        "Check that OpenCode can write its data directory, then run the call again.",
      )
    })
  }

  /** Keeps a fire-and-forget write off the unhandled-rejection path. The chain itself never rejects. */
  private store(work: Promise<void>) {
    void work.catch(() => undefined)
  }

  /** Waits for the writes in flight. The tests use it. */
  flush(): Promise<void> {
    return this.writing
  }
}

/** Every live row, every live folded hour and whatever the old record still holds, added up. No figure is taken over another. */
function total(book: Book, sessionID: string | undefined, now: number): number {
  const horizon = now - WINDOW_MS
  const mine = (id: string) => sessionID === undefined || id === sessionID
  let sum = 0
  for (const row of book.own.values()) if (row.at >= horizon && mine(row.sessionID)) sum += row.credits
  for (const row of book.others.values()) if (row.at >= horizon && mine(row.sessionID)) sum += row.credits
  for (const [hour, bySession] of book.folded) if (hour + BUCKET_MS >= horizon) sum += hourTotal(bySession, sessionID)
  for (const folded of book.otherFolded.values()) if (folded.at + BUCKET_MS >= horizon) sum += hourTotal(folded.bySession, sessionID)
  for (const row of book.legacy.rows) {
    const live = row.hourly ? row.at + BUCKET_MS >= horizon : row.at >= horizon
    if (live && mine(row.sessionID)) sum += row.credits
  }
  return sum
}

const hourTotal = (bySession: Map<string, number>, sessionID: string | undefined) => {
  if (sessionID !== undefined) return bySession.get(sessionID) ?? 0
  let sum = 0
  for (const credits of bySession.values()) sum += credits
  return sum
}

function parseRow(value: unknown): Row | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (typeof row.at !== "number" || typeof row.credits !== "number" || typeof row.sessionID !== "string") return undefined
  return { kind: row.kind === "hold" ? "hold" : "charge", at: row.at, credits: row.credits, sessionID: row.sessionID }
}

function parseHour(value: unknown): Map<string, number> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const sessions = (value as Record<string, unknown>).sessions
  if (sessions === null || typeof sessions !== "object" || Array.isArray(sessions)) return undefined
  const bySession = new Map<string, number>()
  for (const [sessionID, credits] of Object.entries(sessions as Record<string, unknown>)) {
    if (typeof credits === "number" && Number.isFinite(credits)) bySession.set(sessionID, credits)
  }
  return bySession
}

/**
 * The record written before the ledger became append-only: its charges, its holds and its folded totals, read as rows
 * that still count. A total written before the hourly keys holds the newest folded charge's own time; rounding it to
 * its hour only ever lengthens the window it had, which is the side a cap must err on.
 */
function parseLegacy(stored: unknown): Legacy {
  const rows: Legacy["rows"] = []
  const take = (value: unknown, hourly: boolean) => {
    if (!Array.isArray(value)) return
    for (const item of value) {
      if (item === null || typeof item !== "object") continue
      const row = item as Record<string, unknown>
      if (typeof row.at !== "number" || typeof row.credits !== "number" || typeof row.sessionID !== "string") continue
      rows.push({ at: hourly ? bucketOf(row.at) : row.at, credits: row.credits, sessionID: row.sessionID, hourly })
    }
  }
  if (Array.isArray(stored)) take(stored, false)
  else if (stored !== null && typeof stored === "object") {
    const record = stored as Record<string, unknown>
    take(record.entries, false)
    take(record.holds, false)
    take(record.rolled, true)
  }
  return { rows }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A call's price key: the tool and its arguments, so a different prompt is a different price. `estimate_only` is left
 * out, because the estimate and the paid call it prices differ by exactly that flag, and the name's case is folded, as
 * the money gate folds it: an estimate sent in one case prices the paid call sent in another.
 */
const keyOf = (tool: string, input: Record<string, unknown>) => {
  const { estimate_only: _ignored, ...rest } = input
  return `${tool.toLowerCase()}\u0000${stable(rest)}`
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
 * Parses an `estimate_only` result for its price. The figure is the batch total for the arguments it was sent: a
 * four-image estimate came back 761.5151418103446 credits, about 190 an image, and the same call with
 * `generations_count: 1` came back a quarter of that (LIVE-RECONCILE-1). So the figure is not multiplied by anything
 * — it already counts the generations the call asked for, including the count ElevenLabs' own schema defaults to when
 * the call names none. Dividing by that batch size is what gives the clamp its unit.
 *
 * The figure itself is read by `estimatedCreditsOf`, under settlement's own rules rather than the looser walk a
 * reported charge is read with: `estimate.credits` first, the same five named keys, nothing out of prose.
 *
 * The estimate is fractional, and credits in the ledger are whole, so the total rounds up: the over-priced side. A
 * tool whose batch size cannot be known — `creative_generate_in_flow` and `creative_run_flow_nodes` name no default,
 * and `creative_transcribe_audio` has no count at all — is priced at its total with no per-generation figure, so the
 * clamp leaves it alone rather than cutting a count out of a figure it cannot divide.
 */
export function estimatePrice(
  tool: string,
  input: Record<string, unknown>,
  result: { readonly output?: unknown; readonly text?: string; readonly content?: unknown },
): Price | undefined {
  const reported = estimatedCreditsOf(result)
  if (reported === undefined) return undefined
  const asked = generationsOf(input)
  if (asked === NOT_A_COUNT) return undefined
  // What the figure covers: the count the call states, or the one the server's own schema applies when it states none.
  const covered = asked ?? GENERATION_DEFAULTS[tool.toLowerCase()]
  const credits = Math.ceil(reported)
  if (!(credits > 0)) return undefined
  const batch = covered === undefined ? [] : [`${count(covered)} ${covered === 1 ? "generation" : "generations"}${asked === undefined ? " by default" : ""}`]
  const rounded = credits === reported ? [] : [`rounded up from ${reported}`]
  return {
    credits,
    // What ElevenLabs' own estimate returned for exactly these arguments.
    basis: "exact",
    parts: [...batch, "estimated by ElevenLabs", ...rounded],
    ...(covered === undefined || !(covered > 0) ? {} : { perGeneration: reported / covered }),
  }
}

/**
 * True when a call is the `estimate_only` probe, which is never priced, capped or charged. The tool has to be one
 * whose live schema really has the flag: on any other tool `estimate_only` is an argument the server ignores, and
 * reading it as an estimate would let a paid call through unpriced by adding one word to it. The spelling has to be
 * the schema's own for the same reason — a `estimateOnly` the server never reads is not an estimate.
 */
export const isEstimate = (tool: string, input: Record<string, unknown>) => ESTIMATE_TOOLS.includes(tool.toLowerCase()) && input.estimate_only === true

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

/**
 * Which argument stopped a priced call from being priced, in words the caller can act on. One source of price means
 * one obstacle this plugin can name by itself: an argument ElevenLabs' own schema for the tool does not have, which
 * is refused before any estimate is asked for. Everything else — a flag the server would not take, a link that broke,
 * a figure the estimate did not carry — happened at ElevenLabs, and the refusal says so rather than naming an
 * argument it cannot blame.
 */
export function priceObstacle(name: string, input: Record<string, unknown>): string | undefined {
  const tool = name.toLowerCase()
  const unknown = unknownArgument(tool, input)
  if (unknown !== undefined) return unknown
  // A count multiplies whatever one generation costs, so one that cannot be read stops the call.
  const badCount = GENERATION_KEYS.find((key) => countValue(input[key]) === NOT_A_COUNT)
  if (badCount !== undefined) return `"${badCount}" states a generation count no number can be read out of`
  return undefined
}

/**
 * The calls that are never priced, capped or charged: the free `estimate_only` probe, and every tool this table says
 * cannot spend. Undefined means the call must be priced, and the caller goes on.
 *
 * The probe is free, but it is still a call that reaches ElevenLabs, so while a cap is on it is held to the same
 * argument allowlist the paid call is. That check exists to keep an argument ElevenLabs' own schema does not
 * have from reaching it — the server rejects the call and the workspace is left holding a flow and a node for a probe
 * that answered nothing. A check whose purpose is to stop a bad argument reaching ElevenLabs runs on every call that
 * reaches ElevenLabs, the free one included. No money turns on it: the paid call carrying that same argument is
 * refused before any remembered price is reached, so a figure fetched under an invented argument could never pay for
 * one. With both caps off nothing is enforced here, as everywhere else.
 */
function unpriced(context: { readonly caps: () => Caps }, tool: string, args: Record<string, unknown>): Quote | undefined {
  const probe = isEstimate(tool, args)
  if (!probe && mustPrice(tool)) return undefined
  if (probe) {
    const caps = context.caps()
    const capped = caps.sessionCreditCap !== null || caps.dailyCreditCap !== null
    const obstacle = capped ? priceObstacle(tool, args) : undefined
    if (obstacle !== undefined) throw estimateRefused(tool, obstacle)
  }
  return { price: { credits: 0, basis: "exact", parts: [] }, tracked: false }
}

/**
 * The refusal for an estimate that cannot be asked for. It is not `unknownPrice`: that one's next step is to send
 * `estimate_only` first, which is exactly what this caller just did. The argument is the thing to change.
 */
function estimateRefused(tool: string, obstacle: string) {
  return new SpendRefused(
    "PRICE_UNKNOWN",
    `${tool} cannot be estimated with these arguments, so this probe was not sent: ${obstacle}.`,
    `Ask for the estimate again without that argument, or set both "sessionCreditCap" and "dailyCreditCap" to null to send it unchecked.`,
  )
}

async function quote(context: GuardInput, tool: string, args: Record<string, unknown>, mayEstimate: boolean, call: GuardCall): Promise<Quote> {
  const free = unpriced(context, tool, args)
  if (free !== undefined) return free
  const caps = context.caps()
  if (caps.sessionCreditCap === null && caps.dailyCreditCap === null) {
    return { price: { credits: 0, basis: "at-most", parts: ["cost not tracked: both caps are off"] }, tracked: false }
  }
  // An argument no allowlist has is refused before the estimate is asked for, not after: the estimate answers for the
  // arguments it is sent, so an argument the server's own schema does not have would be priced around rather than
  // priced. It is also one fewer flow created in the workspace for a call that is going to be refused.
  // A count that cannot be read multiplies whatever one generation costs by an unknown, so no price for these
  // arguments means anything — whoever it came from. Checked here rather than only inside `estimatePrice`, so a price
  // this ledger already holds cannot carry a call past it either.
  const obstacle = priceObstacle(tool, args)
  if (obstacle !== undefined) throw unknownPrice(tool, priced(tool), obstacle)
  // A remembered estimate is ElevenLabs' own figure for exactly these arguments, minutes old at most. Using it first
  // is not only cheaper: every estimate creates a flow and a node in the workspace, so a second one for the same
  // arguments leaves a second flow behind to say what the first already said.
  let price = context.ledger.rememberedPrice(tool, args)
  if (price === undefined && mayEstimate && priced(tool) && context.estimate) {
    price = await context.estimate(tool, args, call)
    if (price) context.ledger.rememberPrice(tool, args, price)
  }
  if (price === undefined || !(price.credits > 0)) throw unknownPrice(tool, priced(tool), priceObstacle(tool, args))
  // This path can await, so it decides from the store rather than from this process's memory: a charge another
  // location or another OpenCode recorded is merged in first. The check and the hold inside `reserve` stay
  // synchronous, so nothing slips between them.
  await context.ledger.refresh()
  price = clamp(price, caps, args, context.ledger.spend(call.sessionID))
  // The hold is in the store before the call is dispatched, so a crash cannot lose a reservation for a call that ran.
  await context.ledger.reserve(call.id, call.sessionID, price.credits, caps)
  return { price, tracked: true }
}

function quoteSync(context: Omit<GuardInput, "estimate">, tool: string, args: Record<string, unknown>, call: GuardCall): Quote {
  const free = unpriced(context, tool, args)
  if (free !== undefined) return free
  const caps = context.caps()
  if (caps.sessionCreditCap === null && caps.dailyCreditCap === null) {
    return { price: { credits: 0, basis: "at-most", parts: ["cost not tracked: both caps are off"] }, tracked: false }
  }
  const obstacle = priceObstacle(tool, args)
  if (obstacle !== undefined) throw unknownPrice(tool, priced(tool), obstacle)
  // This path cannot await, so it cannot ask ElevenLabs for an estimate: the only price it has is one a call on this
  // ledger already fetched for exactly these arguments. A script prices its own call by sending `estimate_only` first.
  let price = context.ledger.rememberedPrice(tool, args)
  if (price === undefined || !(price.credits > 0)) throw unknownPrice(tool, priced(tool), priceObstacle(tool, args))
  price = clamp(price, caps, args, context.ledger.spend(call.sessionID))
  // Synchronous by the shared shaper contract: this path cannot await the store before the call is dispatched, so it
  // decides from this process's book and the write follows. A write that fails therefore cannot refuse a call that has
  // already gone out; the in-memory hold still bounds this process. See the residual in SECURITY.md.
  void context.ledger.reserve(call.id, call.sessionID, price.credits, caps).catch(() => undefined)
  // The store is read behind the call, not in front of it: the hold above is already written, and the next call on
  // this ledger decides from a book that has seen every other OpenCode's holds since this one.
  context.ledger.catchUp()
  return { price, tracked: true }
}

/**
 * Cuts a request for more variations than the budget affords to what it can pay for, and prices what will run. The
 * unit is ElevenLabs' own estimate divided by the batch it covered, which is fractional, so the clamped figure rounds
 * up and says `at-most`: a share of a batch total is this plugin's arithmetic, not the server's word.
 */
function clamp(price: Price, caps: Caps, args: Record<string, unknown>, spend: Spend): Price {
  const generations = generationsOf(args)
  if (price.perGeneration === undefined || !(price.perGeneration > 0) || generations === undefined || generations === NOT_A_COUNT || generations <= 1) return price
  const left = remaining(caps, spend).available
  const allowed = Math.max(1, Math.min(generations, Math.floor(left / price.perGeneration)))
  if (allowed >= generations) return price
  clampGenerations(args, allowed)
  return { ...price, credits: Math.ceil(price.perGeneration * allowed), basis: "at-most", parts: [`${allowed} ${allowed === 1 ? "generation" : "generations"}, at ElevenLabs' estimate`] }
}

/**
 * The refusal for a call nothing can price. A tool that accepts `estimate_only` is told how to price itself; one that
 * does not — `creative_design_voice` renders three previews, `agents_run_tests` holds conversations — has no price
 * before it runs at all, and the one next step that always works is turning both caps off.
 */
function unknownPrice(tool: string, estimable: boolean, obstacle?: string) {
  const because = obstacle === undefined ? "" : `: ${obstacle}`
  // A name this release has never seen. There is no schema to price it from and no way to tell whether it spends, so
  // the next step is a configuration change or a later release rather than another call: no estimate exists to
  // suggest.
  if (!known(tool)) {
    return new SpendRefused(
      "PRICE_UNKNOWN",
      `${tool} is not in this plugin's tool table, so nothing here can tell whether it spends credits or what it would cost${because}.`,
      `Set both "sessionCreditCap" and "dailyCreditCap" to null to run it unpriced, or wait for a release that classifies it.`,
    )
  }
  if (estimable) {
    return new SpendRefused(
      "PRICE_UNKNOWN",
      `${tool} could not be priced from ElevenLabs' own estimate, so the cap cannot be checked before it runs${because}.`,
      `Call ${tool} once with "estimate_only": true and the same arguments to get its price, then call it again; or set both "sessionCreditCap" and "dailyCreditCap" to null to run it unpriced.`,
    )
  }
  return new SpendRefused(
    "PRICE_UNKNOWN",
    `${tool} may spend credits and does not accept "estimate_only", so nothing can price it before it runs${because}.`,
    `Set both "sessionCreditCap" and "dailyCreditCap" to null to run it unpriced, and watch the balance in /elevenlabs-status.`,
  )
}

/** The error a refused call raises, for a caller that has no code of its own. */
export const spendError = (code: Extract<PluginCode, "SPEND_CAP_REACHED" | "PRICE_UNKNOWN">, message: string, nextStep: string) =>
  elevenlabsError(code, message, nextStep)

export { ESTIMATE_TOOLS, mustPrice, spends }
