// The plugin on the public @opencode/sdk host: load and connect, the permission model, the spending guard, saving a
// generated file, /elevenlabs-status, unload, and the /connect entry with its scope pin. Each describe owns one host.
import { ROOT } from "./isolate.js"
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { Plugin } from "@opencode/plugin"
import * as z from "zod"
import { defaultRules, type Rule } from "../../src/permissions.js"
import { SKILL_NAMES } from "../../src/skills.js"
import { OAUTH_SCOPES, SUPPORTED_HOST, TESTED_HOSTS } from "../../src/constants.js"
import { DELETE, IMAGE, IMAGE_CREDITS, LINK, NEW_TOOL, READ, SPEECH, WRITE } from "./fake-mcp.js"
import { agentRules, attempt, cleanup, effect, HOST_VERSION, session, startHost, until, type Host } from "./harness.js"

const AGENT_RULES = defaultRules().map((rule, index, rules) => `  ${JSON.stringify(rule)}${index < rules.length - 1 ? "," : ""}`).join("\n")
const AGENTS_NEXT_STEP = "Put the default rules shown by /elevenlabs-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for ElevenLabs tools."
const NEW = NEW_TOOL.name
const SIGN_IN = "Run /connect and choose ElevenLabs, then press o or Enter to open the link (in a terminal, opencode mcp auth elevenlabs opens it automatically)."
/** The fake's tools: a read, a write, a delete, a signed link, a speech and an image generation, and one unknown tool. */
const SERVED = [READ, WRITE, DELETE, LINK, SPEECH, IMAGE, NEW].map((tool) => `elevenlabs_${tool}`).sort()

// Starting a host takes several seconds, more on a busy machine.
setDefaultTimeout(120_000)
afterAll(cleanup)

const BUILT_IN = ["build", "general", "explore", "compaction", "title", "summary", "plan"]
const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
/** The host hides a tool when the last rule matching its action is a deny on every resource. */
const hidden = (rules: readonly Rule[], action: string) => {
  const last = rules.findLast((rule) => wildcard(rule.action).test(action))
  return last?.resource === "*" && last.effect === "deny"
}

/** The host lists an MCP server's tools shortly after it connects. */
const elevenlabsTools = (host: Host) =>
  until("ElevenLabs' tools are registered", async () => {
    const ids = (await host.probe().tool.list()).map((tool) => tool.id).filter((id) => id.startsWith("elevenlabs_"))
    const wanted = [...SERVED, "elevenlabs_save_media"].sort()
    return ids.length === wanted.length && ids.sort()
  })

/**
 * Runs `code` as Code Mode does, through a schedule's check program: OpenCode checks each tool's input and output and
 * evaluates permissions with nobody present to answer a prompt. The program reports by throwing "SEEN <json>".
 */
