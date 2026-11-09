import { describe, expect, test } from "bun:test"
import {
  ALL_TOOLS,
  classify,
  CONVERSATION_TOOLS,
  creativeGuardSentence,
  DESTRUCTIVE_TOOLS,
  ESTIMATE_TOOLS,
  EXPORT_TOOLS,
  known,
  mustPrice,
  OWN_TOOLS,
  priced,
  READ_TOOLS,
  SPEND_TOOLS,
  spends,
  TRANSCRIPT_TOOLS,
  UNCLASSIFIED_TOOLS,
  WRITE_TOOLS,
} from "../../src/elevenlabs-tools.js"
import { LIVE, LIVE_TOOLS } from "./elevenlabs-catalog.js"

const LISTS: Readonly<Record<string, readonly string[]>> = { READ_TOOLS, EXPORT_TOOLS, WRITE_TOOLS, SPEND_TOOLS, DESTRUCTIVE_TOOLS }

describe("the tool table", () => {
  test("classifies every list exactly, and nothing twice", () => {
    for (const [tool, expected] of [
      ...READ_TOOLS.map((tool) => [tool, "read"] as const),
      ...EXPORT_TOOLS.map((tool) => [tool, "export"] as const),
      ...WRITE_TOOLS.map((tool) => [tool, "write"] as const),
      ...SPEND_TOOLS.map((tool) => [tool, "spend"] as const),
      ...DESTRUCTIVE_TOOLS.map((tool) => [tool, "destructive"] as const),
    ]) {
      expect(classify(tool)).toBe(expected)
    }
    expect([...ALL_TOOLS].sort()).toEqual(Object.values(LISTS).flat().sort())
  })

  test("holds each name once, sorted, so a change is one line", () => {
    for (const [name, list] of Object.entries(LISTS)) {
      expect({ name, unique: new Set(list).size === list.length }).toEqual({ name, unique: true })
      expect({ name, list }).toEqual({ name, list: [...list].sort() })
    }
    expect(new Set(ALL_TOOLS).size).toBe(ALL_TOOLS.length)
  })

  test("is exactly the live tool list, in both directions, once the unclassified names are counted", () => {
    // The fixture is the catalogue a live account returned, so every name in it is classified or deliberately held.
    expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(40)
    expect([...ALL_TOOLS, ...UNCLASSIFIED_TOOLS].sort()).toEqual([...LIVE_TOOLS].sort())
    expect(ALL_TOOLS.filter((tool) => UNCLASSIFIED_TOOLS.includes(tool))).toEqual([])
  })

  // This test used to assert that `get_more_tools` was held unclassified on purpose, as a catalogue pager that
  // returned tool definitions. Its live schema says otherwise — one required free-text `capability` string, and a
  // description that asks ElevenLabs to build tools with it — so it is a write, and nothing is held (RE-1).
  test("classifies every live name, and get_more_tools is the write its own schema describes", () => {
    expect([...UNCLASSIFIED_TOOLS]).toEqual([])
    expect(classify("get_more_tools")).toBe("write")
    expect(WRITE_TOOLS).toContain("get_more_tools")
    // It asks ElevenLabs to build a tool; it does not spend credits and it is not priced.
    expect(spends("get_more_tools")).toBe(false)
    expect(mustPrice("get_more_tools")).toBe(false)
    // The live definition this class was read from, so a catalogue that changes it fails here rather than in prose.
    const live = LIVE.get("get_more_tools")!
    expect(live.description).toContain("inform which tools get built next")
    expect(live.required).toEqual(["capability"])
  })

  test("a name the table does not classify must be priced, so a cap refuses it whatever it starts with", () => {
    // The money gate is the table, not the `creative_` prefix: a spending tool ElevenLabs ships under any other name
    // would otherwise be allowed by `rule("*", other)` and never priced, and `get_more_tools` exists to ask for new
    // tools (RE-1, RE-3).
    for (const tool of ["agents_new_spender", "foo_bar", "creative_whatever_new", "", "SHINY_NEW_TOOL"]) {
      expect({ tool, mustPrice: mustPrice(tool) }).toEqual({ tool, mustPrice: true })
      expect({ tool, known: known(tool) }).toEqual({ tool, known: false })
    }
    // Everything the table does classify keeps running unpriced unless it spends, the plugin's own tool included.
    for (const tool of ALL_TOOLS) expect({ tool, mustPrice: mustPrice(tool) }).toEqual({ tool, mustPrice: spends(tool) })
    for (const tool of OWN_TOOLS) expect({ tool, mustPrice: mustPrice(tool) }).toEqual({ tool, mustPrice: false })
    expect(mustPrice("Creative_Generate_Speech")).toBe(true)
  })

  test("the README sentence counts the spending tools from the predicate itself", () => {
    expect(creativeGuardSentence()).toContain(`each of the ${SPEND_TOOLS.length} tools that can spend`)
    expect(creativeGuardSentence()).toContain("any name this table does not classify, whatever it starts with")
  })

  test("the saved annotations agree with the classes where the fixture records them", () => {
    for (const tool of LIVE_TOOLS) {
      const live = LIVE.get(tool)!
      const cls = classify(tool)
      if (live.destructiveHint === true) expect({ tool, cls }).toEqual({ tool, cls: "destructive" })
      if (live.readOnlyHint === true) expect({ tool, cls }).toEqual({ tool, cls: "read" })
    }
  })

  test("the conversation lists are reads, and every transcript tool is inside them", () => {
    for (const tool of CONVERSATION_TOOLS) expect(classify(tool)).toBe("read")
    expect([...CONVERSATION_TOOLS]).toEqual([...CONVERSATION_TOOLS, ...TRANSCRIPT_TOOLS.filter((tool) => !CONVERSATION_TOOLS.includes(tool))])
    // Every tool that can return what a caller said, so the README's and SECURITY's sentence about transcripts covers
    // all four: two read one conversation, two search the messages inside them.
    expect([...TRANSCRIPT_TOOLS].sort()).toEqual([
      "agents_get_conversation",
      "agents_get_conversation_summary",
      "agents_search_conversation_messages",
      "agents_semantic_search_conversation_messages",
    ])
  })

  test("estimate tools are all spend tools, and the two spend checks agree", () => {
    for (const tool of ESTIMATE_TOOLS) expect(spends(tool)).toBe(true)
    expect(SPEND_TOOLS.filter(spends)).toEqual([...SPEND_TOOLS])
    expect(ESTIMATE_TOOLS.filter(priced)).toEqual([...ESTIMATE_TOOLS])
    expect(priced("agents_list")).toBe(false)
  })

  test("no read is named like a change, and no destructive tool is also an export", () => {
    expect(READ_TOOLS.filter((tool) => /^(?:add|create|update|delete|remove|save|set|send|share|upload|feedback|give|merge|deploy|duplicate)_/.test(tool))).toEqual([])
    expect(DESTRUCTIVE_TOOLS.filter((tool) => EXPORT_TOOLS.includes(tool))).toEqual([])
  })

  test("the plugin's own tool is not an ElevenLabs tool", () => {
    expect([...OWN_TOOLS]).toEqual(["save_media"])
    for (const tool of OWN_TOOLS) expect(classify(tool)).toBe("unknown")
  })

  test("treats everything else as unknown, so the namespace rule decides it", () => {
    for (const tool of ["shiny_new_tool", "agents_new_thing", "creative_", "AGENTS_LIST", ""]) expect(classify(tool)).toBe("unknown")
  })
})
