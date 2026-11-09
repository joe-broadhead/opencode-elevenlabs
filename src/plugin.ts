import { randomUUID } from "node:crypto"
import { Plugin, type Mcp } from "@opencode/plugin"
import { readBalance, readKey, registerBalanceIntegration } from "./balance.js"
import { appendLine, costLine, costValue, estimatePrice, isEstimate, Ledger, LEDGER_REFRESH_MS, quoteCall, settlementOf, type Caps, type Price } from "./billing.js"
import {
  DISPLAY_NAME,
  errorText,
  MEDIA_HOSTS,
  NAMESPACE_DESCRIPTION,
  OAUTH_SCOPES,
  PLUGIN_ID,
  REGIONS,
  SERVER_NAME,
} from "./constants.js"
import { runDoctor } from "./doctor.js"
import { checkHost } from "./host-version.js"
import { registerToolsRpc, setToolRuntime, shapersFor, METHODS, type ToolRuntime } from "./host/tools-rpc.js"
import { watchIntegration } from "./integration.js"
import { addSaveTool } from "./media/tool.js"
import { mustPrice } from "./elevenlabs-tools.js"
import { parseOptions, type ParsedOptions } from "./options.js"
import { reasonOf } from "./redact.js"
import { defaultRules, registerDefaultRules } from "./permissions.js"
import { loadSkills, registerSkills } from "./skills.js"
import { readStatus, registerStatusCommand, registerStatusRpc, type ServerSource, type SpendFacts } from "./status.js"

/** Internal seam: tests point the server at a loopback fake without OAuth, at their own skills and media hosts. */
export interface ElevenlabsSeam {
  readonly endpoint?: string
  readonly oauth?: false
  readonly skillsDir?: string
  /** Extra hosts a media link may name. Only a test seam adds one; the plugin's own list is ElevenLabs'. */
  readonly mediaHosts?: readonly string[]
  readonly fetch?: typeof fetch
}

type RemoteConfig = Extract<Mcp.ServerConfig, { type: "remote" }>

/**
 * No oauth block beyond the scope pin: OpenCode chooses CIMD and runs the sign-in itself. ElevenLabs advertises eight
 * scopes; the pin is the seven its own MCP client asks for, so `ads_read` is never requested. No protocol, codemode,
 * timeout or headers: the host defaults apply.
 */
export const serverConfig = (url: string, seam: ElevenlabsSeam): RemoteConfig => ({
  type: "remote",
  url,
  ...(seam.oauth === false ? { oauth: false as const } : { oauth: { scope: OAUTH_SCOPES } }),
})

/**
 * Origin and path only, so a token in a query string never reaches status.
 */
export function displayUrl(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return "an invalid URL"
  }
}

/**
 * A conflicting server's address for status. Another origin shows only its origin, because its path can hold a secret.
 */
export function conflictUrl(url: string, expected: string) {
  try {
    const parsed = new URL(url)
    if (parsed.origin === new URL(expected).origin) return displayUrl(url)
    return parsed.pathname === "/" ? parsed.origin : `${parsed.origin}/…`
  } catch {
    return "an invalid URL"
  }
}

/** The region a URL belongs to, when it is one of the five the plugin knows. */
export function regionOf(url: string) {
  const shown = displayUrl(url)
  return (Object.keys(REGIONS) as (keyof typeof REGIONS)[]).find((region) => REGIONS[region] === shown)
}

/** A server name plain enough to print: the characters an MCP server name is made of, and never this plugin's own. */
const SAFE_SERVER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
/** At most this many other entries are named; the point is made by the first few. */
const LISTED_OTHERS = 5

/**
 * The other `mcp.servers` entries that point at one of ElevenLabs' own addresses (RR2-8). OpenCode treats each as its
 * own server with its own tool prefix, so this plugin's hooks never see their calls and its credit caps do not bind
 * them. Nothing is changed: a second entry is the owner's to keep, and status only names it.
 */
