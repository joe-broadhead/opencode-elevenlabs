import type { Plugin, Rpc } from "@opencode/plugin"
import { BALANCE_NAME, type Balance } from "./balance.js"
import { DISPLAY_NAME, oldSignInName, PLUGIN_ID, REGIONS, SERVER_NAME, TESTED_HOSTS, type Region } from "./constants.js"
import { classify, OWN_TOOLS, TRANSCRIPT_TOOLS } from "./elevenlabs-tools.js"
import { isSupportedHost, type HostCheck } from "./host-version.js"
import type { Access, Conversations, CreditCap } from "./options.js"
import { defaultRules, unguardedAgents, type Rule } from "./permissions.js"
import type { OldSignIn } from "./old-sign-ins.js"
import { shortReason } from "./redact.js"
import { VERSION } from "./version.js"

/** The shared status labels in machine form; `/elevenlabs-status` shows them as `sign-in required` and so on. */
type State = "connected" | "sign_in_required" | "connecting" | "disabled" | "failed" | "not_configured" | "conflict"
/**
 * Who owns the `elevenlabs` server: this plugin, the user's own config (adopted unchanged), or a server at another URL
 * than the plugin's (`expected`). `stale` is a server at another region's URL, which a region change leaves behind.
 * URLs are shown as origin and path only.
 */
export type ServerSource =
  | { readonly type: "plugin"; readonly url: string }
  | { readonly type: "adopted"; readonly url: string }
  | { readonly type: "conflict"; readonly url: string; readonly expected: string }
  | { readonly type: "stale"; readonly url: string; readonly expected: string }

/** A skill file OpenCode loads in place of one of the plugin's skills, because it uses the same id. */
interface ShadowedSkill {
  /** The plugin's skill. */
  readonly name: string
  /** The file that takes its place. */
  readonly path: string
}

/** What the last 24 hours have spent, the caps that bound a session and the day, and the balance when a key is stored. */
export interface SpendFacts {
  readonly dailyCredits: number
  readonly sessionCap: CreditCap
  readonly dailyCap: CreditCap
  readonly balance?: Balance
}

/** What status is built from. The TUI fills what it can see; fields it cannot see stay undefined. */
export interface StatusFacts {
  readonly server?: { readonly status: "connected" | "pending" | "disabled" | "failed" | "needs_auth"; readonly error?: string }
  readonly source?: ServerSource
  readonly account?: string
  /** What the default rules allow: the `access` option, `all` when the plugin options were not read. */
  readonly access?: Access
  readonly conversations?: Conversations
  readonly region?: Region
  /** Sign-ins OpenCode still stores for other regions, which this plugin no longer uses. */
  readonly oldSignIns?: readonly OldSignIn[]
  readonly spend?: SpendFacts
  /** Other `mcp.servers` entries that point at ElevenLabs: outside this plugin's hooks, and outside its caps. */
  readonly otherServers?: readonly string[]
  readonly mediaRoot?: string
  readonly host: HostCheck
  /** The names of the tools the `elevenlabs` server serves, without the `elevenlabs_` prefix. */
  readonly tools?: readonly string[]
  readonly agents?: readonly { readonly id: string; readonly permissions: readonly Rule[] }[]
  /** The plugin's own skills with their files, and the skills OpenCode lists; the listed one wins when both share an id. */
  readonly skills?: { readonly own: readonly { readonly name: string; readonly path: string }[]; readonly listed: readonly { readonly id: string; readonly path: string }[] }
  readonly problems?: readonly string[]
}

/**
 * One status model for `/elevenlabs-status`, the `/elevenlabs` dialog and the status RPC. `version`, `host`, `state`,
 * `unguardedAgents` and `nextStep` are the fields every plugin of this family shares; the rest are ElevenLabs' own.
 */
