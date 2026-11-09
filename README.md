# ElevenLabs for OpenCode

Manage the voice and chat agents in your ElevenLabs workspace, review what callers said to them, and generate speech,
images, video, music and sound through ElevenLabs' official MCP server, from OpenCode.

Unofficial; not affiliated with ElevenLabs.

## Requirements

- OpenCode `>=2.2.3 <2.3.0`. Tested on 2.2.3, 2.2.4, 2.2.5 and 2.2.6.
- macOS or Linux.
- An ElevenLabs account with a workspace. Generations spend that workspace's credits.

## Install

```sh
opencode plugin add @joe-broadhead/opencode-elevenlabs
```

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
opencode api post /api/rpc/elevenlabs.tools/agents_list -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{}}}'
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
  read. Exactly: **within one OpenCode the caps are exact; OpenCodes deciding at the same instant cross a cap by at most
  one call's reservation for each one past the first, so eight of them at 3,000 credits a call can spend 31,000 against
  a 10,000 cap; a Code Mode call cannot read the store before it decides, so an OpenCode that has read nothing since it
  started admits a whole cap of its own; a settled charge is never lost.** Both crossings need overlap: calls that wait
  for one another see one another, and those same eight, run one after the next, spend only the 9,000 that fits. Size a
  cap as the bound you can afford to be crossed once per extra OpenCode, not as a hard limit on the account. Two
  machines share nothing: the store cannot see them.
- **Image and video are priced by ElevenLabs, not by this plugin.** Their cost depends on the model, the resolution and
  the duration, and ElevenLabs publishes no per-unit figure, so before an image or video generation the plugin asks
  ElevenLabs for a price with `estimate_only: true`. The cost line says "at most" until the live reconcile proves the
  unit. If the price cannot be had, the call is refused rather than run unpriced.
- **Speech, music, sound effects and transcription use ElevenLabs' published rates** (1 credit per character, two takes,
  900 per minute, 200 per generation, 330 per minute for Speech to Text), so their cost line says "at most". A caller
  `takes` below two does not lower the speech price. A transcription is priced from the file about to be sent, not from
  a duration the caller types; that duration may raise the price, and a file whose container duration cannot be read is
  refused. The file is checked again just before the price is held, and one that changed in between is refused rather
  than sent on the old price. A transcription is a read, but it bills: `access: "read-only"` denies the generations and **not** the
  transcription, so the caps are what bound it.
- **A call that may spend is priced before it runs, or refused.** While either cap is on, a name that starts with creative_ is priced by the table the guard consults or refused PRICE_UNKNOWN before it is sent, unless that table classifies the name as a read, write, export or delete that does not spend.
  Image and video, which the table prices only from ElevenLabs' estimate, are the exception that asks for that estimate.
  A computed price of 0 is a refusal, not a free call.
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
   { "plugins": [{ "package": "@joe-broadhead/opencode-elevenlabs", "options": { "access": "read-only" } }] }
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
`defaultRules("all")` in `src/permissions.ts`:

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
  { "action": "elevenlabs_creative_generate_music", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_generate_sound_effect", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_generate_speech", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_creative_generate_video", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_bulk_delete_knowledge_base", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete_phone_number", "resource": "*", "effect": "allow" },
  { "action": "elevenlabs_agents_delete_tool", "resource": "*", "effect": "allow" }
]
```

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
{ "plugins": [{ "package": "@joe-broadhead/opencode-elevenlabs", "options": {
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
    "package": "@joe-broadhead/opencode-elevenlabs",
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

- **The tool table is provisional.** It holds the 40 tool names ElevenLabs' own MCP skills name; the live list is
  reconciled after a sign-in (`test/fixtures/README.md`). A tool ElevenLabs adds later still runs, under the
  `elevenlabs_*` rule, and status names it as unknown until it is classified.
- **The caps bound this plugin, not the account.** The workspace balance needs the optional API key.
- **No dollar figure is derived from credits.**
- **Image and video prices come from ElevenLabs.** If the estimate is unavailable the call is refused rather than guessed.
- **Two facts about that estimate are unverified until the live reconcile:** that `estimate_only: true` costs nothing, and
  whether its figure is one generation's or the total for the generations asked for. The plugin reads it as one
  generation's and multiplies by the count, which over-states a batch total rather than under-stating a per-generation
  figure; the cost line therefore says "at most" whenever a count multiplies it, and the reconcile measures both against
  a real workspace before this line is removed.
- **Durations are read from the container.** WAV and MP4/M4A state one; MP3, Ogg and WebM do not, and the field is left
  out rather than estimated. A WAV holding more than one `data` chunk states two, and real decoders disagree about
  which counts, so it is treated as stating none.

## Uninstall

Sign out first, so the stored credential goes with the plugin:

```sh
opencode mcp logout elevenlabs
opencode auth list
opencode plugin remove @joe-broadhead/opencode-elevenlabs
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
