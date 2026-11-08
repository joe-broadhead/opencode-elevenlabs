// ElevenLabs' part of the tools RPC: the plugin-specific block of src/host/tools-rpc.ts. The shared part is tested in
// tools-rpc.test.ts.
import { describe, expect, test } from "bun:test"
import { PLUGIN_ID as ELEVENLABS_PLUGIN_ID, SERVER_NAME } from "../../src/constants.js"
import { METHODS, NEXT_STEPS, PLUGIN_ID, setToolRuntime, shapeInput, shapeResult, shapersFor, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { Ledger } from "../../src/billing.js"
import { defaultRules } from "../../src/permissions.js"
import { ALL_TOOLS, READ_TOOLS, SPEND_TOOLS, WRITE_TOOLS } from "../../src/elevenlabs-tools.js"
import { SAVE_ACTION } from "../../src/media/tool.js"

const CALL = { sessionID: "ses_script", agent: "build", action: `elevenlabs_${READ_TOOLS[0]}` }

/** A runtime with the default caps and a ledger that never touches storage. */
const runtime = (sessionCreditCap: number | null = 2000, dailyCreditCap: number | null = 10000) => {
  const ledger = new Ledger()
  return { ledger, caps: () => ({ sessionCreditCap, dailyCreditCap }) }
}

describe("ElevenLabs' tools RPC", () => {
  test("is elevenlabs.tools, under the plugin's own id", () => {
    expect(PLUGIN_ID).toBe(ELEVENLABS_PLUGIN_ID)
    expect(TOOLS_RPC_ID).toBe("elevenlabs.tools")
  })

  test("every known tool is a method, by exact name, with the class describe reports", () => {
    expect(METHODS.map((method) => method.name)).toEqual([...ALL_TOOLS, SAVE_ACTION])
    // Every known tool allows by default, and so does the namespace rule that covers a tool ElevenLabs adds later.
    const allowed = defaultRules().filter((rule) => rule.effect === "allow").map((rule) => rule.action)
    expect(allowed[0]).toBe(`${SERVER_NAME}_*`)
    for (const name of ALL_TOOLS) expect(allowed).toContain(`elevenlabs_${name}`)
    for (const name of ["shiny_new_tool", "describe", "*"]) expect(METHODS.map((method) => method.name)).not.toContain(name)
  })

  test("a read is left exactly as the script wrote it, and its result is not priced", () => {
    setToolRuntime(runtime())
    const input = { query: "refunds" }
    expect(shapeInput(READ_TOOLS[0]!, input, CALL)).toEqual({ query: "refunds" })
    const result = { output: { agent_id: "a1" }, text: "{}" }
    expect(shapeResult(READ_TOOLS[0]!, result, CALL)).toEqual(result)
    setToolRuntime(undefined)
  })

  test("a billed call with no price is refused before dispatch, with the code a script reads", () => {
    setToolRuntime(runtime())
    let refused: unknown
    try {
      shapeInput(SPEND_TOOLS.find((tool) => tool === "creative_generate_image")!, { prompt: "a mug", context: "price it" }, { ...CALL, action: "elevenlabs_creative_generate_image" })
    } catch (error) {
      refused = error
    }
    expect((refused as { code?: string }).code).toBe("PRICE_UNKNOWN")
    setToolRuntime(undefined)
  })

  test("a remembered estimate prices the same arguments, is clamped in the caller's own key, and is charged", () => {
    const spend = runtime()
    setToolRuntime(spend)
    const call = { ...CALL, action: "elevenlabs_creative_generate_image" }
    // DR-6: the caller used `variations`, so the clamp must land there and nowhere else.
    const args: Record<string, unknown> = { prompt: "a mug", variations: 4, context: "price it" }
    shapeInput("creative_generate_image", { ...args, estimate_only: true }, call)
    const estimated = shapeResult("creative_generate_image", { output: { estimate: { credits: 4000 } }, text: "" }, call)
    expect(estimated.output).toMatchObject({ estimate: { credits: 4000 } })

    // 2,000 credits of cap and 1,000 per generation: four become two, and the price follows what will run.
    const clamped = { ...args }
    shapeInput("creative_generate_image", clamped, call)
    expect(clamped).toEqual({ prompt: "a mug", variations: 2, context: "price it" })
    expect(clamped).not.toHaveProperty("generations_count")
    const paid = shapeResult("creative_generate_image", { output: { flow_id: "f1" }, text: "created" }, call)
    expect(paid.text).toContain("Credits: at most 2,000")
    expect(paid.text).toContain("2,000 of 10,000 credits today")
    expect(paid.output).toMatchObject({ cost: { credits: 2000, basis: "at-most", sessionSpent: 2000, dailySpent: 2000, sessionCap: 2000, dailyCap: 10000 } })
    setToolRuntime(undefined)
  })

  test("two script calls that reserve together cannot both fit (DR-1)", () => {
    const spend = runtime(2000, 10000)
    const shapers = shapersFor(spend)
    const call = { ...CALL, action: "elevenlabs_creative_generate_speech" }
    const first = { text: "x".repeat(600) }
    const second = { text: "x".repeat(600) }
    expect(() => shapers.input("creative_generate_speech", first, call)).not.toThrow()
    expect(() => shapers.input("creative_generate_speech", second, call)).toThrow("SPEND_CAP_REACHED")
    expect(spend.ledger.spend("ses_script").sessionCredits).toBe(1200)
  })

  test("a transcription priced only from a caller duration is refused before dispatch", () => {
    setToolRuntime(runtime(100, 10000))
    expect(() => shapeInput("creative_transcribe_audio", { duration_seconds: 60 }, { ...CALL, action: "elevenlabs_creative_transcribe_audio" })).toThrow("PRICE_UNKNOWN")
    setToolRuntime(undefined)
  })

  test("a speech call is priced from ElevenLabs' published rate, and refused when it does not fit", () => {
    const spend = runtime(100)
    setToolRuntime(spend)
    const call = { ...CALL, action: "elevenlabs_creative_generate_speech" }
    let refused: unknown
    try {
      shapeInput("creative_generate_speech", { text: "x".repeat(60) }, call)
    } catch (error) {
      refused = error
    }
    expect((refused as { code?: string }).code).toBe("SPEND_CAP_REACHED")
    expect((refused as { message: string }).message).toContain("120 credits")
    setToolRuntime(undefined)
  })

  test("both caps off runs the call unpriced rather than refusing it", () => {
    setToolRuntime(runtime(null, null))
    const call = { ...CALL, action: "elevenlabs_creative_generate_image" }
    expect(shapeInput("creative_generate_image", { prompt: "a mug" }, call)).toEqual({ prompt: "a mug" })
    setToolRuntime(undefined)
  })

  test("names ElevenLabs' own commands in its next steps, and has no per-account servers", () => {
    expect(NEXT_STEPS.AUTH_REQUIRED).toContain("/connect and choose ElevenLabs")
    expect(NEXT_STEPS.AUTH_REQUIRED).toContain("opencode mcp auth elevenlabs")
    expect(NEXT_STEPS.SERVER_CONFLICT).toContain("mcp.servers.elevenlabs")
    expect(NEXT_STEPS.SERVER_CONFLICT).toContain("/elevenlabs-status")
    for (const step of Object.values(NEXT_STEPS)) expect(step).toMatch(/[^.]\.$/)
    expect(NEXT_STEPS.ACCOUNT_UNKNOWN).toBeUndefined()
  })

  test("the save method refuses cleanly when the owning plugin is not set up", async () => {
    setToolRuntime(undefined)
    const method = METHODS.find((entry) => entry.kind === "plugin")!
    expect(method.kind).toBe("plugin")
    await expect((method as { run: (input: unknown, call: never) => Promise<unknown> }).run({ url: "https://x" }, {} as never)).rejects.toThrow("TOOL_UNAVAILABLE")
  })

  test("every write is a method, so a script's change is resolved before dispatch", () => {
    for (const name of WRITE_TOOLS) expect(METHODS.map((method) => method.name)).toContain(name)
  })
})