export interface Status {
  /** The plugin's version. */
  readonly version: string
  readonly state: State
  /** For a failed connection only: OpenCode's reason, on one line of at most 160 characters, URLs without their query. */
  readonly error?: string
  readonly account?: string
  readonly source?: ServerSource
  /** What the default rules allow: `all`, `ask-changes` or `read-only`. */
  readonly access: Access
  /** How much of a call's transcript the conversation tools may read. */
  readonly conversations: Conversations
  /** The region whose server is registered, and the URL it resolves to. */
  readonly region: Region
  readonly endpoint: string
  /**
   * Sign-ins OpenCode still stores for another region's server, unused since `region` changed. Present only when
   * there is one. A plugin cannot delete a credential, so status names each with the command that removes it.
   */
  readonly oldSignIns?: readonly OldSignIn[]
  /** How many ElevenLabs tools OpenCode lists. */
  readonly tools: number
  /** How many of them the plugin does not know. */
  readonly unknownCount: number
  /** Up to 20 of the unknown tools' names, only those made of lowercase letters, digits and `_`. */
  readonly unknownTools: readonly string[]
  /** Agents where a new ElevenLabs tool would run without asking; empty when there are none. */
  readonly unguardedAgents: readonly string[]
  /** Skills OpenCode loads instead of the plugin's own; empty when there are none. */
  readonly shadowedSkills: readonly ShadowedSkill[]
  /** Credits this plugin has spent, and the caps that bound it. The balance is only here with an API key. */
  readonly spend: SpendFacts
  /**
   * Other `mcp.servers` entries at ElevenLabs' own address. Each is its own server to OpenCode, with its own
   * tool prefix, so this plugin never sees its calls and the caps do not bind them. Empty when there are none.
   */
  readonly otherServers: readonly string[]
  readonly mediaRoot: string
  readonly host: HostCheck
  readonly problems: readonly string[]
  /** The one next step: the `Next step` row, "Nothing to do." when nothing is needed. */
  readonly nextStep: string
}

const SIGN_IN = `Run /connect and choose ${DISPLAY_NAME}, then press o or Enter to open the link (in a terminal, opencode mcp auth ${SERVER_NAME} opens it automatically).`

/** The default rules to paste into an agent's own permissions, one rule a line, as a JSON array body. */
const agentRulesText = (access: Access, conversations: Conversations) =>
  defaultRules(access, conversations)
    .map((rule, index, rules) => `  ${JSON.stringify(rule)}${index < rules.length - 1 ? "," : ""}`)
    .join("\n")

/** The next step while agents lack the rules: the family's one fixed sentence. */
const AGENTS_NEXT_STEP =
  "Put the default rules shown by /elevenlabs-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for ElevenLabs tools."

/** Connected, but ElevenLabs lists no tools: the OAuth grant, the workspace role or an administrator turns them off. */
const NO_TOOLS_NEXT_STEP =
  "ElevenLabs lists no tools for this account. A workspace role or an administrator can turn the connection's tools off: check the workspace you chose at sign-in, then run /elevenlabs-status again."

const NOTHING_TO_DO = "Nothing to do."

/** The permission posture, one fixed sentence per `access` value, from the tool lists. */
const accessText = (access: Access) => {
  if (access === "all") return "every tool runs without asking, reads, spending and new tools included"
  if (access === "read-only") return "reads run without asking; every other tool, spending included, is denied"
  return "reads run without asking; changes, spending and new tools ask first"
}

const TESTED_TEXT = `${TESTED_HOSTS.slice(0, -1).join(", ")} or ${TESTED_HOSTS.at(-1)}`
const LISTED_UNKNOWN = 20
// A tool name comes from the server; list only plain names: the characters OpenCode keeps in a permission action.
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

const STATE_OF = { connected: "connected", pending: "connecting", needs_auth: "sign_in_required", failed: "failed", disabled: "disabled" } as const

