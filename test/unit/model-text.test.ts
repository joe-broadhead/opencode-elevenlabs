// R18: what the model reads says what the default does. Every tool is allowed under `access: "all"`, so no text the
// model sees may say a tool asks first, is read-only, needs an option turned on, or is off until it is classified.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"
import { NAMESPACE_DESCRIPTION } from "../../src/constants.js"
import { SPEND_TOOLS } from "../../src/elevenlabs-tools.js"
import { saveDescription } from "../../src/media/tool.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

/** A claim that is false under the default block: a tool cannot ask, be refused or be off, because every tool allows. */
const STALE: [string, RegExp][] = [
  // Case-sensitive "asks": the imperative "Ask the user before …" is guidance to the model, not a claim about a rule.
  ["says a tool asks first", /\basks (?:the user )?(?:first|before)\b/],
  ["needs an option turned on", /\bneeds? (?:the (?:plugin )?)?option\b/i],
  ["is off until classified", /\b(?:off|asks?) until (?:it is |they are )?classif/i],
  ["says it is read-only now", /\bread-only now\b/i],
  ["is refused while read-only", /\brefused while (?:the plugin is )?read-only\b/i],
  ["says no tool changes anything", /\bno tool (?:here )?changes\b/i],
]

/** A sentence that names a restricting value describes that value, not the default, so it is not a claim about `all`. */
const atAll = (text: string) =>
  text
    .split(/(?<=[.:])\s+/)
    .filter((sentence) => !/["`'](?:ask-changes|read-only)["`']/.test(sentence))
    .join(" ")

describe("the model-facing text at access all", () => {
  const all = {
    "the Code Mode namespace": NAMESPACE_DESCRIPTION,
    "the Jelly summary": (JSON.parse(read("package.json")) as { jelly?: { summary?: string } }).jelly?.summary ?? "",
    // The plugin's own tool description, which the model reads before it saves a file.
    "the save tool's description": saveDescription("~/Downloads/elevenlabs"),
    ...Object.fromEntries(readdirSync(join(ROOT, "skills")).map((name) => [`skills/${name}/SKILL.md`, read(`skills/${name}/SKILL.md`)] as const)),
  }

  test.each(Object.entries(all))("%s claims nothing the default block contradicts", (_file, text) => {
    for (const [claim, pattern] of STALE) expect({ claim, hit: pattern.exec(atAll(text))?.[0] ?? null }).toEqual({ claim, hit: null })
  })

  // DR-2 and DR-3: the money the model is told about is the money the code charges.
  test("the namespace text names every billed tool the table has, so the model is not misled", () => {
    // The namespace text is prose: it must not promise a cost line for a product the table does not price, and must say
    // that a billed read exists.
    expect(NAMESPACE_DESCRIPTION).toContain("each paid call prints its cost")
    expect(NAMESPACE_DESCRIPTION).toContain("Speech to text is billed per minute")
    expect(SPEND_TOOLS.length).toBeGreaterThanOrEqual(6)
    for (const tool of SPEND_TOOLS) expect({ tool, named: NAMESPACE_DESCRIPTION.toLowerCase().includes(tool.split("_")[1]!.toLowerCase()) }).toEqual({ tool, named: true })
  })

  test("no status sentence claims a tool is off or asks under the default", () => {
    // The status strings are built per state; under `access: "all"` none may say a tool asks.
    const status = read("src/status.ts")
    expect(status).not.toMatch(/asks (?:the user )?(?:first|before)/)
    expect(status).toContain("every tool runs without asking")
  })

  test("says that the transcript reads run under the default, and that the option is what stops them", () => {
    const calls = read("skills/elevenlabs-calls/SKILL.md")
    expect(calls).toContain("The plugin can deny these reads")
    expect(calls).toContain('conversations: "summary"')
    expect(calls).not.toMatch(/asks? (?:the user )?(?:first|before)/i)
  })
})
