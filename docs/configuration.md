# Configuration

Every option is optional. The plugin reads them from `opencode.json`:

```json
{ "plugins": [{ "package": "@joe-broadhead/opencode-elevenlabs", "options": { "access": "all" } }] }
```

## Options

| Option | Values | Default | What it does |
| --- | --- | --- | --- |
| `access` | `"all"`, `"ask-changes"`, `"read-only"` | `"all"` | The permission posture the generated default rules express. |
| `region` | `"global"`, `"us"`, `"eu"`, `"in"`, `"sg"` | `"global"` | Which ElevenLabs environment's MCP server to register. Changing it needs a new sign-in. |
| `sessionCreditCap` | a whole number of credits, or `null` | `2000` | The most one session may spend. `null` disables the cap. |
| `dailyCreditCap` | a whole number of credits, or `null` | `10000` | The most this plugin may spend in a rolling 24 hours in this data directory, across sessions, scripts and restarts. Two machines do not share it. `null` disables the cap. |
| `mediaRoot` | a path, `~` for your home folder | `"~/Downloads/elevenlabs"` | Where `elevenlabs_save_media` writes. Created on first use with mode 0700. |
| `maxMediaBytes` | a whole number of bytes | `209715200` (200 MB) | The largest file the save tool writes. |
| `conversations` | `"full"`, `"summary"`, `"off"` | `"full"` | How much of a call's history the conversation reads may return. |
| `allowUntestedHost` | `true`, `false` | `false` | Start on an OpenCode version outside `>=2.2.3 <2.3.0`, with a note in status. |

`0` is refused for either cap: a typo must not turn the guard off. Write `null` to mean it.

## Spending

Twelve tools can bill the workspace: `creative_generate_speech`, `creative_generate_image`, `creative_generate_video`,
`creative_edit_image`, `creative_generate_in_flow`, `creative_run_flow_nodes`, `creative_transcribe_audio`,
`creative_design_voice`, `agents_run_tests`, `agents_compute_kb_rag_index`, `agents_query_knowledge_base_rag` and
`creative_create_brand_kit_from_website`. Each is priced before it runs, from ElevenLabs' own figure: the plugin
sends the same call with `estimate_only: true` and uses what comes back. There is no rate table in this plugin.

The first seven take `estimate_only`. The other five do not, so while either cap is on they are refused
(`PRICE_UNKNOWN`) rather than run unpriced; set both caps to `null` to run them. The last three are counted as
spending because ElevenLabs' catalogue says neither way about them and they describe server-side work it plausibly
bills — embedding a knowledge-base document, running a RAG query, reading a public website — and the plugin counts
silence against the owner's money rather than for it.

A priced call is clamped to the number of generations the caps afford, **reserved** in the ledger before it is sent, and
settled into a charge when its result arrives, so two calls that start together cannot both spend the same budget. A
failure is charged the reserved price. The daily cap is one total for this data directory; two machines do not share it.

A call the plugin cannot price is refused with `PRICE_UNKNOWN` while a cap is on, never run unpriced: a failed or
missing estimate, an argument ElevenLabs' own schema for that tool does not have, a `creative_*` name the table does not
know, and the five spending tools ElevenLabs offers no estimate for — `creative_design_voice`, `agents_run_tests`,
`agents_compute_kb_rag_index`, `agents_query_knowledge_base_rag` and `creative_create_brand_kit_from_website`.

The estimate is sent only where the paid call could run, because it is a call of its own: it costs nothing, but it
creates a flow and a node in the workspace. Under `access: "ask-changes"` the prompt you answer is the generation's own,
asked once, and nothing is estimated if you refuse. The figure is then remembered for ten minutes, so the paid call does
not ask for a second one.

`access: "read-only"` denies every tool that can spend, `creative_transcribe_audio` included: a transcription runs on a
node in a flow, and billing a workspace is not a read.

## The default rules

The block is generated from `defaultRules(access, conversations)` in `src/permissions.ts` and inserted directly after
each agent's base `* * allow`. Everything later wins: the agent's own rules, your `permissions`, and your saved answers.

### `access: "all"` — the default

Every tool runs, including a tool ElevenLabs adds later, and generations spend credits within the caps.