/** The plugin's skills that OpenCode lists from another file: a skill with the same id, such as a user's, replaced it. */
function shadowedOf(facts: StatusFacts): ShadowedSkill[] {
  return (facts.skills?.own ?? []).flatMap((own) => {
    const listed = facts.skills?.listed.find((skill) => skill.id === own.name)
    return listed && listed.path !== own.path ? [{ name: own.name, path: listed.path }] : []
  })
}

export function buildStatus(facts: StatusFacts): Status {
  const state: State = facts.source?.type === "conflict" || facts.source?.type === "stale" ? (facts.source.type === "conflict" ? "conflict" : "not_configured") : facts.server ? STATE_OF[facts.server.status] : "not_configured"
  const unknown = (facts.tools ?? []).filter((tool) => classify(tool) === "unknown")
  // OpenCode's text for a needed sign-in can hold an authorization URL, so only a failure's reason is kept.
  const error = facts.server?.status === "failed" && facts.server.error ? shortReason(facts.server.error) : undefined
  const status = {
    version: VERSION,
    state,
    ...(error ? { error } : {}),
    ...(facts.account ? { account: facts.account } : {}),
    ...(facts.source ? { source: facts.source } : {}),
    access: facts.access ?? "all",
    conversations: facts.conversations ?? "full",
    region: facts.region ?? "global",
    endpoint: REGIONS[facts.region ?? "global"],
    ...(facts.oldSignIns?.length ? { oldSignIns: facts.oldSignIns } : {}),
    tools: facts.tools?.length ?? 0,
    unknownCount: unknown.length,
    unknownTools: unknown.filter((name) => SAFE_NAME.test(name)).slice(0, LISTED_UNKNOWN),
    unguardedAgents: unguardedAgents(facts.agents ?? []),
    shadowedSkills: shadowedOf(facts),
    spend: facts.spend ?? { dailyCredits: 0, sessionCap: null, dailyCap: null },
    otherServers: facts.otherServers ?? [],
    mediaRoot: facts.mediaRoot ?? "~/Downloads/elevenlabs",
    host: facts.host,
    problems: facts.problems ?? [],
  }
  return { ...status, nextStep: nextStepOf(status) }
}

/** Rename or move the skills that take the place of the plugin's own, so OpenCode loads the plugin's. */
function shadowedFix(skills: readonly ShadowedSkill[]) {
  const list = (items: readonly string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0]!)
  const paths = list(skills.map((skill) => skill.path))
  const names = list(skills.map((skill) => skill.name))
  return skills.length > 1
    ? `Rename or move the skills at ${paths}, which use the ids of the plugin's ${names} skills, so OpenCode loads the plugin's own.`
    : `Rename or move the skill at ${paths}, which uses the id of the plugin's ${names} skill, so OpenCode loads the plugin's own.`
}

