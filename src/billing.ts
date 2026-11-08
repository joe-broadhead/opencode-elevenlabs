import type { Plugin } from "@opencode/plugin"
import { elevenlabsError, type PluginCode } from "./constants.js"
import { ESTIMATE_TOOLS, priced, spends } from "./elevenlabs-tools.js"
import type { CreditCap } from "./options.js"

/**
 * ElevenLabs' published credit costs, from elevenlabs.io/pricing. Only these four are exact; image and video cost
 * depends on the model, resolution and duration, and ElevenLabs publishes no per-unit figure, so those are priced by
 * the server's own `estimate_only` call and never guessed here.
 */
export const RATES = {
  /** Text to Speech: 1 credit per character. */
  speechPerCharacter: 1,
  /** Speech returns two takes by default, and each is charged. */
  speechTakes: 2,
  /** Speech to Text: 330 credits per minute. */
  sttPerMinute: 330,
  /** Music: 900 credits per minute. */
  musicPerMinute: 900,
  /** Sound effects: 200 credits per generation. */
  sfxPerGeneration: 200,
} as const

/** The most a call can cost, and how the figure was reached. `at-most` is a bound, never a guess dressed as a fact. */
export interface Price {
  readonly credits: number
  readonly basis: "exact" | "at-most"
  /** The parts, for the cost line: "1,200 characters, 2 takes". */
  readonly parts: readonly string[]
  /** What one variation costs, when the tool takes `generations_count`: used to clamp the request to the budget. */
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

/** The `generations_count` a generating call asks for, when it names one. */
export const generationsOf = (input: Record<string, unknown>) => whole(field(input, ["generations_count", "generations", "variations", "num_generations"]))

/**
 * The credits a call costs, from its arguments and ElevenLabs' published formula. Undefined when the formula does not
 * cover the tool, which is every image and video call: those are priced by the server's own estimate.
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
  if (tool === "creative_generate_music" || tool === "creative_compose_music") {
    const seconds = number(field(input, ["duration_seconds", "duration", "music_length_ms"]))
    if (seconds === undefined) return undefined
    const minutes = (field(input, ["music_length_ms"]) !== undefined ? seconds / 60_000 : seconds / 60)
    const credits = Math.ceil(minutes * RATES.musicPerMinute)
    return { credits, basis: "at-most", parts: [`${Math.round(minutes * 10) / 10} minutes`] }
  }
  if (tool === "creative_generate_sound_effect" || tool === "creative_sound_effects") {
    const credits = RATES.sfxPerGeneration * generations
    return { credits, basis: "at-most", parts: [`${generations} ${generations === 1 ? "generation" : "generations"} at ${RATES.sfxPerGeneration} credits`] }
  }
  return undefined
}

/** The credits a result reports, when it reports any. Undefined means the figure is not known and never invented. */
export function actualCreditsOf(result: { readonly output?: unknown; readonly text?: string }): number | undefined {
  const fromOutput = creditsIn(result.output)
  if (fromOutput !== undefined) return fromOutput
  if (typeof result.text === "string") {
    const parsed = parseJson(result.text)
    if (parsed !== undefined) return creditsIn(parsed)
  }
  return undefined
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
// The ledger. Amounts and times only, in the plugin's own storage, so a reload, a restart or a scheduled script
// cannot reset the cap. Session totals are in memory: a session does not outlive the process that runs it.
// ---------------------------------------------------------------------------------------------------------------

export const LEDGER_KEY = "spend.ledger"
const WINDOW_MS = 24 * 60 * 60 * 1000
/** Entries older than the window are dropped on every write, so the record cannot grow without bound. */
const MAX_ENTRIES = 1_000

interface Entry {
  /** When the credits were spent, in epoch milliseconds. */
  readonly at: number
  readonly credits: number
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

/** The ledger both paths share: the model's hooks and a script's shapers read and write the same totals. */
export class Ledger {
  private entries: Entry[] = []
  private readonly sessions = new Map<string, number>()
  private readonly remember = new Map<string, { price: Price; at: number }>()
  private readonly now: () => number
  private storage: Storage | undefined
  private hydrated: Promise<void> | undefined

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
            return typeof entry.at === "number" && typeof entry.credits === "number" ? [{ at: entry.at, credits: entry.credits }] : []
          })
          this.prune()
        }
      } catch {
        this.entries = []
      }
    })()
    return this.hydrated
  }

  /** The credits spent in the last 24 hours. */
  daily(): number {
    this.prune()
    return this.entries.reduce((sum, entry) => sum + entry.credits, 0)
  }

  session(sessionID: string): number {
    return this.sessions.get(sessionID) ?? 0
  }

  spend(sessionID: string): Spend {
    return { sessionCredits: this.session(sessionID), dailyCredits: this.daily() }
  }

  /** Records a completed call. The memory total moves at once; the stored copy follows, and a failure there is silent. */
  record(sessionID: string, credits: number): Spend {
    if (credits <= 0) return this.spend(sessionID)
    const at = this.now()
    this.entries.push({ at, credits })
    this.sessions.set(sessionID, this.session(sessionID) + credits)
    this.prune()
    void this.persist()
    return this.spend(sessionID)
  }

  /** Remembers a price the server itself gave for one tool, so a later call with the same arguments can be priced. */
  rememberPrice(tool: string, input: Record<string, unknown>, price: Price) {
    this.remember.set(keyOf(tool, input), { price, at: this.now() })
  }

  /** The remembered price for exactly these arguments, if it is still fresh. */
  rememberedPrice(tool: string, input: Record<string, unknown>): Price | undefined {
    const found = this.remember.get(keyOf(tool, input))
    if (!found) return undefined
    return this.now() - found.at > 10 * 60 * 1000 ? undefined : found.price
  }

  /** Forgets everything. The tests use it. */
  reset() {
    this.entries = []
    this.sessions.clear()
    this.remember.clear()
  }

  private prune() {
    const cutoff = this.now() - WINDOW_MS
    this.entries = this.entries.filter((entry) => entry.at >= cutoff).slice(-MAX_ENTRIES)
  }

  private async persist() {
    if (!this.storage) return
    try {
      await this.storage.set(LEDGER_KEY, this.entries.map((entry) => ({ at: entry.at, credits: entry.credits })))
    } catch {
      // The in-memory total still bounds this process; a storage failure must not fail a generation that already ran.
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
  readonly code: Extract<PluginCode, "SPEND_CAP_REACHED" | "ESTIMATE_REQUIRED">
  readonly nextStep: string

  constructor(code: Extract<PluginCode, "SPEND_CAP_REACHED" | "ESTIMATE_REQUIRED">, message: string, nextStep: string) {
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

const raise = `Raise "sessionCreditCap" or "dailyCreditCap" in this plugin's options, set either to null for no cap, or wait for the 24-hour window to roll.`

/** Refuses a call whose price does not fit the caps. Nothing is sent to ElevenLabs. */
export function assertAffordable({ tool, price, caps, spend }: AffordInput) {
  if (price.credits <= remaining(caps, spend).available) return
  throw new SpendRefused(
    "SPEND_CAP_REACHED",
    `${tool} would spend ${price.basis === "at-most" ? "at most " : ""}${count(price.credits)} credits, and ${capText(caps, spend)}.`,
    raise,
  )
}

/** One line the model can repeat, with the figure it can trust and the day's total. */
export function costLine(price: Price, spend: Spend, caps: Caps) {
  const exact = price.basis === "exact" ? "" : "at most "
  const basis = price.parts.length ? ` (${price.parts.join(", ")})` : ""
  const today = caps.dailyCreditCap === null ? `${count(spend.dailyCredits)} credits today` : `${count(spend.dailyCredits)} of ${count(caps.dailyCreditCap)} credits today`
  return `Credits: ${exact}${count(price.credits)}${basis}; ${today}.`
}

/** The structured `cost` a tools-RPC result carries beside its output, as X's does. */
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

/** Parses an `estimate_only` result for its price. Undefined means the server did not say, and the guard refuses. */
export function estimatePrice(input: Record<string, unknown>, result: { readonly output?: unknown; readonly text?: string }): Price | undefined {
  const total = actualCreditsOf(result)
  if (total === undefined) return undefined
  const generations = generationsOf(input) ?? 1
  const perGeneration = generations > 1 ? total / generations : total
  return {
    credits: total,
    basis: "exact",
    parts: [`${generations} ${generations === 1 ? "generation" : "generations"}, estimated by ElevenLabs`],
    perGeneration,
  }
}

/** True when a call is the free `estimate_only` probe, which is never priced or capped. */
export const isEstimate = (input: Record<string, unknown>) => input.estimate_only === true || input.estimateOnly === true

/** The layer between a hook and the plugin: what the model path and the script path both ask. */
export interface GuardCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
}

export interface GuardInput {
  readonly ledger: Ledger
  readonly caps: () => Caps
  /** The server's own estimate, for a tool that accepts `estimate_only`. Only the model path can await it. */
  readonly estimate?: (tool: string, input: Record<string, unknown>, call: GuardCall) => Promise<Price | undefined>
}

/**
 * Prices a billed call and refuses it when it does not fit. Returns the price to remember for the result's cost line,
 * and writes the clamped `generations_count` back into `input`.
 *
 * The model path awaits a real `estimate_only` call for image and video; the script path is synchronous and can only
 * use the table or a price the script itself fetched with `estimate_only: true` first. Both refuse rather than guess.
 */
export async function priceCall(input: GuardInput, tool: string, args: Record<string, unknown>, call: GuardCall): Promise<Price> {
  if (!spends(tool) || isEstimate(args)) return { credits: 0, basis: "exact", parts: [] }
  const caps = input.caps()
  if (caps.sessionCreditCap === null && caps.dailyCreditCap === null) {
    return priceOf(tool, args) ?? { credits: 0, basis: "at-most", parts: ["cost not tracked: both caps are off"] }
  }
  const spend = input.ledger.spend(call.sessionID)
  let price = priceOf(tool, args)
  if (price === undefined && priced(tool) && input.estimate) {
    price = await input.estimate(tool, args, call)
    if (price) input.ledger.rememberPrice(tool, args, price)
  }
  price ??= input.ledger.rememberedPrice(tool, args)
  if (price === undefined) {
    throw new SpendRefused(
      "ESTIMATE_REQUIRED",
      `${tool} has no published credit price, so the cap cannot be checked before it runs.`,
      `Call ${tool} once with "estimate_only": true to get its price, then call it again with the same arguments; ${priced(tool) ? "" : "this tool's schema is not attested, so pass estimate_only only if it accepts it, or "}set both caps to null to run unpriced.`,
    )
  }
  // A request for more variations than the budget affords is cut to what fits, and priced for what it will run.
  const generations = generationsOf(args)
  if (price.perGeneration !== undefined && generations !== undefined && generations > 1) {
    const left = remaining(caps, spend).available
    const allowed = Math.max(1, Math.min(generations, Math.floor(left / price.perGeneration)))
    if (allowed < generations) {
      const key = field(args, ["generations_count", "generations", "variations", "num_generations"]) === undefined ? "generations_count" : generationsKey(args)
      args[key] = allowed
      price = { ...price, credits: price.perGeneration * allowed, parts: [`${allowed} ${allowed === 1 ? "generation" : "generations"}, estimated by ElevenLabs`] }
      input.ledger.rememberPrice(tool, args, price)
    }
  }
  assertAffordable({ tool, price, caps, spend })
  return price
}

const generationsKey = (args: Record<string, unknown>) =>
  ["generations_count", "generations", "variations", "num_generations"].find((key) => args[key] !== undefined) ?? "generations_count"

/** The error a refused call raises, for a caller that has no code of its own. */
export const spendError = (code: Extract<PluginCode, "SPEND_CAP_REACHED" | "ESTIMATE_REQUIRED">, message: string, nextStep: string) =>
  elevenlabsError(code, message, nextStep)

export { ESTIMATE_TOOLS, spends }
