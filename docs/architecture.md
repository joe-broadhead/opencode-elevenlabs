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
| `src/elevenlabs-tools.ts` | The one tool table: all 190 live tools — reads, export, writes, spending tools, deletes — the transcript lists and `classify()` |
| `src/permissions.ts` | The generated default rules, their placement, and the agents that need them |
| `src/billing.ts` | ElevenLabs' estimate as the only price, the argument allowlists, the rolling ledger, the pre-call refusal, the cost line, the RPC `cost` object |
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
10. `ctx.tool.hook("execute.before")` prices a spending call from ElevenLabs' own estimate, may cut a `generations_count`
    the caller named to what the budget affords, and refuses a call that does not fit before it is sent.
    `ctx.tool.hook("execute.after")` charges the ledger and appends the cost line, and the expiry line for a
    generation's link. An `estimate_only` call is neither priced nor charged: its answer is remembered as the price of
    the paid call with the same arguments.
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

**ElevenLabs is the only source of a price.** This plugin computes none of its own: no rate per character, per second
or per minute, and no measurement of a local file. A call that can spend is priced by sending ElevenLabs the same call
with `estimate_only: true` and the same arguments, and reading the figure out of its answer (`estimatePrice` in
`src/billing.ts`). `ESTIMATE_TOOLS` holds the seven tools whose live schema declares `estimate_only`; `SPEND_TOOLS`
holds the nine that can spend. A spending tool with no estimate — `creative_design_voice` and `agents_run_tests` — has
no price at all, so while either cap is on it is refused (`PRICE_UNKNOWN`) rather than run unpriced.

**The figure is read strictly.** `estimatedCreditsOf` reads `estimate.credits` first, because that is the field the
live result used (`{"estimate": {"credits": 761.5151418103446}}`), then the same five named keys settlement reads a
charge under, at the top level. Nothing is read out of prose, and nothing is walked for several levels: a figure this
parser does not find leaves the call with no price, which a cap turns into `PRICE_UNKNOWN`. The estimate sets the
reservation and, where no later figure is seen, the charge, so it is read under at least the rules a figure that could
*lower* a reservation is read under.

The figure ElevenLabs answers with is the **batch total** for the call it was sent, which live reconcile 1 measured: an
estimate for four images came back as 761.5151418103446 credits, about 190 each. It is often fractional, and a
fractional estimate is a real figure — the ledger rounds it up (`Math.ceil`) and the cost line names the figure it
rounded from. When the call states no count, the batch is the server's own default for that tool
(`GENERATION_DEFAULTS`: four for an image or an image edit, two for speech, one for a video), so a price divided per
generation is divided by that default and the cost line says so. A tool whose schema declares `generations_count` with
no default of its own — `creative_generate_in_flow`, `creative_run_flow_nodes` — gets no per-generation figure, only
the total.

**An estimate is free but not harmless.** Live reconcile 1 measured two of them against the workspace balance and saw
no movement and no new billable request, and each one created a flow and a node in the owner's workspace. So the guard
asks for one estimate per set of arguments, remembers the figure for ten minutes (`RESERVATION_MS`), and reuses it for
the paid call rather than creating a second flow. Different arguments are a different call and get their own estimate.

**The estimate is asked for only where the paid call could run.** `estimatorFor` asserts the paid tool's own permission
(`elevenlabs_<tool>`, through `ctx.permission.assert`) before it sends anything. Under `access: "ask-changes"` that is
the one prompt for the generation: the user is asked once, and the estimate goes out only if they allow it — so an
estimate never creates a flow for a generation the user is about to refuse. Under `access: "read-only"` every spending
tool is denied, the assert fails, and no estimate is sent either. A declined or failed assert leaves the call with no
price, which a cap turns into `PRICE_UNKNOWN`.

While either cap is on, two kinds of call are priced or refused before dispatch: the ones the table classifies as
spending, and **any name the table does not classify at all, whatever it starts with**. There is no keyword list and
no prefix. A price that does not fit is refused (`SPEND_CAP_REACHED`), and a count the caller named is first cut to
what the budget affords; a call that named no count is refused at its whole figure rather than quietly given a smaller
batch than it asked for.

The unknown half is what closes the chain that starts at `get_more_tools`: a tool asks ElevenLabs to build more tools,
and a tool this release has never seen has no schema to check its arguments against and no `estimate_only` flag to
call, so nothing here could price it. A read the table already classifies still runs without a price, as it always
did, and so does the plugin's own `elevenlabs_save_media`.

Each refusal names what it could not price and what to do about it, in three shapes. A tool that takes `estimate_only`
is told to send the same call with `estimate_only: true` first. A classified spending tool that does not —
`creative_design_voice` and `agents_run_tests` — is told that ElevenLabs offers no estimate for it and that both caps
must be `null` to run it. A name the table does not know is told that nothing here can tell whether it spends, and to
set both caps to `null` or wait for a release that classifies it.

