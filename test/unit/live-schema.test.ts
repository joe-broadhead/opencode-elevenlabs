// The pricing table against ElevenLabs' own schemas. Every figure the spending guard holds about a priced tool — which
// arguments it takes, and how many generations it runs when a call names none — is a copy of what the live catalogue
// declares. A copy that drifts is money: an argument the server added would reach a paid call unpriced, and a default
// that changed would divide a batch total by the wrong number. This suite is what makes the copies fail loudly.
import { describe, expect, test } from "bun:test"
import { GENERATION_DEFAULTS, GENERATION_KEYS, PRICED_ARGUMENTS } from "../../src/billing.js"
import { ESTIMATE_TOOLS, SPEND_TOOLS } from "../../src/elevenlabs-tools.js"
import { LIVE } from "./elevenlabs-catalog.js"

describe("the priced-argument allowlists", () => {
  test("cover exactly the tools that accept estimate_only, and nothing else", () => {
    expect([...PRICED_ARGUMENTS.keys()].sort()).toEqual([...ESTIMATE_TOOLS].sort())
  })

  test("are each the live schema's own property names", () => {
    for (const tool of ESTIMATE_TOOLS) {
      const live = LIVE.get(tool)
      expect({ tool, found: live !== undefined }).toEqual({ tool, found: true })
      expect({ tool, params: [...PRICED_ARGUMENTS.get(tool)!].sort() }).toEqual({ tool, params: [...live!.params].sort() })
    }
  })

  test("accept estimate_only itself, which the guard sends", () => {
    for (const tool of ESTIMATE_TOOLS) {
      expect({ tool, takesFlag: PRICED_ARGUMENTS.get(tool)!.has("estimate_only") }).toEqual({ tool, takesFlag: true })
      expect({ tool, inSchema: LIVE.get(tool)!.params.includes("estimate_only") }).toEqual({ tool, inSchema: true })
    }
  })

  test("name every tool the live catalogue gives the flag to, so none is missed", () => {
    const flagged = [...LIVE.values()].filter((tool) => tool.params.includes("estimate_only")).map((tool) => tool.name).sort()
    expect(flagged).toEqual([...ESTIMATE_TOOLS].sort())
  })
})

describe("the generation-count key", () => {
  test("is spelled the way every live schema spells it, and nothing else is read as a count", () => {
    // Both directions. A key the catalogue has and this list does not would leave a batch undivided and unclamped; a
    // key in this list that no live schema has would be read as a count on a call the server never reads it from.
    const live = new Set<string>()
    for (const tool of LIVE.values()) for (const param of tool.params) if (/^(generations?|variations|num_(generations|outputs))(_count)?$/.test(param)) live.add(param)
    expect([...live].sort()).toEqual([...GENERATION_KEYS].sort())
  })

  test("is on the six creative tools that batch, and on no other live tool", () => {
    const batching = [...LIVE.values()].filter((tool) => GENERATION_KEYS.some((key) => tool.params.includes(key))).map((tool) => tool.name).sort()
    expect(batching).toEqual(["creative_edit_image", "creative_generate_image", "creative_generate_in_flow", "creative_generate_speech", "creative_generate_video", "creative_run_flow_nodes"])
  })
})

describe("the generation defaults", () => {
  test("are the defaults the live schemas declare, for every tool that declares one", () => {
    const declared: Record<string, number> = {}
    for (const tool of ESTIMATE_TOOLS) {
      const live = LIVE.get(tool)!
      for (const key of GENERATION_KEYS) {
        const value = live.defaults[key]
        if (typeof value === "number") declared[tool] = value
      }
    }
    expect(GENERATION_DEFAULTS).toEqual(declared)
  })

  test("leave the batch size unknown where the live schema names no default", () => {
    // Two tools declare `generations_count` with no default and one has no count field at all. Nothing divides their
    // estimate, so `estimatePrice` reports a batch total with no per-generation figure and the clamp leaves them be.
    for (const tool of ["creative_generate_in_flow", "creative_run_flow_nodes"]) {
      expect({ tool, declares: LIVE.get(tool)!.params.includes("generations_count") }).toEqual({ tool, declares: true })
      expect({ tool, dflt: (GENERATION_DEFAULTS as Record<string, number | undefined>)[tool] }).toEqual({ tool, dflt: undefined })
    }
    const transcribe = LIVE.get("creative_transcribe_audio")!
    expect(GENERATION_KEYS.filter((key) => transcribe.params.includes(key))).toEqual([])
    expect(GENERATION_DEFAULTS.creative_transcribe_audio).toBeUndefined()
  })

  test("are whole positive counts, since they divide a batch total", () => {
    for (const [tool, count] of Object.entries(GENERATION_DEFAULTS)) {
      expect({ tool, ok: Number.isInteger(count) && count > 0 }).toEqual({ tool, ok: true })
    }
  })
})

describe("the spending tools without an estimate", () => {
  test("really have no estimate_only in the live schema, so a cap can only refuse them", () => {
    for (const tool of SPEND_TOOLS.filter((tool) => !ESTIMATE_TOOLS.includes(tool))) {
      const live = LIVE.get(tool)
      expect({ tool, found: live !== undefined }).toEqual({ tool, found: true })
      expect({ tool, flag: live!.params.includes("estimate_only") }).toEqual({ tool, flag: false })
      expect({ tool, allowlist: PRICED_ARGUMENTS.has(tool) }).toEqual({ tool, allowlist: false })
    }
  })
})