export function otherElevenlabsServers(entries: readonly (readonly [string, { readonly type: string; readonly url?: string }])[]) {
  return entries
    .filter(([name, config]) => name !== SERVER_NAME && config.type === "remote" && typeof config.url === "string" && regionOf(config.url) !== undefined)
    .map(([name]) => name)
    .filter((name) => SAFE_SERVER.test(name))
    .slice(0, LISTED_OTHERS)
}

/**
 * Registers `elevenlabs`, or adopts the user's own `mcp.servers.elevenlabs` unchanged when it points at exactly the
 * selected region's URL: user config is applied first, and a later `set` would replace it. Another region's URL is
 * `stale` — a region change leaves an old entry behind, and status gives one next step for it. Any other URL is a
 * conflict, and nothing is added. Synchronous and never throws.
 */
export function registerServer(
  mcp: Pick<Plugin.Context["mcp"], "transform">,
  config: RemoteConfig,
  record: (source: ServerSource | undefined, problem?: string, others?: readonly string[]) => void,
) {
  return mcp.transform((editor) => {
    try {
      const existing = editor.get(SERVER_NAME)
      const expected = displayUrl(config.url)
      // Read beside the entry this plugin owns: another entry at ElevenLabs' address is outside the caps, and status
      // says so. Listing is all that happens; the entry is the owner's.
      const others = otherElevenlabsServers(editor.list())
      if (!existing) {
        editor.set(SERVER_NAME, config)
        return record({ type: "plugin", url: expected }, undefined, others)
      }
      if (existing.type === "remote" && displayUrl(existing.url) === expected) return record({ type: "adopted", url: expected }, undefined, others)
      const stale = existing.type === "remote" && regionOf(existing.url) !== undefined
      // A stale entry is one of ElevenLabs' own addresses, so its full URL is safe and the next step needs it; another
      // server's path can hold a secret and is reduced to its origin.
      const url = stale && existing.type === "remote" ? displayUrl(existing.url) : existing.type === "remote" ? conflictUrl(existing.url, config.url) : "a local command"
      record({ type: stale ? "stale" : "conflict", url, expected }, undefined, others)
    } catch (error) {
      record(undefined, errorText("SERVER_NOT_REGISTERED", `The ${SERVER_NAME} MCP server could not be registered (${reasonOf(error)}).`, "Restart OpenCode."))
    }
  })
}

/**
 * Whether the money guard runs for a server entry (DR-11). It is true for every entry that is ElevenLabs' — the plugin's
 * own, the user's adopted one, and a stale entry at another region's URL, which OpenCode still connects and still lists
 * tools for. Only a server at another vendor's URL is not ours to price.
 */
export const guardsSource = (source: ServerSource | undefined) => source !== undefined && source.type !== "conflict"

/**
 * The tool name without the server prefix, lowercased, or undefined when the call is not one of this server's. Case is
 * folded on both halves (RR2-8): the prefix, as the permission rules fold it, and the name, so every price lookup and
 * every remembered estimate downstream is keyed the one way.
 *
 * Only this plugin's own server entry is stripped. A second MCP entry pointing at ElevenLabs under another name is a
 * different server to OpenCode, and the caps do not reach it; status names it when one exists.
 */
export const toolOf = (id: string) =>
  id.toLowerCase().startsWith(`${SERVER_NAME}_`) ? id.slice(SERVER_NAME.length + 1).toLowerCase() : undefined

/** The line a generation's result carries: the link dies in about two hours, so say how to keep the file. */
export const EXPIRY_LINE =
  "This link expires in about two hours. Save it with elevenlabs_save_media to keep the file; generating it again spends more credits."

/** True when a result carries an http link, so the expiry line is worth saying. */
const hasLink = (result: { readonly content?: unknown }) => {
  const text = typeof result.content === "string" ? result.content : Array.isArray(result.content) ? result.content.map((part: { text?: string }) => part.text ?? "").join("\n") : ""
  return /https:\/\/\S+/.test(text)
}

/**
 * The estimate the model path may await: ElevenLabs' own price for exactly these arguments, through the host's
 * executor. An estimate is not a read. It creates a flow and a node in the workspace, and it runs through the
 * executor, where no permission rule stops it — so this asserts the paid call's own action first. Under
 * `access: "read-only"` the generation is denied and no estimate runs for it; under `"ask-changes"` the estimate runs
 * only once the generation itself has been allowed (README, SECURITY.md).
 */
