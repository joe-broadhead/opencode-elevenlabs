// A loopback Streamable-HTTP MCP server that answers the way ElevenLabs' hosted server does as far as the plugin needs:
// OAuth discovery with the client metadata document and the seven scopes, a tool list of known reads, writes, a delete,
// an export link and a billed generation that prices itself with `estimate_only`, plus generated-file links on a
// loopback "user content" host. Every name and answer is made up; none is ElevenLabs content. While `challenge` is set,
// every MCP request gets 401 with a bearer challenge and the same server plays the sign-in server.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { DESTRUCTIVE_TOOLS, EXPORT_TOOLS, READ_TOOLS, SPEND_TOOLS, WRITE_TOOLS } from "../../src/elevenlabs-tools.js"
import { OAUTH_SCOPES } from "../../src/constants.js"

const SCOPES = OAUTH_SCOPES.split(" ")
/** A tool the plugin has never seen. */
export const NEW_TOOL = { name: "agents_shiny_new_tool", description: "A tool added upstream after the tool lists were written", annotations: {} }
export const READ = "agents_list"
export const WRITE = "agents_update"
export const DELETE = "agents_delete"
export const LINK = "agents_get_link"
export const SPEECH = "creative_generate_speech"
export const IMAGE = "creative_generate_image"
export const TRANSCRIPT = "agents_get_conversation"

/** The credits one image generation costs in the fake's estimate. */
export const IMAGE_CREDITS = 500

const schema = { type: "object", properties: { text: { type: "string" }, prompt: { type: "string" }, generations_count: { type: "integer" }, estimate_only: { type: "boolean" }, agent_id: { type: "string" } } }
const known = (name: string, readOnlyHint: boolean) => ({ name, description: `ElevenLabs ${name}`, annotations: { readOnlyHint }, inputSchema: schema })
const CATALOG = [
  ...READ_TOOLS.map((name) => known(name, true)),
  ...EXPORT_TOOLS.map((name) => known(name, false)),
  ...WRITE_TOOLS.map((name) => known(name, false)),
  ...SPEND_TOOLS.map((name) => known(name, false)),
  ...DESTRUCTIVE_TOOLS.map((name) => known(name, false)),
  { ...NEW_TOOL, inputSchema: schema },
]
const SERVED = [READ, WRITE, DELETE, LINK, SPEECH, IMAGE, NEW_TOOL.name]
const TOOLS = CATALOG.filter((tool) => SERVED.includes(tool.name))

/** The upstream error a "fail" call gets: two lines, the first with a signed URL. */
export const UPSTREAM_FAILURE = "ElevenLabs refused https://files.elevenlabs.example/a.png?signature=fake-signature-123 for this input\nTraceback: second line"

export interface FakeMcpOptions {
  /** List every tool the plugin knows, as a workspace with all of ElevenLabs' features would. */
  readonly catalog?: "elevenlabs"
  /** Answer every request with 401 and a bearer challenge from the start, as ElevenLabs does before a sign-in. */
  readonly challenge?: true
  /** Whether the token endpoint issues a refresh token. */
  readonly refreshTokens?: boolean
  /** Report credits in a generation's result, so the model path can be exact instead of "at most". */
  readonly reportsCredits?: boolean
  /** Report the credits in the text part only, as a server that answers in prose does (DR-10). */
  readonly reportsCreditsInText?: boolean
}

export interface FakeMcp {
  readonly url: string
  /** While true, every MCP request gets 401 with a bearer challenge. The sign-in server keeps answering. */
  challenge: boolean
  /** The server's origin; `${origin}/oauth` is the authorization server, and `${origin}/media/…` serves files. */
  readonly origin: string
  /** Every token request's form, in order. */
  readonly tokens: Record<string, string>[]
  /** Every authorization request's query, in order: the scope pin and the resource are read here. */
  readonly authorizations: Record<string, string>[]
  /** Tool names called, in order. */
  readonly calls: string[]
  /** Each tool call with the path it was sent to, in order. */
  readonly called: { readonly tool: string; readonly path: string }[]
  /** Each tool call's arguments, in order. */
  readonly inputs: { readonly tool: string; readonly arguments: Record<string, unknown> }[]
  /** The `x-elevenlabs-test` header of every request, to tell whose server config the host used. */
  readonly markers: (string | undefined)[]
  close(): Promise<void>
}

type Message = { jsonrpc: "2.0"; id?: number | string; method: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } }

