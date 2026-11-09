// ElevenLabs' tool names, without the `elevenlabs_` server prefix: the one place that classifies them. The default
// permission rules, the tools RPC's methods, status, the spending guard, the jelly tools and the tests all derive from
// these lists, and package.json's `jelly.tools` must match them (test/unit/jelly.test.ts). Keep this file free of
// runtime imports: scripts/check-elevenlabs-tools.mjs loads it with Node's type stripping to report upstream drift.
//
// These are the 190 names the hosted server's own `tools/list` returned on 2026-11-09, reconciled against
// test/fixtures/live-tools.json. `npm run drift` compares the two. The classes are read from what each tool's own
// description says it does; docs/architecture.md records the two judgement calls and the one name left unclassified.

/** Reads. They run without a prompt, and they are the tools RPC's methods. */
export const READ_TOOLS: readonly string[] = [
  "agents_calculate_llm_usage",
  "agents_count_conversations",
  "agents_get",
  "agents_get_alert",
  "agents_get_branch",
  "agents_get_branches_commit_status",
  "agents_get_config_summary",
  "agents_get_conversation",
  "agents_get_conversation_summary",
  "agents_get_insights_report",
  "agents_get_kb_dependents",
  "agents_get_kb_document",
  "agents_get_kb_rag_indexes",
  "agents_get_knowledge_size",
  "agents_get_latest_bi_report",
  "agents_get_mcp_server",
  "agents_get_memory",
  "agents_get_merge_conflicts",
  "agents_get_merge_proposal",
  "agents_get_phone_number",
  "agents_get_procedure",
  "agents_get_procedure_draft",
  "agents_get_rebase_conflicts",
  "agents_get_summaries",
  "agents_get_test",
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
  "agents_get_version",
  "agents_get_widget",
  "agents_list",
  "agents_list_alerts",
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
  "agents_list_secrets",
  "agents_list_test_runs",
  "agents_list_tests",
  "agents_list_tools",
  "agents_list_triage_tickets",
  "agents_list_trigger_connections",
  "agents_merge_branch_preview",
  "agents_query_analytics",
  "agents_query_knowledge_base_rag",
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
  "creative_get_model_guide",
  "creative_get_model_schema",
  "creative_get_view_state",
  "creative_get_voice_design_previews",
  "creative_list_brand_kits",
  "creative_list_flows",
  "creative_list_voices",
  "creative_show_flow_results",
]

/**
 * Reads of other people's calls. `agents_get_conversation` returns a transcript, the caller's identifier and the
 * details the agent extracted; `agents_get_conversation_summary` returns the plain messages of a short call;
 * `agents_search_conversation_messages` and its semantic twin search that text across calls. The generated block
 * allows them at `access: "all"` like every other tool; `conversations: "summary"` denies exactly these, and
 * `"off"` denies them with the rest of the conversation tools.
 */
export const TRANSCRIPT_TOOLS: readonly string[] = [
  "agents_get_conversation",
  "agents_get_conversation_summary",
  "agents_search_conversation_messages",
  "agents_semantic_search_conversation_messages",
]

/**
 * Every read of a call's history, used by `conversations: "off"`. A user who wants no call data in the model's context
 * turns off the lists, the counts, the agent's memories and the triage tickets cut from a call as well as the words.
 */
export const CONVERSATION_TOOLS: readonly string[] = [
  ...TRANSCRIPT_TOOLS,
  "agents_count_conversations",
  "agents_get_memory",
  "agents_get_triage_ticket",
  "agents_list_conversations",
  "agents_list_memories",
  "agents_list_triage_tickets",
  "agents_resolve_conversation",
]

/**
 * Tools that mint a link anyone outside the workspace can use. R4: the class is what the tool does.
 * `agents_get_link` returns the agent's public call link; `creative_get_generations` returns a signed
 * `full_res_url` for a generated file. `creative_create_asset_upload` is a write, not an export: its URL is inbound.
 */
export const EXPORT_TOOLS: readonly string[] = [
  "agents_get_link",
  "creative_get_generations",
]

