// ElevenLabs' tool names, without the `elevenlabs_` server prefix: the one place that classifies them. The default
// permission rules, the tools RPC's methods, status, the spending guard, the jelly tools and the tests all derive from
// these lists, and package.json's `jelly.tools` must match them (test/unit/jelly.test.ts). Keep this file free of
// runtime imports: scripts/check-elevenlabs-tools.mjs loads it with Node's type stripping to report upstream drift.
//
// These are the 237 names the hosted server's own `tools/list` returned on 2026-11-14, reconciled against
// test/fixtures/live-tools.json, which also records ElevenLabs' own `readOnlyHint` for each. `npm run drift` compares
// the two, and test/unit/live-tools.test.ts fails when they disagree. A tool is a read exactly when ElevenLabs marks it
// read-only, with two exceptions kept stricter on purpose (READ_ONLY_OVERRIDES, below; docs/jelly.md gives the reasons).
// The other classes are read from what each tool's own description and schema say it does; docs/architecture.md
// records the judgement calls. Every live name has a class.

/** Reads. They run without a prompt, and they are the tools RPC's methods. */
export const READ_TOOLS: readonly string[] = [
  "account_get_usage",
  "agents_calculate_llm_usage",
  "agents_count_conversations",
  "agents_get",
  "agents_get_alert",
  "agents_get_batch_call",
  "agents_get_branch",
  "agents_get_branches_commit_status",
  "agents_get_config_summary",
  "agents_get_connection_dependents",
  "agents_get_conversation",
  "agents_get_conversation_audio_url",
  "agents_get_conversation_summary",
  "agents_get_insights_report",
  "agents_get_kb_dependents",
  "agents_get_kb_document",
  "agents_get_kb_rag_indexes",
  "agents_get_knowledge_size",
  "agents_get_latest_bi_report",
  // The agent's existing shareable link, as ElevenLabs marks it: a read. It mints nothing; a private agent's
  // credential-like link is `agents_get_signed_url`, which is an export.
  "agents_get_link",
  "agents_get_mcp_server",
  "agents_get_memory",
  "agents_get_merge_conflicts",
  "agents_get_merge_proposal",
  "agents_get_overview_dashboard",
  "agents_get_phone_number",
  "agents_get_procedure",
  "agents_get_procedure_draft",
  "agents_get_rebase_conflicts",
  "agents_get_settings",
  "agents_get_structured_procedure_schema",
  "agents_get_subagent_dependents",
  "agents_get_summaries",
  "agents_get_test",
  "agents_get_test_result",
  "agents_get_test_result_summary",
  "agents_get_test_run",
  "agents_get_test_run_failures",
  "agents_get_test_run_summary",
  "agents_get_tool",
  "agents_get_tool_dependents",
  "agents_get_tool_executions",
  "agents_get_topics",
  "agents_get_topics_summary",
  "agents_get_triage_ticket",
  "agents_get_triage_ticket_assignable_users",
  "agents_get_usage_limits",
  "agents_get_version",
  "agents_get_whatsapp_account",
  "agents_get_widget",
  "agents_list",
  "agents_list_alerts",
  "agents_list_batch_calls",
  "agents_list_branches",
  "agents_list_channels",
  "agents_list_conversations",
  "agents_list_deployments",
  "agents_list_knowledge_base",
  "agents_list_llms",
  "agents_list_mcp_server_tools",
  "agents_list_mcp_servers",
  "agents_list_memories",
  "agents_list_merge_proposals",
  "agents_list_phone_numbers",
  "agents_list_procedures",
  "agents_list_pronunciation_dictionaries",
  "agents_list_secrets",
  "agents_list_test_runs",
  "agents_list_tests",
  "agents_list_tools",
  "agents_list_triage_tickets",
  "agents_list_trigger_connections",
  "agents_list_webhooks",
  "agents_list_whatsapp_accounts",
  "agents_merge_branch_preview",
  "agents_query_analytics",
  "agents_query_workspace_conversations",
  "agents_read_string_field",
  "agents_rebase_branch_preview",
  "agents_resolve_conversation",
  "agents_search_conversation_messages",
  "agents_search_knowledge_base",
  "agents_search_procedures",
  "agents_semantic_search_conversation_messages",
  "agents_suggest_merge_proposal_reviewers",
  "creative_get_available_assets",
  "creative_get_brand_kit",
  "creative_get_flow",
  "creative_get_flow_node",
  "creative_get_flow_node_types",
  "creative_get_flow_run_status",
  // Renders, with signed links to the workspace's own files; "Spends no credits", and ElevenLabs marks it a read.
  "creative_get_generations",
  "creative_get_model_guide",
  "creative_get_model_schema",
  "creative_get_view_state",
  "creative_get_voice_design_previews",
  "creative_list_brand_kits",
  "creative_list_flows",
  "creative_list_voices",
  // Shows a run's generations to the user again. It changes nothing in the workspace, and ElevenLabs marks it a read.
  "creative_show_flow_results",
]