export async function startFakeMcp(options: FakeMcpOptions = {}): Promise<FakeMcp> {
  const calls: string[] = []
  const called: { tool: string; path: string }[] = []
  const inputs: { tool: string; arguments: Record<string, unknown> }[] = []
  const markers: (string | undefined)[] = []
  const tokens: Record<string, string>[] = []
  const authorizations: Record<string, string>[] = []
  let codes = 0
  const fake = { challenge: options.challenge ?? false } as FakeMcp

  /** A generated-file link, on the loopback host the plugin's test seam allows. */
  const linkFor = (name: string) => `${fake.origin}/media/${name}`
  const answer = (message: Message, path = "/mcp") => {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result })
    switch (message.method) {
      case "initialize":
        return reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-elevenlabs", version: "0.0.0" } })
      case "tools/list":
        return reply({ tools: options.catalog === "elevenlabs" ? CATALOG : TOOLS })
      case "tools/call": {
        const tool = message.params?.name ?? ""
        const args = message.params?.arguments ?? {}
        calls.push(tool)
        called.push({ tool, path })
        inputs.push({ tool, arguments: args })
        const asked = String(args.query ?? args.text ?? args.prompt ?? "")
        if (asked.startsWith("fail")) return reply({ content: [{ type: "text", text: UPSTREAM_FAILURE }], isError: true })
        if (args.estimate_only === true) {
          const generations = typeof args.generations_count === "number" ? args.generations_count : 1
          return reply({ content: [{ type: "text", text: `Estimated ${IMAGE_CREDITS * generations} credits.` }], structuredContent: { estimate: { credits: IMAGE_CREDITS * generations } } })
        }
        if (SPEND_TOOLS.includes(tool)) {
          const charged = options.reportsCreditsInText ? " Charged 120 credits." : ""
          const text = `Generated two variations. Link: ${linkFor("voiceover.mp3")} (expires in about two hours).${charged}`
          return reply({
            content: [{ type: "text", text }],
            structuredContent: { flow_id: "flow_1", node_id: "node_1", url: linkFor("voiceover.mp3"), ...(options.reportsCredits ? { credits: 120 } : {}) },
          })
        }
        if (tool === TRANSCRIPT) {
          return reply({ content: [{ type: "text", text: "agent: hello\nuser: I need a refund for order 1234" }], structuredContent: { conversation_id: "conv_1", user_id: "user_1", cost: 12 } })
        }
        if (tool === LINK) return reply({ content: [{ type: "text", text: `Share link: ${fake.origin}/share/agent-1` }], structuredContent: { url: `${fake.origin}/share/agent-1` } })
        if (asked.startsWith("text")) return reply({ content: [{ type: "text", text: `text from ${tool}` }] })
        return reply({ content: [{ type: "text", text: `called ${tool}` }], structuredContent: { tool, path, arguments: args } })
      }
      case "ping":
        return reply({})
      default:
        return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } }
    }
  }

  /** ElevenLabs' sign-in server and its user-content host. */
  const signIn = async (request: IncomingMessage, response: ServerResponse, route: string) => {
    const json = (status: number, body: unknown) => void response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
    const issuer = `${fake.origin}/oauth`
    if (route.startsWith("/.well-known/oauth-protected-resource")) {
      const resource = `${fake.origin}${route.slice("/.well-known/oauth-protected-resource".length) || "/mcp"}`
      return json(200, { resource, authorization_servers: [issuer], scopes_supported: [...SCOPES, "ads_read"], bearer_methods_supported: ["header"] })
    }
    if (["/.well-known/oauth-authorization-server/oauth", "/oauth/.well-known/oauth-authorization-server"].includes(route)) {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [...SCOPES, "ads_read"],
        client_id_metadata_document_supported: true,
      })
    }
    if (route === "/oauth/authorize") {
      const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams
      authorizations.push(Object.fromEntries(query))
      const target = new URL(query.get("redirect_uri") ?? "/")
      target.searchParams.set("code", `fake-code-${++codes}`)
      if (query.get("state")) target.searchParams.set("state", query.get("state")!)
      return void response.writeHead(302, { location: target.toString() }).end()
    }
    if (route === "/oauth/token" && request.method === "POST") {
      const form = Object.fromEntries(new URLSearchParams(await read(request)))
      tokens.push(form)
      if (fake.challenge && form.grant_type === "refresh_token") return json(400, { error: "invalid_grant" })
      return json(200, {
        access_token: `fake-access-${tokens.length}`,
        token_type: "Bearer",
        expires_in: 3600,
        ...(options.refreshTokens === false ? {} : { refresh_token: `fake-refresh-${tokens.length}` }),
        scope: SCOPES.join(" "),
      })
    }
    return json(404, { error: "not_found" })
  }

  /** The generated-file host: one good file, one expired link, and one that is too large. */
  const media = (_request: IncomingMessage, response: ServerResponse, route: string) => {
    if (route === "/media/ok" || route === "/media/voiceover.mp3") {
      return void response.writeHead(200, { "content-type": "audio/mpeg" }).end("ID3fakeaudio")
    }
    if (route === "/media/expired") return void response.writeHead(403).end("expired")
    if (route === "/media/big") {
      response.writeHead(200, { "content-type": "video/mp4", "content-length": String(64 * 1024 * 1024) })
      return void response.end(Buffer.alloc(1024))
    }
    return void response.writeHead(404).end()
  }

  const server = createServer(async (request, response) => {
    const route = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    if (route.startsWith("/.well-known/") || route.startsWith("/oauth")) return signIn(request, response, route)
    if (route.startsWith("/media/")) return media(request, response, route)
    markers.push(header(request, "x-elevenlabs-test"))
    if (fake.challenge) {
      const metadata = `${fake.origin}/.well-known/oauth-protected-resource${route}`
      return void response
        .writeHead(401, { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${metadata}"` })
        .end(JSON.stringify({ detail: "OAuth bearer token required for the hosted MCP." }))
    }
    if (request.method !== "POST") return void response.writeHead(405, { allow: "POST" }).end()
    const body = JSON.parse(await read(request)) as Message | Message[]
    const replies = (Array.isArray(body) ? body : [body]).filter((message) => message.id !== undefined).map((message) => answer(message, route))
    if (!replies.length) return void response.writeHead(202).end()
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(body) ? replies : replies[0]))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  Object.assign(fake, {
    url: `http://127.0.0.1:${port}/mcp`,
    origin: `http://127.0.0.1:${port}`,
    tokens,
    authorizations,
    calls,
    called,
    inputs,
    markers,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  })
  return fake
}

/** The url's host, which the harness adds to the plugin's media allowlist for the test. */
export const mediaHostOf = (url: string) => new URL(url).hostname

const header = (request: IncomingMessage, name: string) => [request.headers[name]].flat()[0]

async function read(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}
