/**
 * The tools RPC, version 2.3: every known tool the plugin exposes, and the plugin's own methods, as RPC methods, so a
 * script can call them with no model.
 *
 *   POST /api/rpc/elevenlabs.tools/<method>
 *   { "input": { "sessionID": "<session>", "input": <the tool's input> } }
 *
 * The transport is source-contract's `tools-rpc` module (pinned in package.json and bundled into dist/index.js): the
 * version 2 rules (resolve before dispatch, only `allow` runs, the one `evaluate` hook that turns an inner ask of this
 * RPC's own calls into a deny), `describe` and the envelope. This module is ElevenLabs' part of it, one
 * `ToolsRpcPlugin` value: the plugin's id, its method table, its spending shapers, its next steps and its own error
 * mapping. It was the PLUGIN-SPECIFIC block of the shared copy every plugin carried.
 *
 * Setup registers the source contract's two methods beside the table (src/events.ts): `events_list`
 * (`elevenlabs_events_list`, class `read`) and `probe` (`elevenlabs_probe`, class `read`).
 *
 * The executor bypasses `execute.before` and `execute.after` hooks, so `shapeInput` runs before dispatch and
 * `shapeResult` after it, whatever those hooks do on the model path.
 */
import { randomUUID } from "node:crypto"
import {
  registerToolsRpc as register,
  toolsRpcId,
  type Failure,
  type McpResult,
  type MethodClass,
  type MethodSpec,
  type NextSteps,
  type PluginMethod,
  type ShapeCall,
  type ToolsRpcContext,
  type ToolsRpcOptions as PackageOptions,
  type ToolsRpcPlugin,
} from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { EventsFailure } from "../events.js"
import { PLUGIN_ID as ELEVENLABS_PLUGIN_ID, SERVER_NAME } from "../constants.js"
import { ALL_TOOLS, classify, mustPrice, spends } from "../elevenlabs-tools.js"
import {
  capped,
  costLine,
  costValue,
  estimatePrice,
  isEstimate,
  isEstimateResult,
  Ledger,
  quoteCallSync,
  RESERVATION_MS,
  settlementOf,
  SpendRefused,
  UNPRICED,
  type Caps,
  type Price,
} from "../billing.js"
import { runSaveMedia, SAVE_ACTION, SAVE_OUTPUT, SAVE_SCHEMA, saveDescription, type SaveToolInput } from "../media/tool.js"

/** The plugin's id. The RPC id is `<PLUGIN_ID>.tools`. */
export const PLUGIN_ID = ELEVENLABS_PLUGIN_ID

/** The class the shared vocabulary knows: spending is a write that bills, so `describe` reports it as a write. */
const classOf = (name: string): MethodClass => {
  switch (classify(name)) {
    case "read":
      return "read"
    case "export":
      return "export"
    case "destructive":
      return "destructive"
    default:
      return "write"
  }
}

/** What the script path needs from setup: the same ledger and caps the model path uses, and the tool's own seam. */
export interface ToolRuntime {
  readonly ledger: Ledger
  readonly caps: () => Caps
  readonly save?: SaveToolInput
}

/** The plugin's own tool, as a method. It writes a file, so it is an export and asserts its own permission inside `run`. */
const saveMethod = (runtime: () => ToolRuntime | undefined): PluginMethod => ({
  kind: "plugin",
  class: "export",
  name: SAVE_ACTION,
  action: SAVE_ACTION,
  description: saveDescription("the media folder this plugin's status names"),
  input: SAVE_SCHEMA,
  output: SAVE_OUTPUT,
  async run(input, call) {
    const save = runtime()?.save
    if (!save) throw new SaveUnavailable()
    return (await runSaveMedia(save, input, call)).output
  },
})

let current: (() => ToolRuntime | undefined) | undefined

/**
 * Every tool this plugin knows, by exact upstream name, with the class `describe` reports, plus `elevenlabs_save_media`.
 * The table is the live catalogue as captured in `test/fixtures/live-tools.json`; a tool ElevenLabs adds later is not a
 * method until it is classified in `src/elevenlabs-tools.ts`, and `describe` lists it as unclassified.
 */
export const METHODS: readonly MethodSpec[] = [
  ...ALL_TOOLS.map((name): MethodSpec => ({ kind: "mcp", name, class: classOf(name) })),
  saveMethod(() => current?.()),
]