/**
 * Reads of other people's calls. `agents_get_conversation` returns a transcript, the caller's identifier and the
 * details the agent extracted; `agents_get_conversation_summary` returns the plain messages of a short call;
 * `agents_search_conversation_messages` and its semantic twin search that text across calls;
 * `agents_get_conversation_audio_url` returns a link to the call's recording. The generated block allows them at
 * `access: "all"` like every other tool; `conversations: "summary"` denies exactly these, and `"off"` denies them with
 * the rest of the conversation tools.
 */
export const TRANSCRIPT_TOOLS: readonly string[] = [
  "agents_get_conversation",
  "agents_get_conversation_audio_url",
  "agents_get_conversation_summary",
  "agents_search_conversation_messages",
  "agents_semantic_search_conversation_messages",
]

/**
 * Every read of a call's history, used by `conversations: "off"`. A user who wants no call data in the model's context
 * turns off the lists, the counts, the agent's memories and the triage tickets cut from a call as well as the words,
 * and the batch calls, whose recipients and per-call status are call history too.
 */
export const CONVERSATION_TOOLS: readonly string[] = [
  ...TRANSCRIPT_TOOLS,
  "agents_count_conversations",
  "agents_get_batch_call",
  "agents_get_memory",
  "agents_get_triage_ticket",
  "agents_list_batch_calls",
  "agents_list_conversations",
  "agents_list_memories",
  "agents_list_triage_tickets",
  "agents_query_workspace_conversations",
  "agents_resolve_conversation",
]

/**
 * Tools that mint something anyone outside the workspace can use. R4: the class is what the tool does.
 * `agents_get_signed_url` mints a signed URL that starts a conversation with a private agent, which ElevenLabs' own
 * description says to treat as a credential. `creative_create_asset_upload` is a write, not an export: its URL is
 * inbound. The agent's existing shareable link (`agents_get_link`) and a render's signed link
 * (`creative_get_generations`) are reads, as ElevenLabs marks them.
 */
export const EXPORT_TOOLS: readonly string[] = [
  "agents_get_signed_url",
]

