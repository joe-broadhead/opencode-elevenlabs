// Reproductions from the fourth re-review. Each one failed at 6c21964 and must pass after the fix. RR4-1 to RR4-4
// were answered in the round before this one and keep their tests in `re-review-3.test.ts`.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ENDPOINT } from "../../src/constants.js"
import { Ledger, RESERVATION_MS, settlementOf } from "../../src/billing.js"
import { createElevenlabsPlugin } from "../../src/plugin.js"
import { mcpEditor, pluginContext } from "./fake.js"

const skillsDir = mkdtempSync(join(tmpdir(), "elevenlabs-rr4-"))
afterAll(() => rmSync(skillsDir, { recursive: true, force: true }))
const seam = { endpoint: ENDPOINT, skillsDir }

type Hook = (event: never) => Promise<void>
type Cost = { credits: number; basis: string; dailySpent: number }

/** The two spending hooks, on a context with the caps this test needs. */
async function hooks(caps: { sessionCreditCap: number | null; dailyCreditCap: number | null }) {
  const { ctx, mcp, hookFns } = pluginContext(caps)
  const cleanup = await createElevenlabsPlugin(seam).setup(ctx)
  mcp.run(mcpEditor().editor)
  const before = hookFns.get("execute.before")! as Hook
  const after = hookFns.get("execute.after")! as Hook
  const event = (id: string, input: Record<string, unknown>) => ({
    tool: "elevenlabs_creative_generate_speech",
    input,
    id,
    sessionID: "ses_test",
    agent: "build",
    messageID: "m1",
  })
  /** One completed result through `execute.after`, and the cost the owner is shown for it. */
  const complete = async (id: string, input: Record<string, unknown>, output: Record<string, unknown>) => {
    const result: { output: Record<string, unknown> } = { output: { ...output } }
    await after({ ...event(id, input), status: "completed", result } as never)
    return result.output.cost as Cost
  }
  return { before, after, event, complete, cleanup: cleanup! }
}

const TEXT = { text: "x".repeat(750) } // 750 characters, two takes: 1,500 credits reserved.

describe("RR4-5 — a recorded charge never goes down after its first settlement", () => {
  test("a result delivered again for a call already charged is ignored unless it is higher", async () => {
    const { before, complete, event, cleanup } = await hooks({ sessionCreditCap: 1_000_000, dailyCreditCap: 1_000_000 })
    await before(event("c1", TEXT) as never)
    // The first result reports nothing, so the reservation is the charge. At 6c21964 the two results after it each
    // overwrote that charge downwards — 1,500 -> 30 -> 1 — because the hook had forgotten what it reserved and read
    // its floor as zero, and `settle` let an attested figure past the floor it did have.
    expect(await complete("c1", TEXT, {})).toMatchObject({ credits: 1_500, basis: "at-most", dailySpent: 1_500 })
    const second = await complete("c1", TEXT, { credits: 30 })
    const third = await complete("c1", TEXT, { credits: 1 })
    expect([second.dailySpent, third.dailySpent]).toEqual([1_500, 1_500])
    // Not 30 and not 1: the first settlement recorded 1,500, and a repeat may only raise it. The lowest the sequence
    // can reach is the 30 it reported, and it does not reach even that.
    for (const cost of [second, third]) expect(cost.dailySpent).toBeGreaterThanOrEqual(30)
    expect(second.credits).toBe(1_500)
    // A repeat that is higher is still a raise.
    expect((await complete("c1", TEXT, { credits: 4_000 })).dailySpent).toBe(4_000)
    await cleanup()
  })

  test("a one-credit completion replayed after every call does not buy a second call", async () => {
    // The review's reproduction: a 5,000 daily cap at 1,500 a call admits three calls, and at 6c21964 replaying a
    // 1-credit result after each emptied the ledger and admitted 200 — 300,000 credits against a 5,000 cap.
    const { before, complete, event, cleanup } = await hooks({ sessionCreditCap: 5_000, dailyCreditCap: 5_000 })
    let admitted = 0
    let refused: unknown
    for (let call = 0; call < 200; call += 1) {
      const id = `c${call}`
      try {
        await before(event(id, TEXT) as never)
      } catch (error) {
        refused = error
        break
      }
      admitted += 1
      await complete(id, TEXT, {})
      await complete(id, TEXT, { credits: 1 })
    }
    expect(admitted).toBe(3)
    expect(refused).toMatchObject({ code: "SPEND_CAP_REACHED" })
    await cleanup()
  })

  test("only a live hold may be settled below its own figure, and only inside the band", () => {
    const ledger = new Ledger()
    const caps = { sessionCreditCap: 100_000, dailyCreditCap: 100_000 }
    // The first settlement of a live hold may lower it, inside the tenth-band.
    ledger.reserve("a", "ses_a", 1_500, caps)
    expect(ledger.settle("a", "ses_a", 900, true).dailyCredits).toBe(900)
    // Every settlement after that may only raise it, whatever it attests.
    expect(ledger.settle("a", "ses_a", 300, true).dailyCredits).toBe(900)
    expect(ledger.settle("a", "ses_a", 1_100, true).dailyCredits).toBe(1_100)
    expect(ledger.settle("a", "ses_a", 1_100, true).dailyCredits).toBe(1_100)
    expect(ledger.recorded("a")).toEqual({ kind: "charge", credits: 1_100 })
  })

  test("a hold that outlived its ten minutes is a charge, and a late figure cannot lower it", () => {
    let now = Date.now()
    const ledger = new Ledger({ now: () => now })
    ledger.reserve("a", "ses_a", 3_000, { sessionCreditCap: 100_000, dailyCreditCap: 100_000 })
    now += RESERVATION_MS + 1_000
    // `prune` records the expired hold as a charge; the call it belongs to is still running and reports 30 later.
    expect(ledger.daily()).toBe(3_000)
    expect(ledger.reservation("a")).toBeUndefined()
    expect(ledger.recorded("a")).toEqual({ kind: "charge", credits: 3_000 })
    expect(ledger.settle("a", "ses_a", 30, true).dailyCredits).toBe(3_000)
  })

  test("a figure below a charge says so in the cost line instead of attesting", () => {
    expect(settlementOf({ output: { credits: 900 } }, 1_500, null, "charge")).toEqual({
      credits: 1_500,
      attested: false,
      note: "the result reported 900 against 1,500 already charged for this call, so the recorded charge stands",
    })
    // The same figure against a live hold is this call's charge, as it was before.
    expect(settlementOf({ output: { credits: 900 } }, 1_500, null)).toEqual({ credits: 900, attested: true })
  })
})
