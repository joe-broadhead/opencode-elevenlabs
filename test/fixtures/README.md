# Fixtures

## `live-tools.json`

**Captured from a live account.** It is one raw MCP `tools/list` response, exactly as ElevenLabs' hosted server sent
it: `{ "tools": [ { name, description, inputSchema } ] }`, 190 tools, with their real descriptions, argument names,
defaults and enums. The only edits are redactions: an id-like string inside a description or an example is replaced
with `<prefix>_example`, and nothing but the input schemas is kept.

The host exposes no MCP `annotations` — none of the 190 carries one — so a tool's class cannot be confirmed from the
server and is decided by `classify()` in `src/elevenlabs-tools.ts` from the name, the description and the schema.

`npm run drift` compares the plugin's table with this file: it names every tool the file has and the table does not,
every tool the table has and the file does not, and every class an annotation would contradict if one existed.

## What live reconcile 1 measured

The first signed-in pass settled the catalogue and the shape of a price. It did not spend: every call it made was a
read or an estimate.

- **The catalogue**: 190 tools (144 `agents_*`, 45 `creative_*`, and `get_more_tools`). `creative_generate_music`,
  `creative_compose_music` and `creative_generate_sound_effect` are not among them. Exactly 7 tools accept
  `estimate_only`.
- **Every tool requires `context`**, a short line naming the reason for the call.
- **An estimate looked free.** Two `estimate_only: true` calls, with the workspace balance read before and after each
  (`GET /v1/user/subscription`), moved it by nothing, and no new billable request appeared.
- **An estimate is not free of effects**: each one created a flow and a node in the workspace. That is why the guard
  asks for one estimate per set of arguments and remembers it for ten minutes.
- **The figure is the batch total, and it can be fractional.** `creative_generate_image` with `generations_count: 4`
  answered `761.5151418103446` credits — about 190 an image — beside `price_cents`, `generations_count`, `currency`,
  `estimated_runtime_seconds`, `flow_id`, `flow_created`, `node_id` and `url`.
- **`creative_transcribe_audio` takes no file and no path.** Its arguments are `connect_from`, `flow_id`, `model_id`,
  `view_state_id`, `context` and `estimate_only`: it transcribes a node on a flow, so no local file can be part of a
  price.

## The live checklist for reconcile 2

The eight things the deep review of the estimate-first reconcile left for a signed-in session, in review order. One
session, both caps left on, and the workspace balance (`GET /v1/user/subscription`) read immediately before and after
every step — the movement is the measurement, not what any result claims.

Each step carries the most it may cost. **The whole list is budgeted at 850 credits.** Four of its eight steps are
budgeted at nothing at all, and step 7 is expected to cost nothing but carries a margin in case it does: that
expectation is itself one of the things being tested. If a step moves the balance by more than its maximum, stop there
and record what happened rather than running the rest; a step that overruns has already answered a question the plugin
was deciding from an assumption.

| # | Step | Expected maximum |
|---|---|---|
| 1 | The estimate result in full | 0 |
| 2 | What a finished generation reports as its cost | 200 |
| 3 | Do the three newly-classed tools bill? | 300 |
| 4 | Prompts raised by one priced generation | 0 |
| 5 | `get_more_tools`, sent once | 0 |
| 6 | The two tools that take no estimate | 300 |
| 7 | Does `creative_show_flow_results` do anything but render? | 50 |
| 8 | The catalogue count and the full name list | 0 |
| | **Total** | **850** |

1. **The estimate result in full — 0 credits.** Send `estimate_only: true` for at least `creative_generate_speech` and
   `creative_generate_image`, and save the whole result: `output` and every `content` block, verbatim. Two questions
   settle `estimatedCreditsOf`, which now reads `estimate.credits` and five attested keys at the top level and
   nothing else: whether any text block echoes the caller's own prompt back, and whether a credit-shaped key appears
   anywhere other than `estimate.credits`. Pass 1 measured an estimate as free; if either of these two moves the
   balance, that is the finding and the rest of the list waits.
2. **What a finished generation reports as its real cost, and in which field — 200 credits.** The one unverified fact
   in the whole plugin, and `README.md`'s **Known limits** is the only place that says so: *"whether a finished
   generation reports what it really cost, and in which field"*. Two paid calls answer it. The smallest real speech
   generation: `creative_list_voices` for a `voice_id`, then `creative_generate_speech` with `generations_count: 1`, a
   `model_id` of `eleven_multilingual_v2` and a prompt of one short sentence — the estimate first, then the same
   arguments without the flag (**under 100**). Then the smallest real transcription: a few seconds of audio on a flow
   (`creative_create_asset_upload`, then `creative_finalize_asset_upload`), then `creative_transcribe_audio` with
   `connect_from` set to that node, estimate first (**under 100**). For each, record every field of the paid result
   beside the balance movement. If a field carries the real figure, `settlementOf` can settle on it and that README
   bullet is replaced by a measurement; until then a call is charged what it reserved and a later figure may only
   raise it. The same two pairs answer whether the estimate is exact — if a paid call costs less than its estimate,
   the cost line's `basis` must stop saying `"exact"`.
