// The docs state what the code does: the tool names, the blocks, the codes and the tested hosts. They must match
// src/elevenlabs-tools.ts, src/permissions.ts and src/constants.ts, so a change cannot leave a stale sentence behind.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PLUGIN_CODES, TESTED_HOSTS } from "../../src/constants.js"
import { ALL_TOOLS, CONVERSATION_TOOLS, OWN_TOOLS, READ_TOOLS, SPEND_TOOLS, TRANSCRIPT_TOOLS } from "../../src/elevenlabs-tools.js"
import { defaultRules } from "../../src/permissions.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const DOCS = readdirSync(join(ROOT, "docs")).map((name) => `docs/${name}`)
const SKILLS = readdirSync(join(ROOT, "skills")).map((name) => `skills/${name}/SKILL.md`)
// Everything a user or the model reads about the current release.
const FILES = ["README.md", "SECURITY.md", "CONTRIBUTING.md", ...DOCS, ...SKILLS]
const text = (file: string) => readFileSync(join(ROOT, file), "utf8")

/** Every TypeScript file under src/, media helpers and the tools RPC included. */
function sources(directory = "src", out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) sources(path, out)
    else if (entry.name.endsWith(".ts")) out.push(path)
  }
  return out
}
const flat = (file: string) => text(file).replace(/\s+/g, " ")