<details>
<summary>The 191 rules it inserts</summary>

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
  { "action": "elevenlabs_creative_show_flow_results", "resource": "*", "effect": "allow" },
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

### `access: "ask-changes"`

The reads run; every other tool asks first, and a tool ElevenLabs adds later asks too. In `opencode run`, where nobody
can answer, an ask is refused. A tool that can spend asks once, before its estimate is sent.

<details>
<summary>The 191 rules it inserts</summary>

```json
[
  { "action": "elevenlabs_*", "resource": "*", "effect": "ask" },
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
  { "action": "elevenlabs_creative_show_flow_results", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_link", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_get_generations", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_add_triage_ticket_comment", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_add_triage_ticket_turn_comment", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_append_to_string_field", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_bulk_move_knowledge_base", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_comment_on_merge_proposal", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_branch", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_code_tool", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_deployment", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_draft", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_kb_crawl", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_kb_folder", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_kb_text", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_kb_url", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_manual_triage_ticket", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_mcp_server", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_merge_proposal", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_procedure", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_test", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_test_folder", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_tool", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_triage_ticket", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_disable_built_in_tool", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_duplicate", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_edit_string_field", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_merge_branch", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_merge_merge_proposal", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_move_tests", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_rebase_branch", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_review_merge_proposal", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_agent_behavior", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_analysis", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_branch", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_client_overrides", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_code_tool", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_conversation", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_end_call_tool", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_guardrails", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_kb_document", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_keypad_tone_tool", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_language_detection_tool", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_language_presets", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_mcp_server", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_merge_proposal", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_operations", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_phone_number", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_procedure_draft", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_prompt_settings", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_skip_turn_tool", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_speech_recognition", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_test", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_tool", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_transfer_to_agent_tool", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_transfer_to_number_tool", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_triage_ticket", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_turn_taking", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_voice", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_voicemail_detection_tool", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_widget", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update_workflow", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_add_brand_kit_item", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_add_flow_asset_node", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_add_flow_node", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_attach_reference_file", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_connect_flow_nodes", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_create_asset_upload", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_create_brand_kit", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_create_flow", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_disconnect_flow_nodes", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_duplicate_flow_nodes", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_finalize_asset_upload", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_save_designed_voice", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_save_view_state", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_update_brand_kit", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_update_brand_kit_item", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_update_flow_nodes", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_update_node", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_upload_flow_reference", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_get_more_tools", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_compute_kb_rag_index", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_query_knowledge_base_rag", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_run_tests", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_create_brand_kit_from_website", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_design_voice", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_edit_image", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_generate_image", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_generate_in_flow", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_generate_speech", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_generate_video", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_run_flow_nodes", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_transcribe_audio", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_bulk_delete_knowledge_base", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_delete", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_delete_draft", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_delete_kb_document", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_delete_mcp_server", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_delete_phone_number", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_delete_procedure", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_delete_procedure_draft", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_delete_test", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_delete_tool", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_delete_triage_ticket", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_delete_brand_kit", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_delete_brand_kit_item", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_delete_flow_nodes", "resource": "*", "effect": "ask" }
]
```

</details>

### `access: "read-only"`

The reads run; everything else is denied, including every tool that can spend. A tool ElevenLabs adds later is denied
too.

<details>
<summary>The 191 rules it inserts</summary>