A price is **reserved** in the ledger before the call is sent and settled into a charge when its result arrives, so a
parallel turn cannot spend one budget twice. A call that fails, and a hold still open after ten minutes, is charged the
reserved price: the plugin cannot tell a free failure from a billed one. A later higher figure may replace that charge.
A zero or a missing result does not free the budget. A charge stays in the session that reserved it, whichever session
a later result is delivered under, exactly as it keeps that row's figure as its floor: a settlement may raise what a
call cost but never moves it to another session's budget. The ledger is append-only: every hold and every charge is one
`ctx.storage` key, `spend/<writerId>/<entryId>`, where `writerId` is unique to this plugin instance and only the
instance that created a key ever rewrites it. A total is a scan over `spend/` and a sum — there is no merge, no
`Math.max` and no read-modify-write of a shared record, so no writer can drop another's row. Pruning folds older
entries into that writer's own hourly key, `spend/<writerId>/h/<hour>`, and the hours of every writer are added
together, which cannot double-count because a charge is folded by exactly one writer. A folded hour is kept while any
minute of its hour is still inside the window, so a folded charge counts for up to an hour past its own day, and never
less than it. A key is removed only once it is past the window. Two ledgers handed one storage object share a book and
one daily cap, as two locations in one OpenCode do. Across processes, exactly: **within one OpenCode the caps are
exact; across OpenCodes a cap is crossed by at most one call's reservation for each one deciding before its read of the
others' holds lands, so eight of them at 3,000 credits a call can spend 31,000 against a 10,000 cap; every OpenCode
reads the store behind each call it admits and every five seconds besides, so none decides on a book older than that; a
settled charge is never lost.** The crossing needs overlap: calls that wait for one another see one another, and those
same eight, run one after the next, spend only the 9,000 that fits.

The bound follows from the order each path works in. `quote` can await, so it refreshes from the store and then
reserves: the most it can admit beyond a cap is one reservation for every OpenCode that read before the first of them
wrote. `quoteSync` cannot await before it dispatches, by the shaper contract, so it bounds its staleness behind itself
instead — it starts a read it does not wait for after the hold is taken, and the next call on that ledger decides from
a book that has seen the other OpenCodes' holds. A process that is idle, or whose calls all refuse, writes nothing and
would never read again, so setup also starts an unref'd timer that reads the store every `LEDGER_REFRESH_MS`, five
seconds, and stops when the plugin is disposed. Measured over one store, 100-credit calls against a 10,000 cap: two
OpenCodes spending together reach 10,000, eight reach 10,400, and an OpenCode that started before another spent the
whole cap admits one call before its next read, or none once the timer has run. Without those two reads the same
measurements were 20,000, 80,000 and a whole fresh cap. `reserve` keeps its check and its hold synchronous, with
nothing awaited between them, then
writes the hold's own key and awaits it before dispatch; a failed write takes the hold back out of memory and refuses
the call. Two machines share nothing. Two locations keep their own tools-RPC shapers. On the script path, one priced
call per session and method is in flight.

### Argument allowlists

Every tool the guard prices has a list of the argument names it may carry while a cap is on, and each list is that
tool's own live schema, name for name, taken from `test/fixtures/live-tools.json` and held against it by
`test/unit/live-schema.test.ts`. An argument outside the list is one ElevenLabs' own schema for that tool does not
have, so the call is refused (`PRICE_UNKNOWN`) and the refusal names the argument. The estimate is not asked for in
that case either: it would answer for arguments nothing here can account for, and leave another flow behind for a call
that is going to be refused. With both caps off nothing is priced and the same call runs. Live reconcile 2 is where
the lists are checked again, by the step that says to confirm each priced tool's real argument names in
`test/fixtures/README.md`.

Every priced call may carry `estimate_only`, `context` and `flow_id`. Every priced call **except a transcription** may also carry
the count key `generations_count`, which is the only batch-size name in the live catalogue — it appears on six tools,
and a count under any other name is an argument the live schema does not have. A transcription takes none: it
transcribes the node it is connected to, once.

| Tools | Arguments |
|---|---|
| `creative_generate_image`, `creative_generate_video`, `creative_edit_image` | `prompt`, `model_id`, `connect_from` |
| `creative_generate_speech` | `prompt`, `model_id`, `voice_id`, `view_state_id` |
| `creative_generate_in_flow` | `prompt`, `model_id`, `voice_id`, `node_type`, `connect_from`, `view_state_id` |
| `creative_run_flow_nodes` | `node_ids` |
| `creative_transcribe_audio` | `model_id`, `connect_from`, `view_state_id` |