const estimatorFor = (ctx: Plugin.Context) => async (tool: string, input: Record<string, unknown>, call: { sessionID: string; agent: string; messageID: string; id: string }): Promise<Price | undefined> => {
  // `toolOf` folded the name's case, so the executor is matched the same way: a server that listed the name in another
  // case still gets its own estimate, rather than being refused for want of a price.
  const id = `${SERVER_NAME}_${tool}`
  const listed = await ctx.tool.list()
  const executor = listed.find((entry) => entry.id === id) ?? listed.find((entry) => entry.id.toLowerCase() === id)
  if (!executor) return undefined
  try {
    await ctx.permission.assert({
      sessionID: call.sessionID,
      agent: call.agent,
      action: id,
      resources: ["*"],
      source: { type: "tool", messageID: call.messageID, id: call.id },
    })
  } catch {
    // The generation is not allowed here, so neither is the estimate that would price it. The guard then refuses the
    // call with PRICE_UNKNOWN, and the host refuses the generation itself for the same reason.
    return undefined
  }
  try {
    const result = await executor.execute({ ...input, estimate_only: true } as never, {
      sessionID: call.sessionID,
      agent: call.agent,
      messageID: call.messageID,
      id: `estimate:${randomUUID()}`,
      signal: new AbortController().signal,
      progress: async () => {},
    } as never)
    const normalised = result as { output?: unknown; content?: unknown }
    const text = typeof normalised.content === "string" ? normalised.content : Array.isArray(normalised.content) ? normalised.content.map((part: { text?: string }) => part.text ?? "").join("\n") : ""
    return estimatePrice(tool, input, { ...(normalised.output === undefined ? {} : { output: normalised.output }), text })
  } catch {
    // A server that refuses the flag, or a link that broke: the guard then refuses rather than guessing a price.
    return undefined
  }
}