```json
[
  { "action": "elevenlabs_*", "resource": "*", "effect": "deny" },
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
  { "action": "elevenlabs_creative_show_flow_results", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_link", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_get_generations", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_add_triage_ticket_comment", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_add_triage_ticket_turn_comment", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_append_to_string_field", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_bulk_move_knowledge_base", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_comment_on_merge_proposal", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_branch", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_code_tool", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_deployment", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_draft", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_kb_crawl", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_kb_folder", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_kb_text", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_kb_url", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_manual_triage_ticket", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_mcp_server", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_merge_proposal", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_procedure", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_test", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_test_folder", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_tool", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_triage_ticket", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_disable_built_in_tool", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_duplicate", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_edit_string_field", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_merge_branch", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_merge_merge_proposal", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_move_tests", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_rebase_branch", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_review_merge_proposal", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_agent_behavior", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_analysis", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_branch", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_client_overrides", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_code_tool", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_conversation", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_end_call_tool", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_guardrails", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_kb_document", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_keypad_tone_tool", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_language_detection_tool", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_language_presets", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_mcp_server", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_merge_proposal", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_operations", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_phone_number", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_procedure_draft", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_prompt_settings", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_skip_turn_tool", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_speech_recognition", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_test", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_tool", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_transfer_to_agent_tool", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_transfer_to_number_tool", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_triage_ticket", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_turn_taking", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_voice", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_voicemail_detection_tool", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_widget", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update_workflow", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_add_brand_kit_item", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_add_flow_asset_node", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_add_flow_node", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_attach_reference_file", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_connect_flow_nodes", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_create_asset_upload", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_create_brand_kit", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_create_flow", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_disconnect_flow_nodes", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_duplicate_flow_nodes", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_finalize_asset_upload", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_save_designed_voice", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_save_view_state", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_update_brand_kit", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_update_brand_kit_item", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_update_flow_nodes", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_update_node", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_upload_flow_reference", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_get_more_tools", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_compute_kb_rag_index", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_query_knowledge_base_rag", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_run_tests", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_create_brand_kit_from_website", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_design_voice", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_edit_image", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_generate_image", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_generate_in_flow", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_generate_speech", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_generate_video", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_run_flow_nodes", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_transcribe_audio", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_bulk_delete_knowledge_base", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_delete", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_delete_draft", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_delete_kb_document", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_delete_mcp_server", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_delete_phone_number", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_delete_procedure", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_delete_procedure_draft", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_delete_test", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_delete_tool", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_delete_triage_ticket", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_delete_brand_kit", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_delete_brand_kit_item", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_delete_flow_nodes", "resource": "*", "effect": "deny" }
]
```

</details>

### `conversations`

The option adds deny rules at the end of the block, so they win over its own allows.

`conversations: "summary"` appends:

```json
[
  {"action":"elevenlabs_agents_get_conversation","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_get_conversation_summary","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_search_conversation_messages","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_semantic_search_conversation_messages","resource":"*","effect":"deny"},
  {"action":"elevenlabs_*transcript*","resource":"*","effect":"deny"},
  {"action":"elevenlabs_*conversation*message*","resource":"*","effect":"deny"},
  {"action":"elevenlabs_*conversation*audio*","resource":"*","effect":"deny"},
  {"action":"elevenlabs_*conversation*recording*","resource":"*","effect":"deny"}
]
```

`conversations: "off"` appends:

```json
[
  {"action":"elevenlabs_agents_get_conversation","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_get_conversation_summary","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_search_conversation_messages","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_semantic_search_conversation_messages","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_count_conversations","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_get_memory","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_get_triage_ticket","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_list_conversations","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_list_memories","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_list_triage_tickets","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_resolve_conversation","resource":"*","effect":"deny"},
  {"action":"elevenlabs_*conversation*","resource":"*","effect":"deny"},
  {"action":"elevenlabs_*transcript*","resource":"*","effect":"deny"},
  {"action":"elevenlabs_*call*recording*","resource":"*","effect":"deny"},
  {"action":"elevenlabs_*get_call*","resource":"*","effect":"deny"},
  {"action":"elevenlabs_*list_calls*","resource":"*","effect":"deny"},
  {"action":"elevenlabs_*export_history*","resource":"*","effect":"deny"}
]
```

### For an agent `reviewer`

An agent of your own gets no default rules, so put the block first in its own `permissions`, followed by your rules for
ElevenLabs:

```json
{ "agents": { "reviewer": { "permissions": [
  { "action": "elevenlabs_*", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_get", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_conversation", "resource": "*", "effect": "allow" }
] } } }
```

## Files outside the project

`elevenlabs_save_media` writes under `mediaRoot`, which is outside the project, so **two rules** apply: the tool's own
permission (`elevenlabs_save_media`) and OpenCode's `external_directory` rule for the folder.

```json
{ "permissions": [
  { "action": "elevenlabs_save_media", "resource": "*", "effect": "allow" },
  { "action": "external_directory", "resource": "/absolute/path/of/your/mediaRoot/*", "effect": "allow" }
] }
```

