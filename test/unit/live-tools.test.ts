// The Jelly declaration against the committed live capture, test/fixtures/live-tools.json: Jelly enforces what
// package.json declares without loading the plugin, so every tool ElevenLabs serves is declared with ElevenLabs' own
// readOnly, and every declared tool is served. test/fixtures/tool-registry.json holds the plugin's own tool and the one
// reasoned exception, in the shape the family's shared drift check reads, so that check can replace this file.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ALL_TOOLS, OWN_TOOLS, READ_ONLY_OVERRIDES, REACH_TOOLS, READ_TOOLS, SPEND_ANY, mustPrice } from "../../src/elevenlabs-tools.js"
import { defaultRules, evaluate } from "../../src/permissions.js"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"))

interface CapturedTool {
  readonly name: string
  readonly readOnlyHint: boolean | null
  readonly inputSchema: { readonly properties?: Record<string, unknown> }
}
interface DeclaredTool {
  readonly name: string
  readonly permission: string
  readonly effect: string
  readonly readOnly: boolean
  readonly note?: string
}
interface Registry {
  readonly own?: readonly string[]
  readonly tools?: Record<string, { readonly availability?: string; readonly reason?: string; readonly readOnlyOverride?: { readonly value: boolean; readonly reason: string } }>
}

const capture = read("test/fixtures/live-tools.json") as { schema: string; evidence: string; listedAt: string; server: string; count: number; tools: CapturedTool[] }
const provenance = read("test/fixtures/provenance.json") as { live: { fixture: string; listedAt: string }; captures: { fixture: string; count: number; listedAt: string; evidence: string }[] }
const registry = read("test/fixtures/tool-registry.json") as Registry
const declared = (read("package.json") as { jelly: { tools: DeclaredTool[] } }).jelly.tools
const permissionOf = (tool: string) => `elevenlabs_${tool}`
const byPermission = new Map(declared.map((tool) => [tool.permission, tool]))
const served = new Map(capture.tools.map((tool) => [tool.name, tool]))
const own = new Set(registry.own ?? [])

describe("the committed capture", () => {
  test("is a live tools/list of the elevenlabs server, with a readOnlyHint on every tool, and its provenance agrees", () => {
    expect(capture.schema).toBe("opencode-family/live-tools@1")
    expect(capture.evidence).toBe("live-observed")
    expect(capture.server).toBe("elevenlabs")
    expect(capture.count).toBe(capture.tools.length)
    expect(capture.tools.filter((tool) => typeof tool.readOnlyHint !== "boolean").map((tool) => tool.name)).toEqual([])
    const entry = provenance.captures.find((item) => item.fixture === "live-tools.json")
    expect(entry).toMatchObject({ count: capture.count, listedAt: capture.listedAt, evidence: "live-observed" })
    expect(provenance.live).toEqual({ fixture: "live-tools.json", listedAt: capture.listedAt })
  })

  test("names exactly the tools the table classifies, and the registry's own tool is the plugin's", () => {
    expect([...served.keys()].sort()).toEqual([...ALL_TOOLS].sort())
    expect([...own].sort()).toEqual([...OWN_TOOLS].sort())
  })
})

describe("the declaration against the capture", () => {
  test("declares every served tool", () => {
    expect([...served.keys()].filter((name) => !byPermission.has(permissionOf(name)))).toEqual([])
  })

  test("declares nothing the server does not serve, apart from the plugin's own tool", () => {
    // No tool is plan- or scope-gated here, so no declared tool may be missing from the capture.
    const unserved = declared.filter((tool) => !served.has(tool.permission.replace(/^elevenlabs_/, "")) && !own.has(tool.permission.replace(/^elevenlabs_/, "")))
    expect(unserved.map((tool) => tool.permission)).toEqual([])
    expect(Object.values(registry.tools ?? {}).filter((entry) => entry.availability !== undefined)).toEqual([])
  })

  test("declares each tool's readOnly as ElevenLabs marks it, unless the registry gives a reason to be stricter", () => {
    const disagreements = capture.tools
      .filter((tool) => byPermission.get(permissionOf(tool.name))?.readOnly !== tool.readOnlyHint)
      .map((tool) => tool.name)
      .sort()
    const overridden = Object.entries(registry.tools ?? {}).filter(([, entry]) => entry.readOnlyOverride !== undefined).map(([name]) => name).sort()
    expect(disagreements).toEqual(overridden)
    for (const name of overridden) {
      const { value, reason } = registry.tools![name]!.readOnlyOverride!
      // Only ever stricter: a tool the server calls a change is never declared a read.
      expect({ name, value, hint: served.get(name)!.readOnlyHint }).toEqual({ name, value: false, hint: true })
      expect(byPermission.get(permissionOf(name))!.readOnly).toBe(value)
      expect(reason).toBe(READ_ONLY_OVERRIDES[name]!)
    }
    expect(Object.keys(READ_ONLY_OVERRIDES).sort()).toEqual(overridden)
  })

  test("declares every tool allow, as the default access does", () => {
    expect(declared.filter((tool) => tool.effect !== "allow").map((tool) => tool.permission)).toEqual([])
  })

  test("reads are exactly the tools declared read-only", () => {
    expect(declared.filter((tool) => tool.readOnly).map((tool) => tool.permission).sort()).toEqual(READ_TOOLS.map(permissionOf).sort())
  })
})