function nextStepOf(status: Omit<Status, "nextStep">): string {
  // A problem reads `CODE: What happened. Next step: What to do.`; its own next step can become the status's.
  const stepOf = (problem: string | undefined) => problem?.split(" Next step: ")[1]
  const problemStep = (code: string) => stepOf(status.problems.find((problem) => problem.startsWith(`${code}: `)))
  switch (status.state) {
    case "conflict": {
      const { url, expected } = status.source as Extract<ServerSource, { type: "conflict" }>
      return `mcp.servers.${SERVER_NAME} is set to ${url}, but ${DISPLAY_NAME}'s server is ${expected}. Point it there or remove it, then restart OpenCode.`
    }
    case "not_configured": {
      const stale = status.source?.type === "stale" ? status.source : undefined
      if (stale) {
        return `mcp.servers.${SERVER_NAME} points at ${stale.url}, the server for a different region. Remove it in /mcps, then run /connect and choose ${DISPLAY_NAME} for region "${status.region}".`
      }
      // When the plugin could not register the server, that is why OpenCode has none.
      return (
        problemStep("SERVER_NOT_REGISTERED")
        ?? `OpenCode has no ${SERVER_NAME} MCP server. Check that no organisation policy (mcp.use) or other plugin removes it, then restart OpenCode.`
      )
    }
    case "disabled":
      return `The ${SERVER_NAME} MCP server is disabled. Enable it in /mcps, or remove "disabled": true from mcp.servers.${SERVER_NAME} in opencode.json.`
    case "connecting":
      return `${DISPLAY_NAME} is still connecting. Run /elevenlabs-status again in a few seconds.`
    case "sign_in_required":
      return SIGN_IN
    case "failed":
      return "Check your network, then run /elevenlabs-status again."
  }
  if (status.tools === 0) return NO_TOOLS_NEXT_STEP
  // When the rules could not be added, every agent lacks them: restarting fixes that, not pasting them everywhere.
  const rules = problemStep("RULES_NOT_ADDED")
  if (rules) return rules
  if (status.unguardedAgents.length) return AGENTS_NEXT_STEP
  const problem = stepOf(status.problems[0])
  if (problem) return problem
  if (status.shadowedSkills.length) return shadowedFix(status.shadowedSkills)
  if (status.oldSignIns?.length) return oldSignInsFix(status.oldSignIns)
  // A second entry at ElevenLabs' address is only worth a next step while a cap is on: with no cap there is nothing
  // for it to be outside of. It is the owner's entry, so removing it is offered, never done.
  const capped = status.spend.sessionCap !== null || status.spend.dailyCap !== null
  if (status.otherServers.length && capped) {
    const many = status.otherServers.length > 1
    const names = listed(status.otherServers.map((name) => `mcp.servers.${name}`))
    return `${names} also ${many ? "point" : "points"} at ${DISPLAY_NAME}, and this plugin's credit caps do not bind calls to ${many ? "them" : "it"}. Remove ${many ? "them" : "it"} in /mcps to bring those calls under the caps.`
  }
  // An untested host changes no next step: the OpenCode row says it is untested.
  return NOTHING_TO_DO
}

const STATE_TEXT: Record<State, string> = {
  connected: "connected",
  connecting: "connecting",
  sign_in_required: "sign-in required",
  failed: "failed",
  disabled: "disabled",
  not_configured: "not configured",
  conflict: "conflict",
}

/** The server's address and owner, after the state label. */
function serverText(source: ServerSource) {
  if (source.type === "plugin") return `${source.url}, registered by this plugin`
  if (source.type === "adopted") return `${source.url}, your own mcp.servers.${SERVER_NAME}, used unchanged`
  return `your mcp.servers.${SERVER_NAME} points at ${source.url}`
}

function skillsText({ shadowedSkills }: Status) {
  return shadowedSkills.length ? shadowedSkills.map((skill) => `${skill.name} is replaced by ${skill.path}`).join("; ") : "the plugin's own"
}

