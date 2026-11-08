import type { Plugin } from "@opencode/plugin"
import { elevenlabsError, type PluginCode } from "./constants.js"
import { ESTIMATE_TOOLS, priced, spendShaped, spends } from "./elevenlabs-tools.js"
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
  /** A conservative floor for an audio bitrate, used only to bound a duration from a file size when nothing else says. */
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
 * cover the tool: every image and video call, whose price only the server's own estimate knows, and a transcription
 * whose audio duration the arguments do not state.
 */
export function priceOf(tool: string, input: Record<string, unknown>): Price | undefined {
  const generations = generationsOf(input) ?? 1
  if (tool === "creative_generate_speech" || tool === "creative_speech" || tool === "text_to_speech") {
    const text = field(input, ["text", "script", "message"])
    if (typeof text !== "string") return undefined
    const takes = whole(field(input, ["takes", "num_takes"])) ?? RATES.speechTakes
    const characters = Array.from(text).length
    const credits = Math.ceil(characters * RATES.speechPerCharacter * takes)
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
    const milliseconds = number(field(input, ["music_length_ms"]))
    const seconds = number(field(input, ["duration_seconds", "duration"]))
    const minutes = milliseconds !== undefined ? milliseconds / 60_000 : seconds === undefined ? undefined : seconds / 60
    if (minutes === undefined) return undefined
    const credits = Math.ceil(minutes * RATES.musicPerMinute)
    return { credits, basis: "at-most", parts: [`${Math.round(minutes * 10) / 10} minutes`] }
  }
  if (tool === "creative_generate_sound_effect" || tool === "creative_sound_effects") {
    const credits = RATES.sfxPerGeneration * generations
    return { credits, basis: "at-most", parts: [`${generations} ${generations === 1 ? "generation" : "generations"} at ${RATES.sfxPerGeneration} credits`] }
  }
  return undefined
}

/**
 * Speech to Text, from the duration the arguments state or a bound from a file size. A transcription whose length
 * nothing bounds cannot be priced, and the guard refuses it while a cap is on rather than run it unguarded (DR-2).
 */
export function transcriptionPrice(input: Record<string, unknown>): Price | undefined {
  const milliseconds = number(field(input, ["duration_ms", "audio_duration_ms"]))
  const statedSeconds = number(field(input, ["duration_seconds", "duration", "audio_duration_seconds"]))
  const seconds = milliseconds !== undefined ? milliseconds / 1000 : statedSeconds
  if (seconds !== undefined) {
    const minutes = seconds / 60
    return { credits: Math.ceil(minutes * RATES.sttPerMinute), basis: "at-most", parts: [`${Math.round(minutes * 10) / 10} minutes of audio`] }
  }
  const bytes = number(field(input, ["size_bytes", "file_size", "bytes"]))
  if (bytes !== undefined) {
    const bound = bytes / RATES.audioBytesPerSecond
    return { credits: Math.ceil((bound / 60) * RATES.sttPerMinute), basis: "at-most", parts: [`at most ${Math.ceil(bound)} s of audio, from ${count(bytes)} bytes`] }
  }
  return undefined
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

/** The text parts of a host tool result, whichever shape the content has. */
export function textsOf(result: { readonly text?: string; readonly content?: unknown }): string[] {
  if (typeof result.text === "string") return [result.text]
  const content = result.content
  if (typeof content === "string") return [content]
  if (Array.isArray(content)) return content.flatMap((part) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []))
  return []
}

