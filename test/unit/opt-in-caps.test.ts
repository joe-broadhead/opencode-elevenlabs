// Credit caps are opt-in. With the default options nothing this plugin adds refuses, clamps or serialises a paid
// call: the workspace's own balance at ElevenLabs and the permission rules are the bounds, and every paid result still
// carries its cost line. A cap the owner sets still refuses exactly as before.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Ledger, SpendRefused } from "../../src/billing.js"
import { ENDPOINT } from "../../src/constants.js"
import { shapersFor } from "../../src/host/tools-rpc.js"
import { parseOptions } from "../../src/options.js"
import { defaultRules } from "../../src/permissions.js"
import { createElevenlabsPlugin } from "../../src/plugin.js"
import { mcpEditor, pluginContext } from "./fake.js"

const skillsDir = mkdtempSync(join(tmpdir(), "elevenlabs-opt-in-"))
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }))
const seam = { endpoint: ENDPOINT, skillsDir }
type Hook = (event: never) => Promise<void>

const image = { prompt: "a ceramic mug", generations_count: 4, model_id: "model_example", context: "make it" }
const event = (id: string, tool: string, input: Record<string, unknown>) => ({ tool: `elevenlabs_${tool}`, input, id, sessionID: "ses_test", agent: "build", messageID: "m1" })
const textOf = (result: { content?: unknown }) => (Array.isArray(result.content) ? result.content.map((part: { text?: string }) => part.text ?? "").join("\n") : String(result.content ?? ""))

/** The model path's two hooks, with ElevenLabs answering every estimate for image generation at `credits`. */
async function modelPath(options: Record<string, unknown>, credits = 50_000) {
  const { ctx, mcp, hookFns, toolList } = pluginContext(options)
  const estimates: Record<string, unknown>[] = []
  toolList.push({
    id: "elevenlabs_creative_generate_image",
    execute: async (input: unknown) => {
      estimates.push(input as Record<string, unknown>)
      return { output: { estimate: { credits } } }
    },
  })
  const cleanup = await createElevenlabsPlugin(seam).setup(ctx)
  mcp.run(mcpEditor().editor)
  return { before: hookFns.get("execute.before")! as Hook, after: hookFns.get("execute.after")! as Hook, estimates, cleanup: cleanup! }
}

