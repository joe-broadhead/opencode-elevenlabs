---
name: elevenlabs
description: Manage the voice and chat agents in the user's ElevenLabs workspace through the hosted MCP server - find, read, create, update, duplicate, test, branch, deploy and delete agents, and work with their knowledge base, tools and conversations. Use when the task is about the agents themselves, not about generating audio or images. Not for meeting notes or transcripts of your own calls (Granola, Wispr Flow, Plaud), and not for building ElevenLabs into the user's own code, which needs the SDK and an API key.
license: MIT
---

If no `elevenlabs_*` tools are in this session, no one is signed in: run `/connect`, choose ElevenLabs, and sign in; on Jelly, call `jelly_connection_request` instead.

# ElevenLabs agents

Read this before the first `agents_*` call. Every tool takes a `context` parameter: pass one short line naming the user's
goal, with no caller's name, number or words in it.

## Start by reading

`agents_list` to find the agent, then `agents_get` for its configuration. Ids only ever come from a tool result or the
user; never guess or rebuild one. `agents_get` is a read and runs freely:

```js
const found = await tools.elevenlabs.agents_list({ context: "find the checkout agent" })
const agent = await tools.elevenlabs.agents_get({ agent_id: found[0].agent_id, context: "read the checkout agent" })
```

## Changing an agent

`agents_update` **publishes to the live branch immediately**, `main` by default. It is not a draft and this plugin cannot
undo it. So:

- read the agent first, and send only the fields that should change;
- say what will change and that it goes live, in one sentence;
- for anything a caller could notice, prefer `agents_create_branch`, make the change on the branch, then
  `agents_merge_branch_preview` before `agents_merge_branch`.

`agents_duplicate` is usually better than rebuilding a configuration by hand.

## Knowledge base

Add with `agents_create_kb_url` (a page that can keep syncing) or `agents_create_kb_text`; organise with
`agents_create_kb_folder`. Before a delete, check `agents_get_kb_dependents`: other agents may use the document.
`agents_bulk_delete_knowledge_base` is irreversible.

## Tests and deployment

Create a test with `agents_create_test`; inspect past runs with `agents_list_test_runs` and `agents_get_test_run`.
`agents_run_tests` **spends credits**: it makes the agent hold conversations, and ElevenLabs offers no estimate for it,
so while a credit cap is on the plugin refuses it with `PRICE_UNKNOWN`. A deployment moves live traffic:
`agents_create_deployment` after a merge, not before.

## Cost

Before a change that switches the model, `agents_calculate_llm_usage` reports what a conversation would cost. Say the
figure and its basis when the user is choosing.

## Deletes

`agents_delete`, `agents_delete_tool`, `agents_delete_phone_number` and `agents_bulk_delete_knowledge_base` cannot be
undone. Say what will be deleted and whom it affects, in one sentence, then make the one call: the plugin asks for
permission at `access: "ask-changes"` and refuses it at `"read-only"`. If the call is declined, nothing changed.

## Not this skill

Call history and transcripts are `elevenlabs-calls`. Generation is `elevenlabs-creative`.