function toolsText({ state, tools, unknownCount, unknownTools, access }: Status) {
  if (state === "connected" && tools === 0) return `0 available: ${DISPLAY_NAME} lists no tools for this account`
  if (unknownCount === 0) return `${tools} available, 0 unknown`
  const more = unknownCount - unknownTools.length
  const names = unknownTools.length ? `: ${unknownTools.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : ""
  const posture = access === "all" ? "new tools run too" : access === "read-only" ? "new tools are denied" : "new tools ask before running"
  return `${tools} available, ${unknownCount} unknown${names} (${posture})`
}

/** Remove the sign-ins a region change left behind: the plugin cannot, so it gives the commands. */
function oldSignInsFix(signIns: readonly OldSignIn[]) {
  const commands = listed(signIns.map((signIn) => `opencode auth logout ${signIn.integrationID}`))
  const names = listed(signIns.map((signIn) => `"${oldSignInName(signIn.region)}"`))
  return `Remove the ${listed(signIns.map((signIn) => signIn.region))} sign-in${signIns.length > 1 ? "s" : ""} left from an earlier region: run ${commands}, or sign out of ${names} in /connect.`
}

/** The Region row: the region and its server, then any sign-in an earlier region left stored. */
function regionText({ region, endpoint, oldSignIns }: Status) {
  if (!oldSignIns?.length) return `${region} (${endpoint})`
  const old = listed(oldSignIns.map((signIn) => signIn.region))
  return `${region} (${endpoint}); a sign-in for ${old} is still stored and unused`
}

/** `a`, `a and b`, `a, b and c`. */
const listed = (items: readonly string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0]!)

/** The other ElevenLabs entries, named as config keys: what the caps do not reach. */
const otherServersText = (names: readonly string[]) =>
  `${listed(names.map((name) => `mcp.servers.${name}`))} ${names.length > 1 ? "also point" : "also points"} at ${DISPLAY_NAME} and ${names.length > 1 ? "are" : "is"} outside these caps`

/** The credits spent, the caps, the workspace balance only when an API key is stored, and what the caps do not bind. */
function spendText({ spend, region, otherServers }: Status) {
  const count = (value: number) => value.toLocaleString("en-US")
  // Caps are opt-in: with none set, the row says what was spent and that nothing here bounds it.
  const parts = [
    spend.dailyCap === null
      ? `${count(spend.dailyCredits)} credits spent in the last 24 hours, with no daily cap`
      : `${count(spend.dailyCredits)} credits spent in the last 24 hours of ${count(spend.dailyCap)}`,
    spend.sessionCap === null ? "no session cap" : `a session is capped at ${count(spend.sessionCap)}`,
  ]
  if (spend.balance) {
    const { used, limit, resetsAt, extension } = spend.balance
    const left = Math.max(0, limit - used)
    const reset = resetsAt === undefined ? "" : `, resetting ${new Date(resetsAt).toISOString().slice(0, 10)}`
    const overage = extension === "unlimited" ? ", overage unlimited" : extension === undefined || extension === 0 ? "" : `, overage up to ${count(extension)} more`
    parts.push(`workspace balance ${count(left)} of ${count(limit)} credits left${reset}${overage}`)
  } else {
    parts.push(`workspace balance unknown: add a key in /connect as "${BALANCE_NAME}" (${REGIONS[region]} charges the workspace)`)
  }
  if (otherServers.length) parts.push(otherServersText(otherServers))
  return parts.join("; ")
}

function conversationsText(status: Status) {
  if (status.conversations === "full") return `full: the transcript tools run, and they carry other people's calls`
  if (status.conversations === "summary") return `summary: ${TRANSCRIPT_TOOLS.join(" and ")} are denied; the metadata reads run`
  return "off: every read of a call's history is denied"
}

/** The OpenCode row: the version, whether it is tested, the supported range, then any setup problems. */
function hostText({ host, problems }: Status) {
  const { version, range, tested } = host
  const outside = version === null || !isSupportedHost(version)
  const notes = [
    ...(outside ? [`It is outside the supported range; the plugin runs because allowUntestedHost is true. If ${DISPLAY_NAME} misbehaves, use OpenCode ${TESTED_TEXT}.`] : []),
    ...problems,
  ]
  return `${version ?? "unknown version"} (${tested ? "tested" : "untested"}; supported range ${range})${notes.length ? `. ${notes.join(" ")}` : ""}`
}

export function formatStatus(status: Status) {
  const { source, unguardedAgents: agents } = status
  const details = [status.error, source && serverText(source)].filter(Boolean).join("; ")
  return [
    `${DISPLAY_NAME} status`,
    `- Connection: ${STATE_TEXT[status.state]}${details ? ` (${details})` : ""}`,
    `- Account: ${status.account ?? `account name not reported by ${DISPLAY_NAME}'s MCP`}`,
    `- Access: ${accessText(status.access)}`,
    `- Region: ${regionText(status)}`,
    `- Spend: ${spendText(status)}`,
    `- Conversations: ${conversationsText(status)}`,
    `- Media: ${status.mediaRoot}`,
    `- Skills: ${skillsText(status)}`,
    `- Tools: ${toolsText(status)}`,
    `- Agents without default rules: ${agents.length ? `${agents.join(", ")}\n${agentRulesText(status.access, status.conversations)}` : "none"}`,
    `- OpenCode: ${hostText(status)}`,
    `- Next step: ${status.nextStep}`,
  ].join("\n")
}

