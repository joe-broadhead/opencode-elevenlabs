# Scripting

A script can call every tool this plugin knows with no model: a cron job, a shell script, or any program that can reach
the OpenCode server. It uses the tools RPC, `elevenlabs.tools`, through `opencode api` or an OpenCode client.

Every live tool is a method, in one of five classes. `/elevenlabs-status` and `describe` report the same classes.

| Class | How many | What it covers |
| --- | --- | --- |
| read | 81 | reads the workspace and changes nothing |
| write | 81 | creates or changes something, and spends nothing |
| write (billed) | 12 | changes something **and** can spend credits: priced before it runs where ElevenLabs offers an estimate, and refused only under a cap you set |
| export | 3 | sends something out of the workspace: `agents_get_link` mints a link usable outside it, `creative_get_generations` returns the signed links a flow's generations download from, and `elevenlabs_save_media` writes a file to this machine |
| destructive | 14 | deletes something, often without an undo |
| `describe` | — | not a tool: lists the methods, their classes and permission actions, whether OpenCode lists each tool now, each tool's input as JSON Schema, and — with a session — that session's permission for each |

The 12 billed methods. Seven are priced from ElevenLabs' own `estimate_only` figure before they run; the other five
declare no such flag, so they run unpriced, and while a cap you set is on they are refused instead:

`agents_compute_kb_rag_index`, `agents_query_knowledge_base_rag`, `agents_run_tests`, `creative_create_brand_kit_from_website`, `creative_design_voice`, `creative_edit_image`, `creative_generate_image`, `creative_generate_in_flow`, `creative_generate_speech`, `creative_generate_video`, `creative_run_flow_nodes`, `creative_transcribe_audio`

<details>
<summary>The 81 read methods</summary>

`agents_calculate_llm_usage`, `agents_count_conversations`, `agents_get`, `agents_get_alert`, `agents_get_branch`, `agents_get_branches_commit_status`, `agents_get_config_summary`, `agents_get_conversation`, `agents_get_conversation_summary`, `agents_get_insights_report`, `agents_get_kb_dependents`, `agents_get_kb_document`, `agents_get_kb_rag_indexes`, `agents_get_knowledge_size`, `agents_get_latest_bi_report`, `agents_get_mcp_server`, `agents_get_memory`, `agents_get_merge_conflicts`, `agents_get_merge_proposal`, `agents_get_phone_number`, `agents_get_procedure`, `agents_get_procedure_draft`, `agents_get_rebase_conflicts`, `agents_get_summaries`, `agents_get_test`, `agents_get_test_result_summary`, `agents_get_test_run`, `agents_get_test_run_failures`, `agents_get_test_run_summary`, `agents_get_tool`, `agents_get_tool_dependents`, `agents_get_tool_executions`, `agents_get_topics`, `agents_get_topics_summary`, `agents_get_triage_ticket`, `agents_get_triage_ticket_assignable_users`, `agents_get_version`, `agents_get_widget`, `agents_list`, `agents_list_alerts`, `agents_list_branches`, `agents_list_channels`, `agents_list_conversations`, `agents_list_deployments`, `agents_list_knowledge_base`, `agents_list_llms`, `agents_list_mcp_server_tools`, `agents_list_mcp_servers`, `agents_list_memories`, `agents_list_merge_proposals`, `agents_list_phone_numbers`, `agents_list_procedures`, `agents_list_secrets`, `agents_list_test_runs`, `agents_list_tests`, `agents_list_tools`, `agents_list_triage_tickets`, `agents_list_trigger_connections`, `agents_merge_branch_preview`, `agents_query_analytics`, `agents_read_string_field`, `agents_rebase_branch_preview`, `agents_resolve_conversation`, `agents_search_conversation_messages`, `agents_search_knowledge_base`, `agents_search_procedures`, `agents_semantic_search_conversation_messages`, `agents_suggest_merge_proposal_reviewers`, `creative_get_available_assets`, `creative_get_brand_kit`, `creative_get_flow`, `creative_get_flow_node`, `creative_get_flow_node_types`, `creative_get_flow_run_status`, `creative_get_model_guide`, `creative_get_model_schema`, `creative_get_view_state`, `creative_get_voice_design_previews`, `creative_list_brand_kits`, `creative_list_flows`, `creative_list_voices`