/** Writes that change the workspace without spending credits. */
export const WRITE_TOOLS: readonly string[] = [
  "agents_add_triage_ticket_comment",
  "agents_add_triage_ticket_turn_comment",
  "agents_add_workflow_node",
  "agents_append_to_string_field",
  "agents_attach_kb_document",
  "agents_attach_test",
  "agents_attach_tool",
  "agents_bulk_move_knowledge_base",
  "agents_cancel_batch_call",
  "agents_comment_on_merge_proposal",
  "agents_connect_workflow_nodes",
  "agents_create",
  "agents_create_branch",
  "agents_create_code_tool",
  "agents_create_deployment",
  "agents_create_draft",
  "agents_create_kb_crawl",
  "agents_create_kb_folder",
  "agents_create_kb_text",
  "agents_create_kb_url",
  "agents_create_manual_triage_ticket",
  "agents_create_mcp_server",
  "agents_create_merge_proposal",
  "agents_create_phone_number",
  "agents_create_procedure",
  "agents_create_secret",
  "agents_create_simulation_test",
  "agents_create_test",
  "agents_create_test_folder",
  "agents_create_tool",
  "agents_create_triage_ticket",
  "agents_delete_workflow_element",
  "agents_detach_kb_document",
  "agents_detach_test",
  "agents_detach_tool",
  "agents_disable_built_in_tool",
  "agents_duplicate",
  "agents_duplicate_test",
  "agents_edit_string_field",
  "agents_merge_branch",
  "agents_merge_merge_proposal",
  "agents_move_tests",
  "agents_publish_draft",
  "agents_rebase_branch",
  "agents_request_merge_proposal_review",
  "agents_review_merge_proposal",
  "agents_update",
  "agents_update_agent_behavior",
  "agents_update_analysis",
  "agents_update_branch",
  "agents_update_client_overrides",
  "agents_update_code_tool",
  "agents_update_conversation",
  "agents_update_end_call_tool",
  "agents_update_guardrails",
  "agents_update_kb_document",
  "agents_update_keypad_tone_tool",
  "agents_update_language_detection_tool",
  "agents_update_language_presets",
  "agents_update_mcp_server",
  "agents_update_merge_proposal",
  "agents_update_operations",
  "agents_update_phone_number",
  "agents_update_procedure_draft",
  "agents_update_procedure_visibility",
  "agents_update_prompt_settings",
  "agents_update_secret",
  "agents_update_settings",
  "agents_update_skip_turn_tool",
  "agents_update_speech_recognition",
  "agents_update_subagents",
  "agents_update_test",
  "agents_update_tool",
  "agents_update_transfer_to_agent_tool",
  "agents_update_transfer_to_number_tool",
  "agents_update_triage_ticket",
  "agents_update_turn_taking",
  "agents_update_voice",
  "agents_update_voicemail_detection_tool",
  "agents_update_whatsapp_account",
  "agents_update_widget",
  "agents_update_workflow",
  "agents_update_workflow_edge",
  "agents_update_workflow_node",
  "creative_add_brand_kit_item",
  "creative_add_flow_asset_node",
  "creative_add_flow_node",
  "creative_attach_reference_file",
  "creative_connect_flow_nodes",
  "creative_create_asset_upload",
  "creative_create_brand_kit",
  "creative_create_flow",
  "creative_disconnect_flow_nodes",
  "creative_duplicate_flow_nodes",
  "creative_finalize_asset_upload",
  "creative_get_sandbox_run",
  "creative_save_designed_voice",
  "creative_save_view_state",
  "creative_update_brand_kit",
  "creative_update_brand_kit_item",
  "creative_update_flow_nodes",
  "creative_update_node",
  "creative_upload_flow_reference",
  // Not a catalogue read. Its one required argument is a free-text `capability` string, and what it does with it is
  // ask ElevenLabs to build a tool: "Describe the capability you were looking for, so it can inform which tools get
  // built next." It returns no tool definitions and adds nothing at run time. It changes what the server will offer,
  // and it carries the model's own words out of the workspace, so it asks under `ask-changes` and `read-only` denies
  // it (docs/architecture.md, SECURITY.md). ElevenLabs marks it read-only; this table is stricter on purpose, and
  // READ_ONLY_OVERRIDES records why.
  "get_more_tools",
]

/**
 * Where this table is stricter than ElevenLabs' own `readOnlyHint`, by name, with the reason. Each one is declared to
 * Jelly as not read-only, so a read-only helper is never given it; docs/jelly.md repeats the reason, and the drift test
 * accepts a disagreement only when it is listed here.
 */
export const READ_ONLY_OVERRIDES: Readonly<Record<string, string>> = {
  agents_query_knowledge_base_rag:
    "A RAG query embeds the query, work ElevenLabs plausibly bills, so this plugin counts it as spending; read-only access promises to deny every tool that can spend, and a read-only helper is never given one.",
  get_more_tools:
    "It sends the model's own free-text description of a missing capability to ElevenLabs, to decide which tools get built next. That is a message out of the workspace, not a read of it, so it is not given to a read-only helper and read-only access denies it.",
}

/**
 * Tools that reach people outside this conversation: a phone call to a list of recipients, a change that goes live to
 * every caller, a WhatsApp number's answers, a notification to workspace members. Each is a change, never a read, so
 * `ask-changes` asks before it runs and `read-only` denies it, and a script's call is refused whenever the rule would
 * ask (a script cannot answer); at the default `all`, as with every tool, it runs. The two batch-call tools also spend
 * and are in SPEND_TOOLS. The skills tell the model to confirm the recipients or the change with the user first.
 */
export const REACH_TOOLS: readonly string[] = [
  "agents_publish_draft",
  "agents_request_merge_proposal_review",
  "agents_retry_batch_call",
  "agents_submit_batch_call",
  "agents_update_whatsapp_account",
]

