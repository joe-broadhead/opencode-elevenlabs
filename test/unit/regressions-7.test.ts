// The eight tools the 19 November 2026 catalogue added, and nothing else: the class each gets, the one that reaches a
// real person, and what the conversation option does to them. No tool runs here; the table, the generated rules and the
// committed capture are the whole input.
import { describe, expect, test } from "bun:test"
import {
  classify,
  DESTRUCTIVE_TOOLS,
  EXPORT_TOOLS,
  priced,
  READ_TOOLS,
  REACH_TOOLS,
  SPEND_TOOLS,
  spends,
  WRITE_TOOLS,
} from "../../src/elevenlabs-tools.js"
import { defaultRules, evaluate } from "../../src/permissions.js"
import type { Access, Conversations } from "../../src/options.js"

const effectOf = (tool: string, access: Access, conversations: Conversations = "full") =>
  evaluate(defaultRules(access, conversations), `elevenlabs_${tool}`)

/** The eight names, and the class each is in, from its own description and schema. */
const ADDED: readonly (readonly [string, "read" | "write" | "spend"])[] = [
  ["agents_add_pronunciation_dictionary_rules", "write"],
  ["agents_create_pronunciation_dictionary", "write"],
  ["agents_get_draft", "read"],
  ["agents_get_pronunciation_dictionary", "read"],
  ["agents_outbound_call", "spend"],
  ["agents_remove_pronunciation_dictionary_rules", "write"],
  ["agents_update_draft", "write"],
  ["creative_get_guide", "read"],
]

describe("the eight tools the 19 November 2026 catalogue added", () => {
  test.each(ADDED)("%s is a %s, and only in that list", (tool, cls) => {
    expect(classify(tool)).toBe(cls)
    const lists = { read: READ_TOOLS, write: WRITE_TOOLS, spend: SPEND_TOOLS }
    for (const [name, list] of Object.entries(lists)) expect({ tool, name, present: list.includes(tool) }).toEqual({ tool, name, present: name === cls })
    expect(EXPORT_TOOLS.includes(tool)).toBe(false)
    expect(DESTRUCTIVE_TOOLS.includes(tool)).toBe(false)
  })

  test("the outbound call is a spend tool and a reach tool, with no price of its own", () => {
    expect(SPEND_TOOLS).toContain("agents_outbound_call")
    expect(REACH_TOOLS).toContain("agents_outbound_call")
    expect(spends("agents_outbound_call")).toBe(true)
    // It says it costs credits and declares no estimate_only, like the batch calls: a cap must refuse it rather than
    // guess a figure, and nothing here invents one.
    expect(priced("agents_outbound_call")).toBe(false)
  })

  test("the outbound call asks under ask-changes and is denied under read-only", () => {
    expect(effectOf("agents_outbound_call", "all")).toBe("allow")
    expect(effectOf("agents_outbound_call", "ask-changes")).toBe("ask")
    expect(effectOf("agents_outbound_call", "read-only")).toBe("deny")
    // Every write the catalogue added follows the same rule.
    for (const [tool, cls] of ADDED) {
      if (cls === "read") continue
      expect({ tool, effect: effectOf(tool, "ask-changes") }).toEqual({ tool, effect: "ask" })
      expect({ tool, effect: effectOf(tool, "read-only") }).toEqual({ tool, effect: "deny" })
    }
  })

  test("the conversation option leaves them alone: none reads a call's history", () => {
    // `conversations` governs reads of a call's history. The outbound call starts one and returns only its id, and the
    // dictionary and draft tools touch no conversation at all, so neither `summary` nor `off` may deny them. The
    // transcript tools are still denied, which is what these rules are for.
    for (const [tool] of ADDED) {
      for (const conversations of ["summary", "off"] as const) {
        expect({ tool, conversations, effect: effectOf(tool, "all", conversations) }).toEqual({ tool, conversations, effect: "allow" })
      }
    }
    expect(effectOf("agents_get_conversation", "all", "off")).toBe("deny")
  })
})
