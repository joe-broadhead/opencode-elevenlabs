import { describe, expect, test } from "bun:test"
import {
  ALL_TOOLS,
  classify,
  CONVERSATION_TOOLS,
  DESTRUCTIVE_TOOLS,
  ESTIMATE_TOOLS,
  EXPORT_TOOLS,
  OWN_TOOLS,
  priced,
  READ_TOOLS,
  SPEND_TOOLS,
  spends,
  TRANSCRIPT_TOOLS,
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

  test("is exactly the saved tool list: the 40 attested names, in both directions", () => {
    expect(ALL_TOOLS).toHaveLength(40)
    expect([...ALL_TOOLS].sort()).toEqual([...LIVE_TOOLS].sort())
  })

  test("the saved annotations agree with the classes where the fixture records them", () => {
    for (const tool of LIVE_TOOLS) {
      const live = LIVE.get(tool)!
      const cls = classify(tool)
      if (live.destructiveHint === true) expect({ tool, cls }).toEqual({ tool, cls: "destructive" })
      if (live.readOnlyHint === true) expect({ tool, cls }).toEqual({ tool, cls: "read" })
    }
  })

  test("the conversation lists are reads, and the transcript pair is inside them", () => {
    for (const tool of CONVERSATION_TOOLS) expect(classify(tool)).toBe("read")
    expect([...CONVERSATION_TOOLS]).toEqual([...CONVERSATION_TOOLS, ...TRANSCRIPT_TOOLS.filter((tool) => !CONVERSATION_TOOLS.includes(tool))])
    expect([...TRANSCRIPT_TOOLS].sort()).toEqual(["agents_get_conversation", "agents_search_conversation_messages"])
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
