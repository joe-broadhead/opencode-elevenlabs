// The shipped skills: exactly three, loadable by the plugin, short, free of internal jargon, and naming only tools the
// plugin knows. Their text is what the model reads, so it must say what the default permission block actually does.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseSkill, SKILL_NAMES, SKILLS_DIR } from "../../src/skills.js"
import { ALL_TOOLS, OWN_TOOLS, SPEND_TOOLS } from "../../src/elevenlabs-tools.js"

const NAMES = [...SKILL_NAMES]
const MAX_LINES = 100
// Words from the plugin's own process that mean nothing to the model or the user.
const JARGON = /manifest|attest|quarantin|evidence|acceptance|harness|fixture|\bfork\b|dispatch|lease|catalog|allowlist|reviewed|capabilit|provisional|\bWS-[A-Z0-9]|PLAN\.md|drift|\bTODO\b/i
const KNOWN = new Set([...ALL_TOOLS, ...OWN_TOOLS])
// An ElevenLabs tool name written bare, as the skills do after dropping the prefix.
const TOOL_SHAPED = /`((?:agents|creative)_[a-z_]+)`/g

const read = (name: string) => readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8")

describe("skills", () => {
  test("exactly the plugin's skills, each a single SKILL.md", () => {
    expect(readdirSync(SKILLS_DIR).sort()).toEqual([...NAMES].sort())
    for (const name of NAMES) expect(readdirSync(join(SKILLS_DIR, name))).toEqual(["SKILL.md"])
  })

  test.each(NAMES)("%s loads, is named after its folder and has a one-line description", (name) => {
    const text = read(name)
    const skill = parseSkill(name, join(SKILLS_DIR, name, "SKILL.md"), text)
    expect(skill.name as string).toBe(name)
    expect(skill.description?.length).toBeGreaterThan(80)
    expect(text.split("\n").filter((line) => line.startsWith("description:"))).toHaveLength(1)
    expect(skill.content.length).toBeGreaterThan(0)
  })

  test.each(NAMES)("%s is under the line limit and free of internal jargon", (name) => {
    const text = read(name)
    expect(text.split("\n").length).toBeLessThan(MAX_LINES)
    expect(text.match(JARGON)?.[0]).toBeUndefined()
  })

  test.each(NAMES)("%s names only ElevenLabs tools and the plugin's own tool", (name) => {
    const named = [...read(name).matchAll(TOOL_SHAPED)].map((match) => match[1]!)
    expect(named.filter((tool) => !KNOWN.has(tool))).toEqual([])
  })

  test.each(NAMES)("%s routes to its neighbours by name", (name) => {
    // Each description ends with a "Not for ..." clause so the trigger test can tell the family apart.
    const description = parseSkill(name, "/x", read(name)).description ?? ""
    expect(description).toContain("Not for")
    expect(description).toMatch(/Granola|Wispr Flow|Plaud/)
  })

  test("the agents skill covers reading first, live updates, branches and deletes", () => {
    const text = read("elevenlabs")
    for (const rule of ["agents_list", "agents_get", "publishes to the live branch immediately", "agents_merge_branch_preview", "agents_duplicate", "cannot be undone", "context"]) {
      expect(text.replace(/\s+/g, " ")).toContain(rule)
    }
  })

  test("the creative skill prices before spending, clamps the variations, and never retries", () => {
    const text = read("elevenlabs-creative")
    for (const rule of ["estimate_only", "generations_count", "Never call a generating tool twice", "creative_get_flow_run_status", "elevenlabs_save_media", "two hours", "Credits: at most"]) {
      expect(text).toContain(rule)
    }
    // Every billed tool is named, so the skill covers what spends.
    for (const tool of SPEND_TOOLS) expect(text).toContain(tool)
  })

  test("the calls skill treats transcripts as personal data and names the option that stops them", () => {
    const text = read("elevenlabs-calls")
    for (const rule of ["Summarise; do not dump", "Never copy a caller's name", "conversations: \"summary\"", "agents_get_conversation", "cost_fiat", "Never send transcript text to a web search"]) {
      expect(text).toContain(rule)
    }
    expect(text).not.toMatch(/redact/i)
  })

  test("no skill promises a tool that asks, is read-only, or is off by default", () => {
    for (const name of NAMES) {
      const text = read(name)
      expect(text).not.toMatch(/\basks? (?:the user )?(?:first|before)\b/i)
      expect(text).not.toMatch(/read-only now|needs? (?:the (?:plugin )?)?option|off until classif/i)
    }
  })
})