export function createElevenlabsPlugin(seam: ElevenlabsSeam = {}) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const options: ParsedOptions = parseOptions(ctx.options)
      const host = checkHost(ctx.app.version, options.allowUntestedHost)
      const { skills, problems: skillProblems } = await loadSkills(seam.skillsDir)
      // Transforms replay on every rebuild, so each one overwrites its own entry rather than appending.
      const problems = new Map<string, string>(skillProblems.map((problem, index) => [`skill:${index}`, problem]))
      const report = (area: string) => (problem: string | undefined) => void (problem ? problems.set(area, problem) : problems.delete(area))
      let source: ServerSource | undefined
      let otherServers: readonly string[] = []

      const url = seam.endpoint ?? REGIONS[options.region]
      const ledger = new Ledger({ storage: ctx.storage })
      await ledger.hydrate()
      // The setup read above is one moment, and a process that spends nothing never takes another: its book would
      // decide for the rest of its life from what the store held when it started. This timer is what bounds that —
      // the book another OpenCode's spending is read into is at most one interval old (RR5-3). It is unref'd, so it
      // never holds the process open, and it is stopped when the plugin is disposed.
      const refreshing = setInterval(() => ledger.catchUp(), LEDGER_REFRESH_MS)
      refreshing.unref?.()
      const caps = (): Caps => ({ sessionCreditCap: options.sessionCreditCap, dailyCreditCap: options.dailyCreditCap })
      const mediaHosts = [...MEDIA_HOSTS, ...(seam.mediaHosts ?? [])]

      await registerServer(ctx.mcp, serverConfig(url, seam), (next, problem, others) => {
        source = next
        otherServers = others ?? []
        report("server")(problem)
      })
      // Code Mode's catalog describes the namespace with this text, unless the server is someone else's; the plugin's
      // own tool lives in the same namespace and is added once.
      // `managed` decides whether this plugin owns the server entry: it may rename it and add its namespace and tool.
      const managed = () => source?.type === "plugin" || source?.type === "adopted"
      /**
       * The guard's own predicate (DR-11): every ElevenLabs entry is guarded, a stale region entry included, because
       * OpenCode still connects it and still lists its tools. Only another vendor's server at the same name is not ours.
       */
      const guarded = () => source !== undefined && source.type !== "conflict"
      await ctx.tool.transform((editor) => {
        if (!managed()) return
        editor.namespace({ name: SERVER_NAME, description: NAMESPACE_DESCRIPTION })
        addSaveTool({
          root: options.mediaRoot,
          maxBytes: options.maxMediaBytes,
          hosts: mediaHosts,
          assert: ctx.permission.assert,
          ...(seam.fetch === undefined ? {} : { fetch: seam.fetch }),
        })(editor)
      })
      await registerDefaultRules(ctx.agent, defaultRules(options.access, options.conversations), report("rules"))
      await registerBalanceIntegration(ctx.integration)

      // The balance is read only when the user added a key, and a failure is a problem for status, never a failed status.
      let balance: SpendFacts["balance"]
      const readSpend = async (): Promise<SpendFacts> => {
        const key = await readKey(ctx.integration).catch(() => undefined)
        if (key !== undefined) {
          try {
            balance = await readBalance(key)
          } catch (error) {
            balance = undefined
            report("balance")(error instanceof Error ? error.message : String(error))
          }
        } else {
          balance = undefined
          report("balance")(undefined)
        }
        const left = ledger.spend("")
        return { dailyCredits: left.dailyCredits, sessionCap: options.sessionCreditCap, dailyCap: options.dailyCreditCap, ...(balance === undefined ? {} : { balance }) }
      }
      const own = skills.map(({ name, path }) => ({ name, path }))
      const read = () =>
        readStatus(ctx, {
          access: options.access,
          conversations: options.conversations,
          region: options.region,
          mediaRoot: options.mediaRoot,
          spend: readSpend,
          ...(source ? { source } : {}),
          otherServers,
          host,
          skills: own,
          problems: [...problems.values()],
        })
      await registerSkills(ctx.skill, skills)
      await registerStatusCommand(ctx, read)
      await registerStatusRpc(ctx.rpc, read)

      // The doctor: the live checks a status report cannot make. It acts, so it is its own command.
      await ctx.command.transform((editor) =>
        editor.add({
          name: "elevenlabs-doctor",
          description: "Check ElevenLabs' address, sign-in discovery, tools, skills, media folder and spend",
          execute: async ({ sessionID }) => {
            const text = await runDoctor(ctx, {
              region: options.region,
              access: options.access,
              conversations: options.conversations,
              mediaRoot: options.mediaRoot,
              maxMediaBytes: options.maxMediaBytes,
              host,
              spend: await readSpend(),
              skills: own,
              ...(balance === undefined ? {} : { balance }),
              problems: [...problems.values()],
              ...(seam.fetch === undefined ? {} : { fetch: seam.fetch }),
            }).catch((error: unknown) => `${errorText("STATUS_UNAVAILABLE", `The doctor could not finish (${reasonOf(error)}).`, "Run /elevenlabs-status, then try again.")}`)
            await ctx.session.synthetic({ sessionID, text, description: `${DISPLAY_NAME} doctor`, resume: false })
          },
        }),
      )

      // Scripts call the known tools with no model, as a session and its agent, under the same ledger and caps.
      const save = { root: options.mediaRoot, maxBytes: options.maxMediaBytes, hosts: mediaHosts, assert: ctx.permission.assert, ...(seam.fetch === undefined ? {} : { fetch: seam.fetch }) }
      const runtime: ToolRuntime = { ledger, caps, save }
      setToolRuntime(runtime)
      const stopTools = await registerToolsRpc(ctx, {
        methods: METHODS,
        mcp: { server: SERVER_NAME, managed: () => source?.type !== "conflict" },
        // The shapers are this location's own, so a second location never prices or saves with the first one's ledger.
        shapers: shapersFor(runtime),
      })

      // The spending guard, on both paths. `execute.before` can change an MCP call's arguments and refuse it before it
      // is sent; `execute.after` charges the ledger and adds the cost line. Scripts go through the block's shapers.
      const estimate = estimatorFor(ctx)
      const pending = new Map<string, Price>()
      const stopBefore = await ctx.tool.hook("execute.before", async (event) => {
        const tool = toolOf(event.tool)
        if (!guarded() || tool === undefined) return
        const args = (typeof event.input === "object" && event.input !== null ? event.input : {}) as Record<string, unknown>
        if (isEstimate(tool, args) || !mustPrice(tool)) return
        // Price, clamp, and reserve before dispatch: a call that starts at the same time sees this reservation.
        const { price, tracked } = await quoteCall({ ledger, caps, estimate }, tool, args, {
          sessionID: event.sessionID,
          agent: event.agent,
          messageID: event.messageID,
          id: event.id,
        })
        if (tracked) pending.set(event.id, price)
      })
      const stopAfter = await ctx.tool.hook("execute.after", async (event) => {
        const tool = toolOf(event.tool)
        if (!guarded() || tool === undefined) return
        const args = (typeof event.input === "object" && event.input !== null ? event.input : {}) as Record<string, unknown>
        const before = pending.get(event.id)
        pending.delete(event.id)
        // An estimate is free and is not a charge: remember it, so the paid call that follows can be priced (DR-5).
        if (isEstimate(tool, args)) {
          if (event.status === "completed") {
            const price = estimatePrice(tool, args, { ...(event.result.output === undefined ? {} : { output: event.result.output }), ...(event.result.content === undefined ? {} : { content: event.result.content }) })
            if (price) ledger.rememberPrice(tool, args, price)
          }
          return
        }
        if (!mustPrice(tool)) return
        // A failure is settled at the reserved price. The plugin cannot tell a free failure from a billed one, and
        // over-counting is the safe side. A missing result must not free the budget.
        if (event.status !== "completed") {
          const reserved = ledger.reservation(event.id)?.credits ?? before?.credits
          if (reserved !== undefined && reserved > 0) ledger.settle(event.id, event.sessionID, reserved)
          return
        }
        // The floor is the ledger's own row for this call, not this hook's memory of it: once the first result has
        // been settled `pending` is empty and the hold is a charge, and a second result for the same call measured
        // against nothing would read as a raise above zero and lower the charge to itself (RR4-5).
        const recorded = ledger.recorded(event.id)
        const floor = recorded?.credits ?? before?.credits ?? 0
        const settled = settlementOf(event.result, floor, caps().dailyCreditCap, recorded?.kind ?? "hold")
        // A figure the plugin would not settle on, and one it settled on but had to flag, both say so in the cost
        // line: the owner sees why the reservation stands, or that a raise was far above what was reserved.
        const parts = settled.credits === floor
          ? [...(before?.parts ?? ["cost not reported"]), ...(settled.note === undefined ? [] : [settled.note])]
          : settled.note === undefined
            ? []
            : [settled.note]
        const price: Price = settled.credits === floor && before && settled.note === undefined
          ? before
          : { credits: settled.credits, basis: settled.credits > 0 && settled.credits !== floor ? "exact" : "at-most", parts }
        const spend = settled.credits <= 0 && floor <= 0 ? ledger.spend(event.sessionID) : ledger.settle(event.id, event.sessionID, settled.credits, settled.attested)
        const line = costLine(price, spend, caps())
        appendLine(event.result, line)
        // The structured `cost` beside the output, as the tools RPC does: a Code Mode program reads the output, not the
        // text parts, so the price travels with it.
        const output = (event.result as { output?: unknown }).output
        if (output !== null && typeof output === "object" && !Array.isArray(output)) {
          ;(output as Record<string, unknown>).cost = costValue(price, spend, caps())
        }
        if (hasLink(event.result)) appendLine(event.result, EXPIRY_LINE)
      })

      const stopWatch = watchIntegration(ctx, managed)
      return async () => {
        clearInterval(refreshing)
        setToolRuntime(undefined)
        await stopWatch()
        await stopBefore.dispose()
        await stopAfter.dispose()
        await stopTools()
      }
    },
  })
}