async function codeMode(host: Host, sessionID: string, code: string): Promise<{ seen: unknown } | { refused: string }> {
  let message: string
  try {
    const schedule = await host.client.experimental.schedule.create({ sessionID, name: "elevenlabs-host-test", when: { in: "6 hours" }, prompt: "noop", if: { code } })
    await host.client.experimental.schedule.delete({ scheduleID: schedule.id })
    throw new Error("the check program finished without reporting")
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  const seen = /SEEN (.*)$/s.exec(message)
  if (!seen) return { refused: message }
  try {
    return { seen: JSON.parse(seen[1]!) }
  } catch {
    return { seen: seen[1]! }
  }
}

async function status(host: Host, sessionID: string) {
  await host.client.sessions.command({ sessionID, name: "elevenlabs-status", text: "" })
  return until("/elevenlabs-status posts its text", async () => {
    const inbox = await host.client.session.inbox.list({ sessionID })
    const posted = inbox.findLast((item) => item.type === "synthetic")
    return posted?.type === "synthetic" ? posted.payload.text : undefined
  })
}

describe(`the plugin's own server on OpenCode ${HOST_VERSION}`, () => {
  let host: Host
  beforeAll(async () => {
    host = await startHost({ config: () => ({ agents: { reviewer: { description: "Reviews changes", mode: "subagent" } } }) })
  })
  afterAll(() => host?.close())

  test("the host's global folders, temp folder and working directory are inside the test's temp root", async () => {
    const global = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].map((key) => join(process.env[key]!, "opencode"))
    expect(global.filter((path) => !existsSync(path))).toEqual([])
    const { paths } = await host.client.server.info()
    const used = [...global, realpathSync(paths.tmp), process.env.OPENCODE_TEST_HOME!, tmpdir(), process.cwd()]
    expect(used.filter((path) => !path.startsWith(ROOT + sep))).toEqual([])
  })

  test("the plugin is active, elevenlabs is connected, and its tools, skills and both commands are registered", async () => {
    const { data: plugins } = await host.client.plugin.list({ location: host.location })
    expect(plugins.find((plugin) => plugin.id === "elevenlabs")?.state.status).toBe("active")
    const { data: servers } = await host.client.mcp.list({ location: host.location })
    expect(servers.find((server) => server.name === "elevenlabs")?.status).toEqual({ status: "connected" })
    expect(await elevenlabsTools(host)).toEqual([...SERVED, "elevenlabs_save_media"].sort())
    const { data: skills } = await host.client.skill.list({ location: host.location })
    expect(skills.map((skill) => skill.id).filter((id) => id.startsWith("elevenlabs")).sort()).toEqual([...SKILL_NAMES].sort())
    const { data: commands } = await host.client.command.list({ location: host.location })
    expect(commands.map((command) => command.name).filter((name) => name.startsWith("elevenlabs")).sort()).toEqual(["elevenlabs-doctor", "elevenlabs-status"])
  })

  test("the rules sit right after the base allow in every built-in agent, once", async () => {
    const rules = await agentRules(host)
    for (const id of BUILT_IN) {
      const permissions = rules.get(id)!
      const base = permissions.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")
      expect(base).toBe(0)
      expect(permissions.slice(base + 1, base + 1 + defaultRules().length)).toEqual(defaultRules())
      expect(permissions.filter((rule) => rule.action === "elevenlabs_*")).toHaveLength(1)
    }
  })

  test("Plan and Explore are not weakened", async () => {
    expect(await effect(host, "plan", "edit")).toBe("deny")
    expect(await effect(host, "explore", `elevenlabs_${READ}`)).toBe("deny")
    const explore = await session(host, "explore")
    expect(await attempt(host, explore, "explore", READ)).toEqual({ asked: undefined, ok: false, error: `Tool.Error: Permission denied: elevenlabs_${READ}` })
  })

  // R18: every tool is allowed by default, a tool ElevenLabs adds later included, so nothing asks here.
  test("every tool runs without a prompt, the plugin's own reads and one it does not know", async () => {
    const build = await session(host)
    const before = host.fake.calls.length
    expect(await attempt(host, build, "build", READ)).toEqual({ asked: undefined, ok: true })
    expect(await attempt(host, build, "build", NEW)).toEqual({ asked: undefined, ok: true })
    expect(await attempt(host, build, "build", WRITE)).toEqual({ asked: undefined, ok: true })
    expect(host.fake.calls.slice(before)).toEqual([READ, NEW, WRITE])
    const rules = (await agentRules(host)).get("build")!
    expect([...SERVED, "elevenlabs_save_media"].filter((action) => hidden(rules, action))).toEqual([])
    expect(await effect(host, "build", `elevenlabs_${NEW}`)).toBe("allow")
  })

  test("an agent defined only in user config gets no rules, and ElevenLabs tools run there unprompted", async () => {
    const reviewer = (await agentRules(host)).get("reviewer")!
    expect(reviewer.some((rule) => rule.action.startsWith("elevenlabs_"))).toBe(false)
    const sessionID = await session(host, "reviewer")
    expect(await attempt(host, sessionID, "reviewer", NEW)).toEqual({ asked: undefined, ok: true })
  })

  // R2: the same proofs on the Code Mode path, inside the host's `execute`, where nobody can answer a prompt.
  test("Code Mode: a read runs; an ask and a deny are refused with nothing sent; an unknown name is refused", async () => {
    await elevenlabsTools(host)
    const run = async (sessionID: string, tool: string) => codeMode(host, sessionID, `const r = await tools.elevenlabs[${JSON.stringify(tool)}]({}); throw new Error("SEEN " + JSON.stringify(r))`)
    const created = async (permissions?: Rule[]) => (await host.client.sessions.create({ agent: "build", location: host.location, ...(permissions ? { permissions } : {}) })).id

    const before = host.fake.calls.length
    expect(await run(await created(), READ)).toHaveProperty("seen")
    expect(host.fake.calls.slice(before)).toEqual([READ])

    const asking = host.fake.calls.length
    const askSession = await created([{ action: `elevenlabs_${READ}`, resource: "*", effect: "ask" }])
    const asked = await run(askSession, READ)
    expect(asked).toHaveProperty("refused")
    expect((asked as { refused: string }).refused).toMatch(/needs approval|nobody is present|not permitted|declined/i)
    expect(host.fake.calls.slice(asking)).toEqual([])
    expect(await host.client.permission.list({ sessionID: askSession })).toEqual([])

    const denied = await run(await created([{ action: `elevenlabs_${READ}`, resource: "*", effect: "deny" }]), READ)
    expect(denied).toHaveProperty("refused")
    const unknown = await run(await created(), "no_such_tool")
    expect(unknown).toHaveProperty("refused")
    expect(host.fake.calls.slice(asking)).toEqual([])
  })

  test("/elevenlabs-status reports the connection, the region, the spend, the tools, the unguarded agent and its fix", async () => {
    await elevenlabsTools(host)
    const text = await status(host, await session(host))
    expect(text).toContain(`- Connection: connected (${host.fake.url}, registered by this plugin)`)
    expect(text).toContain("- Region: global (https://api.elevenlabs.io/v1/mcp)")
    expect(text).toContain("- Spend: 0 credits spent in the last 24 hours, with no daily cap; no session cap")
    expect(text).toContain("- Conversations: full: the transcript tools run, and they carry other people's calls")
    expect(text).toContain("- Skills: the plugin's own\n")
    expect(text).toContain(`- Tools: ${SERVED.length} available, 1 unknown: ${NEW} (new tools run too)\n`)
    expect(text).toContain(`- Agents without default rules: reviewer\n${AGENT_RULES}\n`)
    expect(text).toContain(`- Next step: ${AGENTS_NEXT_STEP}`)
    expect(text).toContain(`- OpenCode: ${HOST_VERSION} (${TESTED_HOSTS.includes(HOST_VERSION) ? "tested" : "untested"}; supported range ${SUPPORTED_HOST})`)
  })

  test("unloading the plugin removes the server, the rules and the commands", async () => {
    await host.client.plugin(Plugin.define({ id: "elevenlabs", setup: () => {} }))
    await until("the elevenlabs server is gone", async () => {
      const { data } = await host.client.mcp.list({ location: host.location })
      return !data.some((server) => server.name === "elevenlabs")
    })
    const rules = await agentRules(host)
    for (const id of BUILT_IN) expect(rules.get(id)!.some((rule) => rule.action.startsWith("elevenlabs_"))).toBe(false)
    const { data: commands } = await host.client.command.list({ location: host.location })
    expect(commands.map((command) => command.name)).not.toContain("elevenlabs-status")
  })
})

