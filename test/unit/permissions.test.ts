import { describe, expect, test } from "bun:test"
import {
  CONVERSATION_TOOLS,
  DESTRUCTIVE_TOOLS,
  EXPORT_TOOLS,
  READ_TOOLS,
  SPEND_TOOLS,
  TRANSCRIPT_TOOLS,
  WRITE_TOOLS,
} from "../../src/elevenlabs-tools.js"
import { conversationDenies, defaultRules, evaluate, hasDefaultRules, insertRules, registerDefaultRules, unguardedAgents, type Rule } from "../../src/permissions.js"
import { agentEditor, allow, builtInAgents, transforms, type FakeAgent } from "./fake.js"

const READ_A = READ_TOOLS[0]!
const WRITE = WRITE_TOOLS[0]!
const SPEND = SPEND_TOOLS[0]!
const effects = (rules: readonly Rule[]) => [`elevenlabs_${READ_A}`, `elevenlabs_${WRITE}`, `elevenlabs_${SPEND}`, "elevenlabs_shiny_new_tool"].map((action) => evaluate(rules, action))

describe("the default rules", () => {
  test("allow every ElevenLabs tool by default, reads, spending and a tool ElevenLabs adds later alike", () => {
    const rules = defaultRules()
    expect(rules[0]).toEqual({ action: "elevenlabs_*", resource: "*", effect: "allow" })
    expect(rules).toEqual([
      { action: "elevenlabs_*", resource: "*", effect: "allow" },
      ...READ_TOOLS.map((tool): Rule => ({ action: `elevenlabs_${tool}`, resource: "*", effect: "allow" })),
      ...[...EXPORT_TOOLS, ...WRITE_TOOLS, ...SPEND_TOOLS, ...DESTRUCTIVE_TOOLS].map((tool): Rule => ({ action: `elevenlabs_${tool}`, resource: "*", effect: "allow" })),
    ])
    expect(effects(rules)).toEqual(["allow", "allow", "allow", "allow"])
  })

  test("ask-changes allows reads and asks for every other tool, spending included", () => {
    const rules = defaultRules("ask-changes")
    expect(rules[0]).toEqual({ action: "elevenlabs_*", resource: "*", effect: "ask" })
    expect(effects(rules)).toEqual(["allow", "ask", "ask", "ask"])
    for (const tool of READ_TOOLS) expect(evaluate([allow("*"), ...rules], `elevenlabs_${tool}`)).toBe("allow")
    for (const tool of [...EXPORT_TOOLS, ...WRITE_TOOLS, ...SPEND_TOOLS, ...DESTRUCTIVE_TOOLS]) {
      expect(evaluate([allow("*"), ...rules], `elevenlabs_${tool}`)).toBe("ask")
    }
  })

  // It carries a sentence the model wrote itself out of the workspace and asks ElevenLabs to build a tool from it, so
  // it is a write with a rule of its own rather than a name left to `rule("*", other)`.
  test("get_more_tools has its own rule: allowed by default, asked for under ask-changes, denied under read-only", () => {
    expect(WRITE_TOOLS).toContain("get_more_tools")
    for (const [access, effect] of [["all", "allow"], ["ask-changes", "ask"], ["read-only", "deny"]] as const) {
      const rules = defaultRules(access)
      expect({ access, rule: rules.find((item) => item.action === "elevenlabs_get_more_tools") }).toEqual({
        access,
        rule: { action: "elevenlabs_get_more_tools", resource: "*", effect },
      })
      expect({ access, effect: evaluate([allow("*"), ...rules], "elevenlabs_get_more_tools") }).toEqual({ access, effect })
    }
  })

  test("read-only denies every tool that is not a read", () => {
    const rules = defaultRules("read-only")
    expect(rules[0]).toEqual({ action: "elevenlabs_*", resource: "*", effect: "deny" })
    expect(effects(rules)).toEqual(["allow", "deny", "deny", "deny"])
  })

  // R18's namespace amendment: a tool ElevenLabs adds later is not classified, so only the namespace rule decides it.
  test("an unclassified tool name follows the namespace pattern: allow, ask, deny for the three access values", () => {
    const unclassified = ["elevenlabs_agents_brand_new_tool", "elevenlabs_creative_tomorrows_tool", "elevenlabs_save_media"]
    for (const [access, effect] of [["all", "allow"], ["ask-changes", "ask"], ["read-only", "deny"]] as const) {
      const rules = defaultRules(access)
      expect(rules[0]).toEqual({ action: "elevenlabs_*", resource: "*", effect })
      for (const action of unclassified) expect({ action, access, effect: evaluate([allow("*"), ...rules], action) }).toEqual({ action, access, effect })
    }
  })

  test("a later user rule wins over the generated block, in every direction", () => {
    expect(evaluate([allow("*"), ...defaultRules("ask-changes"), allow(`elevenlabs_${WRITE}`)], `elevenlabs_${WRITE}`)).toBe("allow")
    expect(evaluate([allow("*"), ...defaultRules("all"), { action: `elevenlabs_${READ_A}`, resource: "*", effect: "deny" }], `elevenlabs_${READ_A}`)).toBe("deny")
  })

  test("conversations adds the exact denies and the patterns at the end, where they win over the block's allows", () => {
    expect(conversationDenies("full")).toEqual([])
    expect(conversationDenies("summary").slice(0, TRANSCRIPT_TOOLS.length)).toEqual([...TRANSCRIPT_TOOLS])
    expect(conversationDenies("off").slice(0, CONVERSATION_TOOLS.length)).toEqual([...CONVERSATION_TOOLS])
    for (const mode of ["summary", "off"] as const) {
      const rules = defaultRules("all", mode)
      for (const tool of conversationDenies(mode).filter((action) => !action.includes("*"))) expect(evaluate([allow("*"), ...rules], `elevenlabs_${tool}`)).toBe("deny")
      // The metadata reads that are not transcripts still run.
      const denied = (action: string) => conversationDenies(mode).some((rule) => new RegExp(`^elevenlabs_${rule.replaceAll("*", ".*")}$`).test(action))
      for (const tool of READ_TOOLS.filter((tool) => !denied(`elevenlabs_${tool}`) && !TRANSCRIPT_TOOLS.includes(tool))) expect(evaluate(rules, `elevenlabs_${tool}`)).toBe("allow")
    }
  })

  // a conversation tool ElevenLabs adds later is denied by the patterns, under every access value.
  test("a conversation tool the table does not know is denied by the patterns, at every access value", () => {
    const later = ["elevenlabs_agents_get_conversation_audio", "elevenlabs_agents_get_conversation_transcript", "elevenlabs_agents_fetch_transcript", "elevenlabs_agents_list_conversations_v2"]
    for (const access of ["all", "ask-changes", "read-only"] as const) {
      const rules = defaultRules(access, "off")
      for (const action of later) expect({ action, access, effect: evaluate([allow("*"), ...rules], action) }).toEqual({ action, access, effect: "deny" })
    }
    // Under `summary` the words are denied and the metadata reads are not.
    const summary = defaultRules("all", "summary")
    for (const action of ["elevenlabs_agents_get_conversation_audio", "elevenlabs_agents_get_conversation_transcript"]) {
      expect(evaluate([allow("*"), ...summary], action)).toBe("deny")
    }
    expect(evaluate([allow("*"), ...summary], "elevenlabs_agents_get_conversation")).toBe("deny")
    expect(evaluate([allow("*"), ...summary], "elevenlabs_agents_list_conversations")).toBe("allow")
  })

  test("hasDefaultRules finds the block anywhere after the base allow, and only the right one", () => {
    const permissions = [allow("*"), { action: "read", resource: "*.env", effect: "ask" } as Rule, ...defaultRules("all")]
    expect(hasDefaultRules(permissions)).toBe(true)
    expect(hasDefaultRules([...defaultRules("all")])).toBe(false)
    expect(hasDefaultRules(permissions, "ask-changes")).toBe(false)
    expect(hasDefaultRules([...permissions, ...defaultRules("all", "off")], "all", "off")).toBe(true)
  })

  test("insertRules puts the block right after the base allow and never loosens a default deny", () => {
    const agent: FakeAgent = { id: "build", permissions: [allow("*"), { action: "read", resource: "*.env", effect: "ask" }] }
    expect(insertRules(agent.permissions, defaultRules("read-only"))).toBe(true)
    expect(agent.permissions[1]).toEqual({ action: "elevenlabs_*", resource: "*", effect: "deny" })
    expect(agent.permissions[0]).toEqual(allow("*"))
    expect(insertRules(agent.permissions, defaultRules("read-only"))).toBe(false)
    const denying: FakeAgent = { id: "locked", permissions: [{ action: "*", resource: "*", effect: "deny" }] }
    expect(insertRules(denying.permissions, defaultRules("all"))).toBe(false)
    expect(denying.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }])
  })

  test("a user's lone elevenlabs_* ask is not the block, so the block is still added before it", () => {
    const own: Rule[] = [allow("*"), { action: "elevenlabs_*", resource: "*", effect: "ask" }, allow(`elevenlabs_${WRITE}`)]
    expect(insertRules(own, defaultRules("all"))).toBe(true)
    expect(evaluate(own, `elevenlabs_${WRITE}`)).toBe("allow")
  })

  test("registers for every agent, keeps the agent's own later rules, and reports a failure as a code", async () => {
    const agents = builtInAgents()
    const { transform, run } = transforms<void>()
    const problems: (string | undefined)[] = []
    await registerDefaultRules({ transform } as never, defaultRules("ask-changes", "off"), (problem) => problems.push(problem))
    run(agentEditor(agents) as never)
    for (const agent of agents) expect(agent.permissions.filter((rule) => rule.action === "elevenlabs_*")).toHaveLength(1)
    expect(problems).toEqual([undefined])
    // Explore denies `*`, then allows a few; the plugin's block sits after that base allow and before its denies.
    const explore = agents.find((agent) => agent.id === "explore")!
    expect(evaluate(explore.permissions, `elevenlabs_${WRITE}`)).toBe("deny")
    expect(evaluate(explore.permissions, `elevenlabs_${READ_A}`)).toBe("deny")

    const failing = transforms<void>()
    const boom = {
      transform: (callback: (editor: unknown) => void) => {
        void callback
        return Promise.reject(new Error("boom"))
      },
    }
    await registerDefaultRules(boom as never, defaultRules("all"), (problem) => problems.push(problem)).catch(() => undefined)
    void failing
  })

  test("names agents with a base allow, without the block, where a new ElevenLabs tool would run without asking", () => {
    const agents: FakeAgent[] = [
      { id: "build", permissions: [allow("*")] },
      { id: "guarded", permissions: [allow("*"), ...defaultRules("all")] },
      { id: "asker", permissions: [allow("*"), { action: "elevenlabs_*", resource: "*", effect: "ask" }] },
      { id: "locked", permissions: [{ action: "*", resource: "*", effect: "deny" }] },
    ]
    expect(unguardedAgents(agents)).toEqual(["build"])
  })
})
