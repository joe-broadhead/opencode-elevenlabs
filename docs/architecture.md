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

`priceOf` computes a price from ElevenLabs' published formula for speech, music, sound effects and transcription. Image
and video have no published price, so the model path awaits a real `estimate_only: true` call through the host's
executor, once, and the script path uses a price the script fetched itself, remembered for ten minutes. A call that
cannot be priced is refused (`PRICE_UNKNOWN`), never guessed, and every `creative_*` name that may spend is caught by a
name pattern even when the table does not know it. A price that does not fit is refused before dispatch
(`SPEND_CAP_REACHED`).

A price is **reserved** in the ledger before the call is sent and settled into a charge when its result arrives, so a
parallel turn cannot spend one budget twice; a call that fails before it charges releases its hold, and a hold nothing
settles expires after ten minutes. Recorded spend is `{ at, credits, sessionID }`, in `ctx.storage`, pruned to the
24-hour window, written one charge at a time, and keyed by session so a reload restores the session's total too. Two
locations keep their own ledger instance and their own tools-RPC shapers: there is no module-level runtime.