describe("docs", () => {
  test.each(FILES)("%s names only ElevenLabs tools the plugin knows", (file) => {
    const named = [...flat(file).matchAll(/\belevenlabs_([a-z][a-z_]*)(?![\w*])/g)].map((match) => match[1]!)
    // `elevenlabs_save_media` is the plugin's own tool; everything else is ElevenLabs'.
    expect(named.filter((tool) => ![...ALL_TOOLS, ...OWN_TOOLS].includes(tool))).toEqual([])
  })

  // S5: version numbers live in package.json and the CHANGELOG heading only, and nothing says the package is unreleased.
  test.each(["README.md", "CONTRIBUTING.md", ...DOCS, ...SKILLS])("%s names no version of the plugin and no pre-release state", (file) => {
    expect(flat(file)).not.toMatch(/opencode-elevenlabs@\d|\bv?\d+\.\d+\.\d+-|\bv?0\.0\.\d\b|not (yet )?published|"private"/i)
  })

  test("only the README's Known limits calls the tool table provisional, and nothing else does", () => {
    const readme = flat("README.md")
    expect([...readme.matchAll(/provisional/gi)]).toHaveLength(1)
    for (const file of ["SECURITY.md", "CONTRIBUTING.md", ...DOCS, ...SKILLS]) expect({ file, hits: (flat(file).match(/provisional/gi) ?? []).length }).toEqual({ file, hits: 0 })
  })

  // Once the plugin is removed and OpenCode reloads, `mcp logout elevenlabs` finds no server: the README signs out first,
  // checks, then removes the plugin.
  test("the README's Uninstall signs out and checks before it removes the plugin", () => {
    const uninstall = /## Uninstall(.*?)## Links/.exec(flat("README.md"))?.[1] ?? ""
    const logout = uninstall.indexOf("opencode mcp logout elevenlabs")
    const check = uninstall.indexOf("opencode auth list")
    const remove = uninstall.indexOf("opencode plugin remove @joe-broadhead/opencode-elevenlabs")
    expect(logout).toBeGreaterThanOrEqual(0)
    expect(check).toBeGreaterThan(logout)
    expect(remove).toBeGreaterThan(check)
  })

  test("the README's Permissions section opens with the R18 sentence and gives the three ways to restrict", () => {
    const section = /## Permissions([\s\S]*?)## Configure/.exec(text("README.md"))?.[1] ?? ""
    expect(section.trimStart().startsWith("**Every tool is allowed by default.**")).toBe(true)
    for (const way of ["The `access` option", "An agent that is read-only or asks", "A rule per tool"]) expect(section).toContain(way)
    for (const value of ["all", "ask-changes", "read-only"]) expect(section).toContain(`\`"${value}"\``)
  })

  test("the configuration guide documents every error code the plugin raises, and nothing else in that table", () => {
    const errors = /## Errors([\s\S]*?)## Doctor/.exec(text("docs/configuration.md"))?.[1] ?? ""
    const documented = [...errors.matchAll(/\| `([A-Z][A-Z_]+)` \|/g)].map((match) => match[1]!).sort()
    expect(documented).toEqual([...PLUGIN_CODES].sort())
    // Every code in the table is raised somewhere in src, not just declared in constants.
    for (const code of PLUGIN_CODES) {
      const raised = sources().some((file) => file !== "src/constants.ts" && text(file).includes(`"${code}"`))
      expect({ code, raised }).toEqual({ code, raised: true })
    }
  })

  test("the README's Troubleshooting table lists every code the plugin raises", () => {
    const table = /## Troubleshooting([\s\S]*?)## Known limits/.exec(text("README.md"))?.[1] ?? ""
    const documented = [...table.matchAll(/\| `([A-Z][A-Z_]+)` \|/g)].map((match) => match[1]!).sort()
    expect(documented).toEqual([...PLUGIN_CODES].sort())
  })

  test("the README explains the Skills row that names a replacing skill, and its fix", () => {
    expect(flat("README.md")).toMatch(/Skills.*is replaced by.*Rename or move/)
  })

  test("the Jelly guide states the declared tool counts", () => {
    const tools = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { jelly: { tools: { readOnly: boolean }[] } }).jelly.tools
    const declared = `${tools.length} tools are declared (${tools.filter((tool) => tool.readOnly).length} read-only)`
    expect(flat("docs/jelly.md")).toContain(declared)
    expect(flat("docs/jelly.md")).toContain("A tool ElevenLabs adds later is not asked about in Jelly")
  })

  // An admin copies these blocks into managed config: each must be the plugin's real block for that access value.
  test("the configuration guide prints the default rules in full for every access value, and in the agent fix example", () => {
    const raw = text("docs/configuration.md")
    for (const access of ["all", "ask-changes", "read-only"] as const) {
      const block = new RegExp(`\`access: "${access}"\`[\\s\\S]*?\\n\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``).exec(raw)?.[1] ?? "[]"
      expect({ access, block: JSON.parse(block) }).toEqual({ access, block: defaultRules(access) })
    }
    const example = /For an agent `reviewer`[\s\S]*?```json\n([\s\S]*?)\n```/.exec(raw)?.[1] ?? "{}"
    const permissions = (JSON.parse(example) as { agents: { reviewer: { permissions: unknown[] } } }).agents.reviewer.permissions
    expect(permissions[0]).toEqual({ action: "elevenlabs_*", resource: "*", effect: "ask" })
    // The rest are reads: the block an admin pastes into their own agent, narrowed to the two it needs.
    for (const rule of permissions.slice(1)) expect(READ_TOOLS).toContain((rule as { action: string }).action.replace("elevenlabs_", ""))
  })

  test("the configuration guide prints the conversation denies for summary and off, by exact name", () => {
    const raw = text("docs/configuration.md")
    const summary = /`conversations: "summary"` appends:[\s\S]*?```json\n([\s\S]*?)\n```/.exec(raw)?.[1] ?? "[]"
    const off = /`conversations: "off"` appends:[\s\S]*?```json\n([\s\S]*?)\n```/.exec(raw)?.[1] ?? "[]"
    expect((JSON.parse(summary) as { action: string }[]).map((rule) => rule.action).sort()).toEqual(TRANSCRIPT_TOOLS.map((tool) => `elevenlabs_${tool}`).sort())
    expect((JSON.parse(off) as { action: string }[]).map((rule) => rule.action).sort()).toEqual(CONVERSATION_TOOLS.map((tool) => `elevenlabs_${tool}`).sort())
  })

  // R19: the export root needs the tool's own rule and the host's external_directory rule.
  test("the README and the configuration guide give both rules for the media folder", () => {
    for (const file of ["README.md", "docs/configuration.md"]) {
      expect(flat(file)).toContain("external_directory")
      expect(flat(file)).toContain("~/Downloads/elevenlabs/*")
    }
  })

  test("the configuration guide gives the status rows and the states", () => {
    for (const row of ["Connection", "Account", "Access", "Region", "Spend", "Conversations", "Tools", "Agents without default rules", "OpenCode", "Next step"]) {
      expect(flat("docs/configuration.md")).toContain(row)
    }
    for (const state of ["connected", "sign-in required", "connecting", "disabled", "failed", "not configured", "conflict"]) expect(flat("docs/configuration.md")).toContain(state)
  })

  test("the scripting guide lists every known tool as a method, and the save tool", () => {
    const guide = flat("docs/scripting.md")
    for (const name of ALL_TOOLS) expect(guide).toContain(`\`${name}\``)
    for (const name of OWN_TOOLS) expect(guide).toContain(`\`elevenlabs_${name}\``)
    expect(guide).toContain("`describe`")
    expect(guide).toContain("x-opencode-directory")
    expect(guide).toContain("estimate_only")
  })

  test("the README says how much the caps allow, that they bound this plugin, and that no dollar figure comes from credits", () => {
    const readme = flat("README.md")
    expect(readme).toContain("2,000 credits")
    expect(readme).toContain("10,000")
    expect(readme).toContain("The caps bound this plugin, not your account")
    expect(readme).toContain("No dollar figure is derived from credits")
  })

  test("the README names every billed tool in its spending section", () => {
    const section = /## Spending([\s\S]*?)## Media and files/.exec(text("README.md"))?.[1] ?? ""
    expect(section).toContain("estimate_only")
    for (const tool of SPEND_TOOLS) expect(flat("docs/configuration.md")).toContain(`elevenlabs_${tool}`)
  })
})

