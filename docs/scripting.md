# Scripting

A script can call every tool this plugin knows with no model: a cron job, a shell script, or any program that can reach
the OpenCode server. It uses the tools RPC, `elevenlabs.tools`, through `opencode api` or an OpenCode client.

| Class | Methods |
| --- | --- |
| read | the 18 read tools (`READ_TOOLS` in `src/elevenlabs-tools.ts`), `creative_transcribe_audio` among them: `agents_get`, `agents_get_conversation`, `agents_get_kb_dependents`, `agents_get_test_run`, `agents_get_widget`, `agents_list`, `agents_list_conversations`, `agents_list_test_runs`, `agents_merge_branch_preview`, `agents_query_knowledge_base_rag`, `agents_search_conversation_messages`, `agents_search_knowledge_base`, `creative_get_flow`, `creative_get_flow_node_types`, `creative_get_flow_run_status`, `creative_get_model_guide`, `creative_list_voices`, `creative_transcribe_audio` |
| write | the 13 tools that change the workspace: `agents_create`, `agents_create_branch`, `agents_create_deployment`, `agents_create_kb_folder`, `agents_create_kb_text`, `agents_create_kb_url`, `agents_create_test`, `agents_duplicate`, `agents_merge_branch`, `agents_update`, `creative_attach_reference_file`, `creative_create_flow`, `creative_upload_flow_reference` |
| write (billed) | the 6 generations, each priced before it runs: `creative_edit_image`, `creative_generate_image`, `creative_generate_music`, `creative_generate_sound_effect`, `creative_generate_speech`, `creative_generate_video` |
| export | `agents_get_link` (mints a link usable outside the workspace) and `elevenlabs_save_media` (writes a file) |
| destructive | `agents_bulk_delete_knowledge_base`, `agents_delete`, `agents_delete_phone_number`, `agents_delete_tool` |
| `describe` | not a tool: lists the methods, their classes and permission actions, whether OpenCode lists each tool now, each tool's input as JSON Schema, and — with a session — that session's permission for each |

The class is the worst thing a tool can do; it never decides whether a call runs: the rules do.

## A script runs as a session

Every call names a session, and the session must name an agent. Create it for the script once, with the agent the script
runs as, and keep its id (`data.id` in the reply):

```sh
opencode api post /api/session -d '{"title":"call review","agent":"build"}'
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
opencode api post /api/session -d '{"title":"agent audit","agent":"build","permissions":[
  {"action":"elevenlabs_*","resource":"*","effect":"deny"},
  {"action":"elevenlabs_agents_list","resource":"*","effect":"allow"},
  {"action":"elevenlabs_agents_get","resource":"*","effect":"allow"}
]}'
```

## Calling a method

The body is `{"input": {"sessionID": "<session>", "input": <the tool's input>}}`. Both keys are required, and no other
key is allowed:

```sh
opencode api post /api/rpc/elevenlabs.tools/agents_list -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{}}}'
```

The tool's input is ElevenLabs', and ElevenLabs defines its fields: `describe` shows each tool's schema as OpenCode lists
it now. Check it rather than guess a field name. For example, reading one conversation takes a `conversation_id` from a
list result:

```sh
opencode api post /api/rpc/elevenlabs.tools/agents_get_conversation -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{"conversation_id":"…"}}}'
```

`describe` takes nothing, or a session to resolve each method's permission for:

```sh
opencode api post /api/rpc/elevenlabs.tools/describe -H "x-opencode-directory:$PWD" -d '{"input":{}}'
opencode api post /api/rpc/elevenlabs.tools/describe -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…"}}'
```

## Spending in a script

A script's generations count against the same rolling 24-hour ledger the model's calls do. `creative_transcribe_audio` is a read that bills: it is allowed at every `access` value, and the caps are what bound it.

- Speech, music, sound effects and transcription are priced from ElevenLabs' published rates, so a script gets a price
  before dispatch and a refusal when it does not fit.
- A script's price is **reserved** before dispatch and settled when the result arrives, so two calls in flight cannot
  spend the same budget. A failed call is charged the reserved price. One priced call per session and method is in
  flight; a second, estimate or not, is refused until the first settles.
- **Image and video have no published price.** A script must fetch one itself, once, then call again with the same
  arguments: the plugin remembers the price for ten minutes.

```sh
opencode api post /api/rpc/elevenlabs.tools/creative_generate_image -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{"prompt":"a ceramic mug on marble","generations_count":1,"estimate_only":true}}}'
```

A paid call with no price and no remembered estimate is refused `PRICE_UNKNOWN`, with no generation and no charge.
A paid call whose price does not fit is refused `SPEND_CAP_REACHED`, also with no generation. Both refusals name the
option to change. Every paid result carries a `cost` object beside its output:

```json
{ "credits": 1200, "basis": "at-most", "sessionSpent": 1200, "dailySpent": 1200, "sessionCap": 2000, "dailyCap": 10000 }
```

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
| `SPEND_CAP_REACHED` | The call would exceed `sessionCreditCap` or `dailyCreditCap`, or a priced call of the same method is already in flight. No generation was sent. |
| `PRICE_UNKNOWN` | The call may spend, and neither the table nor a remembered estimate prices it. No call was sent. |
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
- Get a price for an image or video generation without asking ElevenLabs first, because none is published.
- Rely on a past "Always allow": it does not authorize an ad-hoc script.
- Use a token: the plugin has none to give. The MCP connection, its sign-in and its refresh are OpenCode's.
- Keep a generated file without the `external_directory` rule, which is a path rule and not a permission on the tool.

A script's calls write nothing to the session, and OpenCode's `execute.before` and `execute.after` tool hooks, from any
plugin, do not run for them. The tools RPC applies the same spending guard itself, through its own shapers, so a script
is charged and capped exactly as a model's call is.
