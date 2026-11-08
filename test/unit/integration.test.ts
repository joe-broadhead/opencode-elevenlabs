// The /connect entry: renamed "ElevenLabs" once the host has registered it and again after the host resets it, and the
// account marked for a new sign-in while the server needs one. Against a narrow fake of the members the watcher uses.
import { describe, expect, test } from "bun:test"
import { watchIntegration, type IntegrationContext } from "../../src/integration.js"

type Editor = Parameters<Parameters<IntegrationContext["integration"]["transform"]>[0]>[0]
type Connection = { type: "credential"; id: string; label: string; method: "oauth"; status?: { status: "needs_auth"; message: string } }

function fake(initial: { server?: string; integrationID?: string } = {}) {
  const state = {
    server: initial.server ?? "connected",
    integrationID: "integrationID" in initial ? initial.integrationID : "mcp_elevenlabs",
    /** The host's name for each integration before plugin transforms run. */
    hostName: "elevenlabs",
    connection: undefined as Connection | undefined,
  }
  const transforms: ((editor: Editor) => void)[] = []
  const reported: unknown[] = []
  let push: (() => void) | undefined
  const name = () => {
    let current = state.hostName
    const editor = {
      get: (id: string) => (id === state.integrationID ? { id, name: current } : undefined),
      update: (id: string, update: (integration: { id: string; name: string }) => void) => {
        const integration = { id, name: current }
        update(integration)
        current = integration.name
      },
    } as unknown as Editor
    for (const transform of transforms) transform(editor)
    return current
  }
  const ctx = {
    mcp: { list: async () => ({ data: [{ name: "elevenlabs", status: { status: state.server }, ...(state.integrationID ? { integrationID: state.integrationID } : {}) }] }) },
    integration: {
      transform: async (callback: (editor: Editor) => void) => {
        transforms.push(callback)
        return { dispose: async () => void transforms.splice(transforms.indexOf(callback), 1) }
      },
      // The host projects each credential with the status the plugin set on it; `active` returns the credential alone.
      get: async () => ({
        data: {
          id: state.integrationID,
          name: name(),
          connections: state.connection
            ? [{ type: "credential", id: state.connection.id, label: state.connection.label, method: state.connection.method, ...(state.connection.status ? { status: state.connection.status } : {}) }]
            : [],
        },
      }),
      connection: {
        // As the host does: the credential, without the status the plugin set on it.
        active: async () => (state.connection ? { type: state.connection.type, id: state.connection.id, label: state.connection.label, method: state.connection.method } : undefined),
        status: async (input: { status: Connection["status"] }) => {
          reported.push(input.status)
          if (state.connection) state.connection = { ...state.connection, ...(input.status ? { status: input.status } : { status: undefined }) }
        },
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            await new Promise<void>((resolve) => {
              push = resolve
              signal.addEventListener("abort", () => resolve(), { once: true })
            })
            if (!signal.aborted) yield { type: "integration.updated", data: {} }
          }
        },
      }),
    },
  } as unknown as IntegrationContext
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
  return { ctx, state, transforms, reported, name, emit: () => push?.(), settle }
}

const SIGN_IN_AGAIN = "ElevenLabs needs a new sign-in. Choose this account to sign in again."

describe("watchIntegration", () => {
  test("names the server's /connect entry ElevenLabs once the host has registered it", async () => {
    const view = fake({ integrationID: undefined })
    const stop = watchIntegration(view.ctx, () => true)
    await view.settle()
    expect(view.transforms).toHaveLength(0)
    view.state.integrationID = "mcp_elevenlabs"
    view.emit()
    await view.settle()
    expect(view.name()).toBe("ElevenLabs")
    expect(view.transforms).toHaveLength(1)
    await stop()
    expect(view.transforms).toHaveLength(0)
  })

  test("registers the rename again when the host's name comes back, and drops the old one", async () => {
    const view = fake()
    const stop = watchIntegration(view.ctx, () => true)
    await view.settle()
    expect(view.name()).toBe("ElevenLabs")
    // An MCP reload registers the host's transform again, after the plugin's: the name is reset.
    view.transforms.push((editor) => editor.update("mcp_elevenlabs", (integration) => void (integration.name = "elevenlabs")))
    view.emit()
    await view.settle()
    expect(view.name()).toBe("ElevenLabs")
    expect(view.transforms).toHaveLength(2)
    await stop()
  })

  test("leaves a server that is not ElevenLabs's alone", async () => {
    const view = fake()
    const stop = watchIntegration(view.ctx, () => false)
    await view.settle()
    expect(view.transforms).toHaveLength(0)
    await stop()
  })

  test("marks the account for a new sign-in while the server needs one, and clears only its own mark", async () => {
    const view = fake({ server: "needs_auth" })
    view.state.connection = { type: "credential", id: "c1", label: "Acme", method: "oauth" }
    const stop = watchIntegration(view.ctx, () => true)
    await view.settle()
    expect(view.reported).toEqual([{ status: "needs_auth", message: SIGN_IN_AGAIN }])
    view.state.server = "connected"
    view.emit()
    await view.settle()
    expect(view.reported).toEqual([{ status: "needs_auth", message: SIGN_IN_AGAIN }, undefined])
    view.state.connection = { ...view.state.connection!, status: { status: "needs_auth", message: "Another plugin's problem." } }
    view.emit()
    await view.settle()
    expect(view.reported).toHaveLength(2)
    await stop()
  })
})
