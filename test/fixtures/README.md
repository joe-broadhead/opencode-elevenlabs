# Fixtures

## `live-tools.json`

**Provisional: not yet reconciled with a live account.**

The file is one raw MCP `tools/list` response: `{ "tools": [ { name, description, inputSchema, annotations } ] }`. It
holds the 40 tool names that ElevenLabs' own MCP skills name for the hosted server
(`github.com/elevenlabs/plugin`, `skills/mcp/agents-platform` and `skills/mcp/creative-studio`). The descriptions and
schemas in it are placeholders written from those skills, not ElevenLabs' text: only the **names** are attested.

`tools/list` needs a signed-in account, so the live list and its annotations (`readOnlyHint`, `destructiveHint`) are
reconciled after the owner signs in. ElevenLabs documents more capability than these 40 names cover, so the live list is
expected to be longer.

## The live checklist

Money facts the code assumes, each measured here before the provisional label comes off:

1. **Is `estimate_only: true` free?** Read the workspace balance (`GET /v1/user/subscription` with the optional API key),
   make one `estimate_only` call, and read the balance again. Any movement means the guard pays for its own estimate.
2. **Is the estimate the batch total?** Make one estimate with `generations_count: 1` and one with `4`, and compare: four
   times the first means a batch total, the same figure means one generation.
3. **Which field carries the figure**, and whether a paid result reports one (structured content, text, or neither).
4. **Does `creative_transcribe_audio` bill?** If it does not, remove `SPEND_READS` and the rate; if it does, confirm 330
   credits a minute and that a duration can be passed.
5. **The generation field:** `generations_count`, `variations`, or both. The clamp writes into whichever the caller used.
6. **`creative_edit_image`:** whether it accepts `estimate_only`.
7. **`external_directory`:** whether OpenCode asks for it on a plugin tool that writes with `node:fs`; the plugin asserts
   it either way.
8. **The conversation tool names**, so the `conversations` patterns cover every one.

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

2. `npm run drift` — it names every tool the plugin does not classify, every tool the list no longer has, and every tool
   whose annotations disagree with its class.
3. Update `src/elevenlabs-tools.ts` (classes, transcript lists, spend lists), then `package.json`'s `jelly.tools`, then
   the README's Permissions section. `npm run check` fails until all three agree.

No test pins this file as final: a test asserts it matches the plugin's table, so a reconciled fixture and a table that
still holds the old names fail loudly rather than silently.