// D1: the spending guard. The fake prices an image at IMAGE_CREDITS per generation and charges nothing for an estimate.
describe(`the spending guard on OpenCode ${HOST_VERSION}`, () => {
  describe("a session cap that fits one generation", () => {
    let host: Host
    beforeAll(async () => {
      host = await startHost({ options: { sessionCreditCap: IMAGE_CREDITS, dailyCreditCap: 100_000 } })
      await elevenlabsTools(host)
    })
    afterAll(() => host?.close())

    // The guard runs on the model path and in Code Mode: the host's own `execute` (which a host test's direct executor
    // call bypasses), so each proof here is a Code Mode call, where the arguments and the cost line are observable.
    const generate = (sessionID: string, args: Record<string, unknown>) =>
      codeMode(host, sessionID, `const r = await tools.elevenlabs[${JSON.stringify(IMAGE)}](${JSON.stringify(args)}); throw new Error("SEEN " + JSON.stringify(r))`)

    test("asks ElevenLabs for a price first, clamps four generations to one, and charges only the one that ran", async () => {
      const before = host.fake.calls.length
      const outcome = await generate(await session(host), { prompt: "a ceramic mug", generations_count: 4 })
      expect(outcome).toHaveProperty("seen")
      // Two calls, both to the same tool: the free estimate, then the paid generation, cut to what the cap affords.
      expect(host.fake.calls.slice(before)).toEqual([IMAGE, IMAGE])
      expect(host.fake.inputs.at(-1)!.arguments).toMatchObject({ prompt: "a ceramic mug", generations_count: 1 })
      expect(host.fake.inputs.at(-2)!.arguments).toMatchObject({ estimate_only: true })
      // The result carries the structured cost, so a Code Mode program can read it too.
      expect(JSON.stringify(outcome)).toContain('"cost"')
      expect((outcome as { seen: { cost: { credits: number } } }).seen.cost.credits).toBe(IMAGE_CREDITS)
    })

    test("a request for more than the cap affords is clamped, not refused, while one generation still fits", async () => {
      const before = host.fake.calls.length
      const outcome = await generate(await session(host), { prompt: "a big scene", generations_count: 2 })
      expect(outcome).toHaveProperty("seen")
      expect(host.fake.inputs.at(-1)!.arguments).toMatchObject({ generations_count: 1 })
      expect(host.fake.calls.slice(before)).toEqual([IMAGE, IMAGE])
    })
  })

  describe("a session cap below one generation", () => {
    let host: Host
    beforeAll(async () => {
      host = await startHost({ options: { sessionCreditCap: 10, dailyCreditCap: 100_000 } })
      await elevenlabsTools(host)
    })
    afterAll(() => host?.close())

    const generate = (sessionID: string, tool: string, args: Record<string, unknown>) =>
      codeMode(host, sessionID, `await tools.elevenlabs[${JSON.stringify(tool)}](${JSON.stringify(args)}); throw new Error("SEEN")`)

    test("refuses with SPEND_CAP_REACHED after the estimate, and never makes the generation call", async () => {
      const before = host.fake.calls.length
      const outcome = await generate(await session(host), IMAGE, { prompt: "a ceramic mug", generations_count: 1 })
      expect(outcome).toHaveProperty("refused")
      expect((outcome as { refused: string }).refused).toContain("SPEND_CAP_REACHED")
      // The estimate was free; the paid call never happened.
      expect(host.fake.calls.slice(before)).toEqual([IMAGE])
      expect(host.fake.inputs.at(-1)!.arguments).toMatchObject({ estimate_only: true })
    })

    // This used to prove speech was priced from a published rate in the plugin's own table, so a refusal reached the
    // server not at all. There is no rate table now: speech is estimated like every other paid call, so the estimate
    // is the one call a refusal makes, and the figure in the refusal is ElevenLabs' own.
    test("a speech call is priced from ElevenLabs' estimate and refused on it, and the paid call is never made", async () => {
      const before = host.fake.calls.length
      const outcome = await generate(await session(host), SPEECH, { prompt: "hello there", voice_id: "voice_example", generations_count: 1 })
      expect(outcome).toHaveProperty("refused")
      expect((outcome as { refused: string }).refused).toContain("SPEND_CAP_REACHED")
      expect((outcome as { refused: string }).refused).toContain(`${IMAGE_CREDITS} credits`)
      // The estimate ran, and nothing else: the generation itself was never sent.
      expect(host.fake.calls.slice(before)).toEqual([SPEECH])
      expect(host.fake.inputs.at(-1)!.arguments).toMatchObject({ estimate_only: true })
    })

    test("an argument ElevenLabs' own schema does not have is PRICE_UNKNOWN, and not even the estimate is sent", async () => {
      const before = host.fake.calls.length
      const outcome = await generate(await session(host), SPEECH, { text: "x".repeat(60) })
      expect(outcome).toHaveProperty("refused")
      expect((outcome as { refused: string }).refused).toContain("PRICE_UNKNOWN")
      expect(host.fake.calls.slice(before)).toEqual([])
    })
  })
})

