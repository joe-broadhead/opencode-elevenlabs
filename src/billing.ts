import { randomUUID } from "node:crypto"
import { closeSync, openSync, statSync } from "node:fs"
import type { Plugin } from "@opencode/plugin"
import { elevenlabsError, type PluginCode } from "./constants.js"
import { ESTIMATE_TOOLS, mustPrice, priced, spends } from "./elevenlabs-tools.js"
import { fileReader, riffSecondsWith } from "./media/policy.js"
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
export function priceOf(name: string, input: Record<string, unknown>): Price | undefined {
  // Case is folded here as it is in `mustPrice` (RR2-8), so a name in another case is priced rather than refused: the
  // guard asks this table for every name it must price, and the two must agree on which names those are.
  const tool = name.toLowerCase()
  // A transcription prices its own files and so decides for itself which of them were measured; every other priced
  // tool measures none, so any argument naming a file or a URL is audio the server will read and the price will not
  // cover (RR3-7).
  if (!isTranscription(tool) && unpriceableArgument(input, NO_MEASURED_PATHS) !== undefined) return undefined
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
    // No length at all is the server's own default, which this plugin cannot know: PRICE_UNKNOWN, not a guess. So is
    // a length field holding something no number can be read out of.
    if (stated === undefined || stated.length === 0) return undefined
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
const musicLengthsMs = (input: Record<string, unknown>): number[] | undefined => {
  const milliseconds = lengthValue(input["music_length_ms"])
  if (milliseconds === NOT_A_LENGTH) return undefined
  const stated = [milliseconds]
  for (const name of ["duration_seconds", "duration"] as const) {
    const seconds = lengthValue(input[name])
    if (seconds === NOT_A_LENGTH) return undefined
    stated.push(seconds === undefined ? undefined : seconds * 1_000)
  }
  return stated.filter((value): value is number => value !== undefined && value > 0)
}

/** A length field that holds something no length can be read out of. One such field is the whole call's price (RR3-9). */
const NOT_A_LENGTH = Symbol("not a length")

/**
 * The length a field states. A caller that wrote `"30000"` asked for thirty seconds, so a numeric string is read as the
 * number it spells rather than passed over, which would have priced the call as if the field were not there. Anything
 * a number cannot be read out of — prose, a boolean, an object — is not a length this plugin can price around.
 */
const lengthValue = (value: unknown): number | undefined | typeof NOT_A_LENGTH => {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : Number.NaN
  if (!Number.isFinite(parsed)) return NOT_A_LENGTH
  // A zero or a negative is numeric and states nothing: it leaves the length to the server, as it always did.
  return parsed >= 0 ? parsed : undefined
}

/** Argument names that may hold the audio file a transcription is about to send. A URL is not one of them. */
const AUDIO_PATHS = ["path", "file", "file_path", "audio_path", "filename", "audio_file", "input_file"] as const

/** Argument names that state a duration the caller believes the audio has. One of these may only raise a price. */
const STATED_DURATIONS = ["duration_ms", "audio_duration_ms", "duration_seconds", "duration", "audio_duration_seconds"] as const

/**
 * Every argument name a transcription may carry while a cap is on: the ones the pricing reads, and ElevenLabs' own
 * documented Speech to Text options that change nothing about the length of audio billed. A name outside this list is
 * one whose effect on the bill this plugin does not know, so the call is not priced rather than priced as if the name
 * were not there. `transcript_edit` is deliberately absent: it is documented as a 30% surcharge billed for at least
 * ten seconds, which is a price this plugin does not compute.
 */
const TRANSCRIPTION_ARGUMENTS = new Set<string>([
  ...AUDIO_PATHS,
  ...STATED_DURATIONS,
  "context",
  "estimate_only",
  "estimateOnly",
  "model_id",
  "language_code",
  "timestamps_granularity",
  "diarize",
  "use_speaker_library",
  "detect_speaker_roles",
  "num_speakers",
  "diarization_threshold",
  "keyterms",
  "tag_audio_events",
  "entity_detection",
  "entity_redaction",
  "no_verbatim",
  "use_multi_channel",
  "multichannel_output_style",
  "webhook",
  "webhook_id",
  "webhook_metadata",
  "temperature",
  "seed",
  "additional_formats",
  "file_format",
  "enable_logging",
])

/** A call that measured no file of its own. Every path it names is then one the price does not cover. */
const NO_MEASURED_PATHS: ReadonlySet<string> = new Set<string>()

/** A value that sends the server somewhere this plugin cannot measure. Only `http(s)` is a fetchable remote file. */
const isHttpUrl = (value: string) => /^https?:\/\//i.test(value.trim())

/**
 * Whether a string is worth asking the filesystem about. Prose is not a path, and a priced call's `text` argument is
 * prose, so only a value shaped like one is stat'd: nothing here walks the disk for every word a caller wrote.
 */
const pathShaped = (value: string) =>
  value.length > 0 && value.length <= 4096 && !value.includes("\0") && (value.includes("/") || value.includes("\\") || /\.[A-Za-z0-9]{1,8}$/.test(value))

/** Every string a call carries, however deeply an array or an object holds it. Bounded, so a cyclic shape terminates. */
function* stringsIn(value: unknown, depth = 0): Generator<string> {
  if (depth > 4) return
  if (typeof value === "string") yield value
  else if (Array.isArray(value)) for (const item of value) yield* stringsIn(item, depth + 1)
  else if (value !== null && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) yield* stringsIn(item, depth + 1)
}

/**
 * Why a priced call cannot be priced from its arguments, or undefined when nothing stands in the way. A cap is a bound
 * on what a call may spend, so every argument it carries has to be one the price covers: a remote file the plugin
 * cannot measure (`cloud_storage_url` above all), or a local file it did not measure, is audio the server will read
 * and the price will not include.
 */
export function unpriceableArgument(input: Record<string, unknown>, measured: ReadonlySet<string>): string | undefined {
  for (const [name, value] of Object.entries(input)) {
    for (const text of stringsIn(value)) {
      if (isHttpUrl(text)) return `"${name}" names a file at a URL, which this plugin cannot measure`
      if (measured.has(text) || !pathShaped(text)) continue
      try {
        if (statSync(text).isFile()) return `"${name}" names a local file this plugin did not measure`
      } catch {
        // Not a file on this machine, so it names nothing the server will read from here.
      }
    }
  }
  return undefined
}

/**
 * The file a transcription is about to send, measured here, and the paths that were measured. A PCM RIFF/WAVE file is
 * measured as a decoder reads it: the chunks are walked for `fmt ` and `data`, the audio is the `data` chunk's own
 * bytes clamped to the bytes that really follow it, and the seconds come from the rate the `fmt ` fields imply. Any
 * other container states no duration this plugin will trust, so it is not measured and so is not priced.
 */
export function measureAudio(input: Record<string, unknown>): { readonly durationSeconds: number; readonly paths: ReadonlySet<string> } | undefined {
  let longest: number | undefined
  const paths = new Set<string>()
  // The fixed list is walked, not the caller's keys, so two names for two files give one price whichever order they
  // are written in. Every one of them is measured: the server may read the argument this plugin passed over.
  for (const name of AUDIO_PATHS) {
    const value = input[name]
    if (value === undefined || value === null) continue
    // A known key holding something that is not a string is a file this plugin cannot see and so cannot price.
    if (typeof value !== "string") return undefined
    if (value.length === 0) continue
    if (value.includes("\0")) return undefined
    // A URL names no local file. Nothing here can measure it, and nothing here claims to.
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined
    const measured = measureFile(value)
    // A named file this plugin cannot measure is one the call may still send: a price covering the rest is no price.
    if (measured === undefined) return undefined
    paths.add(value)
    if (longest === undefined || measured > longest) longest = measured
  }
  return longest === undefined ? undefined : { durationSeconds: longest, paths }
}

/** One local file's duration, or undefined when it cannot be read or its container states nothing measurable. */
function measureFile(path: string): number | undefined {
  let fd: number | undefined
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size <= 0) return undefined
    fd = openSync(path, "r")
    // The walk reads chunk headers at the offsets the chunks give, so a `data` chunk behind 100 kB of broadcast
    // metadata is reached without reading the audio, and the file's own size bounds every read.
    const durationSeconds = riffSecondsWith(fileReader(fd, stat.size), stat.size)
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
  // An argument this plugin has never priced may change what the call is billed, so the call is not priced rather
  // than priced as if the argument were not there (RR3-6).
  if (Object.keys(input).some((name) => !TRANSCRIPTION_ARGUMENTS.has(name))) return undefined
  const measured = measureAudio(input)
  if (measured === undefined) return undefined
  // A second file, at a URL or on this disk, is audio this price does not cover (RR3-7).
  if (unpriceableArgument(input, measured.paths) !== undefined) return undefined
  const statedMs = lengthValue(field(input, ["duration_ms", "audio_duration_ms"]))
  const statedSeconds = lengthValue(field(input, ["duration_seconds", "duration", "audio_duration_seconds"]))
  if (statedMs === NOT_A_LENGTH || statedSeconds === NOT_A_LENGTH) return undefined
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
 * attested positive figure may settle below the reserved price. Each name here says *this call's charge*:
 * `credit_cost` is not one of them, because it reads as readily as a per-unit rate, and until the live reconcile
 * observes it carrying a charge, a rate that lowered a reservation would be the plugin's own parse error.
 */
const ATTESTED_CREDIT_KEYS = new Set(["credits", "credits_used", "credits_charged", "billed_credits", "total_credits"])

/**
 * The band a reported figure has to sit in to be read as this call's charge. A result that reports 1 credit against
 * 3,000 reserved is not this call's charge in any pricing this plugin knows — it is a count, a rate, or another call's
 * figure — and neither is one reporting 45,300 against 7,500. Outside the band the reservation stands and the cost
 * line says why, rather than a budget being freed, or spent, on a field the plugin may have read wrong.
 *
 * A tenth and ten times is what ElevenLabs' own published prices span around a reservation: a bound computed from two
 * takes settles at one, a minimum-length charge rounds up, and a generation count the server clamped settles below.
 */
const ATTESTED_MIN_RATIO = 10
const ATTESTED_MAX_RATIO = 10

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
export function settlementOf(
  result: { readonly output?: unknown; readonly text?: string; readonly content?: unknown },
  reserved: number,
): { readonly credits: number; readonly attested: boolean; readonly note?: string } {
  const attested = attestedCreditsOf(result)
  if (attested !== undefined) {
    // Moving a reservation is the one thing a figure the plugin may have misread can do with the owner's money, so it
    // has to look like a charge for this call: a whole number of credits, inside the band around what was reserved.
    if (!Number.isSafeInteger(attested)) {
      return { credits: reserved, attested: false, note: `the result reported ${attested} credits, which is not a whole number, so the reserved price stands` }
    }
    const outside = outsideBand(attested, reserved)
    return outside === undefined ? { credits: attested, attested: true } : { credits: reserved, attested: false, note: outside }
  }
  const parsed = actualCreditsOf(result)
  // A figure under a key nothing attests may still raise a price, but it is held to the same upper bound: otherwise
  // the band an attested figure obeys could be stepped around by the same absurd number under another name.
  if (parsed !== undefined && parsed > reserved) {
    const outside = outsideBand(parsed, reserved)
    return outside === undefined ? { credits: parsed, attested: false } : { credits: reserved, attested: false, note: outside }
  }
  return { credits: reserved, attested: false }
}

/** Why a reported figure is not this call's charge, or undefined when it sits in the band around the reservation. */
function outsideBand(reported: number, reserved: number): string | undefined {
  if (reported * ATTESTED_MIN_RATIO < reserved) {
    return `the result reported ${count(reported)} against ${count(reserved)} reserved, too far below to be this call's charge, so the reserved price stands`
  }
  if (reported > reserved * ATTESTED_MAX_RATIO) {
    return `the result reported ${count(reported)} against ${count(reserved)} reserved, too far above to be this call's charge, so the reserved price stands`
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
// two calls that start together cannot both fit one budget (DR-1).
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
/** The detail keys one writer keeps. An in-window charge past that folds into an hour's total, which never shrinks. */
const MAX_ENTRIES = 1_000
/**
 * How finely a folded total keeps its time (RR2-9). A folded charge loses its own timestamp, so it ages with the hour
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
  /** The session that spent them, so a reload restores its total too (DR-9). */
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
   * reservation, including one held by another ledger on the same storage (DR-1). The returned promise is the hold's
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
   * Turns a reservation into a recorded charge, on the hold's own key. Never below the reserved price unless
   * `attested` is set: a zero, a missing result or a prose figure must not free the budget. A higher figure replaces
   * the settlement, and a repeat settlement reads the recorded charge as its floor.
   */
  settle(id: string, sessionID: string, credits: number, attested = false): Spend {
    const book = this.book()
    const held = book.own.get(id)
    const floor = held?.credits ?? 0
    const charge = credits > floor ? credits : attested && credits > 0 ? credits : floor
    if (charge > 0 && !(held?.kind === "charge" && held.credits === charge)) {
      const row: Row = { kind: "charge", at: held?.at ?? this.now(), credits: charge, sessionID }
      book.own.set(id, row)
      this.store(this.writeRow(book, id, row))
    } else if (charge <= 0 && held) {
      book.own.delete(id)
      this.store(this.removeKey(book, rowKey(book.writerId, id)))
    }
    this.prune()
    return this.spend(sessionID)
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
    this.remembered.set(keyOf(tool, input), { price, at: this.now() })
  }

  /** The remembered price for exactly these arguments, if it is still fresh. */
  rememberedPrice(tool: string, input: Record<string, unknown>): Price | undefined {
    const found = this.remembered.get(keyOf(tool, input))
    if (!found) return undefined
    return this.now() - found.at > 10 * 60 * 1000 ? undefined : found.price
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

/**
 * Which argument stopped a priced call from being priced, in words the caller can act on. `priceOf` returns nothing in
 * each of these cases; this says which one it was, so a refusal names the argument rather than the tool.
 */
export function priceObstacle(name: string, input: Record<string, unknown>): string | undefined {
  const tool = name.toLowerCase()
  if (!isTranscription(tool)) return unpriceableArgument(input, NO_MEASURED_PATHS)
  const unknown = Object.keys(input).find((argument) => !TRANSCRIPTION_ARGUMENTS.has(argument))
  if (unknown !== undefined) return `"${unknown}" is an argument whose effect on the bill this plugin does not know`
  const measured = measureAudio(input)
  if (measured === undefined) return "no argument names a local PCM WAV file this plugin can measure"
  return unpriceableArgument(input, measured.paths)
}

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
  if (isEstimate(args) || !mustPrice(tool)) return { price: { credits: 0, basis: "exact", parts: [] }, tracked: false }
  const caps = context.caps()
  if (caps.sessionCreditCap === null && caps.dailyCreditCap === null) {
    return { price: priceOf(tool, args) ?? { credits: 0, basis: "at-most", parts: ["cost not tracked: both caps are off"] }, tracked: false }
  }
  let price = priceOf(tool, args) ?? context.ledger.rememberedPrice(tool, args)
  if (price === undefined || !(price.credits > 0)) throw unknownPrice(tool, priced(tool), priceObstacle(tool, args))
  price = clamp(price, caps, args, context.ledger.spend(call.sessionID))
  // Synchronous by the shared shaper contract: this path cannot await the store before the call is dispatched, so it
  // decides from this process's book and the write follows. A write that fails therefore cannot refuse a call that has
  // already gone out; the in-memory hold still bounds this process. See the residual in SECURITY.md.
  void context.ledger.reserve(call.id, call.sessionID, price.credits, caps).catch(() => undefined)
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
function unknownPrice(tool: string, estimable: boolean, obstacle?: string) {
  const because = obstacle === undefined ? "" : `: ${obstacle}`
  if (isTranscription(tool)) {
    return new SpendRefused(
      "PRICE_UNKNOWN",
      `${tool} cannot be priced from the audio about to be sent, so the cap cannot be checked before it runs${because}.`,
      `Convert the audio to a local PCM WAV file and pass that; this plugin measures no other container, and a duration you type cannot set the price. Or set both caps to null to run it unpriced.`,
    )
  }
  return new SpendRefused(
    "PRICE_UNKNOWN",
    `${tool} has no published credit price and no remembered estimate, so the cap cannot be checked before it runs${because}.`,
    estimable
      ? `Call ${tool} once with "estimate_only": true and the same arguments to get its price, then call it again; or set both caps to null to run it unpriced.`
      : `This plugin does not know whether ${tool} accepts "estimate_only". Set both "sessionCreditCap" and "dailyCreditCap" to null to run it unpriced, or price it from another call's estimate.`,
  )
}

/** The error a refused call raises, for a caller that has no code of its own. */
export const spendError = (code: Extract<PluginCode, "SPEND_CAP_REACHED" | "PRICE_UNKNOWN">, message: string, nextStep: string) =>
  elevenlabsError(code, message, nextStep)

export { ESTIMATE_TOOLS, mustPrice, spends }
