// Credit caps are opt-in. With the default options nothing this plugin adds prices, refuses, clamps or serialises a
// paid call: no estimate is sent before it, so no flow or node is left in the workspace and no extra prompt is raised,
// and its cost line reports only what its result says, or `Credits: not reported`. The workspace's own balance at
// ElevenLabs and the permission rules are the bounds. A cap the owner sets still prices first and refuses as before.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Ledger, RESERVATION_MS, SpendRefused } from "../../src/billing.js"
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
const done = (text: string, output: Record<string, unknown> = {}) => ({ output, content: [{ type: "text", text }] })

/** The model path's two hooks, with every estimate request and every assert this plugin raises recorded. */
async function modelPath(options: Record<string, unknown>, credits = 50_000, refuse = false) {
  const { ctx, mcp, hookFns, toolList } = pluginContext(options)
  const estimates: Record<string, unknown>[] = []
  const asserts: string[] = []
  ;(ctx as unknown as { permission: { assert: (input: { action: string }) => Promise<void> } }).permission.assert = async (input) => {
    asserts.push(input.action)
    if (refuse) throw new Error("rejected")
  }
  toolList.push({
    id: "elevenlabs_creative_generate_image",
    execute: async (input: unknown) => {
      estimates.push(input as Record<string, unknown>)
      return { output: { estimate: { credits } } }
    },
  })
  const cleanup = await createElevenlabsPlugin(seam).setup(ctx)
  mcp.run(mcpEditor().editor)
  return { before: hookFns.get("execute.before")! as Hook, after: hookFns.get("execute.after")! as Hook, estimates, asserts, cleanup: cleanup! }
}

const uncapped = () => ({ ledger: new Ledger(), caps: () => ({ sessionCreditCap: null, dailyCreditCap: null }) })
const script = (method: string) => ({ sessionID: "ses_script", agent: "build", action: `elevenlabs_${method}` })

describe("with the default options there is no credit cap and no estimate", () => {
  test("both caps default to null", () => {
    expect(parseOptions({})).toMatchObject({ sessionCreditCap: null, dailyCreditCap: null })
    expect(parseOptions(undefined)).toMatchObject({ sessionCreditCap: null, dailyCreditCap: null })
  })

  test("no estimate is sent before a paid call, the count is not cut, and the cost line says not reported", async () => {
    const { before, after, estimates, asserts, cleanup } = await modelPath({})
    const args = { ...image }
    await before(event("c1", "creative_generate_image", args) as never)
    expect({ estimates: estimates.length, asserts: asserts.length }).toEqual({ estimates: 0, asserts: 0 })
    expect(args.generations_count).toBe(4)
    const result = done("created", { flow_id: "f1" })
    await after({ ...event("c1", "creative_generate_image", args), status: "completed", result } as never)
    expect(textOf(result)).toContain("Credits: not reported; 0 credits today.")
    expect((result.output as Record<string, unknown>).cost).toMatchObject({ credits: 0, sessionCap: null, dailyCap: null })
    await cleanup()
  })

  test("a result that reports its charge is reported and counted at that figure", async () => {
    const { before, after, cleanup } = await modelPath({})
    await before(event("c1", "creative_generate_image", { ...image }) as never)
    const result = done("created", { flow_id: "f1", credits_charged: 900 })
    await after({ ...event("c1", "creative_generate_image", image), status: "completed", result } as never)
    expect(textOf(result)).toContain("Credits: 900; 900 credits today.")
    await cleanup()
  })

  test("an explicit estimate_only call still runs and is not reported as a charge", async () => {
    const { before, after, estimates, cleanup } = await modelPath({})
    const probe = { ...image, estimate_only: true }
    await before(event("e1", "creative_generate_image", probe) as never)
    const result = done("estimate", { estimate: { credits: 761.5 } })
    await after({ ...event("e1", "creative_generate_image", probe), status: "completed", result } as never)
    expect(textOf(result)).toBe("estimate")
    expect(estimates).toHaveLength(0)
    await cleanup()
  })

  test("the tools with no estimate run, and their rules still ask under ask-changes and deny under read-only", async () => {
    const { before, after, cleanup } = await modelPath({})
    for (const tool of ["creative_design_voice", "agents_run_tests"]) {
      await before(event(`x-${tool}`, tool, { context: "run it" }) as never)
      const result = done("done")
      await after({ ...event(`x-${tool}`, tool, { context: "run it" }), status: "completed", result } as never)
      expect(textOf(result)).toContain("Credits: not reported")
      const effect = (access: "all" | "ask-changes" | "read-only") => defaultRules(access).find((rule) => rule.action === `elevenlabs_${tool}`)?.effect
      expect([effect("ask-changes"), effect("read-only")]).toEqual(["ask", "deny"])
    }
    await cleanup()
  })

  test("a name the table does not classify runs as it is, with no price and no cost line", async () => {
    const { before, after, cleanup } = await modelPath({})
    await before(event("u1", "creative_upscale", {}) as never)
    const result = done("done")
    await after({ ...event("u1", "creative_upscale", {}), status: "completed", result } as never)
    expect(textOf(result)).toBe("done")
    await cleanup()
  })

  test("a script may run two calls of one method at once, and each result reports only its own figure", () => {
    const runtime = uncapped()
    const shapers = shapersFor(runtime)
    const call = script("creative_generate_image")
    const first = { ...image }
    expect(() => shapers.input("creative_generate_image", first, call)).not.toThrow()
    expect(() => shapers.input("creative_generate_image", { ...image }, call)).not.toThrow()
    expect(first.generations_count).toBe(4)
    expect(shapers.result("creative_generate_image", { output: { flow_id: "f1", credits_charged: 300 }, text: "one" }, call).text).toContain("Credits: 300")
    expect(shapers.result("creative_generate_image", { output: { flow_id: "f2" }, text: "two" }, call).text).toContain("Credits: not reported; 300 credits today.")
    expect(() => shapers.input("creative_design_voice", { context: "x" }, script("creative_design_voice"))).not.toThrow()
    expect(() => shapers.input("agents_run_tests", { context: "x" }, script("agents_run_tests"))).not.toThrow()
  })

  test("a script call that threw leaves nothing behind: the next call of that method never reports the earlier price", () => {
    const runtime = uncapped()
    const shapers = shapersFor(runtime)
    const call = script("creative_generate_image")
    // A price the script fetched, then a paid call whose upstream threw, so its result shaper never ran.
    shapers.input("creative_generate_image", { ...image, estimate_only: true }, call)
    const estimate = shapers.result("creative_generate_image", { output: { estimate: { credits: 3_000 } }, text: "" }, call)
    expect(estimate.text).toBe("")
    shapers.input("creative_generate_image", { ...image }, call)
    shapers.input("creative_generate_image", { ...image }, call)
    const next = shapers.result("creative_generate_image", { output: { flow_id: "f2" }, text: "created" }, call)
    expect(next.text).toContain("Credits: not reported; 0 credits today.")
    expect(next.text).not.toContain("3,000")
    expect(runtime.ledger.spend("ses_script").sessionCredits).toBe(0)
  })
})

