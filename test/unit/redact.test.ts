// Credentials never reach what status prints: the status RPC, /elevenlabs-status (posted into the session, so the model
// reads it) and the dialog. Every shape is checked on all three.
import { describe, expect, test } from "bun:test"
import { ENDPOINT } from "../../src/constants.js"
import { checkHost } from "../../src/host-version.js"
import { registerServer, serverConfig } from "../../src/plugin.js"
import { reasonOf, shortReason } from "../../src/redact.js"
import { buildStatus, formatStatus, registerStatusCommand, registerStatusRpc, type ServerSource, type Status, type StatusFacts } from "../../src/status.js"
import { viewMessage } from "../../src/tui.js"
import { mcpEditor, transforms, type McpEditor } from "./fake.js"

const SECRETS = ["hunter2", "abcdefghijklmnop", "sk-live-0123456789abcdef", "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl", "secret-path-123", "fake-signature", "x".repeat(48)]
const host = checkHost("2.2.3", false)

/** The three surfaces that show a status: the RPC's output, the session text and the dialog's text. */
async function surfaces(status: Status) {
  let rpc: unknown
  await registerStatusRpc(
    { register: async (_definition, handlers) => ((rpc = await handlers.status({} as never, { error: () => undefined } as never)), { dispose: async () => {} }) as never },
    async () => status,
  )
  let posted = ""
  let execute: ((input: { sessionID: string }) => Promise<void>) | undefined
  await registerStatusCommand(
    {
      command: { transform: async (callback) => (callback({ add: (definition) => void (execute = definition.execute as never) }), { dispose: async () => {} }) },
      session: { synthetic: async (input) => ((posted = (input as { text: string }).text), {}) as never },
    },
    async () => status,
  )
  await execute!({ sessionID: "ses_1" })
  return [JSON.stringify(rpc), posted, viewMessage({ status })]
}

async function expectClean(facts: StatusFacts) {
  for (const text of await surfaces(buildStatus(facts))) for (const secret of SECRETS) expect({ secret, leaked: text.includes(secret) }).toEqual({ secret, leaked: false })
}

describe("redaction", () => {
  test.each([
    ["URL credentials", "fetch https://alice:hunter2@api.elevenlabs.ai/connect/mcp failed"],
    ["a bearer token", "401 Authorization: Bearer abcdefghijklmnop rejected"],
    ["a key=value secret", "refused: api_key=hunter2 and token: abcdefghijklmnop"],
    ["a vendor key", "invalid key sk-live-0123456789abcdef"],
    ["a JWT", "expired eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl"],
    ["a signed URL", "GET https://files.elevenlabs.example/a.png?signature=fake-signature failed"],
    ["a long key run", `bad ${"x".repeat(48)}`],
  ])("a failure's reason with %s never shows it", async (_, error) => {
    await expectClean({ server: { status: "failed", error }, source: { type: "plugin", url: ENDPOINT }, host })
  })

  test("a conflicting server at another origin shows only its origin, on every surface", async () => {
    const records: (ServerSource | undefined)[] = []
    const { transform, run } = transforms<McpEditor>()
    await registerServer({ transform }, serverConfig(ENDPOINT, {}), (source) => void records.push(source))
    run(mcpEditor({ elevenlabs: { type: "remote", url: "https://alice:hunter2@mcp.example.com/api/mcp/s/secret-path-123/mcp" } }).editor)
    expect(records[0]).toEqual({ type: "conflict", url: "https://mcp.example.com/…", expected: ENDPOINT })
    const status = buildStatus({ server: { status: "connected" }, source: records[0]!, host })
    expect(status.nextStep).toContain("mcp.servers.elevenlabs is set to https://mcp.example.com/…")
    await expectClean({ server: { status: "connected" }, source: records[0]!, host })
  })

  test("setup problems carry the error's short, redacted message", async () => {
    const reason = reasonOf(new Error("boom\n  at https://alice:hunter2@example.com/x?token=abcdefghijklmnop\n  Bearer abcdefghijklmnop"))
    expect(reason).toBe("boom at https://example.com/x Bearer [redacted]")
    expect(reasonOf("")).toBe("no reason given")
    await expectClean({ server: { status: "connected" }, host, tools: ["search_meetings"], problems: [`RULES_NOT_ADDED: could not be added (${reason}). Next step: Restart OpenCode.`] })
  })

  test("the cut keeps whole characters and stays at 160", () => {
    const cut = shortReason(`${"a ".repeat(79)}😀😀😀`)!
    expect(Array.from(cut)).toHaveLength(160)
    expect(cut.endsWith("…")).toBe(true)
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(shortReason("short 😀")).toBe("short 😀")
  })

  test("the formatted text and the model agree: no surface adds its own unredacted copy", async () => {
    const status = buildStatus({ server: { status: "failed", error: "Bearer abcdefghijklmnop" }, source: { type: "plugin", url: ENDPOINT }, host })
    expect(status.error).toBe("Bearer [redacted]")
    expect(formatStatus(status)).toContain("- Connection: failed (Bearer [redacted];")
  })
})
