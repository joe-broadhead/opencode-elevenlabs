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

/** The locked @opencode/sdk, or another 2.2.x installed outside the lockfile in HOST_SDK_DIR's node_modules. */
const SDK = HOST_SDK_DIR ? join(HOST_SDK_DIR, "node_modules", "@opencode", "sdk") : fileURLToPath(new URL("../../node_modules/@opencode/sdk", import.meta.url))
export const HOST_VERSION = (JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as { version: string }).version

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
    // A schedule's check program is how a host test runs Code Mode with nobody present to answer a prompt.
    experimental: { schedules: true },
    // Keep the built-in local providers from probing their default ports.
    providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } },
    ...input.config?.(fake.url),
  }
  const { OpenCode } = (await import(pathToFileURL(join(SDK, "dist", "index.js")).href)) as typeof import("@opencode/sdk")
  const client: Client = await OpenCode.create({
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
