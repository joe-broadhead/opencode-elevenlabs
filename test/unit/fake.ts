// Narrow fakes of the public plugin context: only the members a test touches, typed with Pick<> so they
// stay valid against later 2.2.x context shapes.
import type { Plugin } from "@opencode/plugin"
import { READ_TOOLS } from "../../src/elevenlabs-tools.js"
import type { Rule } from "../../src/permissions.js"

type Transform<Editor> = (callback: (editor: Editor) => void) => Promise<{ dispose: () => Promise<void> }>

/** Collects transform callbacks; `run` replays them on a fresh editor value, as the host does on each rebuild. */
export function transforms<Editor>() {
  const callbacks: ((editor: Editor) => void)[] = []
  const transform: Transform<Editor> = (callback) => {
    callbacks.push(callback)
    return Promise.resolve({ dispose: async () => void callbacks.splice(callbacks.indexOf(callback), 1) })
  }
  return { transform, callbacks, run: (editor: Editor) => callbacks.forEach((callback) => callback(editor)) }
}

export type McpEditor = Parameters<Parameters<Plugin.Context["mcp"]["transform"]>[0]>[0]
export type AgentEditor = Parameters<Parameters<Plugin.Context["agent"]["transform"]>[0]>[0]
type ServerConfig = NonNullable<ReturnType<McpEditor["get"]>>

export function mcpEditor(initial: Record<string, ServerConfig> = {}) {
  const servers = new Map(Object.entries(structuredClone(initial)))
  const editor: McpEditor = {
    list: () => [...servers],
    get: (name) => servers.get(name),
    set: (name, config) => void servers.set(name, structuredClone(config) as ServerConfig),
    update: (name, update) => {
      const config = servers.get(name)
      if (config) update(config)
    },
    remove: (name) => void servers.delete(name),
  }
  return { editor, servers }
}

export type FakeAgent = { id: string; permissions: Rule[] }

/** Agents shaped like 2.2.3's built-ins: a base allow first, then each agent's own rules. */
export const builtInAgents = (): FakeAgent[] => [
  { id: "build", permissions: [allow("*"), { action: "read", resource: "*.env", effect: "ask" }] },
  { id: "plan", permissions: [allow("*"), { action: "read", resource: "*.env", effect: "ask" }, { action: "edit", resource: "*", effect: "deny" }] },
  { id: "explore", permissions: [allow("*"), { action: "*", resource: "*", effect: "deny" }, allow("read"), allow("grep")] },
]

export const allow = (action: string): Rule => ({ action, resource: "*", effect: "allow" })

export function agentEditor(agents: FakeAgent[]) {
  const editor = {
    list: () => agents,
    get: (id: string) => agents.find((agent) => agent.id === id),
    default: () => {},
    update: (id: string, update: (agent: FakeAgent) => void) => {
      const agent = agents.find((item) => item.id === id)
      if (agent) update(agent)
    },
    remove: () => {},
  }
  return editor as unknown as AgentEditor
}

type SetupContext = Pick<Plugin.Context, "app" | "options" | "mcp" | "agent" | "skill" | "command" | "session" | "tool" | "integration" | "rpc" | "permission" | "location" | "event" | "storage">

/** A context with only what setup touches. Each transform is collected so the test can replay it. */
export function pluginContext(options: unknown, version = "2.2.3") {
  const mcp = transforms<McpEditor>()
  const agent = transforms<Parameters<Parameters<Plugin.Context["agent"]["transform"]>[0]>[0]>()
  const skill = transforms<Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0]>()
  const command = transforms<Parameters<Parameters<Plugin.Context["command"]["transform"]>[0]>[0]>()
  const tool = transforms<Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]>()
  const integration = transforms<Parameters<Parameters<Plugin.Context["integration"]["transform"]>[0]>[0]>()
  const rpc: string[] = []
  const handlers = new Map<string, Record<string, (input: unknown, context: unknown) => Promise<unknown>>>()
  const hooks: string[] = []
  const hookFns = new Map<string, (event: never) => Promise<void>>()
  const stored = new Map<string, unknown>()
  const store = {
    get: async (key: string) => stored.get(key) as never,
    set: async (key: string, value: unknown) => void stored.set(key, value),
    remove: async (key: string) => void stored.delete(key),
    scan: async () => ({ entries: [] }),
  }
  const ctx = {
    app: { name: "opencode", version, channel: "latest" },
    options: options as Plugin.Context["options"],
    storage: store,
    mcp: { transform: mcp.transform, list: async () => ({ data: [{ name: "elevenlabs", status: { status: "connected" } }] }) },
    skill: { transform: skill.transform },
    command: { transform: command.transform },
    rpc: {
      register: async (definition: { id: string }, methods: Record<string, (input: unknown, context: unknown) => Promise<unknown>>) => {
        rpc.push(definition.id)
        handlers.set(definition.id, methods)
        return { dispose: async () => void rpc.splice(rpc.indexOf(definition.id), 1) }
      },
    },
    session: { get: async () => ({ id: "ses_test", agent: "build", location: { directory: "/projects/elevenlabs-test" }, permissions: [] }) },
    agent: { transform: agent.transform, list: async () => ({ data: [] }), get: async () => ({ data: { id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] } }) },
    tool: {
      transform: tool.transform,
      list: async () => [{ id: `elevenlabs_${READ_TOOLS[0]}`, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) }],
      hook: async (name: string, callback?: (event: never) => Promise<void>) => {
        hooks.push(name)
        if (callback) hookFns.set(name, callback)
        return { dispose: async () => void hooks.splice(hooks.indexOf(name), 1) }
      },
    },
    integration: {
      transform: integration.transform,
      get: async () => ({ data: { name: "ElevenLabs", connections: [] } }),
      connection: { active: async () => undefined, resolve: async () => undefined, status: async () => undefined },
    },
    location: { directory: "/projects/elevenlabs-test" },
    permission: { assert: async () => undefined, hook: async () => ({ dispose: async () => undefined }) },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ done: true, value: undefined }))) }) }) },
  } as unknown as SetupContext
  return { ctx: ctx as Plugin.Context, mcp, agent, skill, command, tool, integration, rpc, handlers, hooks, hookFns, stored }
}