/**
 * Calls that spend the workspace's credits. Every one of them is priced from ElevenLabs' own estimate, by calling the
 * same tool with `estimate_only: true` and the same arguments; a tool without that flag is refused `PRICE_UNKNOWN`
 * under a cap. A name missing from this list would spend unguarded, while the model was told it would not.
 *
 * `creative_design_voice` spends (it renders three previews) and has no `estimate_only`.
 *
 * One rule decides every tool the catalogue is silent about: a tool whose description says it does server-side
 * work ElevenLabs plausibly bills, and does not say it spends nothing, is counted as spending. The tools that really
 * do not spend say so unprompted — `creative_upload_flow_reference` ends "This starts no generation and spends no
 * credits", `creative_update_node` ends "This never starts a generation" — so silence beside billable work is the
 * signal, and a loud refusal is better than a silent spend. These names are here on that rule and nothing else:
 * `agents_run_tests` and `agents_run_attached_tests` (a test run holds conversations ElevenLabs bills),
 * `agents_compute_kb_rag_index` (embedding a document), `agents_query_knowledge_base_rag` (a RAG query, which embeds the
 * query), `creative_create_brand_kit_from_website` (fetching a site and
 * extracting its logo, colours, typography and tone), `agents_generate` (an LLM writes a whole agent) and
 * `agents_generate_test_from_conversation` (an LLM writes a test). Three say they spend outright:
 * `creative_execute_sandbox` ("It costs credits for each second the command runs"), and `agents_submit_batch_call`
 * and `agents_retry_batch_call`, which place real phone calls. None of them declares `estimate_only`, so while either
 * cap is on each is refused rather than run unpriced. Live pass 2 measures whether the rule-based ones bill; whichever
 * way it comes back, the rule above is what gets applied.
 */
export const SPEND_TOOLS: readonly string[] = [
  "agents_compute_kb_rag_index",
  "agents_generate",
  "agents_generate_test_from_conversation",
  "agents_query_knowledge_base_rag",
  "agents_retry_batch_call",
  "agents_run_attached_tests",
  "agents_run_tests",
  "agents_submit_batch_call",
  "creative_create_brand_kit_from_website",
  "creative_design_voice",
  "creative_edit_image",
  "creative_execute_sandbox",
  "creative_generate_image",
  "creative_generate_in_flow",
  "creative_generate_speech",
  "creative_generate_video",
  "creative_run_flow_nodes",
  "creative_transcribe_audio",
]

/**
 * Reads that spend. Empty: `agents_query_knowledge_base_rag` is the one tool ElevenLabs marks read-only that this table
 * counts as spending, and it is kept a change instead (READ_ONLY_OVERRIDES), so that `access: "read-only"` keeps its
 * promise to deny every tool that can spend. Kept because money is a separate axis: a cap, when one is set, applies
 * to a read that spends as much as to a write.
 */
const SPEND_READS: readonly string[] = []

/** Every call the guard must price, whether it writes or reads. */
export const SPEND_ANY: readonly string[] = [...SPEND_TOOLS, ...SPEND_READS]

/** True when this table classifies the name: one of the five lists, or the plugin's own tool. Case is folded. */
export const known = (raw: string) => {
  const name = raw.toLowerCase()
  return ALL_TOOLS.includes(name) || OWN_TOOLS.includes(name)
}

/**
 * True when a cap, once the owner sets one, must price this call or refuse it, before dispatch: every name in `SPEND_ANY`, and every name this
 * table does not classify at all, whatever it starts with. A classified name that does not spend — a read, a write, an
 * export, a delete — runs as it always did, and so does the plugin's own `save_media`, which is not ElevenLabs' to
 * bill.
 *
 * The unknown half is the money residual made real. The gate used to be the `creative_` prefix, so a spending
 * tool ElevenLabs shipped tomorrow under any other name was allowed by `rule("*", other)` and never priced; and
 * `get_more_tools` exists to ask ElevenLabs for new tools, so that chain starts inside the catalogue rather than
 * outside it. Nothing here can price a tool it has never seen: there is no schema to check its arguments against and
 * no `estimate_only` flag to call. So while either cap is on it is refused `PRICE_UNKNOWN`, and the owner either
 * turns both caps off or waits for a release that classifies it.
 *
 * Case is folded, as the permission rules fold it: ElevenLabs' live names are lowercase, but the money gate
 * must not be the weaker of the two, and `Creative_Generate_Speech` spends exactly what its lowercase form spends.
 */
