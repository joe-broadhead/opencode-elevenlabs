// One typed code table, and two docs that must match it exactly. A code that is thrown or returned anywhere must be in
// the table, and the README's and the scripting doc's tables must not drift in either direction.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PLUGIN_CODES, RPC_CODES } from "../../src/constants.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(path, out)
    else if (entry.name.endsWith(".ts")) out.push(path)
  }
  return out
}

/** Every SCREAMING_SNAKE code literal in src, wherever it is raised or described, or one that starts a message as `CODE: what happened`. */
const raised = new Set(
  walk("src").flatMap((file) => [
    ...[...read(file).matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)"/g)].map((match) => match[1]!),
    ...[...read(file).matchAll(/["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+): /g)].map((match) => match[1]!),
  ]),
)

/** The codes in the first cell of a Markdown table row that starts with one, or a row that names several. */
function tableCodes(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|")[1]?.trim() ?? "")
    .filter((cell) => cell.startsWith("`"))
    .flatMap((cell) => [...cell.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)`/g)].map((code) => code[1]!))
}

const TROUBLESHOOTING = /## Troubleshooting([\s\S]*?)## Uninstall/.exec(read("README.md"))?.[1] ?? ""
const SCRIPTING = read("docs/scripting.md")

describe("codes", () => {
  test("every code raised in src is in one of the two tables", () => {
    // ACCOUNT_UNKNOWN comes from the shared tools RPC and only exists for per-account servers; this plugin has none.
    const known = new Set<string>([...PLUGIN_CODES, ...RPC_CODES, "ACCOUNT_UNKNOWN"])
    // Not plugin codes: HTTP methods, JSON Schema and platform names a description quotes, and Node's errno codes.
    const plain = new Set([
      "GET", "HEAD", "PUT", "PATCH", "DELETE", "POST", "UTC", "JSON", "MCP", "UUID",
      "ENOENT", "EACCES", "EEXIST", "ENOTDIR", "EISDIR", "EPERM", "ENOSPC", "EMFILE",
      // RIFF/WAVE: the container signatures the duration reader compares, not codes.
      "RIFF", "WAVE", "FAIL",
    ])
    expect([...raised].filter((code) => !known.has(code) && !plain.has(code))).toEqual([])
  })

  test("the README's Troubleshooting table lists exactly the plugin's codes", () => {
    expect(tableCodes(TROUBLESHOOTING).sort()).toEqual([...PLUGIN_CODES].sort())
  })

  test("docs/scripting.md lists exactly the tools RPC's codes, plus the plugin's two refusals", () => {
    // R1's refusal table: the shared codes, then the plugin's own codes for a refused billed call.
    expect(tableCodes(SCRIPTING).sort()).toEqual([...RPC_CODES, "PRICE_UNKNOWN", "SPEND_CAP_REACHED"].sort())
  })
})
