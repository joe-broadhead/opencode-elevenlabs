// Text from OpenCode or the network, made safe to show in status, the dialog, the status RPC and the session. No
// imports: status.ts, which the terminal UI bundle inlines, uses it too.

/**
 * Token shapes, the same as the tools RPC's for upstream errors (src/host/tools-rpc.ts): bearer and basic values,
 * `key=value` secrets, JWTs, vendor-prefixed keys, and any long run of key characters.
 */
const SECRETS: readonly [RegExp, string][] = [
  [/\b(bearer|basic|token)\s+[\w.~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b([\w-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|signature|credential)["']?\s*[:=]\s*)["']?[^\s"'&,;]+["']?/gi, "$1[redacted]"],
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, "[redacted]"],
  [/\b(?:tvly|sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abposr]|lin_api|lin_oauth)[-_][\w-]{8,}/gi, "[redacted]"],
  [/[\w+=-]{40,}/g, "[redacted]"],
]

const REASON_LIMIT = 160

/** A URL in text keeps its scheme, host and path: its `user:password@`, query and fragment go. */
const withoutUrlSecrets = (text: string) =>
  text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => url.replace(/^(https?:\/\/)[^/?#@]*@/i, "$1").replace(/[?#].*$/s, ""))

/**
 * Host or network text as a short reason: one line, URLs without credentials, query or fragment, token shapes
 * redacted, and at most 160 characters, cut between whole characters. Undefined when nothing is left.
 */
export function shortReason(text: string): string | undefined {
  const reason = SECRETS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), withoutUrlSecrets(text))
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "")
  if (reason === "") return undefined
  const characters = Array.from(reason)
  return characters.length > REASON_LIMIT ? `${characters.slice(0, REASON_LIMIT - 1).join("")}…` : reason
}

/** An error's message, or the value itself, as a short reason; `fallback` when nothing is left. */
export const reasonOf = (error: unknown, fallback = "no reason given") =>
  shortReason(error instanceof Error ? error.message : String(error)) ?? fallback