describe("the tools that reach people", () => {
  test("are served changes, never reads, and ask at ask-changes, are denied at read-only and run at all", () => {
    for (const tool of REACH_TOOLS) {
      expect({ tool, served: served.get(tool)?.readOnlyHint }).toEqual({ tool, served: false })
      expect({ tool, readOnly: byPermission.get(permissionOf(tool))?.readOnly }).toEqual({ tool, readOnly: false })
      expect({ tool, effect: evaluate(defaultRules("ask-changes"), permissionOf(tool)) }).toEqual({ tool, effect: "ask" })
      expect({ tool, effect: evaluate(defaultRules("read-only"), permissionOf(tool)) }).toEqual({ tool, effect: "deny" })
      expect({ tool, effect: evaluate(defaultRules("all"), permissionOf(tool)) }).toEqual({ tool, effect: "allow" })
    }
  })

  test("the two that place phone calls are priced or refused while a cap is on", () => {
    for (const tool of ["agents_submit_batch_call", "agents_retry_batch_call"]) {
      expect({ tool, spends: SPEND_ANY.includes(tool), mustPrice: mustPrice(tool) }).toEqual({ tool, spends: true, mustPrice: true })
    }
  })
})

/** Markdown the docs check reads: the skills, the README and docs/. */
function docFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry.endsWith(".md")) out.push(path)
    }
  }
  walk(join(ROOT, "skills"))
  out.push(join(ROOT, "README.md"))
  walk(join(ROOT, "docs"))
  return out
}

/** The top-level keys of the object literal that starts at `text[start] === "{"`, shorthand included. */
function objectKeys(text: string, start: number): string[] {
  const keys: string[] = []
  let depth = 0
  let quote: string | undefined
  let token = ""
  for (let index = start; index < text.length; index++) {
    const char = text[index]!
    if (quote) {
      if (char === "\\") index++
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "{" || char === "[" || char === "(") {
      depth++
      if (depth === 1) token = ""
      continue
    }
    if (char === "}" || char === "]" || char === ")") {
      if (depth === 1 && token.trim() !== "") keys.push(token.trim())
      depth--
      if (depth === 0) break
      continue
    }
    if (depth !== 1) continue
    if (char === ",") {
      if (token.trim() !== "") keys.push(token.trim())
      token = ""
    } else if (char === ":") {
      keys.push(token.trim())
      token = "\u0000"
    } else if (token !== "\u0000") token += char
  }
  return keys.filter((key) => key !== "\u0000" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
}

describe("the docs and skills", () => {
  const calls = docFiles().flatMap((file) => {
    const text = readFileSync(file, "utf8")
    const found: { file: string; tool: string; keys: string[] }[] = []
    for (const match of text.matchAll(/tools\.elevenlabs\.([a-z_]+)\(\s*\{/g)) {
      found.push({ file, tool: match[1]!, keys: objectKeys(text, match.index! + match[0].length - 1) })
    }
    // A script's call: `opencode api post /api/rpc/elevenlabs.tools/<tool> … -d '{"input":{"sessionID":…,"input":{…}}}'`.
    for (const match of text.matchAll(/elevenlabs\.tools\/([a-z_]+)[^\n]*?-d '(\{.*\})'/g)) {
      const body = JSON.parse(match[2]!) as { input?: { input?: Record<string, unknown> } }
      found.push({ file, tool: match[1]!, keys: Object.keys(body.input?.input ?? {}) })
    }
    // `describe` and the plugin's own `elevenlabs_save_media` are methods of the plugin, not ElevenLabs tools.
    return found.filter((call) => call.tool !== "describe" && !own.has(call.tool.replace(/^elevenlabs_/, "")))
  })

  test("call only served tools", () => {
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter((call) => !served.has(call.tool)).map((call) => `${call.file}: ${call.tool}`)).toEqual([])
  })

  test("pass only parameters the served tool's input schema has", () => {
    const unknown = calls.flatMap((call) => {
      const properties = Object.keys(served.get(call.tool)?.inputSchema.properties ?? {})
      return call.keys.filter((key) => !properties.includes(key)).map((key) => `${call.file.slice(ROOT.length)}: ${call.tool} ${key}`)
    })
    expect(unknown).toEqual([])
  })
})