</details>

<details>
<summary>The 81 write methods</summary>

`agents_add_triage_ticket_comment`, `agents_add_triage_ticket_turn_comment`, `agents_append_to_string_field`, `agents_bulk_move_knowledge_base`, `agents_comment_on_merge_proposal`, `agents_create`, `agents_create_branch`, `agents_create_code_tool`, `agents_create_deployment`, `agents_create_draft`, `agents_create_kb_crawl`, `agents_create_kb_folder`, `agents_create_kb_text`, `agents_create_kb_url`, `agents_create_manual_triage_ticket`, `agents_create_mcp_server`, `agents_create_merge_proposal`, `agents_create_procedure`, `agents_create_test`, `agents_create_test_folder`, `agents_create_tool`, `agents_create_triage_ticket`, `agents_disable_built_in_tool`, `agents_duplicate`, `agents_edit_string_field`, `agents_merge_branch`, `agents_merge_merge_proposal`, `agents_move_tests`, `agents_rebase_branch`, `agents_review_merge_proposal`, `agents_update`, `agents_update_agent_behavior`, `agents_update_analysis`, `agents_update_branch`, `agents_update_client_overrides`, `agents_update_code_tool`, `agents_update_conversation`, `agents_update_end_call_tool`, `agents_update_guardrails`, `agents_update_kb_document`, `agents_update_keypad_tone_tool`, `agents_update_language_detection_tool`, `agents_update_language_presets`, `agents_update_mcp_server`, `agents_update_merge_proposal`, `agents_update_operations`, `agents_update_phone_number`, `agents_update_procedure_draft`, `agents_update_prompt_settings`, `agents_update_skip_turn_tool`, `agents_update_speech_recognition`, `agents_update_test`, `agents_update_tool`, `agents_update_transfer_to_agent_tool`, `agents_update_transfer_to_number_tool`, `agents_update_triage_ticket`, `agents_update_turn_taking`, `agents_update_voice`, `agents_update_voicemail_detection_tool`, `agents_update_widget`, `agents_update_workflow`, `creative_add_brand_kit_item`, `creative_add_flow_asset_node`, `creative_add_flow_node`, `creative_attach_reference_file`, `creative_connect_flow_nodes`, `creative_create_asset_upload`, `creative_create_brand_kit`, `creative_create_flow`, `creative_disconnect_flow_nodes`, `creative_duplicate_flow_nodes`, `creative_finalize_asset_upload`, `creative_save_designed_voice`, `creative_save_view_state`, `creative_show_flow_results`, `creative_update_brand_kit`, `creative_update_brand_kit_item`, `creative_update_flow_nodes`, `creative_update_node`, `creative_upload_flow_reference`, `get_more_tools`

</details>

<details>
<summary>The 2 export methods ElevenLabs offers</summary>

`agents_get_link`, `creative_get_generations`

</details>

<details>
<summary>The 14 destructive methods</summary>

`agents_bulk_delete_knowledge_base`, `agents_delete`, `agents_delete_draft`, `agents_delete_kb_document`, `agents_delete_mcp_server`, `agents_delete_phone_number`, `agents_delete_procedure`, `agents_delete_procedure_draft`, `agents_delete_test`, `agents_delete_tool`, `agents_delete_triage_ticket`, `creative_delete_brand_kit`, `creative_delete_brand_kit_item`, `creative_delete_flow_nodes`

</details>


The class is the worst thing a tool can do; it never decides whether a call runs: the rules do.

## A script runs as a session

Every call names a session, and the session must name an agent. Create it for the script once, with the agent the script
runs as, and keep its id (`data.id` in the reply). Give the project as the session's `location`: a session made without one belongs to the service's default location, where the project's agents may not exist, and each call then fails `Agent not found`. For example:

