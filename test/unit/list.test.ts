// The list snapshot: what it answers, what it refuses, and that it stays inside the declared caps. No ElevenLabs call:
// the read is a fake that answers as `agents_list_conversations` does.
import { describe, expect, test } from "bun:test"
import { ACCOUNT, EVENTS_INPUT, EVENTS_METHOD_OUTPUT, EVENTS_OUTPUT, LIST_ANSWER, MAX_BYTES, SOURCE, conversationList, type Read } from "../../src/events.js"
import { NOW, OWNER } from "../support/synthetic-conversations.js"

/** One conversation as the read answers it. */
const conversation = (id: string, agentName: string) => ({
  conversation_id: id,
  agent_id: `agent_${id}`,
  agent_name: agentName,
  start_time_unix_secs: Math.floor(NOW / 1_000) - 3_600,
  status: "done",
  call_successful: "success",
  direction: "inbound",
})

const reading =
  (...conversations: unknown[]): Read =>
  async () => ({ conversations })

describe("the conversations list", () => {
  test("list is on the tools RPC method's input only, and its output accepts the events page or the list answer", () => {
    // Ruling (b): a list is for consumers, never on the model tool, so no agent's schema or description changes.
    expect(Object.keys(EVENTS_INPUT.properties)).not.toContain("list")
    expect(EVENTS_METHOD_OUTPUT.anyOf).toEqual([EVENTS_OUTPUT, LIST_ANSWER])
  })

  test("answers source, account, the list data, the read's time and untrusted", async () => {
    const answer = await conversationList(reading(conversation("conv_list_1", "Support Desk")), OWNER, {}, NOW)
    expect(answer).toEqual({
      source: SOURCE,
      account: ACCOUNT,
      data: { editable: false, items: [{ id: "conv_list_1", text: "Support Desk: inbound call, done, successful", done: true }] },
      asOf: new Date(NOW).toISOString(),
      trust: "untrusted",
    })
  })

  test("screens the whole title, then cuts it, so a secret straddling the 200-character cut is dropped", async () => {
    // The token starts at character 191 of the title, so a title cut to 200 first would end mid-secret and pass.
    const straddling = `${"A".repeat(190)} token=abcdef1234567890`
    const answer = await conversationList(reading(conversation("conv_list_cut", straddling), conversation("conv_list_ok", "Support Desk")), OWNER, {}, NOW)
    expect(answer.data.items.map((item) => item.id)).toEqual(["conv_list_ok"])
  })

  test("50 maximal items stay inside the declared maxBytes", async () => {
    const maximal = Array.from({ length: 50 }, (_, index) => conversation(`c${String(index).padStart(127, "0")}`, "B".repeat(400)))
    const answer = await conversationList(reading(...maximal), OWNER, {}, NOW)
    expect(answer.data.items).toHaveLength(50)
    for (const item of answer.data.items) expect(item.text).toHaveLength(200)
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(MAX_BYTES)
  })

  test("refuses another account, and needs a sign-in", async () => {
    const read = reading(conversation("conv_list_1", "Support Desk"))
    await expect(conversationList(read, OWNER, { account: "other" }, NOW)).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" })
    await expect(conversationList(read, undefined, {}, NOW)).rejects.toMatchObject({ code: "NEEDS_SIGN_IN" })
  })
})