// The README prints the block the plugin inserts, in full, generated from defaultRules(): it is what an administrator
// copies into an agent's own permissions, so it cannot be elided or drift.
describe("the default rules block", () => {
  test("the README's Permissions section prints defaultRules() in full", () => {
    const section = /## Permissions([\s\S]*?)## Configure/.exec(readFileSync(join(ROOT, "README.md"), "utf8"))?.[1] ?? ""
    const printed = /generated from[\s\S]*?```json\n([\s\S]*?)\n```/.exec(section)?.[1] ?? "[]"
    expect(JSON.parse(printed)).toEqual(defaultRules())
  })
})

// Every "tested on …" mention states TESTED_HOSTS, so a release added to the list cannot leave a stale sentence behind.
describe("tested hosts", () => {
  const UNRELEASED = /## \[0\.0\.0\] - Unreleased([\s\S]*?)(?=\n## |$)/.exec(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"))?.[1] ?? ""
  const SOURCES: [string, string][] = [
    ["README.md", readFileSync(join(ROOT, "README.md"), "utf8")],
    ["AGENTS.md", readFileSync(join(ROOT, "AGENTS.md"), "utf8")],
    ["SECURITY.md", readFileSync(join(ROOT, "SECURITY.md"), "utf8")],
    ["docs/configuration.md", readFileSync(join(ROOT, "docs/configuration.md"), "utf8")],
    ["docs/architecture.md", readFileSync(join(ROOT, "docs/architecture.md"), "utf8")],
    ["CHANGELOG.md (Unreleased)", UNRELEASED],
  ]

  test.each(SOURCES)("%s names exactly TESTED_HOSTS wherever it says what is tested", (file, body) => {
    const mentions = body
      .split("\n")
      .flatMap((line) => line.split(/\.\s+/))
      .filter((sentence) => /\btested\b/i.test(sentence))
      // The supported range is not a tested release: drop a backticked `>=a.b.c <d.e.f` span before reading versions.
      .map((sentence) => sentence.replace(/`[^`]*>=[^`]*`/g, "").replace(/`[^`]*(?:2\.2\.3, 2\.2\.4[^`]*)`/g, (span) => span.slice(1, -1)))
      .map((sentence) => [...sentence.matchAll(/\b\d+\.\d+\.\d+\b/g)].map((version) => version[0]!))
      .filter((versions) => versions.length > 0)
    for (const versions of mentions) expect({ file, versions: [...new Set(versions)].sort() }).toEqual({ file, versions: [...TESTED_HOSTS].sort() })
  })

  test("the README's Requirements line names every tested release", () => {
    const requirements = /## Requirements([\s\S]*?)## /i.exec(readFileSync(join(ROOT, "README.md"), "utf8"))?.[1] ?? ""
    const named = [...requirements.matchAll(/\b\d+\.\d+\.\d+\b/g)].map((match) => match[0]).filter((version) => version !== "2.3.0")
    expect([...new Set(named)].sort()).toEqual([...TESTED_HOSTS].sort())
  })

  // A release inside the range that ships later is the untested example, so it must be one that never ships.
  test("the untested example is 2.2.99 or absent, and no doc names a future release as tested", () => {
    const all = SOURCES.map(([, body]) => body).join("\n")
    expect(all).not.toMatch(/\b2\.2\.(?:7|8|9[0-8])\b(?!\d)/)
    expect(readFileSync(join(ROOT, "test/unit/host-version.test.ts"), "utf8")).toContain("2.2.99")
  })
})

describe("README order", () => {
  test("follows S5's section order", () => {
    const headings = [...readFileSync(join(ROOT, "README.md"), "utf8").matchAll(/^## (.+)$/gm)].map((match) => match[1]!)
    expect(headings).toEqual(["Requirements", "Install", "Sign in", "Use", "Spending", "Media and files", "Regions", "Permissions", "Configure", "Organisation rollout", "Troubleshooting", "Known limits", "Uninstall", "Links"])
    // The affiliation sentence is the first line after the opening paragraph.
    const lines = readFileSync(join(ROOT, "README.md"), "utf8").split("\n")
    const affiliation = lines.findIndex((line) => line.startsWith("Unofficial;"))
    expect(lines[affiliation]).toBe("Unofficial; not affiliated with ElevenLabs.")
    expect(lines.slice(0, affiliation).filter((line) => line.trim() !== "").length).toBeLessThanOrEqual(3)
  })

  test("the read tools are all named in the README's block, so a user can write a rule for any of them", () => {
    const block = /generated from[\s\S]*?```json\n([\s\S]*?)\n```/.exec(readFileSync(join(ROOT, "README.md"), "utf8"))?.[1] ?? "[]"
    const actions = (JSON.parse(block) as { action: string }[]).map((rule) => rule.action)
    for (const tool of READ_TOOLS) expect(actions).toContain(`elevenlabs_${tool}`)
  })
})
