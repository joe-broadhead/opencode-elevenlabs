// Maintainer-run drift check against a saved copy of ElevenLabs' tool list. It warns; nothing at runtime depends on it.
//
//   npm run drift            compare the plugin's table with test/fixtures/live-tools.json
//   npm run drift -- <tools.json> [--strict]
//
// <tools.json> is a saved MCP `tools/list` response: an object whose `tools` array holds each tool's `name`, its
// `description` and `inputSchema`, plus `annotations` when the source has them. test/fixtures/README.md says how to save
// one. The script reads that file only: it never reads a credential and never calls ElevenLabs. It prints tool names,
// parameter names and ElevenLabs' readOnlyHint and destructiveHint annotations, and nothing else.
//
// test/fixtures/live-tools.json is the catalogue a live account returned, so the default run compares the table with
// what ElevenLabs actually serves. A name the table leaves unclassified on purpose (UNCLASSIFIED_TOOLS) is not drift;
// the check lists it so the decision stays visible.
//
// Exit codes: 0 no drift, or drift without --strict; 1 drift with --strict; 2 usage or file error.
// Needs Node 22.18 or later, which loads the TypeScript table by stripping its types.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const USAGE = "Usage: node scripts/check-elevenlabs-tools.mjs [<tools.json>] [--strict]"
// Wording that says a tool changes or sends something. A known read whose description gains it needs a second look.
const CHANGE_WORDS = /\b(creates?|updates?|deletes?|removes?|edits?|modif(?:y|ies)|writes?|sends?|posts?|uploads?|archives?|generates?|spends?)\b/i
// Reads whose live description trips CHANGE_WORDS and were read in full and confirmed to be reads: the word describes
// what the tool reports, not what it does. Drop a name here when its description changes, so it is looked at again.
const WORDING_REVIEWED = new Map([
  ["agents_get_conversation_summary", "reports whether the agent updated anything; reads one conversation"],
  ["creative_get_available_assets", "lists assets already uploaded; uploads nothing"],
])
const LIVE = fileURLToPath(new URL("../test/fixtures/live-tools.json", import.meta.url))

let strict = false
let file
for (const arg of process.argv.slice(2)) {
  if (arg === "--strict") strict = true
  else if (!arg.startsWith("--") && file === undefined) file = arg
  else fail(`unknown argument "${arg}". ${USAGE}`)
}
if (!process.features.typescript) fail(`Node ${process.versions.node} cannot load TypeScript files. Use Node 22.18 or later.`)
const path = file ?? LIVE

const tools = await import(new URL("../src/elevenlabs-tools.ts", import.meta.url).href)
const unclassified = new Set(tools.UNCLASSIFIED_TOOLS)
const known = new Set([...tools.ALL_TOOLS, ...unclassified])
const live = readToolList(path)
const names = new Set(live.map((tool) => tool.name))

const added = [...names].filter((name) => !known.has(name)).sort()
const removed = [...known].filter((name) => !names.has(name)).sort()
const held = [...unclassified].filter((name) => names.has(name)).sort()
const annotated = live.some((tool) => tool.annotations !== undefined)
const reclassified = live
  .filter((tool) => {
    const cls = tools.classify(tool.name)
    const hints = tool.annotations ?? {}
    if (hints.destructiveHint === true) return cls !== "destructive"
    if (hints.readOnlyHint === true) return cls !== "read"
    if (hints.readOnlyHint === false) return cls === "read"
    return false
  })
  .map((tool) => tool.name)
  .sort()
const changeWording = live
  .filter((tool) => tools.classify(tool.name) === "read" && CHANGE_WORDS.test(tool.description) && !WORDING_REVIEWED.has(tool.name))
  .map((tool) => `${tool.name}  (${tool.description.match(CHANGE_WORDS)?.[0]})`)
  .sort()

console.log(`${path === LIVE ? "Live catalogue: " : ""}${live.length} tools`)
if (!annotated) console.log("The saved list carries no annotations, so no class can be confirmed from it.")
for (const name of added) console.log(`+ ${name}  new upstream: classify it in src/elevenlabs-tools.ts, then jelly and the README`)
for (const name of removed) console.log(`- ${name}  gone upstream: remove it from src/elevenlabs-tools.ts, jelly and the README`)
for (const name of reclassified) console.log(`! ${name}  upstream annotations disagree with the class in src/elevenlabs-tools.ts`)
for (const line of changeWording) console.log(`? ${line}  a read whose description says it changes something`)
for (const name of held) console.log(`= ${name}  left unclassified on purpose: the rule("*", other) default asks for it, and read-only denies it`)
const drift = added.length + removed.length + reclassified.length
if (drift === 0) console.log("No drift: the table matches the saved list.")
process.exit(drift > 0 && strict ? 1 : 0)

function readToolList(file) {
  let body
  try {
    body = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    fail(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(body?.tools)) fail(`${file} has no "tools" array. ${USAGE}`)
  return body.tools.filter((tool) => typeof tool?.name === "string")
}

function fail(message) {
  console.error(message)
  process.exit(2)
}
