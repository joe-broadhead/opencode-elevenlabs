---
name: elevenlabs
description: Manage the voice and chat agents in the user's ElevenLabs workspace through the hosted MCP server - find, read, create, update, duplicate, test, branch, deploy and delete agents, and work with their knowledge base, tools and conversations. Use when the task is about the agents themselves, not about generating audio or images. Not for meeting notes or transcripts of your own calls (Granola, Wispr Flow, Plaud), and not for building ElevenLabs into the user's own code, which needs the SDK and an API key.
license: MIT
---

If no `elevenlabs_*` tools are in this session, no one is signed in: run `/connect`, choose ElevenLabs, and sign in; on Jelly, call `jelly_connection_request` instead.

# ElevenLabs agents

Read this before the first `agents_*` call. Pass only the arguments a tool's own schema lists.

## Start by reading

`agents_list` to find the agent, then `agents_get` for its configuration. Ids only ever come from a tool result or the
user; never guess or rebuild one. `agents_get` is a read and runs freely:

```js
const found = await tools.elevenlabs.agents_list({ search: "checkout" })
const agent = await tools.elevenlabs.agents_get({ agent_id: found[0].agent_id })
```

## Changing an agent

`agents_update` **publishes to the live branch immediately**, `main` by default. It is not a draft and this plugin cannot
undo it. So:

- read the agent first, and send only the fields that should change;
- say what will change and that it goes live, in one sentence;
- for anything a caller could notice, prefer `agents_create_branch`, make the change on the branch, then
  `agents_merge_branch_preview` before `agents_merge_branch`.

`agents_duplicate` is usually better than rebuilding a configuration by hand.

Workflow, attachment and test edits (`agents_add_workflow_node`, `agents_attach_tool`, `agents_duplicate_test` and the
like) are staged in your own draft of a branch, not live. `agents_publish_draft` **makes every staged change live to
callers at once**: say what goes live and on which branch, in one sentence, before calling it.

## Calls, numbers and people

These reach people outside this conversation. Confirm with the user first, every time, and make the one call:

- `agents_submit_batch_call` **places real phone calls** to every recipient in the list, now or at the scheduled time,
  and spends credits. Read the recipients back to the user and get a yes before calling it. `agents_retry_batch_call`
  calls the failed and unanswered recipients again, and spends again. `agents_cancel_batch_call` stops the recipients
  not yet called. `agents_list_batch_calls` and `agents_get_batch_call` report what happened.
- `agents_update_whatsapp_account` changes how an agent answers a WhatsApp number's users.
- `agents_request_merge_proposal_review` notifies the workspace members named.
- `agents_create_phone_number`, `agents_create_secret` and `agents_update_secret` store credentials that are never
  returned. Take a value only from the user, and never repeat it.

## Knowledge base

Add with `agents_create_kb_url` (a page that can keep syncing) or `agents_create_kb_text`; organise with
`agents_create_kb_folder`. Before a delete, check `agents_get_kb_dependents`: other agents may use the document.
`agents_bulk_delete_knowledge_base` is irreversible.

## Tests and deployment

Create a test with `agents_create_test`; inspect past runs with `agents_list_test_runs` and `agents_get_test_run`.
`agents_run_tests` and `agents_run_attached_tests` **spend credits**: they make the agent hold conversations, and
ElevenLabs offers no estimate for them, so say so before running one and report the cost line its result carries.
`agents_generate` (an LLM writes a whole agent) and `agents_generate_test_from_conversation` are counted as spending too. A deployment moves live traffic:
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