3. **Whether `agents_compute_kb_rag_index`, `agents_query_knowledge_base_rag` and
   `creative_create_brand_kit_from_website` move the balance — 300 credits.** One small call to each, balance either
   side: a RAG index over a single short document, one query against it, one brand kit from one plain site. All three
   were classed as spending on a stated rule — a tool whose description says it does server-side work ElevenLabs
   plausibly bills, and does not say it spends nothing, counts as spending — and none declares `estimate_only`, so
   each is refused outright while a cap is on. This settles that either way: if a tool does not bill, the table
   over-refuses it and `src/elevenlabs-tools.ts` should say so with the measurement beside it.
4. **How many permission prompts one priced generation raises under `access: "ask-changes"` — 0 credits.** One or
   two, counted on step 2's speech generation rather than on a call of its own. The plugin raises one assert, for the
   generation's own action, before it estimates; OpenCode raises the second when the generation runs. Whether the host
   folds them into a single prompt has never been measured, and four documents said "asked once" until this round
   corrected them. Whatever is seen, `README.md`, `SECURITY.md`, `docs/configuration.md` and `docs/architecture.md`
   are made to say it.
5. **`get_more_tools`, sent once — 0 credits.** One call with a capability sentence, and then `ctx.tool.list()`: what
   comes back, and whether a single new tool is in the list afterwards. The plugin describes it as a free-text channel
   to ElevenLabs that is allowed by default and classifies it as a write; that description is reasoned, not measured,
   and this replaces it with a measured one. Watch the balance anyway: it is the one tool whose effect is unknown.
6. **Whether `creative_design_voice` and `agents_run_tests` really bill, and how much — 300 credits.** First check
   whether either has gained an `estimate_only` argument since pass 1. If not, measure the cheapest run each allows by
   balance movement: three voice previews, one agent test. Both are refused today while a cap is on, because neither
   can be priced before it runs. If either does not bill, the table over-refuses it and should say so.
7. **Whether `creative_show_flow_results` has any billable or workspace effect at all — 50 credits.** It was moved
   from read to write this round because its own description is an effect — it renders a run's generations back to the
   user — while its sibling `creative_get_flow_run_status` returns the same data and says it shows nothing. Call it on
   a flow from step 2 and look for both: a balance movement, and any new flow, node or asset in the workspace. If it
   is purely visual, `write` is still right for a tool that puts something in front of the user, and the note in
   `docs/architecture.md` gains a measurement.
8. **The catalogue count and the full name list again — 0 credits.** Re-capture `live-tools.json` by the form below
   and run `npm run drift`. Two things to look for: whether ElevenLabs has added a tool since pass 1, and in
   particular whether any new spending tool sits outside the `creative_` prefix. That prefix is no longer a rule here
   — any name the table does not know is refused while a cap is on — so this exercises the residual rather than
   arguing it.

### Carried from pass 1's list, both free

9. **The argument names — 0 credits.** With step 8's schemas in hand,
   confirm each priced tool's real argument names against them once more, and reconcile `PRICED_ARGUMENTS` and the
   table in `docs/architecture.md` with them. A name the live schema
   has and the list does not refuses an ordinary call while a cap is on; a name that changes the bill and is on the
   list prices a call for less than it costs.
10. **`external_directory` — 0 credits.** Whether OpenCode asks for it on a plugin tool that writes with `node:fs`;
    the plugin asserts it either way.

## Reconciling (the one drop-in form)

1. Save the raw response, replacing this file entirely:

   ```sh
   curl -sS -X POST https://api.elevenlabs.io/v1/mcp \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
     | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const line=s.split("\n").find((l)=>l.startsWith("data: "))??s;console.log(JSON.stringify(JSON.parse(line.replace(/^data: /,"")).result,null,2))})' \
     > test/fixtures/live-tools.json
   ```

2. `npm run drift` — it names every tool the plugin does not classify and every tool the list no longer has.
3. Update `src/elevenlabs-tools.ts` (classes, transcript lists, spend lists), then `package.json`'s `jelly.tools`, then
   the README's Permissions section and the three rule blocks in `docs/configuration.md`. `npm run check` fails until
   they agree.

No test pins this file as final: a test asserts it matches the plugin's table, so a re-captured fixture and a table that
still holds the old names fail loudly rather than silently.