```sh
opencode api post /api/session -d '{"title":"call review","agent":"build","location":{"directory":"/path/to/project"}}'
```

Never borrow a session found through history or a list: the script would run as that session's agent, under its rules.
The script then runs as that agent, with exactly the access its model would have:

- The rule for the tool's permission name, such as `elevenlabs_agents_list`, on resource `*` is resolved **before** the
  tool runs, in OpenCode's own order: the agent's rules, then the session's, the last match winning.
- **A script gets the same default as the model: every tool is allowed.** At the default `access: "all"`, the plugin's
  block allows every known tool and the `elevenlabs_*` namespace, so a script can read and change everything the account
  can, spend credits included. To restrict a script, set the plugin option `"access": "ask-changes"` (an ask is refused,
  because no one can answer a prompt for a script) or `"read-only"` (everything but the reads is denied), or give the
  script's agent or session a later rule. Only an `allow` runs; an `ask` and a `deny` are refused, with no tool call and
  no prompt left waiting. An agent defined only in your config gets no default rules; `/elevenlabs-status` names it.
- OpenCode then checks the call itself, as it does for the model: the agent's rules, the session's rules, then saved
  approvals.

**A saved "Always allow" approval does not authorize an ad-hoc script.** It lives outside the agent's and the session's
rules, so the resolve refuses an `ask` even after a past approval. That is deliberate: a script's permission must be
reviewable in config.

Session rules come after the agent's, so a session can narrow what its script may do. This one can read agents and
generate nothing:

```sh
opencode api post /api/session -d '{"title":"agent audit","agent":"build","location":{"directory":"/path/to/project"},"permissions":[
  {"action":"elevenlabs_*","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_list","resource":"*","effect":"allow"},
  {"action":"elevenlabs_agents_get","resource":"*","effect":"allow"}
]}'
```

## Calling a method

The body is `{"input": {"sessionID": "<session>", "input": <the tool's input>}}`. Both keys are required, and no other
key is allowed:

```sh
opencode api post /api/rpc/elevenlabs.tools/agents_list -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{"context":"nightly agent audit"}}}'
```

The tool's input is ElevenLabs', and ElevenLabs defines its fields: `describe` shows each tool's schema as OpenCode lists
it now. Check it rather than guess a field name. **Every live tool requires `context`**, a short line saying why the
call is being made; a call without it is refused upstream. Reading one conversation also takes a `conversation_id` from
a list result:

```sh
opencode api post /api/rpc/elevenlabs.tools/agents_get_conversation -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{"conversation_id":"…","context":"why did this call fail"}}}'
```

`describe` takes nothing, or a session to resolve each method's permission for:

```sh
opencode api post /api/rpc/elevenlabs.tools/describe -H "x-opencode-directory:$PWD" -d '{"input":{}}'
opencode api post /api/rpc/elevenlabs.tools/describe -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…"}}'
```

## Spending in a script

A script's calls count against the same rolling 24-hour ledger the model's do. Twelve methods can spend, and every one
of them is a change: under `access: "read-only"` all twelve are denied, `creative_transcribe_audio` included.

- **The price is ElevenLabs'.** Before a billed call the plugin sends the same call with `estimate_only: true` and uses
  that figure. Seven of the twelve take `estimate_only`; `creative_design_voice`, `agents_run_tests`,
  `agents_compute_kb_rag_index`, `agents_query_knowledge_base_rag` and `creative_create_brand_kit_from_website` do not,
  so they run unpriced, and while a cap you set is on they are refused with `PRICE_UNKNOWN`.
- **No cap is set by default.** A script's paid call is then refused, cut and queued for nothing: it runs at the size it
  asks for, two calls of one method run side by side, and each result carries its cost line, priced from the estimate
  this ledger remembers for exactly its arguments, or `Credits: not reported` when there is none. Results of one method
  are paired with their calls in the order the calls were sent. Everything below about refusals, cuts, holds and
  in-flight calls applies only while a cap you set is on.