/** "Charged 480 credits": a figure a text-only result states, which the model path used to miss (DR-10). */
function creditsInProse(text: string): number | undefined {
  const match = /\b(?:charged|cost|used|billed)\b[^\d]{0,20}([\d,]{1,12})\s*credits?\b/i.exec(text)
  if (!match) return undefined
  const value = Number(match[1]!.replaceAll(",", ""))
  return Number.isFinite(value) ? value : undefined
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
      if (credits !== undefined) return credits
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
// two calls that start together cannot both fit one budget (DR-1).
// ---------------------------------------------------------------------------------------------------------------

export const LEDGER_KEY = "spend.ledger"
const WINDOW_MS = 24 * 60 * 60 * 1000
/** A reservation older than this was never settled: the call died, and the budget it held is released. */
const RESERVATION_MS = 10 * 60 * 1000
/** Entries older than the window are dropped on every write, so the record cannot grow without bound. */
const MAX_ENTRIES = 1_000

interface Entry {
  /** When the credits were spent, in epoch milliseconds. */
  readonly at: number
  readonly credits: number
  /** The session that spent them, so a reload restores its total too (DR-9). */
  readonly sessionID: string
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
  private entries: Entry[] = []
  private held = new Map<string, { readonly sessionID: string; readonly credits: number; readonly at: number }>()
  private readonly remembered = new Map<string, { price: Price; at: number }>()
  private readonly now: () => number
  private storage: Storage | undefined
  private hydrated: Promise<void> | undefined
  private writing: Promise<void> = Promise.resolve()

  constructor(input: LedgerInput = {}) {
    this.storage = input.storage
    this.now = input.now ?? (() => Date.now())
  }

  /** Reads the stored ledger once. A storage that is unavailable leaves the totals empty, never fails a call. */
  hydrate(): Promise<void> {
    this.hydrated ??= (async () => {
      if (!this.storage) return
      try {
        const stored = await this.storage.get(LEDGER_KEY)
        if (Array.isArray(stored)) {
          this.entries = stored.flatMap((item) => {
            if (item === null || typeof item !== "object") return []
            const entry = item as Record<string, unknown>
            return typeof entry.at === "number" && typeof entry.credits === "number" && typeof entry.sessionID === "string"
              ? [{ at: entry.at, credits: entry.credits, sessionID: entry.sessionID }]
              : []
          })
          this.prune()
        }
      } catch {
        this.entries = []
      }
    })()
    return this.hydrated
  }

  /** The credits spent in the last 24 hours, reservations included, so what is left is what a call may still rely on. */
  daily(): number {
    this.prune()
    const reserved = [...this.held.values()].reduce((sum, held) => sum + held.credits, 0)
    return this.entries.reduce((sum, entry) => sum + entry.credits, 0) + reserved
  }

  session(sessionID: string): number {
    this.prune()
    const spent = this.entries.reduce((sum, entry) => sum + (entry.sessionID === sessionID ? entry.credits : 0), 0)
    const reserved = [...this.held.values()].reduce((sum, held) => sum + (held.sessionID === sessionID ? held.credits : 0), 0)
    return spent + reserved
  }

  spend(sessionID: string): Spend {
    return { sessionCredits: this.session(sessionID), dailyCredits: this.daily() }
  }

  /**
   * Holds `credits` for a call before it is sent, and refuses when it does not fit. Nothing awaits between the check and
   * the hold, so two calls that start together cannot both pass: the second sees the first's reservation.
   */
  reserve(id: string, sessionID: string, credits: number, caps: Caps) {
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
    this.held.set(id, { sessionID, credits, at: this.now() })
  }

  /** The reservation a call holds, if any. */
  reservation(id: string) {
    return this.held.get(id)
  }

  /**
   * Turns a reservation into a recorded charge, using what the result reported or the price it was reserved at. A call
   * that reserved nothing is recorded as given, so a caller with no hook still lands in the ledger.
   */
  settle(id: string, sessionID: string, credits: number): Spend {
    const held = this.held.get(id)
    this.held.delete(id)
    return this.record(sessionID, credits, held?.at)
  }

  /** Releases a hold for a call that failed before it charged anything. A missing reservation is not an error. */
  release(id: string) {
    this.held.delete(id)
  }

  /** Records a completed call. The memory total moves at once; the stored copy follows, one write at a time. */
  record(sessionID: string, credits: number, at = this.now()): Spend {
    if (credits > 0) {
      this.entries.push({ at, credits, sessionID })
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
    this.entries = []
    this.held.clear()
    this.remembered.clear()
  }

  /** Drops entries past the window and reservations no result ever settled. */
  private prune() {
    const now = this.now()
    this.entries = this.entries.filter((entry) => entry.at >= now - WINDOW_MS).slice(-MAX_ENTRIES)
    for (const [id, held] of this.held) if (held.at < now - RESERVATION_MS) this.held.delete(id)
  }

  /** Writes are serialised on one chain: a second charge cannot land before the first, so no charge is lost (DR-9). */
  private persist(): Promise<void> {
    const snapshot = this.entries.map((entry) => ({ at: entry.at, credits: entry.credits, sessionID: entry.sessionID }))
    this.writing = this.writing.then(async () => {
      if (!this.storage) return
      try {
        await this.storage.set(LEDGER_KEY, snapshot)
      } catch {
        // The in-memory total still bounds this process; a storage failure must not fail a generation that already ran.
      }
    })
    return this.writing
  }

  /** Waits for the writes in flight. The tests use it. */
  flush(): Promise<void> {
    return this.writing
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

async function quote(context: GuardInput, tool: string, args: Record<string, unknown>, mayEstimate: boolean, call: GuardCall): Promise<Quote> {
  if (isEstimate(args) || !spendShaped(tool)) return { price: { credits: 0, basis: "exact", parts: [] }, tracked: false }
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
  if (price === undefined) throw unknownPrice(tool, priced(tool))
  price = clamp(price, caps, args, context.ledger.spend(call.sessionID))
  context.ledger.reserve(call.id, call.sessionID, price.credits, caps)
  return { price, tracked: true }
}

function quoteSync(context: Omit<GuardInput, "estimate">, tool: string, args: Record<string, unknown>, call: GuardCall): Quote {
  if (isEstimate(args) || !spendShaped(tool)) return { price: { credits: 0, basis: "exact", parts: [] }, tracked: false }
  const caps = context.caps()
  if (caps.sessionCreditCap === null && caps.dailyCreditCap === null) {
    return { price: priceOf(tool, args) ?? { credits: 0, basis: "at-most", parts: ["cost not tracked: both caps are off"] }, tracked: false }
  }
  let price = priceOf(tool, args) ?? context.ledger.rememberedPrice(tool, args)
  if (price === undefined) throw unknownPrice(tool, priced(tool))
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

export { ESTIMATE_TOOLS, spends, spendShaped }
