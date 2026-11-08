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
| `dailyCreditCap` | a whole number of credits, or `null` | `10000` | The most this plugin may spend in a rolling 24 hours, across sessions, scripts and restarts. `null` disables the cap. |
| `mediaRoot` | a path, `~` for your home folder | `"~/Downloads/elevenlabs"` | Where `elevenlabs_save_media` writes. Created on first use with mode 0700. |
| `maxMediaBytes` | a whole number of bytes | `209715200` (200 MB) | The largest file the save tool writes. |
| `conversations` | `"full"`, `"summary"`, `"off"` | `"full"` | How much of a call's history the conversation reads may return. |
| `allowUntestedHost` | `true`, `false` | `false` | Start on an OpenCode version outside `>=2.2.3 <2.3.0`, with a note in status. |

`0` is refused for either cap: a typo must not turn the guard off. Write `null` to mean it.

## The default rules

The block is generated from `defaultRules(access, conversations)` in `src/permissions.ts` and inserted directly after
each agent's base `* * allow`. Everything later wins: the agent's own rules, your `permissions`, and your saved answers.

### `access: "all"` — the default

Every tool runs, including a tool ElevenLabs adds later, and generations spend credits within the caps.

```json
[
  { "action": "elevenlabs_*", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_conversation", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_kb_dependents", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_test_run", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_widget", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_conversations", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_test_runs", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_merge_branch_preview", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_query_knowledge_base_rag", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_search_conversation_messages", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_search_knowledge_base", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_flow", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_flow_node_types", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_flow_run_status", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_model_guide", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_list_voices", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_transcribe_audio", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_link", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_branch", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_deployment", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_kb_folder", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_kb_text", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_kb_url", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_create_test", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_duplicate", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_merge_branch", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_update", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_attach_reference_file", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_create_flow", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_upload_flow_reference", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_edit_image", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_generate_image", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_generate_speech", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_generate_video", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_bulk_delete_knowledge_base", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete_phone_number", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete_tool", "resource": "*", "effect": "allow" }
]
```

### `access: "ask-changes"`

The reads run; every other tool asks first, and a tool ElevenLabs adds later asks too. In `opencode run`, where nobody
can answer, an ask is refused.

```json
[
  { "action": "elevenlabs_*", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_get", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_conversation", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_kb_dependents", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_test_run", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_widget", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_conversations", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_test_runs", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_merge_branch_preview", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_query_knowledge_base_rag", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_search_conversation_messages", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_search_knowledge_base", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_flow", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_flow_node_types", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_flow_run_status", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_model_guide", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_list_voices", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_transcribe_audio", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_link", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_branch", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_deployment", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_kb_folder", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_kb_text", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_kb_url", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_create_test", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_duplicate", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_merge_branch", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_update", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_attach_reference_file", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_create_flow", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_upload_flow_reference", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_edit_image", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_generate_image", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_generate_speech", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_creative_generate_video", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_bulk_delete_knowledge_base", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_delete", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_delete_phone_number", "resource": "*", "effect": "ask" },
  { "action": "elevenlabs_agents_delete_tool", "resource": "*", "effect": "ask" }
]
```

### `access: "read-only"`

The reads run; everything else is denied, including every generation. A tool ElevenLabs adds later is denied too.

```json
[
  { "action": "elevenlabs_*", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_get", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_conversation", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_kb_dependents", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_test_run", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_widget", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_conversations", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_list_test_runs", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_merge_branch_preview", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_query_knowledge_base_rag", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_search_conversation_messages", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_search_knowledge_base", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_flow", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_flow_node_types", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_flow_run_status", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_get_model_guide", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_list_voices", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_transcribe_audio", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_get_link", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_branch", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_deployment", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_kb_folder", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_kb_text", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_kb_url", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_create_test", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_duplicate", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_merge_branch", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_update", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_attach_reference_file", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_create_flow", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_upload_flow_reference", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_edit_image", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_generate_image", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_generate_speech", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_creative_generate_video", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_bulk_delete_knowledge_base", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_delete", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_delete_phone_number", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_delete_tool", "resource": "*", "effect": "deny" }
]
```

### `conversations`

The option adds deny rules at the end of the block, so they win over its own allows.

`conversations: "summary"` appends:

```json
[
  { "action": "elevenlabs_agents_get_conversation", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_search_conversation_messages", "resource": "*", "effect": "deny" }
]
```

`conversations: "off"` appends:

```json
[
  { "action": "elevenlabs_agents_get_conversation", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_search_conversation_messages", "resource": "*", "effect": "deny" },
  { "action": "elevenlabs_agents_list_conversations", "resource": "*", "effect": "deny" }
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
  { "action": "external_directory", "resource": "~/Downloads/elevenlabs/*", "effect": "allow" }
] }
```

A refusal whose message begins `permission.rejected: external_directory` needs the second rule. The first save asks for
both.

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
| `host untested` | OpenCode is outside the range and the plugin is in status-only mode |

## Errors

Every code the plugin raises, in the order the table lists them:

| Code | What happened | Next step |
| --- | --- | --- |
| `BALANCE_UNAVAILABLE` | The optional API key could not read the subscription. | Run `/elevenlabs-status`; if it keeps failing, remove the key in `/connect`. |
| `ESTIMATE_REQUIRED` | A billed call has no published price, and ElevenLabs did not give one. | Call the tool once with `"estimate_only": true`, then call it again with the same arguments. |
| `HOST_UNTESTED` | OpenCode is outside `>=2.2.3 <2.3.0`. | Use a supported OpenCode, or set `"allowUntestedHost": true`. |
| `MEDIA_EXPIRED` | The generated file's signed link has expired. | Fetch the generation again for a fresh link; do not generate again. |
| `MEDIA_TOO_LARGE` | The file is larger than `maxMediaBytes`. | Raise `maxMediaBytes` if you mean to keep a file this large. |
| `MEDIA_URL_INVALID` | The link is not `https`, carries credentials, or is not on ElevenLabs' generated-file host. | Pass the link a generation returned. |
| `OPTIONS_INVALID` | A plugin option is missing, of the wrong type, or out of range. | Fix the option; the message names the accepted values. |
| `RULES_NOT_ADDED` | The default rules could not be inserted into the agents. | Restart OpenCode. |
| `SAVE_FAILED` | The file could not be written, or the folder changed while it was. | Check `mediaRoot`, its permissions, and the `external_directory` rule. |
| `SERVER_NOT_REGISTERED` | The MCP server could not be registered. | Restart OpenCode. |
| `SKILLS_INVALID` | A skill file is missing or malformed. | Reinstall the plugin. |
| `SPEND_CAP_REACHED` | The call would exceed `sessionCreditCap` or `dailyCreditCap`. | Raise the cap, set it to `null`, or wait for the 24-hour window to roll. |
| `STATUS_UNAVAILABLE` | The status report could not be read. | Restart OpenCode, then run `/elevenlabs-status` again. |

An upstream error from ElevenLabs passes through unchanged, a `429` rate limit included: wait for the window it names.

## Doctor

`/elevenlabs-doctor` makes the checks a status report cannot: ElevenLabs' discovery document for the selected region, the
authorization server's metadata and whether it accepts a client metadata document, the scopes it advertises, whether the
server is connected and how many tools it lists, whether the three skills loaded, the media folder, and the spend. It
reads; it never generates, signs in or spends.