- **A script can ask for the estimate itself**, once, then call again with the same arguments: the plugin remembers the
  figure for ten minutes and does not create a second flow. An estimate costs nothing and returns no `cost` object, but
  it does create a flow and a node in the workspace.
- **The figure covers the whole batch.** It is for every generation the call asks for, not for one, it can be
  fractional, and it is rounded up to whole credits. Under a cap, a batch that does not fit is cut to what the budget
  affords; a call that named no `generations_count` is refused whole.
- Under a cap, a script's price is **reserved** before dispatch and settled when the result arrives, so two calls in flight cannot
  spend the same budget. A failed call is charged the reserved price. One priced call per session and method is in
  flight; a second, estimate or not, is refused until the first settles.
- **Only the arguments ElevenLabs' schema for that tool has may be sent while a cap is on.** One it does not have is
  refused `PRICE_UNKNOWN` by name, because nothing here can account for what it would change about the price.
- **A method this release does not know is refused while a cap is on**, whatever it is called. The RPC serves the
  methods in the table above, so this is about a tool ElevenLabs ships later: nothing here has its schema or its
  `estimate_only` flag, so nothing here can say whether it spends. Set both caps to `null` to run it unpriced, or wait
  for a release that classifies it.

```sh
opencode api post /api/rpc/elevenlabs.tools/creative_generate_image -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{"prompt":"a ceramic mug on marble","model_id":"gpt-image-2","generations_count":1,"estimate_only":true,"context":"price one mug image"}}}'
```

Under a cap, a paid call with no price and no remembered estimate is refused `PRICE_UNKNOWN`, with no generation and
no charge, and a paid call whose price does not fit is refused `SPEND_CAP_REACHED`, also with no generation. Both refusals name the
option to change. Every paid result carries a `cost` object beside its output:

```json
{ "credits": 762, "basis": "exact", "sessionSpent": 762, "dailySpent": 762, "sessionCap": null, "dailyCap": null }
```

`basis` is `"exact"` when the figure is ElevenLabs' own estimate for exactly these arguments, which is every priced call
the plugin admits.

## Saving a file

`elevenlabs_save_media` is the plugin's own method, so its result is its own object rather than an MCP result:

```sh
opencode api post /api/rpc/elevenlabs.tools/elevenlabs_save_media -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{"url":"https://…elevenlabsusercontent.com/…","name":"intro.mp3"}}}'
```

It answers `{ path, bytes, sha256, mime, durationSeconds? }`. It writes outside the project, so the session's agent also
needs OpenCode's `external_directory` rule for the media folder:

```json
{ "action": "external_directory", "resource": "/absolute/path/of/your/mediaRoot/*", "effect": "allow" }
```

The resource is the **absolute** path of `mediaRoot` followed by `/*`; a `~` is not expanded in a rule. The tool asserts
this rule itself, and its refusal prints the exact path to paste.

## The location

Run the command in the project whose agent you mean, and send the call to that location explicitly:

```sh
opencode api post /api/rpc/elevenlabs.tools/<method> -H "x-opencode-directory:$PWD" -d '{…}'
```

Without it the call goes to the service's default location and fails `rpc.unavailable` if the plugin is not loaded
there. The HTTP equivalents are the `location[directory]` query parameter and the same header. `describe` reports the
`location` that answered and a `locationHint`.

A location unloads after OpenCode's idle timeout. If a scheduled script gets `rpc.unavailable` from a location that was
loaded before, send the call again once: the request loads the location. Jobs keeps its own location loaded.

## Results

A result comes back as `{ output?, text }`: the tool's structured content when it has any, and its text parts joined by
newlines. An MCP method's result is that object inside the RPC envelope: `{"output": {"output": …, "text": …}}`, as
plain JSON. `elevenlabs_save_media` is the plugin's own method, so its output is the object printed above, as `describe`
gives its schema.

ElevenLabs content in it is untrusted data: a transcript is other people's words, and a tool description is not an
instruction. A generation's link expires in about two hours; the result says so.