/** The plugin's own refusal for a method whose owning plugin is not set up. */
class SaveUnavailable extends Error {
  readonly code = "TOOL_UNAVAILABLE"
  readonly nextStep = "Run /elevenlabs-status, then try again."
  constructor() {
    super("TOOL_UNAVAILABLE: elevenlabs_save_media is not available in this location. Next step: Run /elevenlabs-status, then try again.")
  }
}

/**
 * The shapers a location's tools RPC uses, built from that location's own runtime. There is no module-level runtime: two
 * locations in one process each price, cap and save with their own ledger, caps and media folder.
 */
export interface LocationShapers {
  readonly input: (method: string, input: unknown, call: ShapeCall) => unknown
  readonly result: (method: string, result: McpResult, call: ShapeCall) => McpResult
}

/** The runtime the block's default shapers use. Setup sets it per location; a second location replaces it. */
export function setToolRuntime(runtime: ToolRuntime | undefined) {
  current = runtime === undefined ? undefined : () => runtime
}

/**
 * One shaper set per runtime, so the price a call reserved is the price its result settles: the pending map lives with
 * the runtime, not with each invocation.
 */
const shaperSets = new WeakMap<ToolRuntime, LocationShapers>()

const shapersOf = (runtime: ToolRuntime) => {
  const found = shaperSets.get(runtime)
  if (found) return found
  const built = shapersFor(runtime)
  shaperSets.set(runtime, built)
  return built
}

/** The block's shapeInput, for a caller that passes no shapers of its own. Setup always passes its own. */
export function shapeInput(method: string, input: unknown, call: ShapeCall): unknown {
  const runtime = current?.()
  return runtime === undefined ? input : shapersOf(runtime).input(method, input, call)
}

/** The block's shapeResult, for a caller that passes no shapers of its own. */
export function shapeResult(method: string, result: McpResult, call: ShapeCall): McpResult {
  const runtime = current?.()
  return runtime === undefined ? result : shapersOf(runtime).result(method, result, call)
}

/**
 * What the model path's `execute.before` hooks do to an MCP call's arguments, which the executor skips: it prices the
 * call, clamps its generation count and **reserves** the price before dispatch, so a second call that starts at the same
 * time cannot spend the same budget. It is synchronous by contract; image and video have no published price, so a script
 * prices them itself first, and the model path gets the same price through the hook, which may await the server's own
 * estimate.
 */