describe("a cap the owner sets prices first and still refuses", () => {
  test("the estimate is sent first, and a call over the cap is refused before it is sent", async () => {
    const { before, estimates, asserts, cleanup } = await modelPath({ sessionCreditCap: 2_000 }, 5_000)
    await expect(before(event("c1", "creative_generate_image", { ...image, generations_count: 1 }) as never)).rejects.toMatchObject({ code: "SPEND_CAP_REACHED" })
    expect(estimates).toHaveLength(1)
    expect(estimates[0]).toMatchObject({ estimate_only: true })
    expect(asserts).toEqual(["elevenlabs_creative_generate_image"])
    await expect(before(event("c2", "creative_design_voice", { context: "x" }) as never)).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    await expect(before(event("c3", "agents_run_tests", { context: "x" }) as never)).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    await expect(before(event("c4", "creative_upscale", {}) as never)).rejects.toBeInstanceOf(SpendRefused)
    await cleanup()
  })

  test("rejecting the estimate's prompt refuses the paid call, and nothing is estimated", async () => {
    const { before, estimates, asserts, cleanup } = await modelPath({ sessionCreditCap: 100_000, access: "ask-changes" }, 500, true)
    await expect(before(event("c1", "creative_generate_image", { ...image }) as never)).rejects.toMatchObject({ code: "PRICE_UNKNOWN" })
    expect({ asserts: asserts.length, estimates: estimates.length }).toEqual({ asserts: 1, estimates: 0 })
    await cleanup()
  })

  test("on the script path one priced call per method is in flight, and a batch is cut to what fits", () => {
    const runtime = { ledger: new Ledger(), caps: () => ({ sessionCreditCap: 7_000, dailyCreditCap: null }) }
    const shapers = shapersFor(runtime)
    const call = script("creative_generate_image")
    shapers.input("creative_generate_image", { ...image, estimate_only: true }, call)
    shapers.result("creative_generate_image", { output: { estimate: { credits: 8_000 } }, text: "" }, call)
    const first = { ...image }
    shapers.input("creative_generate_image", first, call)
    expect(first.generations_count).toBe(3)
    expect(() => shapers.input("creative_generate_image", { ...image }, call)).toThrow("SPEND_CAP_REACHED")
  })

  test("a call that threw holds its slot until its hold is charged, and the next result settles only its own hold", () => {
    let now = 1_000_000
    const runtime = { ledger: new Ledger({ now: () => now }), caps: () => ({ sessionCreditCap: 100_000, dailyCreditCap: null }) }
    const shapers = shapersFor(runtime)
    const call = script("creative_generate_image")
    const one = { ...image, generations_count: 1 }
    shapers.input("creative_generate_image", { ...one, estimate_only: true }, call)
    shapers.result("creative_generate_image", { output: { estimate: { credits: 1_000 } }, text: "" }, call)
    shapers.input("creative_generate_image", { ...one }, call)
    // Its upstream threw, so no result arrives. A second call cannot be paired with it: it is refused while the hold lives.
    expect(() => shapers.input("creative_generate_image", { ...one }, call)).toThrow("SPEND_CAP_REACHED")
    now += RESERVATION_MS + 1
    // The hold became a charge at its reserved price; the slot is free, and the next call holds and settles its own.
    shapers.input("creative_generate_image", { ...one, estimate_only: true }, call)
    shapers.result("creative_generate_image", { output: { estimate: { credits: 1_000 } }, text: "" }, call)
    shapers.input("creative_generate_image", { ...one }, call)
    const settled = shapers.result("creative_generate_image", { output: { flow_id: "f2" }, text: "created" }, call)
    expect(settled.text).toContain("Credits: 1,000")
    expect(runtime.ledger.spend("ses_script").sessionCredits).toBe(2_000)
  })
})
