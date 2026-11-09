# Architecture

The plugin is a thin layer over ElevenLabs' hosted MCP server. OpenCode owns the MCP transport, OAuth, credentials,
permission prompts and tool output limits. The plugin registers the server, names its `/connect` entry, adds the default
permission rules, guards spending, saves generated files, reports status, ships three skills, and lets scripts call the
known tools through a tools RPC. It adds one tool of its own and has no runtime dependencies beyond Node's built-ins.

## Layout

| Path | Role |
| --- | --- |
| `src/index.ts` | The server part: the plugin `elevenlabs` |
| `src/plugin.ts` | Setup: the server, the namespace, the rules, the guard's hooks, the commands, the tools RPC |
| `src/constants.ts` | Ids, the region table, the scope pin, the media host, the host range, `TESTED_HOSTS` and the codes |
| `src/options.ts` | Option parsing and validation |
| `src/elevenlabs-tools.ts` | The one tool table: reads, export, writes, billed generations, deletes, transcript lists, `classify()` |
| `src/permissions.ts` | The generated default rules, their placement, and the agents that need them |
| `src/billing.ts` | Prices, the rolling ledger, the pre-call refusal, the cost line, the RPC `cost` object |
| `src/media/policy.ts` | The export-root path policy and the file write |
| `src/media/save.ts` | The link checks, the download and the extension and duration rules |
| `src/media/tool.ts` | `elevenlabs_save_media`: its schema, its own permission assert, and its tools-RPC method |
| `src/balance.ts` | The optional API key, and the one subscription read it is used for |
| `src/status.ts` | The status model, `/elevenlabs-status`, and the status RPC |
| `src/doctor.ts` | `/elevenlabs-doctor`: the live checks |
| `src/integration.ts` | The `/connect` entry's name and the "Sign in required" mark |
| `src/tui.ts` | The terminal UI part and the `/elevenlabs` dialog |
| `src/host/tools-rpc.ts` | The tools RPC, `elevenlabs.tools`; a copy of a module shared by several plugins |
| `src/skills.ts`, `src/redact.ts`, `src/host-version.ts`, `src/version.ts` | Skills, redaction, the host check, the version |

`scripts/build.mjs` bundles each entry with esbuild into one self-contained file: `src/index.ts` into `dist/index.js` and
`src/tui.ts` into `dist/tui.js`. The bundles have no chunks and no relative imports, because OpenCode reloads a plugin in
place and keeps the modules it already loaded for unchanged paths. Only `@opencode/plugin`, OpenTUI, Solid and
`node:` built-ins stay external. `tsc` only typechecks.

## Setup

1. `parseOptions` validates the options; anything wrong fails with `OPTIONS_INVALID`.
2. `checkHost` compares `ctx.app.version` with `>=2.2.3 <2.3.0`. Inside it the plugin starts; status calls only 2.2.3, 2.2.4, 2.2.5 and 2.2.6 tested. Outside it, setup fails with `HOST_UNTESTED` unless `allowUntestedHost` is set.
3. The ledger is read from `ctx.storage` once, so the 24-hour total survives a reload.
4. `ctx.mcp.transform` registers `elevenlabs` at the selected region's URL, with `oauth.scope` pinned to seven scopes, or
   adopts the user's own entry at exactly that URL. Another region's URL is `stale`; any other is `conflict`.
5. `ctx.tool.transform` sets the namespace description and adds `elevenlabs_save_media`.
6. `ctx.agent.transform` inserts the default rules after each agent's base `* * allow`.
7. `ctx.integration.transform` adds the optional API key entry to `/connect`.
8. `ctx.skill.transform`, `ctx.command.transform` (`/elevenlabs-status`, `/elevenlabs-doctor`) and `ctx.rpc.register`
   (`elevenlabs/status`).
9. `registerToolsRpc` registers `elevenlabs.tools` with the spending guard's shapers.
10. `ctx.tool.hook("execute.before")` prices a billed call, may write a clamped `generations_count`, and refuses one that
    does not fit before it is sent. `ctx.tool.hook("execute.after")` charges the ledger and appends the cost line, and the
    expiry line for a generation's link.
11. `watchIntegration` starts. Setup returns one cleanup that stops it, both hooks and the tools RPC.

