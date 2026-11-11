// src/tui.ts
import { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";

// src/constants.ts
var PLUGIN_ID = "elevenlabs";
var SERVER_NAME = "elevenlabs";
var DISPLAY_NAME = "ElevenLabs";
var REGIONS = {
  global: "https://api.elevenlabs.io/v1/mcp",
  us: "https://api.us.elevenlabs.io/v1/mcp",
  eu: "https://api.eu.residency.elevenlabs.io/v1/mcp",
  in: "https://api.in.residency.elevenlabs.io/v1/mcp",
  sg: "https://api.sg.residency.elevenlabs.io/v1/mcp"
};
var REGION_VALUES = Object.keys(REGIONS);
var DEFAULT_REGION = "global";
var ENDPOINT = REGIONS[DEFAULT_REGION];
var SUPPORTED_HOST = ">=2.2.3 <2.3.0";
var TESTED_HOSTS = ["2.2.3", "2.2.4", "2.2.5", "2.2.6"];
var errorText = (code, message, nextStep) => `${code}: ${message} Next step: ${nextStep}`;

// src/redact.ts
var SECRETS = [
  [/\b(bearer|basic|token)\s+[\w.~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b([\w-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|signature|credential)["']?\s*[:=]\s*)["']?[^\s"'&,;]+["']?/gi, "$1[redacted]"],
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, "[redacted]"],
  [/\b(?:tvly|sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abposr]|lin_api|lin_oauth)[-_][\w-]{8,}/gi, "[redacted]"],
  [/[\w+=-]{40,}/g, "[redacted]"]
];
var REASON_LIMIT = 160;
var withoutUrlSecrets = (text) => text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => url.replace(/^(https?:\/\/)[^/?#@]*@/i, "$1").replace(/[?#].*$/s, ""));
function shortReason(text) {
  const reason = SECRETS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), withoutUrlSecrets(text)).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  if (reason === "") return void 0;
  const characters = Array.from(reason);
  return characters.length > REASON_LIMIT ? `${characters.slice(0, REASON_LIMIT - 1).join("")}\u2026` : reason;
}

// src/elevenlabs-tools.ts
var READ_TOOLS = [
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
  "creative_list_voices"
];
var TRANSCRIPT_TOOLS = [
  "agents_get_conversation",
  "agents_get_conversation_summary",
  "agents_search_conversation_messages",
  "agents_semantic_search_conversation_messages"
];
var CONVERSATION_TOOLS = [
  ...TRANSCRIPT_TOOLS,
  "agents_count_conversations",
  "agents_get_memory",
  "agents_get_triage_ticket",
  "agents_list_conversations",
  "agents_list_memories",
  "agents_list_triage_tickets",
  "agents_resolve_conversation"
];
var EXPORT_TOOLS = [
  "agents_get_link",
  "creative_get_generations"
];
var WRITE_TOOLS = [
  "agents_add_triage_ticket_comment",
  "agents_add_triage_ticket_turn_comment",
  "agents_append_to_string_field",
  "agents_bulk_move_knowledge_base",
  "agents_comment_on_merge_proposal",
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
  "creative_create_flow",
  "creative_disconnect_flow_nodes",
  "creative_duplicate_flow_nodes",
  "creative_finalize_asset_upload",
  "creative_save_designed_voice",
  "creative_save_view_state",
  "creative_show_flow_results",
  "creative_update_brand_kit",
  "creative_update_brand_kit_item",
  "creative_update_flow_nodes",
  "creative_update_node",
  "creative_upload_flow_reference",
  // Not a catalogue read. Its one required argument is a free-text `capability` string, and what it does with it is
  // ask ElevenLabs to build a tool: "Describe the capability you were looking for, so it can inform which tools get
  // built next." It returns no tool definitions and adds nothing at run time. It changes what the server will offer,
  // and it carries the model's own words out of the workspace, so it asks under `ask-changes` and `read-only` denies
  // it (docs/architecture.md, SECURITY.md).
  "get_more_tools"
];
var SPEND_TOOLS = [
  "agents_compute_kb_rag_index",
  "agents_query_knowledge_base_rag",
  "agents_run_tests",
  "creative_create_brand_kit_from_website",
  "creative_design_voice",
  "creative_edit_image",
  "creative_generate_image",
  "creative_generate_in_flow",
  "creative_generate_speech",
  "creative_generate_video",
  "creative_run_flow_nodes",
  "creative_transcribe_audio"
];
var SPEND_READS = [];
var SPEND_ANY = [...SPEND_TOOLS, ...SPEND_READS];
var DESTRUCTIVE_TOOLS = [
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
  "creative_delete_flow_nodes"
];
var ALL_TOOLS = [
  ...READ_TOOLS,
  ...EXPORT_TOOLS,
  ...WRITE_TOOLS,
  ...SPEND_TOOLS,
  ...DESTRUCTIVE_TOOLS
];

// src/host-version.ts
var RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
var parse = (version) => RELEASE.exec(version)?.slice(1).map(Number);
var [LOWEST, ABOVE] = SUPPORTED_HOST.split(" ").map((bound) => parse(bound.replace(/^[<>]=?/, "")));
var compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function isSupportedHost(version) {
  const parts = parse(version);
  return parts !== void 0 && compare(parts, LOWEST) >= 0 && compare(parts, ABOVE) < 0;
}

// src/permissions.ts
var actionOf = (tool) => `elevenlabs_${tool}`;
var rule = (tool, effect) => ({ action: actionOf(tool), resource: "*", effect });
var conversationDenies = (conversations) => conversations === "off" ? [...CONVERSATION_TOOLS, ...CONVERSATION_PATTERNS] : conversations === "summary" ? [...TRANSCRIPT_TOOLS, ...TRANSCRIPT_PATTERNS] : [];
var TRANSCRIPT_PATTERNS = ["*transcript*", "*conversation*message*", "*conversation*audio*", "*conversation*recording*"];
var CONVERSATION_PATTERNS = ["*conversation*", "*transcript*", "*call*recording*", "*get_call*", "*list_calls*", "*export_history*"];
var defaultRules = (access = "all", conversations = "full") => {
  const other = access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny";
  return [
    rule("*", other),
    ...READ_TOOLS.map((tool) => rule(tool, "allow")),
    ...[...EXPORT_TOOLS, ...WRITE_TOOLS, ...SPEND_TOOLS, ...DESTRUCTIVE_TOOLS].map((tool) => rule(tool, other)),
    // Exact names first, then the patterns: a rule's action may be a pattern, and the last matching rule wins.
    ...conversationDenies(conversations).map((tool) => rule(tool, "deny"))
  ];
};

// src/status.ts
var SIGN_IN = `Run /connect and choose ${DISPLAY_NAME}, then press o or Enter to open the link (in a terminal, opencode mcp auth ${SERVER_NAME} opens it automatically).`;
var agentRulesText = (access, conversations) => defaultRules(access, conversations).map((rule2, index, rules) => `  ${JSON.stringify(rule2)}${index < rules.length - 1 ? "," : ""}`).join("\n");
var accessText = (access) => {
  if (access === "all") return "every tool runs without asking, reads, spending and new tools included";
  if (access === "read-only") return "reads run without asking; every other tool, spending included, is denied";
  return "reads run without asking; changes, spending and new tools ask first";
};
var TESTED_TEXT = `${TESTED_HOSTS.slice(0, -1).join(", ")} or ${TESTED_HOSTS.at(-1)}`;
var STATE_TEXT = {
  connected: "connected",
  connecting: "connecting",
  sign_in_required: "sign-in required",
  failed: "failed",
  disabled: "disabled",
  not_configured: "not configured",
  conflict: "conflict"
};
function serverText(source) {
  if (source.type === "plugin") return `${source.url}, registered by this plugin`;
  if (source.type === "adopted") return `${source.url}, your own mcp.servers.${SERVER_NAME}, used unchanged`;
  return `your mcp.servers.${SERVER_NAME} points at ${source.url}`;
}
function skillsText({ shadowedSkills }) {
  return shadowedSkills.length ? shadowedSkills.map((skill) => `${skill.name} is replaced by ${skill.path}`).join("; ") : "the plugin's own";
}
function toolsText({ state, tools, unknownCount, unknownTools, access }) {
  if (state === "connected" && tools === 0) return `0 available: ${DISPLAY_NAME} lists no tools for this account`;
  if (unknownCount === 0) return `${tools} available, 0 unknown`;
  const more = unknownCount - unknownTools.length;
  const names = unknownTools.length ? `: ${unknownTools.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : "";
  const posture = access === "all" ? "new tools run too" : access === "read-only" ? "new tools are denied" : "new tools ask before running";
  return `${tools} available, ${unknownCount} unknown${names} (${posture})`;
}
var listed = (items) => items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0];
var otherServersText = (names) => `${listed(names.map((name) => `mcp.servers.${name}`))} ${names.length > 1 ? "also point" : "also points"} at ${DISPLAY_NAME} and ${names.length > 1 ? "are" : "is"} outside these caps`;
function spendText({ spend, region, otherServers }) {
  const count2 = (value) => value.toLocaleString("en-US");
  const cap2 = (value) => value === null ? "no cap" : count2(value);
  const parts = [
    `${count2(spend.dailyCredits)} credits spent in the last 24 hours of ${cap2(spend.dailyCap)}`,
    `a session is capped at ${cap2(spend.sessionCap)}`
  ];
  if (spend.balance) {
    const { used, limit, resetsAt, extension } = spend.balance;
    const left = Math.max(0, limit - used);
    const reset = resetsAt === void 0 ? "" : `, resetting ${new Date(resetsAt).toISOString().slice(0, 10)}`;
    const overage = extension === "unlimited" ? ", overage unlimited" : extension === void 0 || extension === 0 ? "" : `, overage up to ${count2(extension)} more`;
    parts.push(`workspace balance ${count2(left)} of ${count2(limit)} credits left${reset}${overage}`);
  } else {
    parts.push(`workspace balance unknown: add a key in /connect as "${"ElevenLabs API key (optional)"}" (${REGIONS[region]} charges the workspace)`);
  }
  if (otherServers.length) parts.push(otherServersText(otherServers));
  return parts.join("; ");
}
function conversationsText(status) {
  if (status.conversations === "full") return `full: the transcript tools run, and they carry other people's calls`;
  if (status.conversations === "summary") return `summary: ${TRANSCRIPT_TOOLS.join(" and ")} are denied; the metadata reads run`;
  return "off: every read of a call's history is denied";
}
function hostText({ host, problems }) {
  const { version, range, tested } = host;
  const outside = version === null || !isSupportedHost(version);
  const notes = [
    ...outside ? [`It is outside the supported range; the plugin runs because allowUntestedHost is true. If ${DISPLAY_NAME} misbehaves, use OpenCode ${TESTED_TEXT}.`] : [],
    ...problems
  ];
  return `${version ?? "unknown version"} (${tested ? "tested" : "untested"}; supported range ${range})${notes.length ? `. ${notes.join(" ")}` : ""}`;
}
function formatStatus(status) {
  const { source, unguardedAgents: agents } = status;
  const details = [status.error, source && serverText(source)].filter(Boolean).join("; ");
  return [
    `${DISPLAY_NAME} status`,
    `- Connection: ${STATE_TEXT[status.state]}${details ? ` (${details})` : ""}`,
    `- Account: ${status.account ?? `account name not reported by ${DISPLAY_NAME}'s MCP`}`,
    `- Access: ${accessText(status.access)}`,
    `- Region: ${status.region} (${status.endpoint})`,
    `- Spend: ${spendText(status)}`,
    `- Conversations: ${conversationsText(status)}`,
    `- Media: ${status.mediaRoot}`,
    `- Skills: ${skillsText(status)}`,
    `- Tools: ${toolsText(status)}`,
    `- Agents without default rules: ${agents.length ? `${agents.join(", ")}
${agentRulesText(status.access, status.conversations)}` : "none"}`,
    `- OpenCode: ${hostText(status)}`,
    `- Next step: ${status.nextStep}`
  ].join("\n");
}
var strings = { type: "array", items: { type: "string" } };
var count = { type: "integer", minimum: 0 };
var cap = { type: ["integer", "null"], minimum: 0 };
var StatusRpc = {
  id: PLUGIN_ID,
  methods: {
    status: {
      input: { type: "object" },
      output: {
        type: "object",
        required: [
          "version",
          "state",
          "access",
          "conversations",
          "region",
          "endpoint",
          "tools",
          "unknownCount",
          "unknownTools",
          "unguardedAgents",
          "shadowedSkills",
          "spend",
          "otherServers",
          "mediaRoot",
          "host",
          "problems",
          "nextStep"
        ],
        properties: {
          version: { type: "string" },
          state: { enum: ["connected", "sign_in_required", "connecting", "disabled", "failed", "not_configured", "conflict"] },
          error: { type: "string" },
          account: { type: "string" },
          access: { enum: ["all", "ask-changes", "read-only"] },
          conversations: { enum: ["full", "summary", "off"] },
          region: { enum: ["global", "us", "eu", "in", "sg"] },
          endpoint: { type: "string" },
          source: {
            type: "object",
            required: ["type", "url"],
            properties: { type: { enum: ["plugin", "adopted", "conflict", "stale"] }, url: { type: "string" }, expected: { type: "string" } }
          },
          tools: count,
          unknownCount: count,
          unknownTools: strings,
          unguardedAgents: strings,
          shadowedSkills: {
            type: "array",
            items: { type: "object", required: ["name", "path"], properties: { name: { type: "string" }, path: { type: "string" } } }
          },
          spend: {
            type: "object",
            required: ["dailyCredits", "sessionCap", "dailyCap"],
            properties: {
              dailyCredits: count,
              sessionCap: cap,
              dailyCap: cap,
              balance: {
                type: "object",
                required: ["used", "limit"],
                properties: {
                  used: count,
                  limit: count,
                  resetsAt: { type: "integer" },
                  extension: { type: ["integer", "string"] },
                  tier: { type: "string" }
                }
              }
            }
          },
          otherServers: strings,
          mediaRoot: { type: "string" },
          host: {
            type: "object",
            required: ["version", "range", "tested"],
            properties: { version: { type: ["string", "null"] }, range: { type: "string" }, tested: { type: "boolean" } }
          },
          problems: strings,
          nextStep: { type: "string" }
        }
      },
      errors: { unavailable: { type: "object", required: ["nextStep"], properties: { nextStep: { type: "string" } } } }
    }
  },
  events: {}
};

// src/tui.ts
var TUI_ID = "elevenlabs.tui";
var TITLE = "ElevenLabs status";
var KEYS = "r refresh \xB7 esc close";
function viewMessage(result) {
  return `${reportOf(result)}

${KEYS}`;
}
function reportOf(result) {
  if ("status" in result) return formatStatus(result.status).split("\n").slice(1).join("\n");
  const { error } = result;
  const type = typeof error === "object" && error !== null && "type" in error ? error.type : void 0;
  if (type === "unavailable") {
    const { message, data } = error;
    if (typeof message === "string" && typeof data?.nextStep === "string") return `${message} Next step: ${data.nextStep}`;
  }
  if (type === "rpc.unavailable" || type === "rpc.method_not_found") {
    return errorText("STATUS_UNAVAILABLE", "The ElevenLabs plugin is not running on this OpenCode server.", "Run /plugins to see why it did not start.");
  }
  const reason = shortReason(typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error));
  return errorText("STATUS_UNAVAILABLE", `Could not read ElevenLabs' status${reason ? ` (${reason})` : ""}.`, "Restart OpenCode, then run /elevenlabs again.");
}
function setupView(context) {
  let open;
  let latest = 0;
  let stops = [];
  const unsubscribe = () => {
    for (const stop of stops.splice(0)) stop();
  };
  const subscribe = () => {
    if (stops.length) return;
    stops = [
      context.data.on("mcp.status.changed", (event) => {
        if (event.data.server === SERVER_NAME) refresh();
      }),
      // Status events can be missed while the TUI is reconnecting.
      context.data.on("server.connected", refresh),
      context.data.on("agent.updated", refresh),
      // Signing in, out or switching accounts changes the account and the sign-in state.
      context.data.on("integration.updated", refresh),
      context.data.on("credential.updated", refresh),
      context.data.on("credential.switched", refresh)
    ];
  };
  const [shown, setShown] = createSignal(false);
  const show = async (refresh2) => {
    if (refresh2 && open === void 0) return;
    const request = ++latest;
    const location = context.location;
    const result = await context.client.rpc(StatusRpc).status({}, location ? { location } : {}).then((status) => ({ status }), (error) => ({ error }));
    if (request !== latest || refresh2 && open === void 0) return;
    open = request;
    setShown(true);
    subscribe();
    void context.ui.dialog.alert({ title: TITLE, message: viewMessage(result) }).then(() => {
      if (open !== request) return;
      open = void 0;
      setShown(false);
      unsubscribe();
    });
    context.ui.dialog.set({ size: "large" });
  };
  const refresh = () => void show(true);
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "elevenlabs.status",
        title: "ElevenLabs: Status",
        description: "Sign-in, account, region, spend, tools and the next step for ElevenLabs",
        group: "ElevenLabs",
        palette: true,
        slash: { name: "elevenlabs" },
        run: () => show(false)
      },
      { id: "elevenlabs.status.refresh", title: "Refresh ElevenLabs status", group: "ElevenLabs", bind: "r", enabled: shown, run: refresh }
    ]
  }));
  return () => {
    unsubscribe();
    if (open === void 0) return;
    open = void 0;
    setShown(false);
    context.ui.dialog.clear();
  };
}
var tui_default = Plugin.define({ id: TUI_ID, setup: setupView });
export {
  tui_default as default,
  setupView,
  viewMessage
};
