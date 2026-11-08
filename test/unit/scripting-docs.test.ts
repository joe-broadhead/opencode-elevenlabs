// docs/scripting.md and the README's scripting lines are the contract a script author copies. Every example must use a
// method this plugin registers, carry the location header and the strict envelope, and name only fields that method's
// schema accepts, so a doc example cannot drift from the code.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { METHODS, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { LIVE } from "./elevenlabs-catalog.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const FILES = ["docs/scripting.md", "README.md"]
const METHODS_BY_NAME = new Map(METHODS.map((method) => [method.name, method]))

/** Every `opencode api post /api/rpc/…` call in a file, as its method name and its parsed body. */
function calls(text: string): { file: string; line: number; method: string; body: unknown; statement: string }[] {
  const out: { file: string; line: number; method: string; body: unknown; statement: string }[] = []
  for (const match of text.matchAll(/opencode api post \/api\/rpc\/([A-Za-z0-9.]+)\/([A-Za-z0-9_]+)/g)) {
    const start = match.index!
    // A statement runs to the end of its fenced block or the next blank line.
    const rest = text.slice(start)
    const end = rest.search(/\n\s*\n|\n```/)
    const statement = (end === -1 ? rest : rest.slice(0, end)).trim()
    out.push({
      file: "",
      line: text.slice(0, start).split("\n").length,
      method: match[2]!,
      body: bodyOf(statement),
      statement,
    })
    void match[1]
  }
  return out
}

/** The `-d '{…}'` body of a statement, by matching braces. */
function bodyOf(statement: string): unknown {
  const at = statement.indexOf("-d '{")
  if (at === -1) return undefined
  let depth = 0
  let inString = false
  for (let i = at + 4; i < statement.length; i++) {
    const char = statement[i]
    if (inString) {
      if (char === "\\") i++
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(statement.slice(at + 4, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

const examples = FILES.flatMap((file) => calls(readFileSync(join(ROOT, file), "utf8")).map((call) => ({ ...call, file })))

describe("the scripting examples", () => {
  test("there are examples to check", () => {
    expect(examples.length).toBeGreaterThan(2)
  })

  test.each(examples)("$file:$line calls $method with this plugin's RPC id and a real method", (example) => {
    expect(example.statement).toContain("/api/rpc/elevenlabs.tools/")
    expect(TOOLS_RPC_ID).toBe("elevenlabs.tools")
    expect(example.method === "describe" || METHODS_BY_NAME.has(example.method)).toBe(true)
  })

  test.each(examples)("$file:$line sends the location header", (example) => {
    expect(example.statement).toContain('-H "x-opencode-directory:$PWD"')
  })

  test.each(examples)("$file:$line sends the strict envelope", (example) => {
    const envelope = (example.body as { input?: Record<string, unknown> } | undefined)?.input
    expect(envelope).toBeDefined()
    expect(Object.keys(envelope!).sort()).toEqual(example.method === "describe" ? expect.any(Array) : ["input", "sessionID"])
    if (example.method !== "describe") {
      expect(typeof envelope!["sessionID"]).toBe("string")
      expect(typeof envelope!["input"]).toBe("object")
    }
  })

  test.each(examples.filter((example) => example.method !== "describe"))("$file:$line names only fields $method accepts", (example) => {
    const method = METHODS_BY_NAME.get(example.method)!
    if (method.kind === "plugin") {
      // The plugin's own method: its schema is the contract, and it has no upstream tool behind it.
      const input = (deepEnvelope(example.body) ?? {}) as Record<string, unknown>
      const properties = Object.keys((method.input as { properties?: Record<string, unknown> }).properties ?? {})
      for (const key of Object.keys(input)) expect({ key, known: properties.includes(key) }).toEqual({ key, known: true })
      return
    }
    expect(method.kind).toBe("mcp")
    const live = LIVE.get(example.method)!
    expect({ method: example.method, known: live !== undefined }).toEqual({ method: example.method, known: true })
    const input = (deepEnvelope(example.body) ?? {}) as Record<string, unknown>
    for (const key of Object.keys(input)) expect({ key, known: live!.params.includes(key) }).toEqual({ key, known: true })
    for (const key of live!.required) expect({ key, given: key in input }).toEqual({ key, given: true })
  })
})

function deepEnvelope(body: unknown): unknown {
  const envelope = (body as { input?: { input?: unknown } } | undefined)?.input
  return envelope !== undefined && "input" in envelope ? envelope.input : undefined
}
