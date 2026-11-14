import { DEFAULT_REGION, elevenlabsError, REGION_VALUES, type Region } from "./constants.js"

/** What the default rules allow. `all` is the default; the other two are how a user restricts the plugin. */
export type Access = "all" | "ask-changes" | "read-only"

const ACCESS_VALUES: readonly Access[] = ["all", "ask-changes", "read-only"]

/** How much of a conversation the conversation tools may read. `summary` keeps the metadata reads and denies the words. */
export type Conversations = "full" | "summary" | "off"

const CONVERSATION_VALUES: readonly Conversations[] = ["full", "summary", "off"]

/** A credit cap: a positive whole number of credits, or null for no cap. */
export type CreditCap = number | null

/**
 * No cap unless the owner sets one. ElevenLabs already refuses a call the workspace's balance cannot pay for, and the
 * permission rules decide whether a paid call runs at all; a cap is an extra bound an owner may opt in to.
 */
const DEFAULT_SESSION_CAP: CreditCap = null
const DEFAULT_DAILY_CAP: CreditCap = null
export const DEFAULT_MEDIA_ROOT = "~/Downloads/elevenlabs"
export const DEFAULT_MEDIA_BYTES = 200 * 1024 * 1024

/** A credit cap above this is nearly always a typo, and a typo must not quietly turn an opted-in cap into no cap. */
const CAP_LIMIT = 10_000_000

interface Options {
  /** Run on an OpenCode version outside the supported range, with a note in status. */
  readonly allowUntestedHost: boolean
  /** What the generated default rules allow: everything, changes ask, or read-only. */
  readonly access: Access
  /** The region whose MCP server the plugin registers and signs in to. */
  readonly region: Region
  /** The most credits one session (one conversation with the model) may spend. Null, the default, is no cap. */
  readonly sessionCreditCap: CreditCap
  /** The most credits this plugin may spend in any rolling 24 hours in this data directory. Null, the default, is no cap. */
  readonly dailyCreditCap: CreditCap
  /** Where `elevenlabs_save_media` writes, with `~` expanded when the file is written. */
  readonly mediaRoot: string
  /** The largest file `elevenlabs_save_media` will write. */
  readonly maxMediaBytes: number
  /** How much of a call's transcript the conversation tools may read. */
  readonly conversations: Conversations
}

export type ParsedOptions = Options

const EXAMPLE = `"plugins": [{ "package": "github:joe-broadhead/opencode-elevenlabs#v0.0.4", "options": { "access": "read-only" } }]`
const ACCEPTED = {
  allowUntestedHost: "true or false (the default)",
  access: `"all" (the default), "ask-changes" or "read-only"`,
  region: `${REGION_VALUES.map((value) => `"${value}"`).join(", ")}; "global" is the default`,
  sessionCreditCap: "a whole number of credits, or null for no cap (the default)",
  dailyCreditCap: "a whole number of credits, or null for no cap (the default)",
  mediaRoot: `a path, with ~ for your home folder (the default is "${DEFAULT_MEDIA_ROOT}")`,
  maxMediaBytes: "a whole number of bytes",
  conversations: `"full" (the default), "summary" or "off"`,
} as const

const invalid = (problem: string) =>
  elevenlabsError("OPTIONS_INVALID", `${problem}.`, `Fix the plugin options in opencode.json, for example ${EXAMPLE}.`)

const DEFAULT = Object.freeze({
  allowUntestedHost: false,
  access: "all",
  region: DEFAULT_REGION,
  sessionCreditCap: DEFAULT_SESSION_CAP,
  dailyCreditCap: DEFAULT_DAILY_CAP,
  mediaRoot: DEFAULT_MEDIA_ROOT,
  maxMediaBytes: DEFAULT_MEDIA_BYTES,
  conversations: "full",
} as const satisfies Options)

/** Validates the plugin options from opencode.json. Every option is optional. */
export function parseOptions(raw: unknown): Options {
  if (raw === undefined || raw === null) return { ...DEFAULT }
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid(`The plugin options must be an object, found ${describe(raw)}`)
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(ACCEPTED, key)) {
      throw invalid(`Unknown option "${key}". Accepted options: ${Object.keys(ACCEPTED).map((name) => `"${name}"`).join(", ")}`)
    }
  }
  const { allowUntestedHost = false, access = "all", region = DEFAULT_REGION } = input
  if (typeof allowUntestedHost !== "boolean") {
    throw invalid(`The option "allowUntestedHost" must be ${ACCEPTED.allowUntestedHost}, found ${describe(allowUntestedHost)}`)
  }
  if (typeof access !== "string" || !(ACCESS_VALUES as readonly string[]).includes(access)) {
    throw invalid(`The option "access" must be ${ACCEPTED.access}, found ${describe(access)}`)
  }
  if (typeof region !== "string" || !(REGION_VALUES as readonly string[]).includes(region)) {
    throw invalid(`The option "region" must be ${ACCEPTED.region}, found ${describe(region)}`)
  }
  const conversations = input.conversations ?? "full"
  if (typeof conversations !== "string" || !(CONVERSATION_VALUES as readonly string[]).includes(conversations)) {
    throw invalid(`The option "conversations" must be ${ACCEPTED.conversations}, found ${describe(conversations)}`)
  }
  const mediaRoot = input.mediaRoot ?? DEFAULT_MEDIA_ROOT
  if (typeof mediaRoot !== "string" || mediaRoot.trim() === "" || mediaRoot.includes("\0")) {
    throw invalid(`The option "mediaRoot" must be ${ACCEPTED.mediaRoot}, found ${describe(mediaRoot)}`)
  }
  const maxMediaBytes = input.maxMediaBytes ?? DEFAULT_MEDIA_BYTES
  if (!wholeNumber(maxMediaBytes) || maxMediaBytes < 1024) {
    throw invalid(`The option "maxMediaBytes" must be ${ACCEPTED.maxMediaBytes} of at least 1024, found ${describe(maxMediaBytes)}`)
  }
  return {
    allowUntestedHost,
    access: access as Access,
    region: region as Region,
    // A cap is opt-in: a missing one and `null` both mean no cap.
    sessionCreditCap: cap("sessionCreditCap", input.sessionCreditCap === undefined ? DEFAULT_SESSION_CAP : input.sessionCreditCap),
    dailyCreditCap: cap("dailyCreditCap", input.dailyCreditCap === undefined ? DEFAULT_DAILY_CAP : input.dailyCreditCap),
    mediaRoot,
    maxMediaBytes,
    conversations: conversations as Conversations,
  }
}

/**
 * A cap is a positive whole number, or null. `0` and negative numbers are refused: a typo in a cap the owner set must
 * not be read as some other bound, and null (or leaving it out) is how a user has no cap.
 */
function cap(name: "sessionCreditCap" | "dailyCreditCap", value: unknown): CreditCap {
  if (value === null) return null
  if (!wholeNumber(value) || value < 1) throw invalid(`The option "${name}" must be ${ACCEPTED[name]}, found ${describe(value)}`)
  if (value > CAP_LIMIT) {
    throw invalid(`The option "${name}" must be at most ${CAP_LIMIT} credits, found ${describe(value)}`)
  }
  return value
}

const wholeNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)

const describe = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "string" ? JSON.stringify(value) : typeof value === "object" ? "an object" : String(value)