// D2: the plugin's own tool saves a generated file, and nothing binary enters the conversation.
describe(`elevenlabs_save_media on OpenCode ${HOST_VERSION}`, () => {
  let host: Host
  beforeAll(async () => {
    host = await startHost({ options: { mediaRoot: join(ROOT, "media"), maxMediaBytes: 1024 * 1024 } })
    await elevenlabsTools(host)
  })
  afterAll(() => host?.close())

  const save = async (sessionID: string, url: string, name?: string) => {
    const outcome = await attempt(host, sessionID, "build", "save_media", "reject", { url, ...(name ? { name } : {}) })
    if (!outcome.ok) return outcome
    const tool = (await host.probe().tool.list()).find((entry) => entry.id === "elevenlabs_save_media")!
    void tool
    return outcome
  }

  test("writes the file under the media root and answers with its path, size and hash", async () => {
    const sessionID = await session(host)
    const outcome = await save(sessionID, `${host.fake.origin}/media/ok`, "clip")
    expect(outcome).toEqual({ asked: undefined, ok: true })
    const folder = join(ROOT, "media")
    const written = (await Array.fromAsync(new Bun.Glob("*.mp3").scan(folder))).map((name) => join(folder, name))
    expect(written).toHaveLength(1)
    expect(readFileSync(written[0]!).toString()).toBe("ID3fakeaudio")
  })

  test("an expired link is MEDIA_EXPIRED, and the next step says to fetch the generation again", async () => {
    const outcome = await save(await session(host), `${host.fake.origin}/media/expired`)
    expect(outcome.ok).toBe(false)
    expect((outcome as { error: string }).error).toContain("MEDIA_EXPIRED")
  })

  test("a session that denies external_directory writes nothing, and the refusal names the rule", async () => {
    const sessionID = (
      await host.client.sessions.create({ agent: "build", location: host.location, permissions: [{ action: "external_directory", resource: "*", effect: "deny" }] })
    ).id
    const outcome = await attempt(host, sessionID, "build", "save_media", "reject", { url: `${host.fake.origin}/media/ok`, name: "blocked" })
    expect(outcome.ok).toBe(false)
    const message = (outcome as { error: string }).error
    expect(message).toMatch(/EXTERNAL_DIRECTORY_DENIED|Permission denied|external_directory/)
    // Nothing was written for this name.
    const folder = join(ROOT, "media")
    expect(existsSync(folder) ? await Array.fromAsync(new Bun.Glob("blocked*").scan(folder)) : []).toEqual([])
  })

  test("a link on a host that is not ElevenLabs' own is refused before anything is fetched", async () => {
    const outcome = await save(await session(host), "https://example.com/a.mp3")
    expect(outcome.ok).toBe(false)
    expect((outcome as { error: string }).error).toContain("MEDIA_URL_INVALID")
  })
})