interface StatusContext {
  readonly mcp: Pick<Plugin.Context["mcp"], "list">
  readonly agent: Pick<Plugin.Context["agent"], "list">
  readonly tool: Pick<Plugin.Context["tool"], "list">
  readonly skill: Pick<Plugin.Context["skill"], "list">
  readonly integration: { readonly connection: Pick<Plugin.Context["integration"]["connection"], "active"> }
}

/** What setup knows: the options, the server's owner, the host check, the plugin's own skills and any setup problems. */
interface SetupFacts {
  readonly access: Access
  readonly conversations: Conversations
  readonly region: Region
  readonly mediaRoot: string
  /** Sign-ins stored for other regions' servers, looked up when status is read. */
  readonly oldSignIns?: () => Promise<readonly OldSignIn[]>
  readonly spend: () => SpendFacts | Promise<SpendFacts>
  readonly source?: ServerSource
  /** Other `mcp.servers` entries pointing at ElevenLabs, read beside this plugin's own at registration. */
  readonly otherServers?: readonly string[]
  readonly host: HostCheck
  readonly skills: readonly { readonly name: string; readonly path: string }[]
  readonly problems: readonly string[]
}

/** Reads the live facts through public host APIs; never calls ElevenLabs. Optional lookups that fail leave their field empty. */
export async function readStatus(ctx: StatusContext, facts: SetupFacts) {
  const [servers, agents, tools, listed] = await Promise.all([
    ctx.mcp.list(),
    ctx.agent.list(),
    ctx.tool.list(),
    // The skill check is advice; a failed list must not hide the rest of the status.
    ctx.skill.list().then((result) => result.data, () => undefined),
  ])
  const server = servers.data.find((entry) => entry.name === SERVER_NAME)
  const connection = server?.integrationID ? await ctx.integration.connection.active(server.integrationID).catch(() => undefined) : undefined
  const oldSignIns = await facts.oldSignIns?.().catch(() => undefined)
  return buildStatus({
    access: facts.access,
    conversations: facts.conversations,
    region: facts.region,
    ...(oldSignIns?.length ? { oldSignIns } : {}),
    mediaRoot: facts.mediaRoot,
    spend: await facts.spend(),
    otherServers: facts.otherServers ?? [],
    ...(facts.source ? { source: facts.source } : {}),
    host: facts.host,
    problems: facts.problems,
    ...(listed ? { skills: { own: facts.skills, listed } } : {}),
    ...(server ? { server: server.status } : {}),
    ...(connection?.type === "credential" ? { account: connection.label } : {}),
    // The plugin's own tool lives in the same namespace; it is not an ElevenLabs tool, so it is not counted.
    tools: tools.filter((tool) => tool.options?.namespace === SERVER_NAME && !OWN_TOOLS.includes(tool.name)).map((tool) => tool.name),
    agents: agents.data,
  })
}

/** Why status could not be read: a coded message and its next step. The reason is cut like a failure's. */
function unavailable(error: unknown) {
  const reason = shortReason(error instanceof Error ? error.message : String(error))
  return {
    message: `STATUS_UNAVAILABLE: Could not read ${DISPLAY_NAME}'s status${reason ? ` (${reason})` : ""}.`,
    nextStep: "Restart OpenCode, then run /elevenlabs-status again.",
  }
}

const strings = { type: "array", items: { type: "string" } }
const count = { type: "integer", minimum: 0 }
const cap = { type: ["integer", "null"], minimum: 0 }