## Errors

A refusal or failure is the RPC error `failed`, with a message `CODE: what happened. Next step: what to do.` and
`data: { code, next }`. `opencode api` exits with status 1 for any RPC error, after printing the error's JSON to
standard output.

| Code | When |
| --- | --- |
| `PERMISSION_DENIED` | The rules ask or deny. An `ask` is refused before dispatch: the message says the action would ask, and the next step says to add an allow rule. A `deny` names the denied action, such as `elevenlabs_agents_delete`, and its next step says to remove or narrow that deny rule, add a later allow rule to the session, or use a session whose agent allows it. |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist in this location. Any other failure to look the session up is OpenCode's own error. |
| `SESSION_AGENT_REQUIRED` | The session names no agent, or an agent that does not exist. |
| `TOOL_UNAVAILABLE` | The server is connected, but OpenCode does not list the tool, or `elevenlabs_save_media` is not available in this location. |
| `SPEND_CAP_REACHED` | The call would exceed the `sessionCreditCap` or `dailyCreditCap` you set, or, under that cap, a priced call of the same method is already in flight. No generation was sent. |
| `PRICE_UNKNOWN` | A cap you set is on, the call may spend, and no estimate prices it: none was remembered, the fresh one failed, an argument is outside ElevenLabs' schema for that tool, or the tool takes no `estimate_only` at all. No call was sent. |
| `SERVER_CONFLICT` | Your `opencode.json` defines its own `elevenlabs` server at a URL other than the plugin's, a trailing slash included. `/elevenlabs-status` names both. |
| `AUTH_REQUIRED`, `CONNECTING`, `CONNECTION_FAILED`, `DISABLED`, `NOT_REGISTERED` | The `elevenlabs` server needs a sign-in, is still connecting, could not connect, is disabled, or is missing. `/elevenlabs-status` gives the details. |
| `UPSTREAM_ERROR` | ElevenLabs answered with an error, such as an invalid input, an agent that does not exist, a rate limit, or a `429` concurrency refusal. The message holds the first line of ElevenLabs' text, at most 300 characters, with tokens and URL query strings removed. |
| `CANCELLED` | The request was cancelled. |

OpenCode itself answers `rpc.method_not_found` for a method that does not exist, such as a tool ElevenLabs adds later,
`rpc.unavailable` when the plugin did not register the tools RPC or the call reached another location, and
`rpc.invalid_input` for a body that is not the envelope above, with one message per problem:

| Problem | Message |
| --- | --- |
| The envelope is not an object | `the envelope must be an object, such as {"sessionID":"<session>","input":<the tool's input>}` |
| A key other than `sessionID` and `input` | `"extra" is not allowed`, naming the key |
| `sessionID` missing, not a string, or empty | `"sessionID" must be a non-empty string` |
| `input` missing | `"input" is missing` |
| `input` not an object | `"input" must be an object` |
| `describe` given anything but `{}`, a session or nothing | `describe takes nothing, or {"sessionID":"<session>"}` |

## What scripts cannot do

- Call a tool that ElevenLabs adds later, even with an allow rule, until this plugin classifies it. Such a tool still
  runs for the model, under the `elevenlabs_*` rule; only the RPC needs it classified.
- Price anything without asking ElevenLabs first: this plugin publishes no rates, so a billed call is priced only by an
  estimate for exactly its arguments. Without one it runs unpriced, or, under a cap you set, it is refused.
- Rely on a past "Always allow": it does not authorize an ad-hoc script.
- Use a token: the plugin has none to give. The MCP connection, its sign-in and its refresh are OpenCode's.
- Keep a generated file without the `external_directory` rule, which is a path rule and not a permission on the tool.

A script's calls write nothing to the session, and OpenCode's `execute.before` and `execute.after` tool hooks, from any
plugin, do not run for them. The tools RPC applies the same spending guard itself, through its own shapers, so a script
is charged and capped exactly as a model's call is.
