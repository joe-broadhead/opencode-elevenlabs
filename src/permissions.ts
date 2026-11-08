import type { Plugin } from "@opencode/plugin"
import { DISPLAY_NAME, errorText, SERVER_NAME } from "./constants.js"
import type { Access, Conversations } from "./options.js"
import {
  CONVERSATION_TOOLS,
  DESTRUCTIVE_TOOLS,
  EXPORT_TOOLS,
  READ_TOOLS,
  SPEND_TOOLS,
  TRANSCRIPT_TOOLS,
  WRITE_TOOLS,
} from "./elevenlabs-tools.js"
import { reasonOf } from "./redact.js"

export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

/** The host's permission action for an MCP tool of the `elevenlabs` server. */
const actionOf = (tool: string) => `elevenlabs_${tool}`
const rule = (tool: string, effect: Rule["effect"]): Rule => ({ action: actionOf(tool), resource: "*", effect })

/**
 * The tools `conversations` denies, by exact live name, then the patterns that catch a conversation tool ElevenLabs adds
 * later (DR-7). `summary` keeps the metadata reads and stops the words; `off` stops every read of a call's history. The
 * denies come last, so they win over the block's own allows and over the `elevenlabs_*` namespace rule.
 */
export const conversationDenies = (conversations: Conversations): readonly string[] =>
  conversations === "off" ? [...CONVERSATION_TOOLS, ...CONVERSATION_PATTERNS] : conversations === "summary" ? [...TRANSCRIPT_TOOLS, ...TRANSCRIPT_PATTERNS] : []

/**
 * Patterns for the words a tool that returns a call's words carries, whatever it is called exactly. Bare, because the
 * rule helper adds the `elevenlabs_` prefix.
 */
export const TRANSCRIPT_PATTERNS: readonly string[] = ["*transcript*", "*conversation*message*", "*conversation*audio*", "*conversation*recording*"]

/**
 * Patterns that catch a read of a call's history, a new tool included, for `conversations: "off"`. Narrow on purpose:
 * `get_call`, `list_calls` and `export_history` are history reads, and none of them match a generation, a transcription
 * or another tool this table means to keep. A broader `*call*` would. The match itself ignores case.
 */
export const CONVERSATION_PATTERNS: readonly string[] = ["*conversation*", "*transcript*", "*call*recording*", "*get_call*", "*list_calls*", "*export_history*"]

/**
 * Broad first, narrow last, because the last matching rule wins. Every tool the plugin registers is allowed at
 * `access: "all"`, and so is one ElevenLabs adds later; `ask-changes` asks for anything that is not a read, and
 * `read-only` denies it. The reads are always allowed, which is why the first rule alone decides the unknown tools.
 *
 * Spending credits is a change like any other: reads run, and every generation asks or is denied with the rest. The
 * credit caps bound a call that does run, whatever `access` says.
 */
export const defaultRules = (access: Access = "all", conversations: Conversations = "full"): Rule[] => {
  const other: Rule["effect"] = access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny"
  return [
    rule("*", other),
    ...READ_TOOLS.map((tool) => rule(tool, "allow")),
    ...[...EXPORT_TOOLS, ...WRITE_TOOLS, ...SPEND_TOOLS, ...DESTRUCTIVE_TOOLS].map((tool) => rule(tool, other)),
    // Exact names first, then the patterns: a rule's action may be a pattern, and the last matching rule wins.
    ...conversationDenies(conversations).map((tool) => rule(tool, "deny")),
  ]
}

const same = (a: Rule | undefined, b: Rule) => a?.action === b.action && a.resource === b.resource && a.effect === b.effect
const BASE_ALLOW: Rule = { action: "*", resource: "*", effect: "allow" }
const isBaseAllow = (item: Rule) => same(item, BASE_ALLOW)

/**
 * True when the whole default block appears, in order, anywhere after the agent's first base allow: inserted by the
 * plugin or copied by the user. Other plugins insert their blocks at the same index, so it need not follow directly.
 */
export function hasDefaultRules(permissions: readonly Rule[], access: Access = "all", conversations: Conversations = "full") {
  return hasBlock(permissions, defaultRules(access, conversations))
}

/** True when `block` appears in order, anywhere after the agent's first base allow. */
function hasBlock(permissions: readonly Rule[], block: readonly Rule[]) {
  const base = permissions.findIndex(isBaseAllow)
  if (base === -1) return false
  return permissions.some((_, start) => start > base && block.every((item, offset) => same(permissions[start + offset], item)))
}

/**
 * Splices `rules` in right after the agent's first base `* * allow`, by index. Everything later still wins: the agent's
 * own stricter rules (Plan, Explore), the user's `permissions`, and saved approvals. Agents without a base allow, or
 * that already carry the rules, are left alone: there, the block's ask would loosen a default deny. Returns whether it
 * inserted.
 */
export function insertRules(permissions: Rule[], rules: readonly Rule[]) {
  if (hasBlock(permissions, rules)) return false
  const base = permissions.findIndex(isBaseAllow)
  if (base === -1) return false
  permissions.splice(base + 1, 0, ...rules.map((item) => ({ ...item })))
  return true
}

/** Registers the default rules for every agent. Synchronous and never throws; a failure is kept for status. */
export function registerDefaultRules(
  agent: Pick<Plugin.Context["agent"], "transform">,
  rules: readonly Rule[],
  report: (problem: string | undefined) => void,
) {
  return agent.transform((editor) => {
    try {
      for (const { id } of editor.list()) editor.update(id, (info) => void insertRules(info.permissions, rules))
      report(undefined)
    } catch (error) {
      report(errorText("RULES_NOT_ADDED", `${DISPLAY_NAME}'s default permission rules could not be added (${reasonOf(error)}), so ${DISPLAY_NAME} tools may run without asking.`, "Restart OpenCode."))
    }
  })
}

/** Case-insensitive: `elevenlabs_Agents_Get_Conversation` is the same action as the lowercase rule. */
const wildcard = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i")

/** The host's evaluation for an MCP call (resource `*`): the last matching rule wins, and no match asks. */
export function evaluate(permissions: readonly Rule[], action: string): Rule["effect"] {
  return permissions.findLast((item) => wildcard(item.action).test(action) && wildcard(item.resource).test("*"))?.effect ?? "ask"
}

/**
 * Agents that need the per-agent fix: they have a base allow but not the block (for example agents defined only in the
 * user's config, which OpenCode creates after plugins run), and their own rules would let an ElevenLabs tool this plugin
 * does not know run without asking. An agent whose rules already ask or deny for every ElevenLabs tool is not listed.
 */
export const unguardedAgents = (agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[]) =>
  agents
    .filter((agent) => agent.permissions.some(isBaseAllow) && !hasDefaultRules(agent.permissions) && evaluate(agent.permissions, actionOf("new_tool")) === "allow")
    .map((agent) => agent.id)

/** The server name these rules belong to, for status text that has to name it. */
export const RULES_SERVER = SERVER_NAME
