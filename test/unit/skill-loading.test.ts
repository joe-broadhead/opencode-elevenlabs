import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSkills, parseSkill, registerSkills, SKILL_NAMES, SKILLS_DIR } from "../../src/skills.js"

const root = mkdtempSync(join(tmpdir(), "elevenlabs-skill-loading-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function skills(files: Record<string, string>) {
  const directory = mkdtempSync(join(root, "skills-"))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(directory, name))
    writeFileSync(join(directory, name, "SKILL.md"), text)
  }
  return directory
}

describe("skill loading", () => {
  test("elevenlabs, elevenlabs-creative and elevenlabs-calls, from the package's skills folder", () => {
    expect([...SKILL_NAMES]).toEqual(["elevenlabs", "elevenlabs-creative", "elevenlabs-calls"])
    expect(SKILLS_DIR.replaceAll("\\", "/").endsWith("/skills/")).toBe(true)
  })

  test("parses LF and CRLF frontmatter into a skill", () => {
    for (const newline of ["\n", "\r\n"]) {
      const text = ["---", "name: elevenlabs", 'description: "Use ElevenLabs: find, read and cite meetings."', "---", "", "# ElevenLabs", "Body."].join(newline)
      expect(parseSkill("elevenlabs", "/pkg/skills/elevenlabs/SKILL.md", text)).toEqual({
        id: "elevenlabs",
        name: "elevenlabs",
        description: "Use ElevenLabs: find, read and cite meetings.",
        path: "/pkg/skills/elevenlabs/SKILL.md",
        content: "# ElevenLabs\nBody.",
      } as never)
    }
  })

  test.each([
    ["no frontmatter", "# ElevenLabs", "skills/elevenlabs/SKILL.md has no frontmatter"],
    ["the wrong name", "---\nname: other\ndescription: d\n---\n", 'skills/elevenlabs/SKILL.md must be named "elevenlabs" in its frontmatter'],
    ["no description", "---\nname: elevenlabs\n---\n", "skills/elevenlabs/SKILL.md has no description"],
  ])("rejects a skill with %s", (_, text, message) => {
    expect(() => parseSkill("elevenlabs", "/x", text)).toThrow(message)
  })

  test("loads all three skills", async () => {
    const ok = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`
    const directory = skills({ elevenlabs: ok("elevenlabs"), "elevenlabs-creative": ok("elevenlabs-creative"), "elevenlabs-calls": ok("elevenlabs-calls") })
    const loaded = await loadSkills(directory)
    expect(loaded.skills.map((skill): string => skill.id)).toEqual(["elevenlabs", "elevenlabs-creative", "elevenlabs-calls"])
    expect(loaded.skills.map((skill): string => skill.path)).toEqual(SKILL_NAMES.map((name) => join(directory, name, "SKILL.md")))
    expect(loaded.problems).toEqual([])
  })

  test("a missing or broken skill becomes a problem for status, not a setup failure", async () => {
    const directory = skills({ elevenlabs: "---\nname: elevenlabs\n---\n" })
    expect(await loadSkills(directory)).toEqual({
      skills: [],
      problems: [
        'SKILLS_INVALID: The "elevenlabs" skill was not loaded: skills/elevenlabs/SKILL.md has no description. Next step: Reinstall the plugin.',
        'SKILLS_INVALID: The "elevenlabs-creative" skill was not loaded: skills/elevenlabs-creative/SKILL.md is missing. Next step: Reinstall the plugin.',
        'SKILLS_INVALID: The "elevenlabs-calls" skill was not loaded: skills/elevenlabs-calls/SKILL.md is missing. Next step: Reinstall the plugin.',
      ],
    })
  })

  test("an unreadable skill file is reported as unreadable, not missing", async () => {
    const directory = skills({ "elevenlabs-creative": "---\nname: elevenlabs-creative\ndescription: d\n---\n" })
    mkdirSync(join(directory, "elevenlabs", "SKILL.md"), { recursive: true })
    const problems = (await loadSkills(directory)).problems
    expect(problems[0]).toBe('SKILLS_INVALID: The "elevenlabs" skill was not loaded: skills/elevenlabs/SKILL.md cannot be read (EISDIR). Next step: Reinstall the plugin.')
    // elevenlabs is unreadable, elevenlabs-calls is missing; elevenlabs-creative loaded.\n    expect(problems).toHaveLength(2)
  })

  test("registers every loaded skill", async () => {
    const added: string[] = []
    await registerSkills(
      { transform: async (callback) => (callback({ add: (skill: { id: string }) => void added.push(skill.id) } as never), { dispose: async () => {} }) },
      [parseSkill("elevenlabs", "/x", "---\nname: elevenlabs\ndescription: d\n---\n")],
    )
    expect(added).toEqual(["elevenlabs"])
  })
})