// a figure that arrives only in the text part is still the charge.
describe(`a text-only credit figure on OpenCode ${HOST_VERSION}`, () => {
  let host: Host
  beforeAll(async () => {
    // Five credits a generation, so two takes are estimated at 10 and reserved at 10, and the fake's text part
    // reports 120. The reservation used to come from the plugin's own rate table; it is ElevenLabs' estimate now,
    // and what this proves is unchanged: the figure the result states is the charge.
    host = await startHost({ fake: { reportsCreditsInText: true, estimateCreditsPerGeneration: 5 }, options: { dailyCreditCap: 100_000, sessionCreditCap: 10_000 } })
    await elevenlabsTools(host)
  })
  afterAll(() => host?.close())

  const speak = async (prompt: string) => {
    const sessionID = await session(host)
    const args = { prompt, voice_id: "voice_example", generations_count: 2 }
    const outcome = await codeMode(host, sessionID, `const r = await tools.elevenlabs[${JSON.stringify(SPEECH)}](${JSON.stringify(args)}); throw new Error("SEEN " + JSON.stringify(r))`)
    expect(outcome).toHaveProperty("seen")
    return (outcome as { seen: { cost: { credits: number; basis: string } } }).seen.cost
  }

  test("the model path charges the figure it was told, not the pre-call bound", async () => {
    // Two takes at five reserve 10, and the fake reports 120 in its text part: the figure is the charge.
    expect(await speak("hello")).toMatchObject({ credits: 120, basis: "exact" })
  })

  test("a figure more than ten times the reservation is charged, not refused", async () => {
    // Correcting Ruling B's ceiling, which kept the 10-credit reservation here: 120 is twelve times the hold, and a
    // charge the plugin under-reserved is the owner's money all the same. Both calls are in the day's total.
    expect(await speak("hello")).toMatchObject({ credits: 120, basis: "exact", dailySpent: 240 })
  })
})

