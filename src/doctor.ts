import type { Plugin } from "@opencode/plugin"
import type { Balance } from "./balance.js"
import { AUTH_SERVERS, DISPLAY_NAME, OAUTH_SCOPES, REGIONS, SERVER_NAME, type Region } from "./constants.js"
import { expandRoot } from "./media/policy.js"
import type { HostCheck } from "./host-version.js"
import type { Access, Conversations } from "./options.js"
import type { Rule } from "./permissions.js"
import type { SpendFacts } from "./status.js"

/**
 * The live check behind `/elevenlabs-doctor`: what OpenCode can see, what ElevenLabs' own discovery document says, and
 * the local parts of the plugin that generate and save files. It reads; it never generates, signs in or spends.
 */
export interface DoctorContext {
  readonly mcp: Pick<Plugin.Context["mcp"], "list">
  readonly tool: Pick<Plugin.Context["tool"], "list">
  readonly skill: Pick<Plugin.Context["skill"], "list">
  readonly agent: Pick<Plugin.Context["agent"], "list">
}

export interface DoctorFacts {
  readonly region: Region
  readonly access: Access
  readonly conversations: Conversations
  readonly mediaRoot: string
  readonly maxMediaBytes: number
  readonly host: HostCheck
  readonly spend: SpendFacts
  readonly skills: readonly { readonly name: string; readonly path: string }[]
  readonly balance?: Balance
  readonly problems: readonly string[]
  readonly fetch?: typeof fetch
}

type Line = readonly [ok: boolean, text: string]

/**
 * ElevenLabs' discovery chain for this region, unauthenticated: the resource document, then the authorization server's
 * metadata. It is the one check that proves the address and the sign-in are reachable from this machine.
 */
