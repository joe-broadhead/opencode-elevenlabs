// A synthetic ElevenLabs workspace for the source contract's tests: agents_list_conversations answering as the live
// tool does (its public API reference: `conversations`, `has_more`, `next_cursor`; each conversation's
// `conversation_id`, `agent_id`, `agent_name`, `start_time_unix_secs`, `status`, `call_successful`, `direction`, with
// the transcript summary, title and other fields present to prove they are never read), and agents_list and agents_get
// giving each agent's retention (`platform_settings.privacy`, as ElevenLabs' API reference documents it). Every id, name
// and time is invented. No ElevenLabs call, no sign-in.

/** The clock every test fixes. */
export const NOW = Date.parse("2026-11-01T12:00:00Z")
/** Where a first listing starts. */
export const SINCE = "2026-10-20T00:00:00Z"
/** OpenCode's credential for the elevenlabs server, as `integration.connection.active` names it. */
export const CREDENTIAL = { type: "credential" as const, id: "cred_synthetic_01", label: "Ada's ElevenLabs" }
/** The owner every page and probe names for it. */
export const OWNER = { id: "elevenlabs:credential:cred_synthetic_01", label: "Ada's ElevenLabs" }

export interface SyntheticConversation {
  readonly conversation_id: string
  readonly agent_id: string
  readonly agent_name?: string
  /** ISO, whole seconds. */
  readonly at: string
  readonly status: "initiated" | "in-progress" | "processing" | "done" | "failed"
  readonly call_successful: "success" | "failure" | "unknown"
  readonly direction?: "inbound" | "outbound"
}

const SUPPORT = { agent_id: "agent_01synthsupport0000000000", agent_name: "Support Desk" }
const BOOKING = { agent_id: "agent_02synthbooking0000000000", agent_name: "Booking Line" }

/** The workspace's conversations. Two start in the same second; one is still in progress, one failed. */
export const CONVERSATIONS: readonly SyntheticConversation[] = [
  { conversation_id: "conv_01", ...SUPPORT, at: "2026-10-21T09:00:00Z", status: "done", call_successful: "success", direction: "inbound" },
  { conversation_id: "conv_02", ...BOOKING, at: "2026-10-22T10:30:00Z", status: "done", call_successful: "failure", direction: "outbound" },
  { conversation_id: "conv_03b", ...SUPPORT, at: "2026-10-23T14:00:00Z", status: "done", call_successful: "unknown", direction: "inbound" },
  { conversation_id: "conv_03a", ...BOOKING, at: "2026-10-23T14:00:00Z", status: "failed", call_successful: "unknown" },
  { conversation_id: "conv_04", agent_id: "agent_03synthnoname00000000000", at: "2026-10-25T08:15:00Z", status: "done", call_successful: "success", direction: "inbound" },
  { conversation_id: "conv_05", ...SUPPORT, at: "2026-10-28T16:45:00Z", status: "done", call_successful: "success" },
  { conversation_id: "conv_06", ...BOOKING, at: "2026-10-30T11:00:00Z", status: "processing", call_successful: "unknown", direction: "inbound" },
  { conversation_id: "conv_07", ...SUPPORT, at: "2026-11-01T11:30:00Z", status: "in-progress", call_successful: "unknown", direction: "inbound" },
  { conversation_id: "conv_08", ...BOOKING, at: "2026-11-01T11:40:00Z", status: "done", call_successful: "success", direction: "inbound" },
]

/** An agent whose name holds a password in a link: a secret the source must refuse for good. */
export const SECRET: SyntheticConversation = {
  conversation_id: "conv_05s",
  agent_id: "agent_04synthstaging0000000000",
  agent_name: "Staging https://pilot:Wq7rZp4xLm9@files.example.net/agent",
  at: "2026-10-27T10:00:00Z",
  status: "done",
  call_successful: "success",
  direction: "inbound",
}

/** What other people said or are: present in every answer, so a test can prove none of it reaches an event. */
export const CALLER_TEXT = ["Caller Jo Example asked to move their 3pm appointment", "+44 7700 900123", "Jo Example"]

/** One conversation as the list answers it, with the fields events_list must never read. */
function summaryOf(conversation: SyntheticConversation) {
  return {
    agent_id: conversation.agent_id,
    ...(conversation.agent_name === undefined ? { agent_name: null } : { agent_name: conversation.agent_name }),
    conversation_id: conversation.conversation_id,
    start_time_unix_secs: Date.parse(conversation.at) / 1000,
    call_duration_secs: 95,
    message_count: 12,
    status: conversation.status,
    call_successful: conversation.call_successful,
    ...(conversation.direction ? { direction: conversation.direction } : {}),
    branch_id: null,
    version_id: null,
    termination_reason: "",
    call_summary_title: CALLER_TEXT[0],
    transcript_summary: `${CALLER_TEXT[0]}; they gave ${CALLER_TEXT[1]}.`,
    main_language: "en",
    conversation_initiation_source: "twilio",
    rating: null,
    user_id: CALLER_TEXT[2],
    tag_ids: [],
  }
}

