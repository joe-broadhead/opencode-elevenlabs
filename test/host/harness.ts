// An embedded OpenCode host from the public @opencode/sdk, isolated in the temp root from ./isolate.js: the
// environment, config, database and project directory all live there, and any fetch that leaves loopback fails the
// run. The ElevenLabs plugin is built with the internal seam, pointed at the loopback fake without OAuth, and gets its
// options injected the way the host passes config options. A probe plugin, loaded after it, lends its context to the
// tests.
import { HOST_SDK_DIR, ROOT as root } from "./isolate.js"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { OpenCodeClient } from "@opencode/client"
import { Plugin } from "@opencode/plugin"
import { createElevenlabsPlugin } from "../../src/plugin.js"
import { SKILL_NAMES } from "../../src/skills.js"
import { startFakeMcp, type FakeMcpOptions } from "./fake-mcp.js"

export type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }

/** The SDK's `Interface`, which its own declarations resolve to `any`. */
type Client = Omit<OpenCodeClient, "plugin"> & {
  readonly sessions: OpenCodeClient["session"]
  readonly plugin: ((plugin: Plugin.Plugin) => Promise<void>) & OpenCodeClient["plugin"]
  readonly close: () => Promise<void>
}

/** The locked @opencode/sdk, or another tested release installed outside the lockfile in HOST_SDK_DIR's node_modules. */
const SDK = HOST_SDK_DIR ? join(HOST_SDK_DIR, "node_modules", "@opencode", "sdk") : fileURLToPath(new URL("../../node_modules/@opencode/sdk", import.meta.url))
export const HOST_VERSION = (JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as { version: string }).version

/**
 * From OpenCode 2.3.1, `experimental.automation` replaces `experimental.schedule`, and a code action no longer runs when
 * it is created: it runs when the scheduler finds it due.
 */
export const AUTOMATIONS = ((major, minor, patch) => major > 2 || (major === 2 && (minor > 3 || (minor === 3 && patch >= 1))))(
  ...(HOST_VERSION.split(".").map(Number) as [number, number, number]),
)

/**
 * The SDK's host. From 2.3.1 it is the same embedded host, with its own Automation service also running the scheduler,
 * as `opencode serve` does (only a server process starts it): `PromiseSdk.create` is what `OpenCode.create` calls, here
 * with the SDK's `overrides`. The modules sit next to the SDK, so they are the instances its bundle imports.
 */
async function createSdk(options: Parameters<(typeof import("@opencode/sdk"))["OpenCode"]["create"]>[0]): Promise<Client> {
  const load = (...path: string[]) => import(pathToFileURL(join(...path)).href)
  if (!AUTOMATIONS) return ((await load(SDK, "dist", "index.js")) as typeof import("@opencode/sdk")).OpenCode.create(options) as Promise<Client>
  const modules = join(SDK, "..", "..")
  const { PromiseSdk } = await load(SDK, "dist", "promise.js")
  const { Automation } = await load(modules, "@opencode", "core", "dist", "automation.js")
  const { Effect, Layer } = await load(modules, "effect", "dist", "index.js")
  const scheduling = Automation.node.mapLayer((layer: unknown) =>
    Layer.effect(
      Automation.Service,
      Effect.gen(function* () {
        const automations = yield* Automation.Service
        yield* Effect.forkScoped(automations.run)
        return automations
      }),
    ).pipe(Layer.provide(layer)),
  )
  return PromiseSdk.create(options, { overrides: [Automation.node.replace(scheduling)] })
}

const offLoopback: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init)
    offLoopback.push(url.origin)
    return Promise.reject(new Error(`host test blocked a fetch to ${url.origin}`))
  },
  { preconnect: realFetch.preconnect },
) as typeof fetch

/** Removes the temp root; call once after every host in the file has closed. */
export const cleanup = () => rmSync(root, { recursive: true, force: true })