/**
 * One read-only method for the TUI view and scripts. The TUI part does not receive the plugin options on 2.2.x, and
 * cannot see the server's own findings, so it asks the server for the same status /elevenlabs-status reports.
 */
export const StatusRpc = {
  id: PLUGIN_ID,
  methods: {
    status: {
      input: { type: "object" },
      output: {
        type: "object",
        required: [
          "version",
          "state",
          "access",
          "conversations",
          "region",
          "endpoint",
          "tools",
          "unknownCount",
          "unknownTools",
          "unguardedAgents",
          "shadowedSkills",
          "spend",
          "otherServers",
          "mediaRoot",
          "host",
          "problems",
          "nextStep",
        ],
        properties: {
          version: { type: "string" },
          state: { enum: ["connected", "sign_in_required", "connecting", "disabled", "failed", "not_configured", "conflict"] },
          error: { type: "string" },
          account: { type: "string" },
          access: { enum: ["all", "ask-changes", "read-only"] },
          conversations: { enum: ["full", "summary", "off"] },
          region: { enum: ["global", "us", "eu", "in", "sg"] },
          endpoint: { type: "string" },
          oldSignIns: {
            type: "array",
            items: {
              type: "object",
              required: ["region", "integrationID"],
              properties: { region: { enum: ["global", "us", "eu", "in", "sg"] }, integrationID: { type: "string" } },
            },
          },
          source: {
            type: "object",
            required: ["type", "url"],
            properties: { type: { enum: ["plugin", "adopted", "conflict", "stale"] }, url: { type: "string" }, expected: { type: "string" } },
          },
          tools: count,
          unknownCount: count,
          unknownTools: strings,
          unguardedAgents: strings,
          shadowedSkills: {
            type: "array",
            items: { type: "object", required: ["name", "path"], properties: { name: { type: "string" }, path: { type: "string" } } },
          },
          spend: {
            type: "object",
            required: ["dailyCredits", "sessionCap", "dailyCap"],
            properties: {
              dailyCredits: count,
              sessionCap: cap,
              dailyCap: cap,
              balance: {
                type: "object",
                required: ["used", "limit"],
                properties: {
                  used: count,
                  limit: count,
                  resetsAt: { type: "integer" },
                  extension: { type: ["integer", "string"] },
                  tier: { type: "string" },
                },
              },
            },
          },
          otherServers: strings,
          mediaRoot: { type: "string" },
          host: {
            type: "object",
            required: ["version", "range", "tested"],
            properties: { version: { type: ["string", "null"] }, range: { type: "string" }, tested: { type: "boolean" } },
          },
          problems: strings,
          nextStep: { type: "string" },
        },
      },
      errors: { unavailable: { type: "object", required: ["nextStep"], properties: { nextStep: { type: "string" } } } },
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition

export function registerStatusRpc(rpc: Pick<Plugin.Context["rpc"], "register">, read: () => Promise<Status>) {
  return rpc.register(StatusRpc, {
    status: (_input, { error }) =>
      read().catch((cause: unknown) => {
        const { message, nextStep } = unavailable(cause)
        return error("unavailable", message, { nextStep })
      }),
  })
}

export function registerStatusCommand(
  ctx: { readonly command: Pick<Plugin.Context["command"], "transform">; readonly session: Pick<Plugin.Context["session"], "synthetic"> },
  read: () => Promise<Status>,
) {
  return ctx.command.transform((editor) =>
    editor.add({
      name: "elevenlabs-status",
      description: "Show ElevenLabs' connection, sign-in, region, spend, tools and the next step",
      execute: async ({ sessionID }) => {
        const text = await read().then(formatStatus, (cause: unknown) => {
          const { message, nextStep } = unavailable(cause)
          return `${message} Next step: ${nextStep}`
        })
        await ctx.session.synthetic({ sessionID, text, description: `${DISPLAY_NAME} status`, resume: false })
      },
    }),
  )
}