// R18: one host test per access value, on the tools RPC path, where a refusal must reach nothing.
describe(`access on OpenCode ${HOST_VERSION}`, () => {
  const call = async (host: Host, sessionID: string, method: string, input: unknown = {}): Promise<{ value?: unknown; refused?: string }> =>
    host.client.rpc
      .call({ rpcID: "elevenlabs.tools", method, input: { sessionID, input } as never, location: host.location })
      .then((result) => ({ value: result.output }))
      .catch((error: unknown) => ({ refused: (error as { data?: { code?: string }; message?: string }).data?.code ?? String(error) }))

  for (const [access, effectOf] of [
    ["ask-changes", "ask"],
    ["read-only", "deny"],
  ] as const) {
    describe(access, () => {
      let host: Host
      beforeAll(async () => {
        host = await startHost({ options: { access } })
        await elevenlabsTools(host)
      })
      afterAll(() => host?.close())

      test(`the block is the ${access} one, and a read still runs on the tools RPC path`, async () => {
        const rules = (await agentRules(host)).get("build")!
        expect(rules.slice(1, 1 + defaultRules(access).length)).toEqual(defaultRules(access))
        const before = host.fake.calls.length
        const sessionID = await session(host)
        expect(await call(host, sessionID, READ)).toHaveProperty("value")
        expect(host.fake.calls.slice(before)).toEqual([READ])
      })

      test(`a billed generation is ${effectOf === "deny" ? "denied" : "asked for"} and never reaches ElevenLabs or the ledger`, async () => {
        const before = host.fake.calls.length
        expect(await call(host, await session(host), IMAGE, { prompt: "a mug", generations_count: 1 })).toMatchObject({ refused: "PERMISSION_DENIED" })
        expect(host.fake.calls.slice(before)).toEqual([])
        // An unclassified name is not a method at all: the RPC refuses it before any rule runs.
        expect((await call(host, await session(host), NEW)).refused ?? "").toContain("Unknown RPC method")
      })
    })
  }
})

describe("a user elevenlabs server that points elsewhere", () => {
  let host: Host
  beforeAll(async () => {
    host = await startHost({ config: (url) => ({ mcp: { servers: { elevenlabs: { type: "remote", url: url.replace(/\/mcp$/, "/other"), oauth: false } } } }) })
  })
  afterAll(() => host?.close())

  test("is left in place and reported as a conflict", async () => {
    const text = await status(host, await session(host))
    const other = host.fake.url.replace(/\/mcp$/, "/other")
    expect(text).toContain(`- Connection: conflict (your mcp.servers.elevenlabs points at ${other})`)
    expect(text).toContain(`- Next step: mcp.servers.elevenlabs is set to ${other}, but ElevenLabs's server is ${host.fake.url}.`)
  })
})

// ElevenLabs' server answers 401 with a bearer challenge until the user signs in. On the host's own MCP client that is
// a sign-in, not a failure: status and the status RPC say so, with the /connect step.
describe("a server that asks for a sign-in", () => {
  let host: Host
  beforeAll(async () => {
    host = await startHost({ oauth: true, fake: { challenge: true } })
  })
  afterAll(() => host?.close())

  test("is sign-in required, with the /connect next step, in the RPC and in /elevenlabs-status", async () => {
    const server = await until("the server needs a sign-in", async () => {
      const { data } = await host.client.mcp.list({ location: host.location })
      const found = data.find((item) => item.name === "elevenlabs")
      return found?.status.status === "needs_auth" ? found : undefined
    })
    expect(server.status.status).toBe("needs_auth")
    const { output } = (await host.client.rpc.call({ rpcID: "elevenlabs", method: "status", input: {}, location: host.location })) as { output: Record<string, unknown> }
    expect(output).toMatchObject({ state: "sign_in_required", nextStep: SIGN_IN })
    const text = await status(host, await session(host))
    expect(text).toContain(`- Connection: sign-in required (${host.fake.url}, registered by this plugin)`)
    expect(text).toContain(`- Next step: ${SIGN_IN}`)
    expect(host.fake.markers.length).toBeGreaterThan(0)
  })
})