/** Writes that change the workspace without spending credits. */
export const WRITE_TOOLS: readonly string[] = [
  "agents_add_triage_ticket_comment",
  "agents_add_triage_ticket_turn_comment",
  "agents_append_to_string_field",
  "agents_bulk_move_knowledge_base",
  "agents_comment_on_merge_proposal",
  "agents_compute_kb_rag_index",
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
  "agents_create_procedure",
  "agents_create_test",
  "agents_create_test_folder",
  "agents_create_tool",
  "agents_create_triage_ticket",
  "agents_disable_built_in_tool",
  "agents_duplicate",
  "agents_edit_string_field",
  "agents_merge_branch",
  "agents_merge_merge_proposal",
  "agents_move_tests",
  "agents_rebase_branch",
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
  "agents_update_prompt_settings",
  "agents_update_skip_turn_tool",
  "agents_update_speech_recognition",
  "agents_update_test",
  "agents_update_tool",
  "agents_update_transfer_to_agent_tool",
  "agents_update_transfer_to_number_tool",
  "agents_update_triage_ticket",
  "agents_update_turn_taking",
  "agents_update_voice",
  "agents_update_voicemail_detection_tool",
  "agents_update_widget",
  "agents_update_workflow",
  "creative_add_brand_kit_item",
  "creative_add_flow_asset_node",
  "creative_add_flow_node",
  "creative_attach_reference_file",
  "creative_connect_flow_nodes",
  "creative_create_asset_upload",
  "creative_create_brand_kit",
  "creative_create_brand_kit_from_website",
  "creative_create_flow",
  "creative_disconnect_flow_nodes",
  "creative_duplicate_flow_nodes",
  "creative_finalize_asset_upload",
  "creative_save_designed_voice",
  "creative_save_view_state",
  "creative_update_brand_kit",
  "creative_update_brand_kit_item",
  "creative_update_flow_nodes",
  "creative_update_node",
  "creative_upload_flow_reference",
]

/**
 * Calls that spend the workspace's credits. Every one of them is priced from ElevenLabs' own estimate, by calling the
 * same tool with `estimate_only: true` and the same arguments; a tool without that flag is refused `PRICE_UNKNOWN`
 * under a cap. A name missing from this list would spend unguarded, while the model was told it would not (DR-3).
 *
 * `creative_design_voice` spends (it renders three previews) and has no `estimate_only`. `agents_run_tests` is a
 * judgement call: no description says it charges, but a test run holds conversations ElevenLabs bills, and a loud
 * refusal is better than a silent spend (docs/architecture.md).
 */
export const SPEND_TOOLS: readonly string[] = [
  "agents_run_tests",
  "creative_design_voice",
  "creative_edit_image",
  "creative_generate_image",
  "creative_generate_in_flow",
  "creative_generate_speech",
  "creative_generate_video",
  "creative_run_flow_nodes",
  "creative_transcribe_audio",
]

/**
 * Reads that spend. Empty against this catalogue: `creative_transcribe_audio` was the one candidate, and live it adds
 * a node to a flow, so it is a write that spends and sits in `SPEND_TOOLS`. Kept because `access` is about changing
 * the workspace and money is a separate axis (DR-2); the caps always apply either way.
 */
export const SPEND_READS: readonly string[] = []

/** Every call the guard must price, whether it writes or reads. */
export const SPEND_ANY: readonly string[] = [...SPEND_TOOLS, ...SPEND_READS]

/**
 * True when a cap must price this call or refuse it, before dispatch: every name in `SPEND_ANY`, and every other name
 * that starts with `creative_` except one this table classifies as a read, write, export or delete that does not
 * spend. A `creative_` name this table does not know is priced from its own `estimate_only` call or refused. There
 * is no keyword list.
 *
 * Case is folded, as the permission rules fold it (RR2-8): ElevenLabs' live names are lowercase, but the money gate
 * must not be the weaker of the two, and `Creative_Generate_Speech` spends exactly what its lowercase form spends.
 */
export const mustPrice = (raw: string) => {
  const name = raw.toLowerCase()
  if (SPEND_ANY.includes(name)) return true
  if (!name.startsWith("creative_")) return false
  if (READ_TOOLS.includes(name) || WRITE_TOOLS.includes(name) || EXPORT_TOOLS.includes(name) || DESTRUCTIVE_TOOLS.includes(name)) return false
  return true
}

/**
 * The README sentence for that rule, from the same predicate. A classified non-spending `creative_` name is the only
 * exception, and only while the table still has one.
 */
export function creativeGuardSentence() {
  const exempt = ALL_TOOLS.some((name) => name.startsWith("creative_") && !mustPrice(name))
  const rule = "While either cap is on, a name that starts with creative_ is priced by ElevenLabs' own estimate or refused PRICE_UNKNOWN before it is sent"
  return exempt ? `${rule}, unless the tool table classifies the name as a read, write, export or delete that does not spend.` : `${rule}.`
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
 * Names the live catalogue returned that this table does not classify. `get_more_tools` sends the caller's own words
 * to ElevenLabs to search the catalogue and changes nothing in the workspace, so neither a read nor a write describes
 * it; the `rule("*", other)` default already asks for it under `ask-changes` and denies it under `read-only`.
 * Status reports the count, and it is deliberately not in `ALL_TOOLS`.
 */
export const UNCLASSIFIED_TOOLS: readonly string[] = [
  "get_more_tools",
]

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
export type ToolClass = "read" | "write" | "spend" | "export" | "destructive" | "unknown"

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
 * True for a tool the guard may price with `estimate_only: true`. Case is folded, as `mustPrice` folds it (RR2-8):
 * a name in another case must be offered its own estimate, not refused as a tool that cannot be priced at all.
 */
export const priced = (name: string) => ESTIMATE_TOOLS.includes(name.toLowerCase())

/** The permission action and the tools-RPC method name: `<server>_<tool>`. */
export const actionOf = (name: string) => `elevenlabs_${name}`
