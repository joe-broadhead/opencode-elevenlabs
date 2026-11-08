// Every call example a user or the model copies, in the skills, the README and the scripting guide, uses only tools
// and parameters that ElevenLabs's live schemas have (test/unit/elevenlabs-catalog.ts), and passes each tool's required
// parameters. Every backticked snake_case name in the skills is a tool, a parameter or a result field ElevenLabs
// describes, so a renamed field can't linger in the teaching.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { SAVE_SCHEMA } from "../../src/media/tool.js"
import { LIVE } from "./elevenlabs-catalog.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const SKILLS = readdirSync(join(ROOT, "skills")).map((name) => `skills/${name}/SKILL.md`)
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

/** The keys of an object literal's text, at any depth: `key: value` and the shorthand `key`. */
const keysOf = (object: string) =>
  [...object.replace(/"[^"]*"(\s*:)?/g, (string, key: string | undefined) => (key ? string : '""')).matchAll(/(?<=[{,]\s*)"?([a-z_]+)"?(?=\s*[:,}])/g)].map((match) => match[1]!)

/** `tools.elevenlabs.<tool>({ … })` in Code Mode examples. */
function codeExamples(text: string) {
  return [...text.matchAll(/tools\.elevenlabs\.([a-z_]+)\((\{[^\n]*\})?\)/g)].map((match) => ({ tool: match[1]!, keys: keysOf(match[2] ?? "{}") }))
}

/** `opencode api post /api/rpc/elevenlabs.tools/<tool> -d '{"input":{"sessionID":…,"input":{…}}}'`. */
function scriptExamples(text: string) {
  return [...text.matchAll(/api\/rpc\/elevenlabs\.tools\/([a-z_]+)[^\n]*?-d '(\{.*?\})'/g)].map((match) => {
    const body = JSON.parse(match[2]!) as { input?: { input?: Record<string, unknown> } }
    return { tool: match[1]!, keys: Object.keys(body.input?.input ?? {}) }
  })
}

function check(examples: { tool: string; keys: string[] }[]) {
  // `describe` is the RPC's own method, not a tool: it takes a session or nothing.
  for (const { tool, keys } of examples.filter((example) => example.tool !== "describe")) {
    if (tool === "elevenlabs_save_media") {
      // The plugin's own method: its schema is its contract.
      const allowed = Object.keys(SAVE_SCHEMA.properties)
      expect({ tool, unknown: keys.filter((key) => !allowed.includes(key)) }).toEqual({ tool, unknown: [] })
      expect(keys).toContain("url")
      continue
    }
    const live = LIVE.get(tool)
    expect({ tool, known: live !== undefined }).toEqual({ tool, known: true })
    expect({ tool, unknown: keys.filter((key) => !live!.params.includes(key)) }).toEqual({ tool, unknown: [] })
    expect({ tool, missing: live!.required.filter((param) => !keys.includes(param)) }).toEqual({ tool, missing: [] })
  }
}

describe("call examples", () => {
  test.each(SKILLS)("%s calls only live tools, with live parameter names and every required one", (file) => {
    const examples = codeExamples(read(file))
    check(examples)
    if (file === "skills/elevenlabs/SKILL.md") expect(examples.length).toBeGreaterThan(0)
  })

  test.each(["README.md", "docs/scripting.md"])("%s's script examples call only live tools, with live parameter names", (file) => {
    const examples = scriptExamples(read(file))
    expect(examples.length).toBeGreaterThan(0)
    check(examples)
  })

  test.each(SKILLS)("%s names in backticks only tools, parameters and fields the plugin knows", (file) => {
    const known = new Set([...LIVE.keys(), ...[...LIVE.values()].flatMap((tool) => tool.params)])
    // The plugin's own tool, the fields its result carries, and the two argument shorthands the skills use.
    const others = new Set([
      "save_media", "elevenlabs_save_media", "duration_seconds", "sha256", "flow_id", "node_id", "session_ids",
      "connect_from", "voice_id", "model_id", "first_message", "agent_id", "conversation_id", "branch_id", "prompt",
      "estimate_only", "generations_count", "cost_fiat", "mediaRoot", "text_to_speech", "speech_history_read",
      "convai_read", "convai_write", "image_video_generation", "voice_generation", "all_completed", "has_failures",
      "eleven_multilingual_v2", "eleven_v3", "gemini-2.5-flash-image", "gpt-image-2", "flux-2-pro", "main",
    ])
    const named = [...read(file).matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]!)
    expect(named.filter((name) => !known.has(name) && !others.has(name))).toEqual([])
  })

  test("the parser finds keys at any depth and in shorthand", () => {
    expect(keysOf('{ agent_id, prompt: { text: next }, voice_id: "a, b: c" }')).toEqual(["agent_id", "prompt", "text", "voice_id"])
  })
})