const skillsDir = join(root, "skills")
for (const name of SKILL_NAMES) {
  mkdirSync(join(skillsDir, name), { recursive: true })
  writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: Host test ${name} skill.\n---\nBody.\n`)
}

export interface HostInput {
  /** Plugin options, as a user writes them in opencode.json. */
  readonly options?: Record<string, unknown>
  /** Extra user config: permissions, agents, mcp. `(url) => config` receives the fake server's URL. */
  readonly config?: (url: string) => Record<string, unknown>
  /** Register the server with OAuth, as the published plugin does, so the host gives it a /connect entry. */
  readonly oauth?: true
  /** Options for the loopback fake server. */
  readonly fake?: FakeMcpOptions
  /** Extra plugins, loaded after this one: a test that needs another namespace in the session. */
  readonly plugins?: readonly Plugin.Plugin[]
}

let hosts = 0

export async function startHost(input: HostInput = {}) {
  const base = join(root, `host-${++hosts}`)
  const work = join(base, "work")
  mkdirSync(work, { recursive: true })
  const fake = await startFakeMcp(input.fake)
  const elevenlabs = createElevenlabsPlugin({
    endpoint: fake.url,
    ...(input.oauth ? {} : { oauth: false as const }),
    skillsDir,
    // The fake's generated-file links point at loopback, so the test adds that host to the media allowlist.
    mediaHosts: [new URL(fake.origin).hostname],
  })
  const withOptions = Plugin.define({ id: elevenlabs.id, setup: (ctx) => elevenlabs.setup({ ...ctx, options: input.options ?? {} }) })
  const probes = new Map<string, Plugin.Context>()
  const probe = Plugin.define({ id: "elevenlabs.host-test.probe", setup: (ctx) => void probes.set(ctx.location.directory, ctx) })
  const config = {
    // A schedule's check program, or on 2.3.1 and later an automation's code action, is how a host test runs Code Mode
    // with nobody present to answer a prompt.
    experimental: AUTOMATIONS ? { automations: true } : { schedules: true },
    // Keep the built-in local providers from probing their default ports.
    providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } },
    ...input.config?.(fake.url),
  }
  const client: Client = await createSdk({
    plugins: [withOptions, ...(input.plugins ?? []), probe],
    // An embedded host reports "unknown" unless told, and the plugin's host guard refuses that.
    app: { version: HOST_VERSION },
    config: { content: JSON.stringify(config), directory: join(base, "config"), project: false, claude: false },
    database: { path: join(base, "opencode.db") },
    models: { fetch: false },
    fs: { filewatcher: false },
    log: { level: "error" },
  })
  const location = { directory: work }
  const host = {
    client,
    location,
    fake,
    probe: () => {
      const ctx = probes.get(work)
      if (!ctx) throw new Error("the probe plugin has not loaded")
      return ctx
    },
    async close() {
      await client.close()
      await fake.close()
      if (offLoopback.length) throw new Error(`the host tried to leave loopback: ${[...new Set(offLoopback)].join(", ")}`)
    },
  }
  try {
    await until("the ElevenLabs plugin and the elevenlabs server are ready", async () => {
      const { data: plugins } = await client.plugin.list({ location })
      const state = plugins.find((plugin) => plugin.id === elevenlabs.id)?.state
      if (state?.status === "failed") throw new Error(`the ElevenLabs plugin failed: ${state.error}`)
      const { data: servers } = await client.mcp.list({ location })
      return state?.status === "active" && servers.some((server) => server.status.status !== "pending") && probes.has(work)
    })
  } catch (error) {
    await host.close().catch(() => {})
    throw error
  }
  return host
}

export type Host = Awaited<ReturnType<typeof startHost>>

/** Polls `check` until it returns a value. The default leaves room for a busy machine, inside the 120 s test limit. */
export async function until<T>(what: string, check: () => Promise<T | false | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`)
    await Bun.sleep(50)
  }
}

export const session = async (host: Host, agent = "build") => (await host.client.sessions.create({ agent, location: host.location })).id

let calls = 0

/**
 * Runs a ElevenLabs MCP tool through the host's own executor, which asserts `elevenlabs_<tool>` for the session's agent.
 * A prompt, if one appears, is answered with `decision`. Reports whether it asked, and how the call ended.
 */
