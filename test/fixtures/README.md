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

What is still unmeasured is the paid side: whether a finished generation reports what it really cost, and in which
field. Everything below is one signed-in session, with both caps left on. **Nothing in it may cost more than a few
hundred credits**; read the balance before and after each step.

1. **The smallest real speech generation.** `creative_list_voices` for a `voice_id`, then `creative_generate_speech`
   with `generations_count: 1`, a `model_id` of `eleven_multilingual_v2` and a prompt of one short sentence — first
   with `estimate_only: true`, then the same arguments without it. Expected maximum: **under 100 credits**. Record the
   estimate, the balance movement, and every field of the paid result.
2. **The smallest real transcription.** Put a few seconds of audio on a flow (`creative_create_asset_upload`, then
   `creative_finalize_asset_upload`), then `creative_transcribe_audio` with `connect_from` set to that node — the
   estimate first, then the paid call. Expected maximum: **under 100 credits**.
3. **Does a paid result report its charge, and where?** Compare each paid result's structured content and text with the
   balance movement. If a field carries the real figure, `settlementOf` can settle on it; until then a call is charged
   its reserved estimate and a later figure may only raise that.
4. **Is the estimate exact?** Compare each estimate with the balance movement of the paid call made from the same
   arguments. If the paid call costs less, the cost line's `basis` must stop saying `"exact"`.
5. **The argument names**: confirm each priced tool's real argument names against the live schemas once more, and
   reconcile `PRICED_ARGUMENTS` and the table in `docs/architecture.md` with them. A name the live schema has and the
   list does not refuses an ordinary call while a cap is on; a name that changes the bill and is on the list prices a
   call for less than it costs.
6. **The two tools with no estimate**: whether `creative_design_voice` or `agents_run_tests` has gained an
   `estimate_only` argument, and if not, what each one really costs, measured by balance movement on the cheapest run
   either allows.
7. **`external_directory`:** whether OpenCode asks for it on a plugin tool that writes with `node:fs`; the plugin
   asserts it either way.

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
