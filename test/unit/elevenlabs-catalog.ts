// The saved tool list, test/fixtures/live-tools.json, as a test reads it. The file is one raw MCP `tools/list` response,
// captured from a live account: the 190 tools ElevenLabs' hosted MCP server serves, with their own descriptions and
// input schemas (test/fixtures/README.md says how it was captured and what was redacted). No runtime import, so the
// drift script can load this file too.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export interface LiveTool {
  readonly name: string
  readonly description: string
  readonly params: readonly string[]
  readonly required: readonly string[]
  /** Each property the live schema gives a `default`, by name. The pricing table's generation counts come from these. */
  readonly defaults: Readonly<Record<string, unknown>>
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
}

interface RawTool {
  readonly name?: unknown
  readonly description?: unknown
  readonly inputSchema?: { readonly properties?: Record<string, unknown>; readonly required?: unknown }
  readonly annotations?: { readonly readOnlyHint?: unknown; readonly destructiveHint?: unknown }
}

/** Reads a tool list file, or the plugin's own fixture when no path is given. */
export function readToolList(path?: string): readonly LiveTool[] {
  const file = path ?? fileURLToPath(new URL("../fixtures/live-tools.json", import.meta.url))
  const body = JSON.parse(readFileSync(file, "utf8")) as { tools?: RawTool[] }
  if (!Array.isArray(body.tools)) throw new Error(`${file} has no "tools" array`)
  return body.tools.flatMap((tool) => {
    if (typeof tool.name !== "string") return []
    const properties = tool.inputSchema?.properties
    return [{
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      params: properties && typeof properties === "object" ? Object.keys(properties).sort() : [],
      required: Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required.filter((item): item is string => typeof item === "string") : [],
      defaults: defaultsOf(properties),
      ...(typeof tool.annotations?.readOnlyHint === "boolean" ? { readOnlyHint: tool.annotations.readOnlyHint } : {}),
      ...(typeof tool.annotations?.destructiveHint === "boolean" ? { destructiveHint: tool.annotations.destructiveHint } : {}),
    }]
  })
}

/** The `default` each property declares, for the properties that declare one. */
function defaultsOf(properties: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!properties || typeof properties !== "object") return {}
  const out: Record<string, unknown> = {}
  for (const [name, schema] of Object.entries(properties)) {
    if (schema && typeof schema === "object" && "default" in schema) out[name] = (schema as { default: unknown }).default
  }
  return out
}

/** The fixture's tools by name. */
export const LIVE: ReadonlyMap<string, LiveTool> = new Map(readToolList().map((tool) => [tool.name, tool]))

/** The fixture's names, in the order the list gives them. */
export const LIVE_TOOLS: readonly string[] = readToolList().map((tool) => tool.name)
