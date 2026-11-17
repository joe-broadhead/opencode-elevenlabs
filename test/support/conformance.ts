// The source contract's conformance kit over the source this plugin declares in package.json's `sources`, run on the
// plugin's own events_list and probe methods against the synthetic workspace (test/support/synthetic-conversations.ts:
// every id, name and time invented, in the shape ElevenLabs' list answers with): no ElevenLabs call, no sign-in. The
// read goes through a fake of OpenCode's executor that asserts `elevenlabs_agents_list_conversations` on the kit's
// recording permission, as the host asserts it, so the kit sees exactly what each read asserts. scripts/conformance.ts
// writes the report; test/unit/conformance.test.ts holds it to ok.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sourceConformance, type ConformanceReport, type PageCase, type SessionContext } from "@we-the-rebel-alliance/source-contract/conformance"
import { encodeBoundCursor, encodeCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { SOURCES_SCHEMA, type Sources } from "@we-the-rebel-alliance/source-contract/schema"
import type { ToolCall } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { ACCOUNT, LIST_TOOL, SOURCE, SOURCE_ID, eventsMethod, probeMethod, type EventsContext, type EventsState } from "../../src/events.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { CONVERSATIONS, CREDENTIAL, NOW, SECRET, SINCE, syntheticList } from "./synthetic-conversations.js"

export const ROOT = fileURLToPath(new URL("../..", import.meta.url))
export const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  name: string
  version: string
  sources: unknown
  jelly: { tools: { name: string; readOnly: boolean }[] }
}

/** The declaration as the contract's schema parses it, which is what the kit takes. */
export function declaredSources(): Sources {
  const checked = SOURCES_SCHEMA.check(pkg.sources)
  if (!checked.ok) throw new Error(`the sources declaration is invalid: ${checked.problems.join("; ")}`)
  return checked.value
}

/** The plugin's declared tools, as the kit names them: without the server prefix, with ElevenLabs' readOnly. */
export const declaredTools = () => pkg.jelly.tools.map((tool) => ({ id: tool.name.replace(/^elevenlabs_/, ""), readOnly: tool.readOnly }))

/**
 * Why no single conversation can fail on its own, for the kit's `failed-holds-cursor` check: events_list reads only the
 * list, which answers each page whole, and nothing per conversation.
 */
export const ATOMIC =
  "events_list reads only agents_list_conversations, which answers each page whole, and reads nothing per conversation: a failed read fails the whole call, so no single conversation fails on its own"

/**
 * Why the kit's `gap-and-cursor-expired` check does not apply: the cursor is the plugin's own position, never an
 * ElevenLabs token.
 */
export const NO_EXPIRY =
  "the cursor is the start time and id of the last conversation listed, kept by the plugin, never an ElevenLabs paging token, so it cannot expire; each call queries agents_list_conversations afresh from that start"

/** The source's state as setup gives it: ElevenLabs' own server, conversations on. */
const STATE: EventsState = { managed: () => true, disabled: () => false }

/** OpenCode's executor for the list, answering from the synthetic workspace; it asserts `elevenlabs_<tool>` first, as the host does. */
export function context(permission: SessionContext["permission"], options: { readonly credential?: typeof CREDENTIAL | undefined } = {}): EventsContext {
  const { list } = syntheticList({ conversations: [...CONVERSATIONS, SECRET] })
  const credential = "credential" in options ? options.credential : CREDENTIAL
  return {
    tool: {
      list: async () =>
        [{
          id: `elevenlabs_${LIST_TOOL}`,
          execute: async (input: Record<string, unknown>) => {
            await permission.assert({ action: `elevenlabs_${LIST_TOOL}`, resources: ["*"] })
            return list(input)
          },
        }] as never,
    },
    mcp: { list: async () => ({ data: [{ name: "elevenlabs", status: { status: "connected" }, integrationID: "int_elevenlabs" }] }) as never },
    integration: { connection: { active: async () => credential as never } },
    permission: { assert: (input: { action: string; resources?: readonly string[] }) => permission.assert({ action: input.action, resources: input.resources ?? ["*"] }) } as never,
  }
}