The second rule's resource is the **absolute** path of `mediaRoot` followed by `/*`; the default root is
`~/Downloads/elevenlabs`, and `~` is expanded to your home folder (the status report prints the expanded path). A refusal
whose message begins `permission.rejected: external_directory`, or that starts `EXTERNAL_DIRECTORY_DENIED`, needs that
rule; the plugin's own refusal prints the exact path to paste.

## Status

`/elevenlabs-status`, `/elevenlabs` and the status RPC print the same rows: `Connection`, `Account`, `Access`, `Region`,
`Spend`, `Conversations`, `Media`, `Skills`, `Tools`, `Agents without default rules`, `OpenCode`, `Next step`.

| State | Meaning |
| --- | --- |
| `connected` | signed in and the server lists tools |
| `sign-in required` | the stored credential needs a new sign-in: `/connect` → ElevenLabs |
| `connecting` | the server is still starting |
| `disabled` | the server is turned off in `/mcps` |
| `failed` | the connection failed; the row carries OpenCode's reason |
| `not configured` | OpenCode has no `elevenlabs` server, or yours points at another region's |
| `conflict` | your own `mcp.servers.elevenlabs` is at a URL that is not ElevenLabs' |

## Errors

Every code the plugin raises, in the order the table lists them:

| Code | What happened | Next step |
| --- | --- | --- |
| `BALANCE_UNAVAILABLE` | The optional API key could not read the subscription. | Run `/elevenlabs-status`; if it keeps failing, remove the key in `/connect`. |
| `EXTERNAL_DIRECTORY_DENIED` | The save tool's `external_directory` rule is not allowed for the media folder. | Add `{ "action": "external_directory", "resource": "<absolute mediaRoot>/*", "effect": "allow" }` to the agent's rules. |
| `HOST_UNTESTED` | OpenCode is outside `>=2.2.3 <2.3.0`. | Use a supported OpenCode, or set `"allowUntestedHost": true`. |
| `MEDIA_EXPIRED` | The generated file's signed link has expired. | Fetch the generation again for a fresh link; do not generate again. |
| `MEDIA_TOO_LARGE` | The file is larger than `maxMediaBytes`. | Raise `maxMediaBytes` if you mean to keep a file this large. |
| `MEDIA_URL_INVALID` | The link is not `https`, carries credentials, or is not on ElevenLabs' generated-file host. | Pass the link a generation returned. |
| `OPTIONS_INVALID` | A plugin option is missing, of the wrong type, or out of range. | Fix the option; the message names the accepted values. |
| `PRICE_UNKNOWN` | A call that may spend cannot be priced, and a cap is on, so it was refused before it was sent. | Price it first with `"estimate_only": true` where the tool takes it, or set both caps to `null` — the refusal's next step says which. |
| `RULES_NOT_ADDED` | The default rules could not be inserted into the agents. | Restart OpenCode. |
| `SAVE_FAILED` | The file could not be written, or the folder changed while it was. | Check `mediaRoot`, its permissions, and the `external_directory` rule. |
| `SERVER_NOT_REGISTERED` | The MCP server could not be registered. | Restart OpenCode. |
| `SKILLS_INVALID` | A skill file is missing or malformed. | Reinstall the plugin. |
| `SPEND_CAP_REACHED` | The call would exceed `sessionCreditCap` or `dailyCreditCap`, or a priced call of the same method is already in flight. | Raise the cap, set it to `null`, wait for the 24-hour window to roll, or wait for the in-flight call to return or for its ten-minute reservation to run out. |
| `STATUS_UNAVAILABLE` | The status report could not be read. | Restart OpenCode, then run `/elevenlabs-status` again. |

An upstream error from ElevenLabs passes through unchanged, a `429` rate limit included: wait for the window it names.

## Doctor

`/elevenlabs-doctor` makes the checks a status report cannot: ElevenLabs' discovery document for the selected region, the
authorization server's metadata and whether it accepts a client metadata document, the scopes it advertises, whether the
server is connected and how many tools it lists, whether the three skills loaded, the media folder, and the spend. It
reads; it never generates, signs in or spends.