export const mustPrice = (raw: string) => {
  const name = raw.toLowerCase()
  if (SPEND_ANY.includes(name)) return true
  return !known(name)
}

/** The README sentence for that rule, counted from the same predicate rather than written beside it. */
export function creativeGuardSentence() {
  const spenders = ALL_TOOLS.filter(mustPrice).length
  return `Only when you set a cap: each of the ${spenders} tools that can spend is priced by ElevenLabs' own estimate or refused PRICE_UNKNOWN before it is sent, and so is any name this table does not classify, whatever it starts with. With no cap, the default, nothing is refused for want of a price.`
}

/**
 * The tools whose live schema accepts `estimate_only: true`, which prices a run without spending anything. The
 * spending guard calls these itself before a paid call, and a script calls them once to learn a price. An estimate is
 * not free of effect: it creates a flow and a node in the workspace, which is why it only runs when the paid call it
 * prices is itself permitted (README, SECURITY).
 */
export const ESTIMATE_TOOLS: readonly string[] = [
  "creative_edit_image",
  "creative_generate_image",
  "creative_generate_in_flow",
  "creative_generate_speech",
  "creative_generate_video",
  "creative_run_flow_nodes",
  "creative_transcribe_audio",
]

/** Deletes. Nothing in the workspace undoes them. */
export const DESTRUCTIVE_TOOLS: readonly string[] = [
  "agents_bulk_delete_knowledge_base",
  "agents_delete",
  "agents_delete_draft",
  "agents_delete_kb_document",
  "agents_delete_mcp_server",
  "agents_delete_phone_number",
  "agents_delete_procedure",
  "agents_delete_procedure_draft",
  "agents_delete_test",
  "agents_delete_tool",
  "agents_delete_triage_ticket",
  "creative_delete_brand_kit",
  "creative_delete_brand_kit_item",
  "creative_delete_flow_nodes",
]

/**
 * Names the live catalogue returned that this table does not classify. Empty: all 237 have a class.
 *
 * `get_more_tools` was held here, as a catalogue pager that returned tool definitions and changed nothing. Its live
 * schema says otherwise — one required free-text `capability` string, and a description that asks ElevenLabs to build
 * tools with it — so it is a write. Nothing is held on a guess about what a tool does: a name stays here only
 * while its own schema and description genuinely fit no class, and `npm run drift` reports whatever is here as known
 * rather than as drift.
 */
export const UNCLASSIFIED_TOOLS: readonly string[] = []

export const ALL_TOOLS: readonly string[] = [
  ...READ_TOOLS,
  ...EXPORT_TOOLS,
  ...WRITE_TOOLS,
  ...SPEND_TOOLS,
  ...DESTRUCTIVE_TOOLS,
]

/** The plugin's own tool, in the same namespace: it saves a generated file the model was given a link to. */
export const OWN_TOOLS: readonly string[] = ["save_media"]

/** What a tool can do. `spend` is a write that bills the workspace, kept apart so the guard and SECURITY can name it. */
type ToolClass = "read" | "write" | "spend" | "export" | "destructive" | "unknown"

export function classify(name: string): ToolClass {
  if (READ_TOOLS.includes(name)) return "read"
  if (EXPORT_TOOLS.includes(name)) return "export"
  if (WRITE_TOOLS.includes(name)) return "write"
  if (SPEND_TOOLS.includes(name)) return "spend"
  if (DESTRUCTIVE_TOOLS.includes(name)) return "destructive"
  return "unknown"
}

/** True for a call that spends, writes and billed reads alike. The guard's gate is `mustPrice`, not this. */
export const spends = (name: string) => SPEND_ANY.includes(name.toLowerCase())

/**
 * True for a tool the guard may price with `estimate_only: true`. Case is folded, as `mustPrice` folds it:
 * a name in another case must be offered its own estimate, not refused as a tool that cannot be priced at all.
 */
export const priced = (name: string) => ESTIMATE_TOOLS.includes(name.toLowerCase())

/** The permission action and the tools-RPC method name: `<server>_<tool>`. */
export const actionOf = (name: string) => `elevenlabs_${name}`