export async function checkDiscovery(region: Region, send: typeof fetch = fetch): Promise<Line[]> {
  const resource = `${new URL(REGIONS[region]).origin}/.well-known/oauth-protected-resource`
  const auth = AUTH_SERVERS[region]
  try {
    const response = await send(resource, { headers: { accept: "application/json" } })
    if (!response.ok) return [[false, `discovery: ${resource} answered HTTP ${response.status}`]]
    const body = (await response.json()) as { resource?: unknown; authorization_servers?: unknown }
    const servers = Array.isArray(body.authorization_servers) ? body.authorization_servers.filter((item): item is string => typeof item === "string") : []
    if (!servers.includes(auth)) {
      return [[false, `discovery: the resource document names ${servers.join(", ") || "no authorization server"}, not ${auth}`]]
    }
    const metadata = await send(`${auth}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" } })
    if (!metadata.ok) return [[false, `discovery: ${auth}/.well-known/oauth-authorization-server answered HTTP ${metadata.status}`]]
    const as = (await metadata.json()) as { client_id_metadata_document_supported?: unknown; scopes_supported?: unknown }
    const scopes = Array.isArray(as.scopes_supported) ? as.scopes_supported.filter((item): item is string => typeof item === "string") : []
    const missing = OAUTH_SCOPES.split(" ").filter((scope) => !scopes.includes(scope))
    const cimd = as.client_id_metadata_document_supported === true
    return [
      [true, `discovery: ${new URL(resource).origin} describes itself, and names ${auth} as its sign-in server`],
      [cimd, `sign-in: ${cimd ? "accepts a client metadata document, so no client ID is needed" : "does not advertise a client metadata document; OpenCode would try dynamic registration"}`],
      [missing.length === 0, `scopes: ${missing.length === 0 ? `all ${OAUTH_SCOPES.split(" ").length} the plugin asks for are advertised` : `the server does not advertise ${missing.join(", ")}`}`],
    ]
  } catch {
    return [[false, `discovery: could not reach ${resource}`]]
  }
}

const lines = async (context: DoctorContext, facts: DoctorFacts): Promise<Line[]> => {
  const [servers, tools, skills, agents] = await Promise.all([
    context.mcp.list(),
    context.tool.list(),
    context.skill.list().then((result) => result.data, () => []),
    context.agent.list(),
  ])
  const server = servers.data.find((entry) => entry.name === SERVER_NAME)
  const listed = tools.filter((tool) => tool.options?.namespace === SERVER_NAME)
  const owned = skills.filter((skill) => facts.skills.some((own) => own.name === skill.id))
  const root = expandRoot(facts.mediaRoot)
  const unguarded = agents.data.filter((agent) => agent.permissions.some((rule) => rule.action === "*" && rule.effect === "allow")).length
  const spend = facts.spend
  const count = (value: number) => value.toLocaleString("en-US")
  const cap = (value: number | null) => (value === null ? "no cap" : count(value))
  return [
    [true, `region: ${facts.region} (${REGIONS[facts.region]})`],
    [facts.host.tested || facts.host.version !== null, `OpenCode: ${facts.host.version ?? "unknown"} (${facts.host.tested ? "tested" : "untested"}; supported ${facts.host.range})`],
    [server !== undefined && server.status.status === "connected", `server: ${server === undefined ? "not registered" : server.status.status}`],
    [server?.status.status !== "needs_auth", `sign-in: ${server?.status.status === "needs_auth" ? "a sign-in is required; run /connect and choose " + DISPLAY_NAME : "the stored credential is in use"}`],
    [listed.length > 0, `tools: ${listed.length} listed${listed.length === 0 ? "" : `, ${new Set(listed.map((tool) => tool.name.split("_")[0])).size} namespaces`}`],
    [owned.length === facts.skills.length, `skills: ${owned.length} of ${facts.skills.length} loaded${owned.length === facts.skills.length ? "" : ` (missing: ${facts.skills.filter((own) => !owned.some((skill) => skill.id === own.name)).map((own) => own.name).join(", ")})`}`],
    [true, `permissions: ${facts.access}; ${unguarded} agent(s) with a base allow (status names any that lack the block)`],
    [true, `conversations: ${facts.conversations}`],
    [true, `media: ${root} (created on the first save, files up to ${cap(facts.maxMediaBytes)} bytes)`],
    [
      true,
      `spend: ${count(spend.dailyCredits)} credits in the last 24 hours${spend.dailyCap === null ? ", with no daily cap" : ` of ${count(spend.dailyCap)}`}; ${spend.sessionCap === null ? "no session cap" : `a session is capped at ${count(spend.sessionCap)}`}`,
    ],
    [
      facts.balance !== undefined || spend.balance === undefined,
      spend.balance === undefined
        ? "balance: no API key added, so the spend counts this plugin's own calls only"
        : `balance: ${count(Math.max(0, spend.balance.limit - spend.balance.used))} of ${count(spend.balance.limit)} credits left this period`,
    ],
    [facts.problems.length === 0, `problems: ${facts.problems.length === 0 ? "none" : facts.problems.join(" ")}`],
  ]
}

/** The report `/elevenlabs-doctor` shows: one line per check, then the conclusion. */
export async function runDoctor(context: DoctorContext, facts: DoctorFacts): Promise<string> {
  const discovery = await checkDiscovery(facts.region, facts.fetch)
  const checks = [...(await lines(context, facts)), ...discovery]
  const failed = checks.filter(([ok]) => !ok)
  const report = checks.map(([ok, text]) => `${ok ? "ok  " : "FAIL"} ${text}`)
  const conclusion =
    failed.length === 0
      ? "Everything checked out. Nothing to do."
      : `Next step: fix the ${failed.length} line(s) marked FAIL above, then run /elevenlabs-status.`
  return [`${DISPLAY_NAME} doctor`, ...report, "", conclusion].join("\n")
}

/** A one-line summary for the status dialog, so the same facts are not re-fetched. */
export const doctorSummary = (checks: readonly Line[]) => {
  const failed = checks.filter(([ok]) => !ok).length
  return failed === 0 ? "doctor: all checks passed" : `doctor: ${failed} check(s) failed; run /elevenlabs-doctor`
}

export type { Rule }