/** An agent of the workspace and its privacy settings, as agents_get gives them under `fields`; none for the default. */
export interface SyntheticAgent {
  readonly agent_id: string
  readonly name: string
  readonly archived?: boolean
  readonly privacy?: { readonly retention_days?: number; readonly zero_retention_mode?: boolean }
}

/**
 * The workspace's agents: one keeps conversations without limit, one states no privacy settings (two years, ElevenLabs'
 * default), one keeps them 30 days, one a year, and two keep none (retention 0, and an archived one in Zero Retention
 * Mode), which the source never sees and answers no gap for. The latest horizon is therefore 30 days back.
 */
export const AGENTS: readonly SyntheticAgent[] = [
  { agent_id: "agent_01synthsupport0000000000", name: "Support Desk", privacy: { retention_days: -1 } },
  { agent_id: "agent_02synthbooking0000000000", name: "Booking Line" },
  { agent_id: "agent_03synthnoname00000000000", name: "", privacy: { retention_days: 30 } },
  { agent_id: "agent_04synthstaging0000000000", name: "Staging", privacy: { retention_days: 365, zero_retention_mode: false } },
  { agent_id: "agent_06synthnokeep00000000000", name: "No history", privacy: { retention_days: 0 } },
  { agent_id: "agent_05synthzrm00000000000000", name: "Zero retention", archived: true, privacy: { retention_days: 30, zero_retention_mode: true } },
]

/** The retention horizon the agents above give at NOW: 30 days back. */
export const HORIZON = NOW - 30 * 86_400_000

export interface ToolCall {
  readonly tool: string
  readonly input: Readonly<Record<string, unknown>>
}

/**
 * The workspace's three free reads, as OpenCode's executor runs them (`{ output, content }`):
 *
 * - agents_list_conversations over `conversations`: `call_start_after_unix` keeps the conversations that started after
 *   it, `sort_direction` orders by start (ties in the order given, as ElevenLabs does not state theirs), and the opaque
 *   `next_cursor` is an offset;
 * - agents_list over `agents`, filtered by `archived`, paged the same way;
 * - agents_get with `fields`, keying each value under `config` by its path, as the live tool says it does.
 *
 * `fail` makes a call throw the executor's Tool.Error, as OpenCode raises ElevenLabs' own.
 */
export function syntheticWorkspace(
  options: { readonly conversations?: readonly SyntheticConversation[]; readonly agents?: readonly SyntheticAgent[]; readonly fail?: (call: number, tool: string) => string | undefined } = {},
) {
  const conversations = options.conversations ?? CONVERSATIONS
  const agents = options.agents ?? AGENTS
  const calls: ToolCall[] = []
  const answer = (value: unknown) => ({ output: value, content: [{ type: "text", text: JSON.stringify(value) }] })
  const paged = <T>(items: readonly T[], input: Record<string, unknown>, fallback: number) => {
    const size = typeof input["page_size"] === "number" ? input["page_size"] : fallback
    const offset = typeof input["cursor"] === "string" ? Number(input["cursor"].replace(/^page-/, "")) : 0
    const more = offset + size < items.length
    return { slice: items.slice(offset, offset + size), more, next_cursor: more ? `page-${offset + size}` : null }
  }
  const execute = async (tool: string, input: Record<string, unknown>) => {
    calls.push({ tool, input: structuredClone(input) })
    const failure = options.fail?.(calls.length, tool)
    if (failure !== undefined) throw Object.assign(new Error(failure), { _tag: "Tool.Error", message: failure })
    if (tool === "agents_list") {
      const page = paged(agents.filter((agent) => (agent.archived ?? false) === (input["archived"] ?? false)), input, 30)
      return answer({ agents: page.slice.map((agent) => ({ agent_id: agent.agent_id, name: agent.name, tags: [], created_at_unix_secs: 1_760_000_000 })), has_more: page.more, next_cursor: page.next_cursor })
    }
    if (tool === "agents_get") {
      const agent = agents.find((item) => item.agent_id === input["agent_id"])
      if (!agent) throw Object.assign(new Error("Agent not found"), { _tag: "Tool.Error", message: "Agent not found" })
      return answer({ agent_id: agent.agent_id, branch_id: "agtbranch_main", version_id: null, config: agent.privacy ? { "platform_settings.privacy": agent.privacy } : {} })
    }
    if (tool !== "agents_list_conversations") throw new Error(`the synthetic workspace has no ${tool}`)
    const after = typeof input["call_start_after_unix"] === "number" ? input["call_start_after_unix"] : -Infinity
    const ascending = input["sort_direction"] === "asc"
    const matching = conversations
      .map((conversation, order) => ({ conversation, order, start: Date.parse(conversation.at) / 1000 }))
      .filter((entry) => entry.start > after)
      .sort((a, b) => (ascending ? a.start - b.start : b.start - a.start) || a.order - b.order)
    const page = paged(matching, input, 30)
    return answer({ conversations: page.slice.map((entry) => summaryOf(entry.conversation)), has_more: page.more, next_cursor: page.next_cursor })
  }
  return { execute, calls }
}
