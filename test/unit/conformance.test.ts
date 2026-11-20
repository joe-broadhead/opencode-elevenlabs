// The source contract's conformance kit over the declared source (test/support/conformance.ts), held to ok: the report
// `npm run conformance` writes for a release is the same one.
import { describe, expect, test } from "bun:test"
import { declarationProblems } from "@we-the-rebel-alliance/source-contract/conformance"
import { readInstalledDescriptor } from "@we-the-rebel-alliance/source-contract/descriptor"
import { ACCOUNT, PACKAGE, SOURCE_ID } from "../../src/events.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { ATOMIC, ROOT, conformanceReports, declaredSources, declaredTools, list, pkg, probe } from "../support/conformance.js"
import { SINCE } from "../support/synthetic-conversations.js"

/**
 * v0.3 checks this source carries nothing for. The kit marks each not applicable and states no reason of its own; an
 * empty reason would be no reason, so the test states why. A conversation's actor is role agent, not from or author.
 */
const ABSENT = {
  "actor-kind": "the fixture names no machine actor, so actor-kind does not apply",
  "commitment-key": "no page carries a commitment, so commitment-key does not apply",
  facts: "no page carries a fact, so facts does not apply",
  hints: "the source declares no hint file, so hints does not apply",
  "one-author": "no page lists a from or author actor, so one-author does not apply",
  "parts-stable": "no page carries a part, so parts-stable does not apply",
  routines: "the source declares no routine file, so routines does not apply",
}

describe("the source contract's conformance kit", () => {
  test("the declaration validates, as a consumer reads it from the installed package", () => {
    const installed = readInstalledDescriptor(ROOT, { version: pkg.version })
    expect(installed.ok ? [] : installed.problems).toEqual([])
    expect(declarationProblems(pkg.sources, { tools: declaredTools() })).toEqual([])
    const sources = declaredSources()
    expect(sources.rpc).toBe(TOOLS_RPC_ID)
    expect(pkg.name).toBe(PACKAGE)
    expect(sources.items.map((item) => [item.id, item.kind])).toEqual([
      [SOURCE_ID, "events"],
      ["elevenlabs.conversations.list", "snapshot"],
    ])
  })

  test("the descriptor and the reads agree: one account, default, which probe names and every page carries", async () => {
    const source = declaredSources().items[0]!
    expect(source.accounts).toEqual({ named: false })
    const probed = (await probe({})) as { account: string }
    expect(probed.account).toBe(ACCOUNT)
    expect(await list({ since: SINCE, limit: 1 })).toMatchObject({ account: ACCOUNT })
  })

  test(`${SOURCE_ID} keeps the contract, with every check that applies run`, async () => {
    const [report] = await conformanceReports()
    expect(report!.problems).toEqual([])
    expect(report!.incomplete).toBe(false)
    expect(report!.ok).toBe(true)
    // Not applicable: failed[] for its stated reason (any failure fails the whole read), and what the source never does
    // (a removal, a cost, details, scope suggestions, a snapshot). The v0.3 checks in ABSENT do not apply either; each
    // reason is non-empty, which is what the kit accepts for a stated skip. The gap checks run, on a cursor behind an
    // agent's retention horizon, and event-within-max-bytes runs because a page carries events.
    const skipped = Object.fromEntries(report!.checks.filter((check) => check.notApplicable).map((check) => [check.name, check.reason ?? null]))
    expect(skipped).toEqual({
      "actor-kind": null,
      "billed-cost": null,
      "commitment-key": null,
      details: null,
      facts: null,
      "failed-holds-cursor": ATOMIC,
      hints: null,
      "one-author": null,
      "output-schema": null,
      "parts-stable": null,
      "removals-are-final": null,
      routines: null,
      suggest: null,
    })
    for (const [name, reason] of Object.entries(ABSENT)) {
      expect(reason.trim()).not.toBe("")
      expect(report!.checks.find((check) => check.name === name)).toMatchObject({ ran: false, notApplicable: true, problems: [] })
    }
    expect(report!.checks.filter((check) => check.ran).map((check) => check.name).sort()).toEqual(
      ["declaration", "event-within-max-bytes", "gap-and-cursor-expired", "gap-once-per-read", "identity-grants", "page-result", "probe", "refused-is-final", "rpc-id", "unused-grants"].sort(),
    )
  })
})