describe("with the default options there is no credit cap", () => {
  test("both caps default to null", () => {
    expect(parseOptions({})).toMatchObject({ sessionCreditCap: null, dailyCreditCap: null })
    expect(parseOptions(undefined)).toMatchObject({ sessionCreditCap: null, dailyCreditCap: null })
  })

  test("a paid call of any size runs, its generation count is not cut, and its result carries the cost line", async () => {
    const { before, after, estimates, cleanup } = await modelPath({})
    const args = { ...image }
    await before(event("c1", "creative_generate_image", args) as never)
    // Priced for the cost line by ElevenLabs' own estimate, and not clamped: 50,000 credits for four images runs.
    expect(estimates).toHaveLength(1)
    expect(args.generations_count).toBe(4)
    const result = { output: { flow_id: "f1" }, content: [{ type: "text", text: "created" }] }
    await after({ ...event("c1", "creative_generate_image", args), status: "completed", result } as never)
    expect(textOf(result)).toContain("Credits: 50,000 (4 generations, estimated by ElevenLabs); 50,000 credits today.")
    expect((result.output as Record<string, unknown>).cost).toMatchObject({ credits: 50_000, sessionCap: null, dailyCap: null })
    // A second, just as large, is not refused either: nothing here keeps a budget.
    await before(event("c2", "creative_generate_image", { ...image }) as never)
    await cleanup()
  })

  test("the tools with no estimate run unpriced, and say so in the cost line", async () => {
    const { before, after, cleanup } = await modelPath({})
    for (const tool of ["creative_design_voice", "agents_run_tests"]) {
      await before(event(`x-${tool}`, tool, { context: "run it" }) as never)
      const result = { output: {}, content: [{ type: "text", text: "done" }] }
      await after({ ...event(`x-${tool}`, tool, { context: "run it" }), status: "completed", result } as never)
      expect(textOf(result)).toContain("Credits: not reported (not priced before it ran)")
    }
    await cleanup()
  })

  test("they still ask under ask-changes and are denied under read-only: the permission rules are the bound", () => {
    for (const tool of ["creative_design_voice", "agents_run_tests", "creative_generate_image"]) {
      const effect = (access: "all" | "ask-changes" | "read-only") => defaultRules(access).find((rule) => rule.action === `elevenlabs_${tool}`)?.effect
      expect([effect("ask-changes"), effect("read-only")]).toEqual(["ask", "deny"])
    }
  })

  test("a name the table does not classify runs as it is, with no price and no cost line", async () => {
    const { before, after, cleanup } = await modelPath({})
    await before(event("u1", "creative_upscale", {}) as never)
    const result = { output: {}, content: [{ type: "text", text: "done" }] }
    await after({ ...event("u1", "creative_upscale", {}), status: "completed", result } as never)
    expect(textOf(result)).toBe("done")
    await cleanup()
  })

  test("a script may run two priced calls of one method at once, and each result carries its own cost line", () => {
    const runtime = { ledger: new Ledger(), caps: () => ({ sessionCreditCap: null, dailyCreditCap: null }) }
    const shapers = shapersFor(runtime)
    const call = { sessionID: "ses_script", agent: "build", action: "elevenlabs_creative_generate_image" }
    shapers.input("creative_generate_image", { ...image, estimate_only: true }, call)
    shapers.result("creative_generate_image", { output: { estimate: { credits: 3_000 } }, text: "" }, call)
    const first = { ...image }
    const second = { ...image }
    expect(() => shapers.input("creative_generate_image", first, call)).not.toThrow()
    expect(() => shapers.input("creative_generate_image", second, call)).not.toThrow()
    expect([first.generations_count, second.generations_count]).toEqual([4, 4])
    expect(shapers.result("creative_generate_image", { output: { flow_id: "f1" }, text: "one" }, call).text).toContain("Credits: 3,000")
    expect(shapers.result("creative_generate_image", { output: { flow_id: "f2" }, text: "two" }, call).text).toContain("6,000 credits today")
    // And the tools with no estimate are not refused on this path either.
    expect(() => shapers.input("creative_design_voice", { context: "x" }, { ...call, action: "elevenlabs_creative_design_voice" })).not.toThrow()
    expect(() => shapers.input("agents_run_tests", { context: "x" }, { ...call, action: "elevenlabs_agents_run_tests" })).not.toThrow()
  })
})

describe("a cap the owner sets still refuses", () => {
  test("a call over the session cap is refused before it is sent, and the tools with no estimate are refused", async () => {
    const { before, cleanup } = await modelPath({ sessionCreditCap: 2_000 }, 5_000)
    const args = { ...image, generations_count: 1 }
    await expect(before(event("c1", "creative_generate_image", args) as never)).rejects.toMatchObject({ code: "SPEND_CAP_REACHED" })
    await expect(before(event("c2", "creative_design_voice", { context: "x" }) as never)).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    await expect(before(event("c3", "agents_run_tests", { context: "x" }) as never)).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    await expect(before(event("c4", "creative_upscale", {}) as never)).rejects.toBeInstanceOf(SpendRefused)
    await cleanup()
  })

  test("on the script path one priced call per method is in flight, and a batch is cut to what fits", () => {
    const runtime = { ledger: new Ledger(), caps: () => ({ sessionCreditCap: 7_000, dailyCreditCap: null }) }
    const shapers = shapersFor(runtime)
    const call = { sessionID: "ses_script", agent: "build", action: "elevenlabs_creative_generate_image" }
    shapers.input("creative_generate_image", { ...image, estimate_only: true }, call)
    shapers.result("creative_generate_image", { output: { estimate: { credits: 8_000 } }, text: "" }, call)
    const first = { ...image }
    shapers.input("creative_generate_image", first, call)
    expect(first.generations_count).toBe(3)
    expect(() => shapers.input("creative_generate_image", { ...image }, call)).toThrow("SPEND_CAP_REACHED")
  })
})
