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
