# ElevenLabs for OpenCode

Manage the voice and chat agents in your ElevenLabs workspace, review what callers said to them, and generate speech,
images and video through ElevenLabs' official MCP server, from OpenCode.

Unofficial; not affiliated with ElevenLabs.

ElevenLabs is a trademark of Eleven Labs Inc. The icon is ElevenLabs' "11" symbol, unmodified, on a neutral holding shape three times its height, used under [ElevenLabs' brand guidelines](https://elevenlabs.io/brand) only to identify the service this plugin connects to.

## Requirements

- OpenCode `>=2.2.3 <2.3.0`. Tested on 2.2.3, 2.2.4, 2.2.5 and 2.2.6.
- macOS or Linux.
- An ElevenLabs account with a workspace. Generations spend that workspace's credits.

## Install

```sh
opencode plugin add github:joe-broadhead/opencode-elevenlabs#v0.0.1
```

Run `opencode reload`, or restart OpenCode, then run `/elevenlabs-status`.

Each release has its own tag, and a Git install does not update by itself. To move to a newer release, remove the old entry with `opencode plugin remove github:joe-broadhead/opencode-elevenlabs#v0.0.0`, then add the new tag with `opencode plugin add github:joe-broadhead/opencode-elevenlabs#v<version>`.

Or add the plugin to `opencode.json` instead, with the same spec:

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-elevenlabs#v0.0.1" }] }
```

The install takes the GitHub release tag. Its commit carries the built `dist/`, so the install runs no build.
A new release is a new tag: install it with its own `#v<version>` spec.

## Sign in

Run `/connect` and choose **ElevenLabs**. In the terminal, press `o` or Enter to open the link; on the command line,
`opencode mcp auth elevenlabs` opens the browser itself and `opencode auth login elevenlabs` does the same. Sign in with
your account, choose the workspace, and approve the permissions the consent screen lists.

No API key is copied anywhere, and no client ID ships with the plugin: ElevenLabs accepts a client metadata document, so
OpenCode registers itself with the consent screen. Revoke the connection at any time from OpenCode, or from your
ElevenLabs account settings.

The consent is for seven scopes: `convai_read`, `convai_write`, `text_to_speech`, `speech_history_read`, `flows`,
`image_video_generation` and `voice_generation`. ElevenLabs also advertises `ads_read`; this plugin never asks for it,
because it has no advertising tool.

## Use

Ask for what you want in your own words:

- "List my agents and tell me which ones still use the default first message."
- "My checkout agent fails when someone asks about refunds. Read yesterday's calls and tell me why."
- "Duplicate the production agent, change the voice, and set the first message to Spanish."
- "Price a five-second video of a ceramic mug in morning light, then make it if it is under 2,000 credits."
- "Save that voiceover to my Downloads folder."

One tool and one guard do more than relay ElevenLabs:

- **`elevenlabs_save_media`** writes a generated file to disk from the signed link a generation returns. The link expires
  about two hours after the generation, so this is how a result is kept. It answers with the path, size, sha256 and, when
  the file states one, the duration; the file itself never enters the conversation.
- **a spending guard** prices each generation, refuses one that does not fit the caps, and adds a cost line to every
  paid result.

A script can call the same tools with no model, under the same spending guard:

```sh
opencode api post /api/rpc/elevenlabs.tools/agents_list -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{"context":"list my agents"}}}'
```

[docs/scripting.md](https://github.com/joe-broadhead/opencode-elevenlabs/blob/HEAD/docs/scripting.md) has the envelope,
the estimate path and every refusal.

`/elevenlabs-status` prints the connection, the account, the region, the spend, the tools and one next step.
`/elevenlabs` opens the same report in a dialog. `/elevenlabs-doctor` makes the live checks a status report cannot.

## Spending

Generations are billed in **credits** against the workspace you signed in with.

- **Caps are on by default.** `sessionCreditCap` is 2,000 credits and `dailyCreditCap` is 10,000, counted over a rolling
  24 hours across sessions, scripts and restarts. A generation that does not fit is refused **before it is sent**, and a
  request for more variations than the budget affords is cut to what fits. Set either to `null` for no cap.
- **How far a cap reaches.** Every hold and every charge is written to this data directory's store under its own key,
  which only the OpenCode that created it ever rewrites, and a total is read by scanning those keys and adding them up.
  Nothing merges two writers' records, so no writer can drop another's charge. What a cap cannot do is decide across two
  running OpenCodes at once: `ctx.storage` has no compare-and-set and no lock, so each admits a call against what it has
  read. Exactly: **within one OpenCode the caps are exact; across OpenCodes a cap is crossed by at most one call's
  reservation for each one deciding before its read of the others' holds lands, so eight of them at 3,000 credits a
  call can spend 31,000 against a 10,000 cap; every OpenCode reads the store behind each call it admits and every five
  seconds besides, so none decides on a book older than that; a settled charge is never lost.** The crossing needs
  overlap: calls that wait for one another see one another, and those same eight, run one after the next, spend only
  the 9,000 that fits. Size a cap as the bound you can afford to be crossed once per extra OpenCode, not as a hard
  limit on the account. Two machines share nothing: the store cannot see them.
- **Every price comes from ElevenLabs, never from this plugin.** There is no rate table here: no credits per character,
  per second or per minute, and nothing measures a file on this machine. Before a call that can spend, the plugin sends
  ElevenLabs the **same call with `estimate_only: true`** and uses the figure that comes back. Twelve tools can spend:
  `creative_generate_speech`, `creative_generate_image`, `creative_generate_video`, `creative_edit_image`,
  `creative_generate_in_flow`, `creative_run_flow_nodes`, `creative_transcribe_audio`, `creative_design_voice`,
  `agents_run_tests`, `agents_compute_kb_rag_index`, `agents_query_knowledge_base_rag` and
  `creative_create_brand_kit_from_website`. The first seven take `estimate_only`; the other five do not, so while a cap
  is on they are refused rather than run unpriced. The last three are counted as spending because ElevenLabs' catalogue
  says neither way and the work they describe — embedding a document, running a RAG query, reading a website — is work
  it plausibly bills; a refusal you can turn off is better than a charge you did not see.
- **An estimate is free, but it is not nothing.** Measured against a real workspace: two estimates moved the balance by
  zero credits, and each left a flow and a node behind in the workspace. So one estimate is asked per set of arguments,
  the figure is kept for ten minutes, and the paid call reuses it instead of creating a second flow. The estimate is
  sent only where the paid call could run: the permission it asks for is the generation's own, so nothing is estimated
  if you say no, and under `access: "read-only"` every spending tool is denied and no estimate is sent either. The
  plugin raises that permission twice for one paid call — before the estimate, and again for the generation — so under
  `ask-changes` you may be prompted twice. Whether OpenCode folds the two into one prompt is OpenCode's to decide, and
  no release has measured it yet.
- **The figure is the whole batch.** ElevenLabs answers for every generation the call asks for, not for one — a
  four-image estimate came back as 761.5151418103446 credits, about 190 an image. Credits are charged as whole numbers,
  so a fractional figure is rounded up. A batch that does not fit is cut to the number of generations the budget
  affords, and a call that named no count is refused whole rather than quietly given a smaller batch.
- **A call that cannot be priced is refused, not guessed.** While either cap is on, each of the 12 tools that can spend is priced by ElevenLabs' own estimate or refused PRICE_UNKNOWN before it is sent, and so is any name this table does not classify, whatever it starts with.
  A failed or missing estimate, an argument ElevenLabs' own schema for that tool does not have, and a tool with no
  estimate at all each end there. The refusal says what to do: send the same call with `estimate_only: true`, or set
  both caps to `null`. A price of 0 is a refusal, not a free call.
- **Transcription spends like everything else.** `creative_transcribe_audio` transcribes a node on a flow — it takes no
  file and no path — and it is priced from its own estimate. It is **not** a read: `access: "read-only"` denies it along
  with every other tool that can spend.
- **Two calls that start together cannot both spend the same budget.** The price is reserved in the ledger before the call
  is sent and settled when its result arrives. A call that fails, or whose result never arrives, is charged the reserved
  price: the plugin cannot tell a free failure from a billed one, and over-counting is the safe side. A later result that
  reports a higher figure may replace that charge. A missing result, a zero, or an error does not free the budget. A hold
  still open after ten minutes is settled at the reserved price rather than dropped. On the script path, one priced call
  per session and method is in flight; a second is refused until the first settles.
- **Past a thousand priced calls in a day, the oldest ones are counted by the hour.** The detail log keeps the newest
  1,000 charges; an older charge still inside the window is folded into a total for its session and the hour it was
  spent in, which nothing afterwards can shrink. A folded total is kept while any minute of its hour is still inside the
  24 hours, so a folded charge can go on counting for up to an hour after its own day ran out. The cap errs high, never
  low, and only on a day that busy.
- **The caps bound this plugin, not your account.** Someone generating in the ElevenLabs app spends from the same pool,
  and so does a second MCP entry pointing at ElevenLabs under another name: its tools carry that name's prefix, which
  this plugin's guard never sees. `/elevenlabs-status` names such an entry when it finds one.
- **The balance is only visible with an API key.** Add one through `/connect` → **ElevenLabs API key (optional)** and
  status shows the workspace balance and its reset date. It is used for one read, the subscription, and never to
  generate. Without it the Spend row says the caps count this plugin's own calls only.
- **A retry is a second charge.** The skills poll for a result instead of asking again.
- **No dollar figure is derived from credits.** There is no published conversion; `cost_fiat`, when ElevenLabs reports
  it, is the dollars.

## Media and files

Generated files are saved under `mediaRoot`, default `~/Downloads/elevenlabs`, created on the first save with mode 0700.
Only a link on ElevenLabs' generated-file host is fetched, over `https`, with no redirect to any other host, and a file
larger than `maxMediaBytes` (200 MB by default) is refused.

That folder is outside your project, so **two rules apply**: the plugin's own permission, and OpenCode's
`external_directory` rule for the folder. The plugin asserts both before it fetches anything, and its refusal prints the
exact rule. To pre-approve the folder:

```json
{ "permissions": [
  { "action": "elevenlabs_save_media", "resource": "*", "effect": "allow" },
  { "action": "external_directory", "resource": "/absolute/path/of/your/mediaRoot/*", "effect": "allow" }
] }
```

The second resource is the **absolute** path of `mediaRoot` followed by `/*`; a `~` is not expanded in a rule, so write
the path out (`/absolute/path/...`, not `~/...`). A refusal that starts `permission.rejected: external_directory` or
`EXTERNAL_DIRECTORY_DENIED` needs that second rule.

## Regions

ElevenLabs runs separate environments, and an isolated one is a separate workspace with a separate account.

| `region` | Server |
| --- | --- |
| `global` (the default) | `https://api.elevenlabs.io/v1/mcp` |
| `us` | `https://api.us.elevenlabs.io/v1/mcp` |
| `eu` | `https://api.eu.residency.elevenlabs.io/v1/mcp` |
| `in` | `https://api.in.residency.elevenlabs.io/v1/mcp` |
| `sg` | `https://api.sg.residency.elevenlabs.io/v1/mcp` |

The server address is part of the stored credential's key, so **changing `region` needs a new sign-in**. The old entry
stays in your config; `/elevenlabs-status` detects it and gives one next step.

## Permissions

**Every tool is allowed by default.** An agent can read and change agents, delete them, read callers' transcripts and
spend your credits without asking, and so can a tool ElevenLabs adds later. Restrict it in any of these three ways.

1. **The `access` option**, which drives the default rules the plugin inserts:

   | Value | What runs | What asks |
   | --- | --- | --- |
   | `"all"` (the default) | every tool, spending included, and any tool ElevenLabs adds later | nothing |
   | `"ask-changes"` | the read tools | everything else: creates, updates, deletes, share links and every generation |
   | `"read-only"` | the read tools | nothing: everything else is **denied**, generations included |

   ```json
   { "plugins": [{ "package": "github:joe-broadhead/opencode-elevenlabs#v0.0.1", "options": { "access": "read-only" } }] }
   ```

2. **An agent that is read-only or asks**, with rules of its own, later than the plugin's:

   ```json
   { "agents": { "reader": { "permissions": [
     { "action": "elevenlabs_*", "resource": "*", "effect": "ask" },
     { "action": "elevenlabs_agents_list", "resource": "*", "effect": "allow" }
   ] } } }
   ```

3. **A rule per tool**, with the exact names in the block below. To make one tool ask, or stop it:

   ```json
   { "permissions": [
     { "action": "elevenlabs_creative_generate_video", "resource": "*", "effect": "deny" },
     { "action": "elevenlabs_agents_delete", "resource": "*", "effect": "ask" }
   ] }
   ```

The plugin inserts this block directly after each agent's base rule that allows everything, generated from
`defaultRules("all")` in `src/permissions.ts`. It is the namespace rule plus one rule per live tool: 191 rules in all, so
it is folded here:

<details>
<summary>The 191 rules <code>access: "all"</code> inserts</summary>

```json
[
  { "action": "elevenlabs_*", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_calculate_llm_usage", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_count_conversations", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_alert", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_branch", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_branches_commit_status", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_config_summary", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_conversation", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_conversation_summary", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_insights_report", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_kb_dependents", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_kb_document", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_kb_rag_indexes", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_knowledge_size", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_latest_bi_report", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_mcp_server", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_memory", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_merge_conflicts", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_merge_proposal", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_phone_number", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_procedure", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_procedure_draft", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_rebase_conflicts", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_summaries", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_test", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_test_result_summary", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_test_run", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_test_run_failures", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_test_run_summary", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_tool", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_tool_dependents", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_tool_executions", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_topics", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_topics_summary", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_triage_ticket", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_triage_ticket_assignable_users", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_version", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_widget", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_alerts", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_branches", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_channels", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_conversations", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_deployments", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_knowledge_base", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_llms", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_mcp_server_tools", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_mcp_servers", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_memories", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_merge_proposals", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_phone_numbers", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_procedures", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_secrets", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_test_runs", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_tests", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_tools", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_triage_tickets", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_trigger_connections", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_merge_branch_preview", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_query_analytics", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_read_string_field", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_rebase_branch_preview", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_resolve_conversation", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_search_conversation_messages", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_search_knowledge_base", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_search_procedures", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_semantic_search_conversation_messages", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_suggest_merge_proposal_reviewers", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_available_assets", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_brand_kit", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_flow", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_flow_node", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_flow_node_types", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_flow_run_status", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_model_guide", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_model_schema", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_view_state", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_voice_design_previews", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_list_brand_kits", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_list_flows", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_list_voices", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_link", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_generations", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_add_triage_ticket_comment", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_add_triage_ticket_turn_comment", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_append_to_string_field", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_bulk_move_knowledge_base", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_comment_on_merge_proposal", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_branch", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_code_tool", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_deployment", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_draft", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_kb_crawl", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_kb_folder", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_kb_text", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_kb_url", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_manual_triage_ticket", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_mcp_server", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_merge_proposal", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_procedure", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_test", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_test_folder", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_tool", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_triage_ticket", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_disable_built_in_tool", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_duplicate", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_edit_string_field", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_merge_branch", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_merge_merge_proposal", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_move_tests", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_rebase_branch", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_review_merge_proposal", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_agent_behavior", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_analysis", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_branch", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_client_overrides", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_code_tool", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_conversation", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_end_call_tool", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_guardrails", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_kb_document", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_keypad_tone_tool", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_language_detection_tool", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_language_presets", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_mcp_server", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_merge_proposal", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_operations", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_phone_number", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_procedure_draft", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_prompt_settings", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_skip_turn_tool", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_speech_recognition", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_test", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_tool", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_transfer_to_agent_tool", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_transfer_to_number_tool", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_triage_ticket", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_turn_taking", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_voice", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_voicemail_detection_tool", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_widget", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update_workflow", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_add_brand_kit_item", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_add_flow_asset_node", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_add_flow_node", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_attach_reference_file", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_connect_flow_nodes", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_create_asset_upload", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_create_brand_kit", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_create_flow", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_disconnect_flow_nodes", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_duplicate_flow_nodes", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_finalize_asset_upload", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_save_designed_voice", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_save_view_state", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_show_flow_results", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_update_brand_kit", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_update_brand_kit_item", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_update_flow_nodes", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_update_node", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_upload_flow_reference", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_get_more_tools", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_compute_kb_rag_index", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_query_knowledge_base_rag", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_run_tests", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_create_brand_kit_from_website", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_design_voice", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_edit_image", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_generate_image", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_generate_in_flow", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_generate_speech", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_generate_video", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_run_flow_nodes", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_transcribe_audio", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_bulk_delete_knowledge_base", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete_draft", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete_kb_document", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete_mcp_server", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete_phone_number", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete_procedure", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete_procedure_draft", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete_test", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete_tool", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete_triage_ticket", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_delete_brand_kit", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_delete_brand_kit_item", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_delete_flow_nodes", "resource": "*", "effect": "allow" }
]
```

</details>

Everything later wins: an agent's own stricter rules (Explore cannot use ElevenLabs), your `permissions` in
`opencode.json`, and your saved answers. In an unattended run such as `opencode run`, a tool that asks is refused:
**run writes interactively**.

### Calls and personal data

A transcript holds another person's words, the identifier your integration gave them, their phone number, and whatever
the agent was told to extract. **No redaction is applied**: the point of reading a call is what was said. Instead:

- `conversations: "summary"` denies `agents_get_conversation` and `agents_search_conversation_messages`, and keeps the
  metadata reads.
- `conversations: "off"` denies those and `agents_list_conversations` too.

The skills tell the model to summarise rather than quote, and never to move a caller's details anywhere else.

## Configure

Options, the permission rules and every error code are in
[docs/configuration.md](https://github.com/joe-broadhead/opencode-elevenlabs/blob/HEAD/docs/configuration.md).

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-elevenlabs#v0.0.1", "options": {
  "access": "all",
  "region": "global",
  "sessionCreditCap": 2000,
  "dailyCreditCap": 10000,
  "mediaRoot": "~/Downloads/elevenlabs",
  "maxMediaBytes": 209715200,
  "conversations": "full"
} }] }
```

## Organisation rollout

Pre-set the region and the caps in the system config, so every member only presses sign-in. On Linux
`/etc/opencode/opencode.json`, on macOS `/Library/Application Support/opencode/opencode.json`:

```json
{
  "plugins": [{
    "package": "github:joe-broadhead/opencode-elevenlabs#v0.0.1",
    "options": { "region": "eu", "dailyCreditCap": 5000, "access": "ask-changes" }
  }]
}
```

Nothing else needs configuring: there is no client ID to register and no secret to distribute.

## Troubleshooting

Every state, and every sentence `/elevenlabs-status` and `/elevenlabs-doctor` can print, is in
[docs/configuration.md](https://github.com/joe-broadhead/opencode-elevenlabs/blob/HEAD/docs/configuration.md). Run
`/elevenlabs-doctor` first when something is wrong.

| Code | What it means | What to do |
| --- | --- | --- |
| `BALANCE_UNAVAILABLE` | the optional API key could not read the subscription | run `/elevenlabs-status`; if it keeps failing, remove the key in `/connect` |
| `EXTERNAL_DIRECTORY_DENIED` | the media folder's `external_directory` rule is not allowed | add the rule the message prints, with the absolute path |
| `HOST_UNTESTED` | OpenCode is outside `>=2.2.3 <2.3.0` | use a supported OpenCode, or set `"allowUntestedHost": true` |
| `MEDIA_EXPIRED` | the generated file's signed link has expired | fetch the generation again; do not generate again |
| `MEDIA_TOO_LARGE` | the file is larger than `maxMediaBytes` | raise `maxMediaBytes` deliberately |
| `MEDIA_URL_INVALID` | the link is not `https`, or not on ElevenLabs' generated-file host | pass the link a generation returned |
| `OPTIONS_INVALID` | a plugin option is wrong | fix the option; the message names the accepted values |
| `PRICE_UNKNOWN` | a call that may spend cannot be priced, and a cap is on, so it was refused before it was sent | price it with `"estimate_only": true` where the tool takes it, or set both caps to `null` |
| `RULES_NOT_ADDED` | the default rules could not be inserted | restart OpenCode |
| `SAVE_FAILED` | the file could not be written | check `mediaRoot`, its permissions, and the `external_directory` rule |
| `SERVER_NOT_REGISTERED` | the MCP server could not be registered | restart OpenCode |
| `SKILLS_INVALID` | a skill failed to load | reinstall the plugin |
| `SPEND_CAP_REACHED` | the call would exceed a credit cap, or a priced call of the same method is already in flight, so it was refused before it was sent | raise the cap, set it to `null`, wait for the 24-hour window, or wait for the in-flight call to return or for its ten-minute reservation to run out |
| `STATUS_UNAVAILABLE` | the status report could not be read | restart OpenCode, then run `/elevenlabs-status` |

An upstream error from ElevenLabs, a rate limit included, passes through unchanged.

If `/elevenlabs-status` has a `Skills` row saying a skill **is replaced by** another file, a skill with the same id earlier
in your config shadows the plugin's. **Rename or move** that file, then restart OpenCode.

## Known limits

- **The tool table is the live catalogue.** It was captured from a signed-in workspace: 190 tools, with each one's real
  argument names, defaults and enums, kept in `test/fixtures/live-tools.json` and checked by `npm run drift`. A tool
  ElevenLabs adds after that capture still runs, under the `elevenlabs_*` rule, and `/elevenlabs-status` names it as
  unknown until it is classified.
- **Every live tool requires a `context` argument**, a short line saying why the call is being made. ElevenLabs reads
  it; the plugin only passes it on.
- **The caps bound this plugin, not the account.** The workspace balance needs the optional API key.
- **No dollar figure is derived from credits.**
- **Prices come from ElevenLabs' own estimate.** If the estimate is unavailable the call is refused rather than
  guessed, and a tool ElevenLabs offers no estimate for cannot run while a cap is on.
- **One fact about a paid call stays unverified until the live reconcile measures it:** whether a finished generation
  reports what it really cost, and in which field of its result. Pass 1 did not measure it: it spent nothing. Pass 2
  does, as step 2 of the checklist in `test/fixtures/README.md`, on the two cheapest paid calls this plugin can make.
  Until then a call is charged the estimate it was reserved at, and a later figure can only raise that charge, never
  lower it. What the live pass did settle is on the
  estimate's side: an estimate moved the balance by nothing, its figure covers the whole batch rather than one
  generation, it can be fractional, and it leaves a flow and a node behind in the workspace.
- **Durations are read from the container, and only for display.** WAV and MP4/M4A state one; MP3, Ogg and WebM do not,
  and the field is left out rather than estimated. A WAV holding more than one `data` chunk, or more than one `fmt `
  chunk, states two durations, and real decoders disagree about which counts, so it is treated as stating none. No
  price reads any of this.

- Updates are not automatic for a Git install, and `opencode plugin update` and `opencode plugin check` do not work on one: to move to a newer release, remove the old entry and add the new tag.

## Uninstall

Sign out first, so the stored credential goes with the plugin:

```sh
opencode mcp logout elevenlabs
opencode auth list
opencode plugin remove github:joe-broadhead/opencode-elevenlabs#v0.0.1
```

Files already saved under `mediaRoot` stay. Remove them yourself if you no longer want them.

## Links

- [Configuration, permission rules and error codes](https://github.com/joe-broadhead/opencode-elevenlabs/blob/HEAD/docs/configuration.md)
- [Scripting](https://github.com/joe-broadhead/opencode-elevenlabs/blob/HEAD/docs/scripting.md)
- [Architecture](https://github.com/joe-broadhead/opencode-elevenlabs/blob/HEAD/docs/architecture.md)
- [ElevenLabs' hosted MCP server](https://elevenlabs.io/docs/eleven-agents/operate/hosted-mcp)
- [ElevenLabs' MCP server overview](https://elevenlabs.io/docs/eleven-api/resources/mcp-server)
- [CHANGELOG](https://github.com/joe-broadhead/opencode-elevenlabs/blob/HEAD/CHANGELOG.md)
- [LICENSE](https://github.com/joe-broadhead/opencode-elevenlabs/blob/HEAD/LICENSE)