// The /connect mark is only observable while a credential remains, so this signs in with ElevenLabs' own flow and a
// token that has no refresh token. The plugin reads its mark back from the projected connection, so the mark it sets is
// the one it clears — and the authorization request carries exactly the seven pinned scopes.
describe("the /connect sign-in mark", () => {
  let host: Host
  beforeAll(async () => {
    host = await startHost({ oauth: true, fake: { challenge: true, refreshTokens: false } })
  })
  afterAll(() => host?.close())

  const SIGN_IN_AGAIN = "ElevenLabs needs a new sign-in. Choose this account to sign in again."

  const connections = async () => {
    const { data: servers } = await host.client.mcp.list({ location: host.location })
    const integrationID = servers.find((server) => server.name === "elevenlabs")?.integrationID
    if (!integrationID) return []
    const { data } = await host.client.integration.get({ integrationID, location: host.location })
    return (data as unknown as { connections?: { type?: string; status?: { status: string; message?: string } }[] }).connections ?? []
  }

  const signIn = async () => {
    const { data: servers } = await host.client.mcp.list({ location: host.location })
    const integrationID = servers.find((server) => server.name === "elevenlabs")!.integrationID!
    const { data: integration } = await host.client.integration.get({ integrationID, location: host.location })
    const oauth = (host.client.integration as unknown as { oauth: { connect: (input: object) => Promise<{ data: { attemptID: string; url: string } }> } }).oauth
    const { data: attempt } = await oauth.connect({ integrationID, methodID: (integration.methods[0] as unknown as { id: string }).id, location: host.location })
    const redirect = await fetch(attempt.url, { redirect: "manual" })
    const callback = redirect.headers.get("location")
    expect(callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
    await fetch(callback!)
  }
  const connected = () =>
    until("the server is connected", async () => {
      const { data } = await host.client.mcp.list({ location: host.location })
      return data.find((server) => server.name === "elevenlabs")?.status.status === "connected"
    })

  test("is set while the server needs a sign-in, and cleared once the same account connects again", async () => {
    await signIn()
    await until("the sign-in stores a token without a refresh token", async () => host.fake.tokens.length === 1)
    expect(host.fake.tokens[0]).toMatchObject({ grant_type: "authorization_code" })
    expect(host.fake.tokens[0]).not.toHaveProperty("refresh_token")
    // The scope pin: exactly the seven, and never `ads_read`.
    expect(host.fake.authorizations[0]!.scope).toBe(OAUTH_SCOPES)
    expect(host.fake.authorizations[0]!.scope).not.toContain("ads_read")
    expect(OAUTH_SCOPES.split(" ")).toHaveLength(7)

    host.fake.challenge = false
    await connected()
    expect(await until("/connect shows the account", async () => (await connections()).find((item) => item.type === "credential" && item.status?.message === undefined))).toBeDefined()

    host.fake.challenge = true
    const mcp = host.client.mcp as unknown as Record<"connect" | "disconnect", (input: object) => Promise<unknown>>
    await mcp.disconnect({ server: "elevenlabs", location: host.location })
    await mcp.connect({ server: "elevenlabs", location: host.location }).catch(() => {})
    await until("the server needs a sign-in", async () => {
      const { data } = await host.client.mcp.list({ location: host.location })
      return data.find((server) => server.name === "elevenlabs")?.status.status === "needs_auth"
    })
    expect(await until("/connect shows the new sign-in on the account", async () => (await connections()).find((item) => item.status?.message === SIGN_IN_AGAIN))).toBeDefined()

    host.fake.challenge = false
    await mcp.connect({ server: "elevenlabs", location: host.location })
    await connected()
    expect(await until("/connect clears the sign-in mark", async () => ((await connections()).some((item) => item.status?.message) ? undefined : true))).toBe(true)
  })
})

describe("the /connect entry", () => {
  let host: Host
  beforeAll(async () => {
    host = await startHost({ oauth: true })
  })
  afterAll(() => host?.close())

  const entry = async () => {
    const { data } = await host.client.mcp.list({ location: host.location })
    const integrationID = data.find((server) => server.name === "elevenlabs")?.integrationID
    if (!integrationID) return undefined
    return (await host.client.integration.get({ integrationID, location: host.location })).data
  }

  test("is named ElevenLabs, also after the host reloads its MCP servers", async () => {
    expect((await until("the entry is named ElevenLabs", async () => ((await entry())?.name === "ElevenLabs" ? entry() : undefined)))?.methods).toHaveLength(1)
    await host.probe().mcp.reload()
    await until("the entry is named ElevenLabs again after the reload", async () => (await entry())?.name === "ElevenLabs")
    await Bun.sleep(1000)
    expect((await entry())?.name).toBe("ElevenLabs")
  })
})

// Once another namespace spends the inline tool budget, OpenCode drops every tool into Code Mode and writes one
// catalogue section per namespace into the system prompt. That section is sent on every request of every session that
// loads the plugin, so it is a standing cost: the family holds it to 1,000 tokens, and the shape is the namespace
// description, the skill it points at, and the tools it shows.
describe("the forced Code Mode catalogue", () => {
  let host: Host
  let captured = ""
  let server: ReturnType<typeof createServer>

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      let raw = ""
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw) as { messages?: { role: string; content?: unknown }[] }
      captured = (body.messages ?? [])
        .filter((item) => item.role === "system")
        .map((item) => (typeof item.content === "string" ? item.content : ""))
        .join("\n")
      response.writeHead(200, { "content-type": "text/event-stream" })
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "m1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      response.write(chunk({ role: "assistant", content: "ok" }))
      response.write(chunk({}, "stop"))
      response.end("data: [DONE]\n\n")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    // A second namespace whose one tool carries a 9 kB description, which is what forces Code Mode on.
    const filler = Plugin.define({
      id: "elevenlabs.host-test.filler",
      async setup(ctx) {
        await ctx.tool.transform((editor) => {
          editor.namespace({ name: "filler", description: "Spends the inline budget." })
          editor.add({
            name: "pad",
            description: "pad",
            input: z.object({ note: z.string().describe("x".repeat(9_000)) }),
            options: { namespace: "filler", permission: "filler_pad", pinned: true },
            execute: async () => ({ content: "ok" }),
          } as never)
        })
      },
    })
    host = await startHost({
      plugins: [filler],
      config: () => ({
        providers: {
          scripted: {
            name: "Scripted",
            package: ["@opencode", "ai", "providers", "openai-compatible"].join("/"),
            settings: { baseURL, apiKey: "test" },
            models: { m1: { name: "Mock", capabilities: { tools: true } } },
          },
        },
        model: "scripted/m1",
      }),
    })
  })
  afterAll(async () => {
    await host?.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test("stays at most 1,000 tokens, and still names the skill to read first", async () => {
    // Measure the full catalogue: every served tool registered, not just the plugin's own one.
    expect(await elevenlabsTools(host)).toHaveLength(SERVED.length + 1)
    const sessionID = await session(host)
    await host.client.sessions.prompt({ sessionID, text: "Reply with ok." } as never)
    await until("the catalogue reaches the model", async () => captured.includes("- elevenlabs ("))
    const lines = captured.split("\n")
    const start = lines.findIndex((line) => line.startsWith("- elevenlabs ("))
    const section = [lines[start]!]
    for (let i = start + 1; i < lines.length && lines[i]!.startsWith("  "); i++) section.push(lines[i]!)
    const text = section.join("\n")
    // The one thing the section must carry: where the model reads the rules before it spends anything.
    expect(text).toContain("elevenlabs skill")
    expect(Math.round(text.length / 4)).toBeLessThanOrEqual(1_000)
  })
})
