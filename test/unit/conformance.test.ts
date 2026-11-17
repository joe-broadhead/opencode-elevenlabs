// The source contract's conformance kit over the declared source (test/support/conformance.ts), held to ok: the report
// `npm run conformance` writes for a release is the same one.
import { describe, expect, test } from "bun:test"
import { declarationProblems } from "@we-the-rebel-alliance/source-contract/conformance"
import { readInstalledDescriptor } from "@we-the-rebel-alliance/source-contract/descriptor"
import { ACCOUNT, PACKAGE, SOURCE_ID } from "../../src/events.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { ATOMIC, NO_EXPIRY, ROOT, conformanceReports, declaredSources, declaredTools, list, pkg, probe } from "../support/conformance.js"
import { SINCE } from "../support/synthetic-conversations.js"

describe("the source contract's conformance kit", () => {
  test("the declaration validates, as a consumer reads it from the installed package", () => {
    const installed = readInstalledDescriptor(ROOT, { version: pkg.version })
    expect(installed.ok ? [] : installed.problems).toEqual([])
    expect(declarationProblems(pkg.sources, { tools: declaredTools() })).toEqual([])
    const sources = declaredSources()
    expect(sources.rpc).toBe(TOOLS_RPC_ID)
    expect(pkg.name).toBe(PACKAGE)
    expect(sources.items.map((item) => [item.id, item.kind])).toEqual([[SOURCE_ID, "events"]])
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
    // Not applicable, each for its stated reason: one list call per page, a cursor of the plugin's own, and nothing
    // the source never does (a gap, a removal, a cost, details, scope suggestions, a snapshot).
    const skipped = Object.fromEntries(report!.checks.filter((check) => check.notApplicable).map((check) => [check.name, check.reason ?? null]))
    expect(skipped).toEqual({
      "failed-holds-cursor": ATOMIC,
      "gap-and-cursor-expired": NO_EXPIRY,
      "gap-once-per-read": null,
      "removals-are-final": null,
      "billed-cost": null,
      details: null,
      suggest: null,
      "output-schema": null,
    })
    expect(report!.checks.filter((check) => check.ran).map((check) => check.name).sort()).toEqual(
      ["declaration", "identity-grants", "page-result", "probe", "refused-is-final", "rpc-id", "unused-grants"].sort(),
    )
  })
})