export function shapersFor(runtime: ToolRuntime): LocationShapers {
  /**
   * While a cap is on, one in-flight priced call per session and method. A second shapeInput, estimate or not, waits
   * until this call's shapeResult has run. An estimate must not share a flag with a paid hold: the paid result would be settled at the
   * estimate. Pairing the two by call id needs that id on ShapeCall, which is shared and is not added here.
   */
  interface Flight {
    readonly kind: "paid" | "estimate"
    readonly id: string
    readonly price: Price
    readonly args: Record<string, unknown>
    /** When it was admitted, which is how an estimate ages: it has no reservation to expire. */
    readonly at: number
  }
  const flights = new Map<string, Flight>()
  /**
   * The slot a call's flight is held in. The name is folded, as the money gate and the permission gate both fold it:
   * a slot that told `Creative_Generate_Speech` from `creative_generate_speech` would let two priced calls run beside
   * each other through the one gate meant to admit one.
   */
  const key = (call: ShapeCall, method: string) => `${call.sessionID}\u0000${method.toLowerCase()}`

  /**
   * Whether a flight's call can still be waiting. A paid one lasts as long as its reservation, which becomes a charge
   * when it runs out. An estimate holds no money and has no reservation to expire, so it ages on the same window: a
   * bookkeeping entry with nothing behind it must never refuse a call, and a refusal whose next step cannot be carried
   * out is the wrong refusal.
   */
  const live = (flight: Flight) =>
    flight.kind === "paid" ? runtime.ledger.reservation(flight.id) !== undefined : flight.at > runtime.ledger.now() - RESERVATION_MS

  /** Why a result's own figure did not lower the charge, for the cost line the model reads. */
  const lowerIgnored = (reported: number, reserved: number) =>
    `the result reported ${reported.toLocaleString("en-US")} credits, which this path cannot tell apart from another call's, so the ${reserved.toLocaleString("en-US")} reserved stands`

  /**
   * A result with no cap set. Nothing was priced, held or queued, so nothing pairs it with a call: a result that is an
   * `estimate_only` answer is left as it is, and a paid one is reported and recorded at the figure it reports itself, or
   * as not reported. A call that threw leaves nothing behind for a later result to be read against.
   */
  const uncappedResult = (result: McpResult, call: ShapeCall): McpResult => {
    if (isEstimateResult(result)) return result
    const caps = runtime.caps()
    const reported = settlementOf(result, 0, null)
    const price: Price = reported.credits > 0 ? { credits: reported.credits, basis: "exact", parts: reported.note === undefined ? [] : [reported.note] } : UNPRICED
    const spend = price.credits > 0 ? runtime.ledger.record(call.sessionID, price.credits) : runtime.ledger.spend(call.sessionID)
    const line = costLine(price, spend, caps)
    const value = costValue(price, spend, caps)
    const output = result.output !== null && typeof result.output === "object" && !Array.isArray(result.output)
      ? { ...(result.output as Record<string, unknown>), cost: value }
      : { cost: value }
    return { ...result, output, text: result.text === "" ? line : `${result.text}\n${line}` }
  }

  return {
    input(method, input, call) {
      const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>
      if (!mustPrice(method)) return input
      const slot = key(call, method)
      // No cap: nothing is priced, refused, clamped, held or serialised, and nothing is remembered about this call.
      if (!capped(runtime.caps())) return input
      // Prune first, so a hold that outlasted ten minutes is already a charge and no longer a reservation.
      runtime.ledger.spend(call.sessionID)
      const flight = flights.get(slot)
      if (flight && live(flight)) {
        throw new SpendRefused(
          "SPEND_CAP_REACHED",
          `a priced call to ${method} is already in flight for this session, so another cannot start until it settles.`,
          "Wait for that call to return, or call it again once its ten-minute reservation has run out.",
        )
      }
      // It ran out while its call was still running. A paid one was charged at its reservation the moment the hold
      // expired, so that call is paid for and a late answer to it changes nothing here: there is no ghost to
      // keep this slot conservative for, because on this path a result can only ever raise a charge.
      if (flight) flights.delete(slot)
      if (isEstimate(method, args)) {
        flights.set(slot, { kind: "estimate", id: "", price: { credits: 0, basis: "exact", parts: [] }, args, at: runtime.ledger.now() })
        return input
      }
      const id = `${call.sessionID}\u0000${method}\u0000${randomUUID()}`
      // Synchronous from the price to the reservation: nothing can slip between the check and the hold.
      const { price, tracked } = quoteCallSync({ ledger: runtime.ledger, caps: runtime.caps }, method, args, {
        sessionID: call.sessionID,
        agent: call.agent,
        messageID: "",
        id,
      })
      if (tracked) flights.set(slot, { kind: "paid", id, price, args, at: runtime.ledger.now() })
      return input
    },

    result(method, result, call) {
      if (!mustPrice(method)) return result
      const slot = key(call, method)
      if (!capped(runtime.caps())) return spends(method) ? uncappedResult(result, call) : result
      const flight = flights.get(slot)
      // No priced call is in flight. Do not record a stray figure: an estimate result must not settle a paid hold.
      if (!flight) return result
      flights.delete(slot)
      if (flight.kind === "estimate") {
        const price = estimatePrice(method, flight.args, result)
        if (price) runtime.ledger.rememberPrice(method, flight.args, price)
        return result
      }
      const caps = runtime.caps()
      const reported = settlementOf(result, flight.price.credits, caps.dailyCreditCap)
      // Nothing on `ShapeCall` says which call a result answers, so on this path a result may raise a charge and may
      // never lower one: whichever call the figure came from, this slot spent at least the reservation, and
      // over-counting is the safe side of a pairing this path cannot make. `SHAPECALL-ID-PROPOSAL.md` is the route to
      // pairing them exactly; until it lands, the reservation is the floor.
      const raised = reported.credits > flight.price.credits
      const note = raised ? reported.note : (reported.note ?? (reported.credits < flight.price.credits ? lowerIgnored(reported.credits, flight.price.credits) : undefined))
      const parts = note === undefined ? flight.price.parts : [...flight.price.parts, note]
      const price: Price = raised
        ? { credits: reported.credits, basis: "exact", parts: note === undefined ? [] : [note] }
        : { ...flight.price, parts }
      const spend = runtime.ledger.settle(flight.id, call.sessionID, price.credits, raised && reported.attested)
      const line = costLine(price, spend, caps)
      const value = costValue(price, spend, caps)
      const output = result.output !== null && typeof result.output === "object" && !Array.isArray(result.output)
        ? { ...(result.output as Record<string, unknown>), cost: value }
        : { cost: value }
      return { ...result, output, text: result.text === "" ? line : `${result.text}\n${line}` }
    },
  }
}