`connect_from` is on these lists because that is how a live creative tool is given its input: a node on the same flow,
not a file on this machine. `creative_transcribe_audio` has no file or path argument at all — its audio comes from the
node it is connected to, and the server never sees anything on this disk.

The two spending tools with no list are `creative_design_voice` and `agents_run_tests`, because their live schemas
declare no `estimate_only` and nothing here can price them; a cap refuses them outright, so a list of arguments would
decide nothing.

### What each tool is allowed to do

`classify()` puts each of the 190 live tools in one class, from its own name, description and schema: 83 reads, 2
exports, 82 writes, 9 that can spend and 14 destructive. Nothing is left unclassified. The class is the worst thing a
tool can do; it never decides whether a call runs, only what the generated default rules give it.

Two of them are judgement calls, recorded here because nothing in the catalogue settles them:

- **`agents_run_tests` is counted as spending.** A test run makes the agent hold conversations, which bills the agent's
  own LLM usage. ElevenLabs gives no estimate for it, so while a cap is on it is refused rather than run unpriced.
  `agents_create_test` and the other test tools only describe a test, and are ordinary writes.
- **`creative_design_voice` is counted as spending** and `creative_save_designed_voice` is a write: designing previews
  is the part that generates audio.
- **`creative_create_asset_upload` is a write, not an export.** It opens an upload into the workspace; nothing leaves
  it. The two exports are `agents_get_link`, which mints a link usable outside the workspace, and
  `creative_get_generations`, which returns the signed links a flow's generations can be downloaded from.

- **`get_more_tools` is a write.** It is not a catalogue pager and it returns no tool definitions. Its live schema has
  one required argument, a free-text string named `capability`, and its description says what the server does with it:
  *"Call this when the user's request cannot be completed with any of the available tools. Describe the capability you
  were looking for, so it can inform which tools get built next."* So it changes what ElevenLabs will offer, which is a
  change like any other, and it is the one tool that sends words the model composed itself out of the workspace. It
  asks under `ask-changes`, `read-only` denies it, and SECURITY.md lists it with the other things `access: "all"`
  allows without a prompt. This release classified it from its own schema after live reconcile 1; until then the table
  held it unclassified and described it as something it never was.

Nothing is left unclassified, so `/elevenlabs-status` reports `0 unknown` against this catalogue. A name that really
fits no class would go in `UNCLASSIFIED_TOOLS`, where `npm run drift` reports it as known rather than as drift — but
while either credit cap is on, a name the table does not classify is refused before dispatch, so holding one there is
not free.

### The one duration, and what it is not

`elevenlabs_save_media` prints how long a saved file is. Nothing else in the plugin reads a file's length, and no
price comes from one.

It used to. Until live reconcile 1 the guard priced a transcription by measuring the local WAV it was given, at a
per-minute rate written down here. The live catalogue ended that: `creative_transcribe_audio` takes no file and no
path — its arguments are `connect_from`, `flow_id`, `model_id`, `view_state_id`, `context` and `estimate_only` — so
the audio it bills for is a node on a flow in the workspace, and the server never opens anything on this disk. A
duration measured here would have answered for a file ElevenLabs was not charging for. Transcription is now priced
the way every other spending call is, from ElevenLabs' own estimate, and the whole of the measuring apparatus the old
price rested on — the stamping of each file's device, inode, size and modification time before and after the
measurement, the freezing of the arguments that named them, the refusal of a file that moved between the two
readings — went with it. There is no local file in a price to protect.

What remains is `durationOf`, and it is a display figure. The saved line reads a PCM RIFF/WAVE file the way a decoder
does — the `fmt ` fields and the bytes behind `data` — and otherwise reads the duration an MP4 or M4A states in the
`mvhd` box inside its `moov`, which is the format ElevenLabs returns and carries no length a decoder-free reader
could compute. That walk is bounded: every read is inside the file's own size, the number of boxes it steps through
is capped, and a stated duration longer than the file's bytes could hold at 8 kbps is dropped rather than shown. A
file whose length depends on which decoder opens it — two `data` chunks, which CoreAudio and Python's `wave` read
differently, or two `fmt ` chunks, which are two sample rates and so two lengths — carries no duration on the saved
line at all. A `data` size that understates the bytes behind it is reported at the longer reading, with
`understated` saying so, so a line that disagrees with the owner's own player can be explained.

The rigour is kept because a figure shown to the owner should be one a decoder would agree with. It is not kept
because anything depends on it: `savedText` prints `Saved <mime> to <path> (<size>, <n> s).`, drops the seconds when
the file states none, and no cap, hold or charge reads that number.