export const call = (): ToolCall => ({ sessionID: "ses_conformance", agent: "build", messageID: "msg_script", id: "script:conformance", signal: new AbortController().signal, progress: async () => {} })
const open: SessionContext = { account: ACCOUNT, permission: { assert: async () => {} } }

export const list = (input: Record<string, unknown>, session: SessionContext = open) =>
  eventsMethod(context(session.permission), STATE, () => NOW).run(input, call()) as Promise<Record<string, any>>
export const probe = (input: Record<string, unknown>, session: SessionContext = open) => probeMethod(context(session.permission), STATE).run(input, call())

/** A cursor bound like the source's own, for a test to bend one part of. */
export const boundCursor = (binding: { plugin: string; source: string; account: string }, owner = CREDENTIAL.id) =>
  encodeBoundCursor(binding, { o: createHash("sha256").update(`elevenlabs:credential:${owner}`).digest("hex").slice(0, 16), t: Date.parse(SINCE), i: "" })

async function cases(): Promise<PageCase[]> {
  const first = (await list({ since: SINCE, limit: 2 }))["cursor"] as string
  const done = (await list({ since: SINCE, limit: 500 }))["cursor"] as string
  const own = { plugin: "elevenlabs", source: SOURCE, account: ACCOUNT }
  return [
    { name: "a first listing, one conversation refused for a secret, stopping before the one still in progress", input: { since: SINCE }, expect: "page" },
    { name: "what came after the first two", input: { account: ACCOUNT, cursor: first }, expect: "page" },
    { name: "the same, two at a time", input: { account: ACCOUNT, cursor: first, limit: 2 }, expect: "page" },
    { name: "nothing listable since the last listing", input: { account: ACCOUNT, cursor: done }, expect: "empty" },
    { name: "a cursor without the account it reads", input: { cursor: first }, expect: { refuses: "INPUT_INVALID" } },
    { name: "another account than ElevenLabs' one", input: { account: "work", since: SINCE }, expect: { refuses: "ACCOUNT_MISMATCH" } },
    { name: "a cursor issued for another sign-in", input: { account: ACCOUNT, cursor: boundCursor(own, "cred_someone_else") }, expect: { refuses: "ACCOUNT_MISMATCH" } },
    { name: "another source's cursor", input: { account: ACCOUNT, cursor: boundCursor({ ...own, source: "gmail" }) }, expect: { refuses: "CURSOR_INVALID" } },
    { name: "a cursor bound to another plugin", input: { account: ACCOUNT, cursor: boundCursor({ ...own, plugin: "wisprflow" }) }, expect: { refuses: "CURSOR_INVALID" } },
    { name: "an earlier version's unbound cursor", input: { account: ACCOUNT, cursor: encodeCursor(SOURCE, { o: "0123456789abcdef", t: 0, i: "" }) }, expect: { refuses: "CURSOR_INVALID" } },
    { name: "a source this plugin does not have", input: { source: "transcripts", since: SINCE }, expect: { refuses: "SOURCE_UNKNOWN" } },
    { name: "a limit out of range", input: { since: SINCE, limit: 0 }, expect: { refuses: "INPUT_INVALID" } },
  ]
}

/** The kit's report for every source the plugin declares: one, elevenlabs.conversations. */
export async function conformanceReports(): Promise<ConformanceReport[]> {
  const sources = declaredSources()
  const source = sources.items.find((item) => item.id === SOURCE_ID)
  if (!source || sources.items.length !== 1) throw new Error(`package.json must declare exactly one source, ${SOURCE_ID}`)
  const report = await sourceConformance({
    plugin: pkg.name,
    source,
    tools: declaredTools(),
    calls: {
      list: (input, session) => list(input as Record<string, unknown>, session),
      probe: (input, session) => probe(input as Record<string, unknown>, session),
    },
    cases: await cases(),
    identityOperations: [],
    account: ACCOUNT,
    sources,
    describe: { id: TOOLS_RPC_ID },
    atomicPages: { reason: ATOMIC },
    noExpiry: { reason: NO_EXPIRY },
  })
  return [report]
}