Transforms are synchronous and never throw: a failure is kept as a problem for status, and cleared when the next replay
succeeds.

## Platform facts (OpenCode 2.2.3 to 2.2.6)

- **The sign-in is CIMD.** ElevenLabs' authorization server advertises `client_id_metadata_document_supported: true` and
  no registration endpoint, so OpenCode sends its own client metadata document
  (`https://opencode.ai/oauth/opencode/client.json`). Nothing ships with the plugin. A pinned `client_id` or
  `redirect_uri` would disable that; the plugin pins neither.
- **The scope pin.** OpenCode requests `oauth.scope` when it is set, otherwise the scope in the `401` challenge
  (ElevenLabs' names none), otherwise every scope in `scopes_supported`. ElevenLabs advertises eight; the plugin pins the
  seven its own MCP client asks for, so `ads_read` is never requested. A host test asserts the exact scopes in the
  authorization request and fails if the pin is removed.
- **Discovery.** The global MCP resource names `https://api.us.elevenlabs.io` as its authorization server, so the global
  and US servers share one. Each region serves the same documents with its own host, and each accepts CIMD.
- **The token never reaches the plugin.** OpenCode holds it and refreshes it; `/elevenlabs-status` sees only a
  credential's label. That is why the balance needs a separate key.
- **The hooks.** `execute.before` can change an MCP call's arguments on the model path and in Code Mode, and
  `execute.after` can add to a result. The tools RPC's executor bypasses both, so the same guard runs there through the
  block's own shapers.
- **A plugin tool's declared permission only hides it on a deny.** Every plugin-owned tool that writes asserts its own
  action inside `execute`; `elevenlabs_save_media` does, on both paths.
- **Changing a server's URL changes its integration id** (`mcp_` + `sha1(name\0url)`), so a region change needs a new
  sign-in and leaves the old credential behind. Status detects that and gives one next step.
- **`dist/tui.js` carries no zod and no host contract**: the RPC contract is plain JSON Schema, written with
  `Rpc.define`.

## The spending guard

`priceOf` computes a price from ElevenLabs' published formula for speech, music, sound effects and a transcription whose
file the plugin can measure. A number the caller types may raise that price; it cannot lower one, and a price of 0 is a
refusal. Image and video have no published price, so the model path awaits a real `estimate_only: true` call through the
host's executor, once, and the script path uses a price the script fetched itself, remembered for ten minutes. A call
that cannot be priced is refused (`PRICE_UNKNOWN`), never guessed. While either cap is on, a name that starts with
`creative_` and is not priced by the table the guard consults is refused before dispatch. There is no keyword list. A
price that does not fit is refused before dispatch (`SPEND_CAP_REACHED`).

A price is **reserved** in the ledger before the call is sent and settled into a charge when its result arrives, so a
parallel turn cannot spend one budget twice. A call that fails, and a hold still open after ten minutes, is charged the
reserved price: the plugin cannot tell a free failure from a billed one. A later higher figure may replace that charge.
A zero or a missing result does not free the budget. The ledger is append-only: every hold and every charge is one
`ctx.storage` key, `spend/<writerId>/<entryId>`, where `writerId` is unique to this plugin instance and only the
instance that created a key ever rewrites it. A total is a scan over `spend/` and a sum — there is no merge, no
`Math.max` and no read-modify-write of a shared record, so no writer can drop another's row. Pruning folds older
entries into that writer's own hourly key, `spend/<writerId>/h/<hour>`, and the hours of every writer are added
together, which cannot double-count because a charge is folded by exactly one writer. A folded hour is kept while any
minute of its hour is still inside the window, so a folded charge counts for up to an hour past its own day, and never
less than it. A key is removed only once it is past the window. Two ledgers handed one storage object share a book and
one daily cap, as two locations in one OpenCode do. Across processes, exactly: **within one process the caps are exact;
two calls started at the same instant in two processes can exceed a cap by at most one call's reservation; a settled
charge is never lost.** `reserve` keeps its check and its hold synchronous, with nothing awaited between them, then
writes the hold's own key and awaits it before dispatch; a failed write takes the hold back out of memory and refuses
the call. Two machines share nothing. Two locations keep their own tools-RPC shapers. On the script path, one priced
call per session and method is in flight.

### Argument allowlists

Every tool the guard prices has a list of the argument names it may carry while a cap is on. An argument outside its
tool's list is one whose effect on the bill this plugin does not know, so the call is refused (`PRICE_UNKNOWN`) and the
refusal names the argument, rather than being priced as if the argument were not there. With both caps off nothing is
priced and the same call runs. The lists come from the schemas the plugin knows — `test/fixtures/live-tools.json` and
the fake server in `test/host/fake-mcp.ts` — and from the names the pricing itself reads. Neither source has been
checked against a live account, so confirming each priced tool's real argument names is one of the live-reconcile
steps in `test/fixtures/README.md`.

Every priced call may carry `estimate_only`, `estimateOnly`, `context`, `generations_count`, `generations`,
`variations`, `num_generations` and `num_outputs`. The count keys all multiply the price: a call stating more than one
is priced from the largest, and a clamp writes the allowed count into every one of them. Beyond those:

| Tools | Arguments |
|---|---|
| `creative_generate_speech`, `creative_speech`, `text_to_speech` | `text`, `script`, `message`, `takes`, `num_takes`, `voice_id`, `model_id` |
| `creative_transcribe_audio`, `speech_to_text`, `creative_transcription` | `path`, `file`, `file_path`, `audio_path`, `filename`, `audio_file`, `input_file`, `duration_ms`, `audio_duration_ms`, `duration_seconds`, `duration`, `audio_duration_seconds`, `model_id`, `language_code`, `timestamps_granularity`, `diarize`, `use_speaker_library`, `detect_speaker_roles`, `num_speakers`, `diarization_threshold`, `keyterms`, `tag_audio_events`, `entity_detection`, `entity_redaction`, `no_verbatim`, `use_multi_channel`, `multichannel_output_style`, `webhook`, `webhook_id`, `webhook_metadata`, `temperature`, `seed`, `additional_formats`, `file_format`, `enable_logging` |
| `creative_generate_music`, `creative_compose_music` | `prompt`, `music_length_ms`, `duration_seconds`, `duration`, `composition_plan` |
| `creative_generate_sound_effect`, `creative_sound_effects` | `prompt`, `duration_seconds` |
| `creative_generate_image` | `prompt`, `model_id` |
| `creative_generate_video` | `prompt`, `model_id`, `duration_seconds` |

Two names are deliberately absent. `transcript_edit` is documented as a 30% surcharge billed for at least ten seconds,
which is a price this plugin does not compute. `connect_from` points the server at a file somewhere this plugin cannot
measure, and for a transcription the file is the whole of the price. Any other tool has no list, because the guard
cannot price it at all and a cap already refuses it.

A `composition_plan` is priced at the sum of its sections' `duration_ms` (or `duration_seconds`), and the call is
priced at whichever is longer, that sum or a length the call states. A plan whose durations cannot be read — no
sections, a section with no duration, a duration no number can be read out of — is `PRICE_UNKNOWN`. A length above
ElevenLabs' published maximum is priced as stated: over-pricing a call is the safe side, and no refusal is owed.

### Two durations, and why they never meet

`elevenlabs_save_media` prints how long a saved file is, and the spending guard decides what a file costs. These read
different things on purpose.

The guard measures a local PCM WAV the way a decoder does — the `fmt ` fields and the `data` bytes — and refuses every
other container (`PRICE_UNKNOWN`). It calls `riffSecondsWith` itself. Nothing it reads is a figure the file states
about itself, because a file that sets its own duration would set its own price. A WAV holding more than one `data`
chunk is refused as well: CoreAudio reads the last such chunk and Python's `wave` the first, so its length depends on
which decoder opens it, and a rule that picked one would be picking the cheaper reading of a file.

The saved line uses `durationOf`, which measures a WAV the same way and otherwise reads the duration an MP4 or M4A
states in the `mvhd` box inside its `moov` — the format ElevenLabs returns, which carries no length anywhere a
decoder-free reader can compute. That walk is bounded: every read is inside the file's own size, the number of boxes
it steps through is capped, and a stated duration longer than the file's bytes could hold at 8 kbps is dropped rather
than shown. It is a display figure and nothing prices a call from it.
