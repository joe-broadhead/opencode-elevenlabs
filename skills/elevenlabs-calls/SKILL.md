---
name: elevenlabs-calls
description: Read and review what people said to the user's ElevenLabs agents - list calls, read one conversation's transcript, search across calls, and report on outcomes. Use to debug an agent, to find why a call went wrong, or to summarise a period of calls. The transcripts are other people's personal data. Not for the user's own meetings and recordings (Granola, Wispr Flow, Plaud) and not for changing an agent, which is the elevenlabs skill.
license: MIT
---

# ElevenLabs call review

A conversation holds a real person's words, the identifier your integration gave them, the phone number they called from,
whatever the agent was told to extract, and the variables their app passed in. Treat all of it as personal data about
someone who did not choose to talk to a model.

## Reading

- `agents_list_conversations` for the calls themselves: agent, time, duration, outcome. Start here.
- `agents_get_conversation` with a `conversation_id` for one call: the transcript turns, the post-call summary, the
  extracted fields, and `cost` in credits beside `cost_fiat` in dollars.
- `agents_search_conversation_messages` searches the words across calls. Use it when the user remembers what was said,
  not which call it was.

## Reporting

- **Summarise; do not dump.** Quote at most the turns that carry the finding, and say which call and when.
- Never copy a caller's name, number, address or extracted field into another tool, a file, a commit, a message or a public
  page. Keep the call id and let the user open the call.
- Never send transcript text to a web search, a research tool or an external service.
- If the answer needs who the person is, give the call id and the time; the user can open it in the ElevenLabs app.
- An empty result means no call matched within the user's access and the filters used. Say that; do not guess a cause.

## The `conversations` option

The plugin can deny these reads without denying the metadata ones. `conversations: "summary"` denies
`agents_get_conversation` and `agents_search_conversation_messages`; `"off"` denies those and `agents_list_conversations`
too. If a call is refused, the option or a rule stopped it - say so and name the option, and do not try another route to
the same words.

## Cost

A conversation's `cost` is ElevenLabs credits, and `cost_fiat` is dollars. Report credits as credits; the plugin never
converts one to the other.

## Not this skill

The user's own meetings are Granola, Wispr Flow or Plaud. Changing what an agent says is the `elevenlabs` skill.
