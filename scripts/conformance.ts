// The conformance stage of `npm run check`, and `npm run conformance`: source-contract's kit over this plugin's own reads
// and the offline fixture (test/support/conformance.ts), with its report written to reports/conformance-report.json for
// the release to attach beside SHA256SUMS. Fails when any source's report is not ok. The report holds no time or path,
// so every run writes the same bytes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, conformanceReports, pkg } from "../test/support/conformance.js"

const contract = JSON.parse(readFileSync(join(ROOT, "node_modules", "@we-the-rebel-alliance", "source-contract", "package.json"), "utf8")) as { version: string }
const reports = await conformanceReports()
const ok = reports.every((report) => report.ok)
mkdirSync(join(ROOT, "reports"), { recursive: true })
writeFileSync(
  join(ROOT, "reports", "conformance-report.json"),
  `${JSON.stringify({ plugin: pkg.name, version: pkg.version, contract: `source-contract ${contract.version}`, fixture: "test/support/synthetic-conversations.ts", ok, reports }, null, 2)}\n`,
)
for (const report of reports) {
  const ran = report.checks.filter((check) => check.ran).length
  const skipped = report.checks.filter((check) => check.notApplicable).map((check) => check.name)
  console.log(`${report.ok ? "ok" : "NOT OK"}: ${report.source}: ${ran} checks ran${skipped.length > 0 ? `; not applicable: ${skipped.join(", ")}` : ""}`)
  for (const problem of report.problems) console.error(`  - ${problem}`)
  if (report.incomplete) console.error(`  incomplete: ${report.checks.filter((check) => !check.ran && !check.notApplicable).map((check) => check.name).join(", ")}`)
}
console.log("wrote reports/conformance-report.json")
process.exit(ok ? 0 : 1)
