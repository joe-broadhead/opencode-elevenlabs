// A synthetic ElevenLabs workspace for the source contract's tests: agents_list_conversations answering as the live
// tool does (its public API reference: `conversations`, `has_more`, `next_cursor`; each conversation's
// `conversation_id`, `agent_id`, `agent_name`, `start_time_unix_secs`, `status`, `call_successful`, `direction`, with
// the transcript summary, title and other fields present to prove they are never read). Every id, name and time is
// invented. No ElevenLabs call, no sign-in.

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

export interface ListCall {
  readonly input: Readonly<Record<string, unknown>>
}

/**
 * agents_list_conversations over `conversations`: `call_start_after_unix` keeps the conversations that started after
 * it, `sort_direction` orders by start (ties in the order given, as ElevenLabs does not state theirs), and the opaque
 * `next_cursor` is an offset. `fail` makes a call throw the executor's Tool.Error, as OpenCode raises ElevenLabs' own.
 */
export function syntheticList(options: { readonly conversations?: readonly SyntheticConversation[]; readonly fail?: (call: number) => string | undefined } = {}) {
  const conversations = options.conversations ?? CONVERSATIONS
  const calls: ListCall[] = []
  const list = async (input: Record<string, unknown>) => {
    calls.push({ input: structuredClone(input) })
    const failure = options.fail?.(calls.length)
    if (failure !== undefined) throw Object.assign(new Error(failure), { _tag: "Tool.Error", message: failure })
    const after = typeof input["call_start_after_unix"] === "number" ? input["call_start_after_unix"] : -Infinity
    const size = typeof input["page_size"] === "number" ? input["page_size"] : 30
    const ascending = input["sort_direction"] === "asc"
    const matching = conversations
      .map((conversation, order) => ({ conversation, order, start: Date.parse(conversation.at) / 1000 }))
      .filter((entry) => entry.start > after)
      .sort((a, b) => (ascending ? a.start - b.start : b.start - a.start) || a.order - b.order)
    const offset = typeof input["cursor"] === "string" ? Number(input["cursor"].replace(/^page-/, "")) : 0
    const slice = matching.slice(offset, offset + size)
    const more = offset + size < matching.length
    const answer = { conversations: slice.map((entry) => summaryOf(entry.conversation)), has_more: more, ...(more ? { next_cursor: `page-${offset + size}` } : { next_cursor: null }) }
    return { output: answer, content: [{ type: "text", text: JSON.stringify(answer) }] }
  }
  return { list, calls }
}
