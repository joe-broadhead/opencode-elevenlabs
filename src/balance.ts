import type { Plugin } from "@opencode/plugin"
import { elevenlabsError, SUBSCRIPTION_URL } from "./constants.js"

/**
 * The optional API key. ElevenLabs' OAuth scopes cover products, not the account, so the hosted MCP cannot read the
 * workspace's credit balance; and the plugin never sees the MCP token. A user who wants the real balance adds their own
 * API key through `/connect`, and it is used for exactly one read: the subscription.
 */
const BALANCE_INTEGRATION_ID = "elevenlabs-balance"
const BALANCE_NAME = "ElevenLabs API key (optional)"

type Context = Plugin.Context

/** The credit balance, as the subscription endpoint reports it. */
export interface Balance {
  /** Credits used this billing period. */
  readonly used: number
  /** The period's allowance. */
  readonly limit: number
  /** When the allowance resets, in epoch milliseconds, when ElevenLabs says. */
  readonly resetsAt?: number
  /** How far usage may go beyond the allowance: a number, `"unlimited"`, or 0 when overage is off. */
  readonly extension?: number | "unlimited"
  readonly tier?: string
}

/** Adds "ElevenLabs API key (optional)" to `/connect`, as a key method on the plugin's own integration. */
export function registerBalanceIntegration(integration: Pick<Context["integration"], "transform">) {
  return integration.transform((editor) => {
    editor.update(BALANCE_INTEGRATION_ID, (draft) => {
      draft.name = BALANCE_NAME
    })
    editor.method.update({
      integrationID: BALANCE_INTEGRATION_ID,
      method: {
        type: "key",
        label: "API key",
        form: [
          {
            key: "note",
            type: "string",
            title: "What it is used for",
            description: "One read: your subscription's credit balance for the status report. It is never used to generate anything.",
            required: false,
          },
        ],
      },
    })
  })
}

/** The stored key, or undefined when the user has not added one. The key is never logged, printed or returned. */
export async function readKey(integration: Pick<Context["integration"], "connection">): Promise<string | undefined> {
  const connection = await integration.connection.active(BALANCE_INTEGRATION_ID).catch(() => undefined)
  if (connection === undefined) return undefined
  const resolved = await integration.connection.resolve(connection).catch(() => undefined)
  if (resolved?.type !== "key") return undefined
  const key = resolved.key.trim()
  return key === "" ? undefined : key
}

interface SubscriptionBody {
  readonly character_count?: unknown
  readonly character_limit?: unknown
  readonly next_character_count_reset_unix?: unknown
  readonly max_credit_limit_extension?: unknown
  readonly tier?: unknown
}

const whole = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

/**
 * Reads the subscription. A refusal is a coded problem for status, never a failed status: the balance is a convenience
 * and the rest of the report still matters.
 */
export async function readBalance(key: string, url = SUBSCRIPTION_URL, send: typeof fetch = fetch): Promise<Balance> {
  let response: Response
  try {
    response = await send(url, { headers: { "xi-api-key": key, accept: "application/json" } })
  } catch {
    throw elevenlabsError(
      "BALANCE_UNAVAILABLE",
      "The balance could not be read: ElevenLabs was unreachable.",
      "Check your network, then run /elevenlabs-status again.",
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw elevenlabsError(
      "BALANCE_UNAVAILABLE",
      "ElevenLabs refused the stored API key.",
      "Run /connect, choose ElevenLabs API key (optional), and add a key that is still valid.",
    )
  }
  if (!response.ok) {
    throw elevenlabsError(
      "BALANCE_UNAVAILABLE",
      `ElevenLabs answered HTTP ${response.status} for the subscription.`,
      "Run /elevenlabs-status again; if it keeps failing, remove the key in /connect.",
    )
  }
  let body: SubscriptionBody
  try {
    body = (await response.json()) as SubscriptionBody
  } catch {
    throw elevenlabsError("BALANCE_UNAVAILABLE", "The subscription answer was not JSON.", "Run /elevenlabs-status again; if it keeps failing, remove the key in /connect.")
  }
  const used = whole(body.character_count)
  const limit = whole(body.character_limit)
  if (used === undefined || limit === undefined) {
    throw elevenlabsError("BALANCE_UNAVAILABLE", "The subscription answer had no credit counts.", "Run /elevenlabs-status again; if it keeps failing, remove the key in /connect.")
  }
  const reset = whole(body.next_character_count_reset_unix)
  const extension = body.max_credit_limit_extension === "unlimited" ? ("unlimited" as const) : whole(body.max_credit_limit_extension)
  return {
    used,
    limit,
    ...(reset === undefined ? {} : { resetsAt: reset * 1000 }),
    ...(extension === undefined ? {} : { extension }),
    ...(typeof body.tier === "string" ? { tier: body.tier } : {}),
  }
}
