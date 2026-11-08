// ElevenLabs' tool names, without the `elevenlabs_` server prefix: the one place that classifies them. The default
// permission rules, the tools RPC's methods, status, the spending guard, the jelly tools and the tests all derive from
// these lists, and package.json's `jelly.tools` must match them (test/unit/jelly.test.ts). Keep this file free of
// runtime imports: scripts/check-elevenlabs-tools.mjs loads it with Node's type stripping to report upstream drift.
//
// PROVISIONAL: these are the 40 names ElevenLabs' own MCP skills name for the hosted server (elevenlabs/plugin,
// skills/mcp/agents-platform and skills/mcp/creative-studio). The live `tools/list` needs a signed-in account, so the
// list is reconciled after a sign-in: replace test/fixtures/live-tools.json with the raw response, run `npm run drift`,
// then update these lists. ElevenLabs documents more capability than these 40 names cover.

/** Known reads. They run without a prompt, and they are the tools RPC's methods. */
export const READ_TOOLS: readonly string[] = [
  "agents_get",
  "agents_get_conversation",
  "agents_get_kb_dependents",
  "agents_get_test_run",
  "agents_get_widget",
  "agents_list",
  "agents_list_conversations",
  "agents_list_test_runs",
  "agents_merge_branch_preview",
  "agents_query_knowledge_base_rag",
  "agents_search_conversation_messages",
  "agents_search_knowledge_base",
  "creative_get_flow",
  "creative_get_flow_node_types",
  "creative_get_flow_run_status",
  "creative_get_model_guide",
  "creative_list_voices",
  "creative_transcribe_audio",
]

/**
 * Reads of other people's calls. `agents_get_conversation` returns a transcript, the caller's identifier and the
 * details the agent extracted; `agents_search_conversation_messages` searches that text across calls. The generated
 * block allows them at `access: "all"` like every other tool; `conversations: "summary"` denies exactly these two, and
 * `"off"` denies them with the rest of the conversation tools.
 */
export const TRANSCRIPT_TOOLS: readonly string[] = ["agents_get_conversation", "agents_search_conversation_messages"]

/**
 * Every read of a call's history, used by `conversations: "off"`. A user who wants no call data in the model's context
 * turns off the list as well as the words.
 */
export const CONVERSATION_TOOLS: readonly string[] = [...TRANSCRIPT_TOOLS, "agents_list_conversations"]

/** Known tools that mint a link anyone outside the workspace can use. R4: the class is what the tool does. */
export const EXPORT_TOOLS: readonly string[] = ["agents_get_link"]

/** Known writes that change the workspace without spending credits. */
export const WRITE_TOOLS: readonly string[] = [
  "agents_create",
  "agents_create_branch",
  "agents_create_deployment",
  "agents_create_kb_folder",
  "agents_create_kb_text",
  "agents_create_kb_url",
  "agents_create_test",
  "agents_duplicate",
  "agents_merge_branch",
  "agents_update",
  "creative_attach_reference_file",
  "creative_create_flow",
  "creative_upload_flow_reference",
]

/**
 * Writes that spend the workspace's credits. Their price is a formula (characters, minutes, generations) or, for image
 * and video, known only from ElevenLabs' own estimate. Every generation tool ElevenLabs' skills name is here: a name
 * missing from this list would spend unguarded, while the model was told it would not (DR-3).
 */
export const SPEND_TOOLS: readonly string[] = [
  "creative_edit_image",
  "creative_generate_image",
  "creative_generate_music",
  "creative_generate_sound_effect",
  "creative_generate_speech",
  "creative_generate_video",
]

/**
 * Reads that spend: Speech to Text is 330 credits a minute. They stay reads for permissions, because `access` is about
 * changing the workspace, not about money — but the caps always apply (DR-2).
 */
export const SPEND_READS: readonly string[] = ["creative_transcribe_audio"]

/**
 * Names the published formulas already price, which are not in the attested 40. They are in the table the guard
 * consults, so a formula is never left where the dispatcher will not run it.
 */
export const SPEND_ALIASES: readonly string[] = ["creative_compose_music", "creative_sound_effects"]

/** Every call the price table prices, whether it writes or reads, aliases included. */
export const SPEND_ANY: readonly string[] = [...SPEND_TOOLS, ...SPEND_READS, ...SPEND_ALIASES]

/**
 * True when a cap must price this call or refuse it, before dispatch. Every name that starts with `creative_` is
 * included, except one this table classifies as a read, write, export or delete that does not spend. A name the table
 * does not price is refused. There is no keyword list.
 */
export const mustPrice = (name: string) => {
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
  const rule = "While either cap is on, a name that starts with creative_ is priced by the table the guard consults or refused PRICE_UNKNOWN before it is sent"
  return exempt ? `${rule}, unless that table classifies the name as a read, write, export or delete that does not spend.` : `${rule}.`
}

/**
 * The generation tools that accept `estimate_only: true` and price a run without spending anything. The spending guard
 * calls these itself before a paid call, and a script calls them once to learn a price. ElevenLabs' creative skill
 * documents the flag for speech, image and video; `creative_edit_image` is left out because its schema is not attested,
 * so it is priced from a remembered estimate or refused with a next step that works (DR-5).
 */
export const ESTIMATE_TOOLS: readonly string[] = [
  "creative_generate_image",
  "creative_generate_speech",
  "creative_generate_video",
]

/** Known deletes. Nothing in the workspace undoes them. */
export const DESTRUCTIVE_TOOLS: readonly string[] = [
  "agents_bulk_delete_knowledge_base",
  "agents_delete",
  "agents_delete_phone_number",
  "agents_delete_tool",
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

/** True for a tool the price table prices, writes and billed reads alike. The guard's gate is `mustPrice`, not this. */
export const spends = (name: string) => SPEND_ANY.includes(name)

/** True for a generation tool the guard may price with `estimate_only: true`. */
export const priced = (name: string) => ESTIMATE_TOOLS.includes(name)

/** The permission action and the tools-RPC method name: `<server>_<tool>`. */
export const actionOf = (name: string) => `elevenlabs_${name}`