/** The next step for each code. Each is one sentence that ends with a full stop. */
export const NEXT_STEPS: NextSteps = {
  SESSION_UNKNOWN: `Create a session in the location you mean, such as POST /api/session with {"agent":"build"} sent with the header "x-opencode-directory: <dir>" or the location[directory] query, and pass its id.`,
  SESSION_AGENT_REQUIRED: `Create a session that names an agent this project has, with its project as the location, such as POST /api/session with {"agent":"build","location":{"directory":"/path/to/project"}}, and pass its id.`,
  PERMISSION_DENIED: "Add an allow rule for the tool to the session's agent or to the session, or use a session whose agent allows it.",
  SERVER_CONFLICT: `Run /elevenlabs-status, then point your own mcp.servers.${SERVER_NAME} in opencode.json at the URL it names or remove it, and restart OpenCode.`,
  AUTH_REQUIRED: `Run /connect and choose ElevenLabs, then press o or Enter to open the link (in a terminal, opencode mcp auth ${SERVER_NAME} opens it automatically).`,
  CONNECTING: "Wait a few seconds, then call the method again.",
  CONNECTION_FAILED: "Check your network, then run /elevenlabs-status and follow its next step.",
  DISABLED: `Enable the ${SERVER_NAME} server in /mcps, or remove "disabled": true from mcp.servers.${SERVER_NAME} in opencode.json.`,
  NOT_REGISTERED: "Run /elevenlabs-status and follow its next step.",
  TOOL_UNAVAILABLE: "Call describe to see which methods OpenCode lists now, and run /elevenlabs-status.",
  UPSTREAM_ERROR: "Check the input against the method's schema from describe, and run /elevenlabs-status if it keeps failing.",
  CANCELLED: "Call the method again if you still need the result.",
}

/** The plugin's own errors: a billed call that does not fit its caps, one that cannot be priced, and the save tool. */
export function pluginError(error: unknown): Failure | undefined {
  if (error instanceof SpendRefused) {
    const rest = error.message.slice(error.code.length + 2)
    const what = rest.split(" Next step: ")[0] ?? rest
    return { code: error.code, what: what.replace(/\.$/, ""), next: error.nextStep }
  }
  if (error instanceof SaveUnavailable) return { code: error.code, what: "elevenlabs_save_media is not available in this location", next: error.nextStep }
  // events_list's and probe's refusals carry the source contract's own codes, so a consumer reads them without a mapping.
  if (error instanceof EventsFailure) return { code: error.code, what: error.what, next: error.next }
  return undefined
}

export { CLASSES, LOCATION_HEADER, LOCATION_HINT, evaluate, hidden, upstreamText } from "@we-the-rebel-alliance/source-contract/tools-rpc"
export type {
  Failure,
  JsonSchema,
  McpMethod,
  McpResult,
  MethodClass,
  MethodSpec,
  NextSteps,
  OwnedMethod,
  PluginMethod,
  Rule,
  ShapeCall,
  Shapers,
  ToolCall,
  ToolsRpcContext,
  ToolsRpcPlugin,
} from "@we-the-rebel-alliance/source-contract/tools-rpc"

/** ElevenLabs' part of the tools RPC, as the package's one value. No method has a resource resolver. */
export const ELEVENLABS: ToolsRpcPlugin = { id: PLUGIN_ID, nextSteps: NEXT_STEPS, shapeInput, shapeResult, pluginError }

/** `elevenlabs.tools`, the id package.json's `sources.rpc` names. */
export const TOOLS_RPC_ID = toolsRpcId(PLUGIN_ID)

/** Everything setup and the suites pass: the table, its shapers and the MCP options, which ElevenLabs' value completes. */
export type ToolsRpcOptions = Omit<PackageOptions, "plugin">

/** The package's `registerToolsRpc` with ElevenLabs' value, so a caller passes only the table and the MCP options. */
export function registerToolsRpc(ctx: ToolsRpcContext, options: ToolsRpcOptions): Promise<() => Promise<void>> {
  return register(ctx, { ...options, plugin: ELEVENLABS })
}