export async function attempt(host: Host, sessionID: string, agent: string, tool: string, decision: "once" | "always" | "reject" = "reject", input: Record<string, unknown> = {}) {
  const executor = await until(`elevenlabs_${tool} is registered`, async () => (await host.probe().tool.list()).find((item) => item.id === `elevenlabs_${tool}`))
  const context = { sessionID, agent, messageID: "msg_host_test", id: `call_host_test_${++calls}`, signal: new AbortController().signal, progress: async () => {} }
  let settled = false
  const run = executor.execute(input as never, context as never).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
  ).finally(() => (settled = true))
  let asked: string | undefined
  while (!settled) {
    const pending = await host.client.permission.list({ sessionID })
    const request = pending.find((item) => item.action === `elevenlabs_${tool}`)
    if (request) {
      asked = request.action
      await host.client.permission.reply({ sessionID, requestID: request.id, decision })
      break
    }
    await Promise.race([run, Bun.sleep(25)])
  }
  return { asked, ...(await run) }
}

export const agentRules = async (host: Host) =>
  new Map((await host.client.agent.list({ location: host.location })).data.map((agent) => [agent.id as string, agent.permissions as Rule[]]))

/** The host's own last-match evaluation for an MCP call (resource `*`), via its permission API. */
export async function effect(host: Host, agent: string, action: string) {
  const sessionID = await session(host, agent)
  return (await host.client.permission.create({ sessionID, agent, action, resources: ["*"] })).effect
}

/** How OpenCode answered a program run with nobody present: it ran and returned, or its message. */
export type Unattended = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** The part of the `experimental.automation` client of 2.3.1 and later used here; the checks compile against 2.2.3. */
interface Automations {
  create(input: { sessionID: string; name: string; trigger: { type: "at"; at: string }; action: { type: "code"; code: string } }): Promise<{ id: string }>
  get(input: { automationID: string }): Promise<{ lastOutcome?: string; lastOutput?: string }>
  delete(input: { automationID: string }): Promise<unknown>
}

/** A schedule check returned a boolean or `{ wake }`; an automation returns nothing, so the program is wrapped. */
const asCheck = (code: string) =>
  `const checked = await (async () => {\n${code}\n})()\nif (typeof checked !== "boolean" && !(typeof checked === "object" && checked !== null && typeof checked.wake === "boolean")) throw new Error("A code check must return a boolean or { wake, state?, message? }")`

/**
 * Runs a Code Mode program once with nobody present to answer a prompt, as the session's agent and under its rules,
 * with no model, and answers as a schedule's `if: { code }` check did at creation up to 2.3.0: `ok` when the program
 * returned a boolean or `{ wake }`, else OpenCode's message (a refusal, or what the program threw). Up to 2.3.0 it is
 * that check, and the schedule is deleted at once. From 2.3.1 it is an automation's code action, due at once:
 * creation refuses what the rules do not allow, as the check did, and the run's outcome is read back before the
 * automation is deleted. A run that never comes throws, so it is never read as a refusal.
 */
export async function unattended(host: Host, sessionID: string, code: string): Promise<Unattended> {
  const name = "elevenlabs-host-test"
  const refused = (error: unknown): Unattended => ({ ok: false, error: error instanceof Error ? error.message : String(error) })
  if (!AUTOMATIONS) {
    try {
      const schedule = await host.client.experimental.schedule.create({ sessionID, name, when: { in: "6 hours" }, prompt: "noop", if: { code } })
      await host.client.experimental.schedule.delete({ scheduleID: schedule.id })
      return { ok: true }
    } catch (error) {
      return refused(error)
    }
  }
  const automations = (host.client.experimental as unknown as { automation: Automations }).automation
  let automationID: string
  try {
    automationID = (await automations.create({ sessionID, name, trigger: { type: "at", at: "in 1 millis" }, action: { type: "code", code: asCheck(code) } })).id
  } catch (error) {
    return refused(error)
  }
  try {
    const run = await until("the automation's code action has run (is the host's Automation scheduler forked? see the harness's createSdk)", async () => {
      const info = await automations.get({ automationID })
      return info.lastOutcome === undefined ? undefined : info
    })
    if (run.lastOutcome === "fired" || run.lastOutcome === "late") return { ok: true }
    // A program that cannot succeed on a retry (a bad return value, a scoped ask) pauses its automation.
    if (run.lastOutcome === "failed") return { ok: false, error: (run.lastOutput ?? "").replace(/^Paused: /, "") }
    throw new Error(`the automation's code action ended "${run.lastOutcome}": ${run.lastOutput ?? ""}`)
  } finally {
    await automations.delete({ automationID })
  }
}
