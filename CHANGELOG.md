# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- **The eight tools ElevenLabs added to its hosted server,** captured on 19 November 2026 and classified the way the
  table already classifies tools: `agents_get_draft`, `agents_get_pronunciation_dictionary` and `creative_get_guide`
  are reads; `agents_create_pronunciation_dictionary`, `agents_add_pronunciation_dictionary_rules`,
  `agents_remove_pronunciation_dictionary_rules` and `agents_update_draft` are writes; and `agents_outbound_call` is a
  spending tool that also reaches people, so `ask-changes` asks before it, `read-only` denies it, and a credit cap
  refuses it rather than invent a price. `/elevenlabs-status` now reports no unknown tools against the catalogue, and
  the skills cover the outbound call, the pronunciation dictionary flow, the draft flow and `creative_get_guide`.
- **A refreshed live capture,** `test/fixtures/live-tools.json`: 245 tools from the server's own `tools/list`,
  read-only, with names, schemas and annotations only.

### Changed

- **The counts follow the catalogue:** nineteen tools can spend, and the Jelly declaration holds 247 tools (104
  read-only). `jelly.cost` now says nineteen. The Jelly fields changed, so Jelly asks for consent again; the source
  descriptor is unchanged.

## [0.0.9] - 2026-11-18

### Changed

- OpenCode 2.3.1 and 2.3.2 join the tested releases, so the host, pack and CI stages run on each: tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7, 2.3.0, 2.3.1 and 2.3.2. The supported range is unchanged (`>=2.2.3 <2.4.0`), and so are the host devDependencies the checks compile against (2.2.3).

## [0.0.8] - 2026-11-17

### Added

- **A source contract source,** `elevenlabs.conversations`, declared in `package.json`'s `sources`: `events_list` (the
  tool `elevenlabs_events_list`, and a method of the tools RPC) lists the conversations the workspace's agents had,
  oldest first, as metadata only (the conversation's id, its start, the agent, and a title of the agent's name with the
  call's direction, status and outcome; never a caller, a transcript or a summary), and `probe` names the sign-in. Both
  only read, through `agents_list_conversations`, `agents_list` and `agents_get` or nothing, and spend no credits;
  every `access` allows them, and `conversations: "off"` denies `events_list`. A read that starts before an agent's
  retention horizon answers `gap` (`expired`) once; agents that keep no conversations are never seen.
  `npm run conformance` runs the source contract's conformance kit offline and writes
  `reports/conformance-report.json`, which a release attaches.

### Changed

- The tools RPC's transport is source-contract's `tools-rpc` module, pinned in `package.json` and bundled into
  `dist/index.js`, instead of a copy of the family's shared module. Same RPC id, same methods, same answers.
- Tested on OpenCode 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7 and 2.3.0 (`TESTED_HOSTS` in `src/constants.ts`); the host range
  is unchanged, `>=2.2.3 <2.4.0`.

## [0.0.7] - 2026-11-15

### Added

- **For jelly:** `jelly.cost`, the line jelly shows on the plugin's review before it installs: "Eighteen tools spend the
  signed-in workspace's ElevenLabs credits, such as generating speech, images and video. A speech call renders two takes
  and an image call four by default, a retry is charged again, and each paid result has a cost line with the credits it
  reported. No cap unless you set one."

## [0.0.6] - 2026-11-15

### Changed

- Admits OpenCode 2.3: the host range is `>=2.2.3 <2.4.0`, tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7 and 2.3.0, and CI
  runs the host and pack suites on each of them. An out-of-range example is now 2.4.0.

### Fixed

- `elevenlabs_save_media` passes the call's signal to its download and file write, so pressing Stop (which OpenCode 2.3
  aborts) stops a save part-way: the staged file is removed and nothing is published.

## [0.0.5] - 2026-11-14

### Changed

- The icon is now ElevenLabs' own "11" symbol, the published `elevenlabs-symbol.svg` from [elevenlabs.io/brand](https://elevenlabs.io/brand) with its two bars unmodified on a white holding square three times their height, in place of the look-alike drawn on the family's 48 grid; `opencode.vendor.mark` is `true`.

- `package.json` is `"private": true`, so nothing can be published to npm; an install from the release tag is unaffected.

### Fixed

- The lockfile's root `name` is `@joe-broadhead/opencode-elevenlabs`; it was another plugin's name.

## [0.0.4] - 2026-11-14

### Added

- 47 ElevenLabs tools the server now serves are classified and declared to Jelly: 16 reads (account usage, batch calls,
  settings, webhooks, WhatsApp numbers, a call's recording link, workspace call counts and more), 24 writes (workflow
  nodes, attachments, secrets, phone numbers, simulation tests, publishing a draft), 6 that can spend
  (`agents_submit_batch_call`, `agents_retry_batch_call`, `agents_run_attached_tests`, `agents_generate`,
  `agents_generate_test_from_conversation` and `creative_execute_sandbox`), and one export, `agents_get_signed_url`.
  Every one that can spend is in the spending table, so while a credit cap is on it is refused unpriced (none takes
  `estimate_only`); caps stay off by default. The declaration now has 238 tools, 100 of them read-only.
- Five tools that reach people are named in the docs, the skills and SECURITY.md: the two batch-call tools place real
  phone calls, `agents_publish_draft` makes staged changes live, `agents_update_whatsapp_account` changes a WhatsApp
  number's answers, and `agents_request_merge_proposal_review` notifies members. Each is a change: `ask-changes` asks,
  a script's call is then refused, and `read-only` denies it.
- `test/fixtures/live-tools.json` is the live capture of 14 November 2026 with ElevenLabs' own read-only marks, beside
  `provenance.json` and `tool-registry.json`. `test/unit/live-tools.test.ts` fails when the Jelly declaration and the
  capture disagree, and when a skill or doc calls a tool or passes an argument the server does not serve.
- Jelly: a second sign-in, **ElevenLabs API key (optional, balance only)**, on the plugin's own `elevenlabs-balance`
  integration, not required; `/connect` uses the same name for it. The server's sign-in declares `relay: {}`, so Jelly
  can offer its relay to a browser tab; that path has not yet been checked with ElevenLabs.
- A sign-in an earlier `region` left stored is listed in `/connect` as "ElevenLabs, old `<region>` sign-in (not in use)",
  and status names it with the `opencode auth logout` command that removes it. A plugin cannot delete a stored
  credential itself.

### Changed

- Each tool's `readOnly`, in OpenCode's rules and in Jelly, now follows ElevenLabs' own mark. `agents_get_link`,
  `creative_get_generations` and `creative_show_flow_results` are reads, so `read-only` allows them.
  `agents_query_knowledge_base_rag` (it can spend) and `get_more_tools` (it sends the model's words to ElevenLabs) stay
  changes on purpose; `docs/jelly.md` gives the reasons. `agents_get_signed_url` is the one export.
- ElevenLabs no longer takes a `context` argument on any tool. The skills and docs no longer pass it, and while a cap
  is on a priced call that carries it is refused as an argument the schema lacks.
- `conversations: "summary"` also denies a call's recording link, and `"off"` also denies the batch calls and the
  workspace's call counts.

## [0.0.3] - 2026-11-13

### Added

- The `jelly` settings declare their choices: `access` is drawn as Allowed, Ask before changes or Read only, with
  Jelly's own line for each, and `region`, `conversations`, `sessionCreditCap`, `dailyCreditCap` and `maxMediaBytes`
  are now settings too, with the options parser's own values and bounds (needs a jelly that includes app#1301). A cap
  is no cap in Jelly by being left unset.

## [0.0.2] - 2026-11-12

### Changed

- Credit caps are opt-in. `sessionCreditCap` and `dailyCreditCap` now default to `null` (no cap); set either to a
  number to add a bound of your own, which works as before. With no cap the plugin refuses, cuts and queues nothing
  for money: a paid call runs at any size, `creative_design_voice`, `agents_run_tests` and the other tools with no
  estimate run unpriced, a name the table does not classify runs, and a script may run two calls of one method at
  once. The bounds are the workspace's balance at ElevenLabs and the permission rules: `ask-changes` still asks for
  every paid call and `read-only` still denies it.
- With no cap, no estimate is sent before a paid call, so no flow or node is left in the workspace for it and no extra
  prompt is raised. Every paid result still carries a cost line, with the figure the result reports or
  `Credits: not reported`, never a guess. An explicit `estimate_only` call still works, and under a cap the plugin still
  sends the estimate first.

## [0.0.1] - 2026-11-12

### Changed

- The icon is ElevenLabs' "11" symbol, unmodified, on a neutral holding shape three times its height, used under
  ElevenLabs' brand guidelines. The README carries ElevenLabs' trademark line.

## [0.0.0] - 2026-11-10
<!-- kit-release: the GitHub release v0.0.0 -->

### Added

- Jelly shows and sets the `access` option, so the same restriction is one setting in every host (default `all`).
- Sign-in to ElevenLabs' hosted MCP server from `/connect`, with a client metadata document: no client ID and no API key
  ship with the plugin. The consent asks for seven scopes and never for `ads_read`.
- A `region` option: `global` (the default), `us`, `eu`, `in` and `sg`. A change needs a new sign-in, and status names the
  entry a change leaves behind.
- The 190 tools the live server lists, classified in one table as reads, exports, writes, destructive calls or spending
  calls. The README explains each class.
- A spending guard. Twelve tools can spend credits. Seven of them are priced by ElevenLabs' own `estimate_only` call before
  they run; the other five are refused while a cap is on, because ElevenLabs gives no estimate for them. A call that does
  not fit the caps is refused before it is sent. The price is reserved before the call and settled when its result arrives,
  and every paid result carries a cost line. The README's Spending section states how far the caps reach.
- Two credit caps, on by default and settable to `null`: `sessionCreditCap` (2,000 credits) and `dailyCreditCap` (10,000
  credits). The daily cap counts a rolling 24 hours across sessions, scripts and restarts.
- `elevenlabs_save_media`, the plugin's own tool. It saves a generated file from its signed link under `mediaRoot`
  (`~/Downloads/elevenlabs` by default), created with mode 0700, and reports the path, size, sha256 and, when the file
  states one, its duration. It fetches only ElevenLabs' generated-file host, over https, and refuses a file larger than
  `maxMediaBytes` (200 MB by default). Before it fetches anything it asserts its own permission and OpenCode's
  `external_directory` rule for `mediaRoot`.
- `conversations`: `full` (the default), `summary` or `off`. Each is enforced by deny rules on exact tool names and on
  patterns, so a conversation tool ElevenLabs adds later is denied too.
- An optional ElevenLabs API key entry in `/connect`, used for one subscription read that shows the workspace balance.
- `/elevenlabs-status`, the `/elevenlabs` dialog and the status RPC.
- `/elevenlabs-doctor`, which checks the region's discovery documents, the scopes, the server, the tools, the skills and
  the media folder.
- Three skills: `elevenlabs` (agents), `elevenlabs-creative` (generation and saving) and `elevenlabs-calls` (transcripts
  and personal data).
- The tools RPC `elevenlabs.tools`, so a script can call every known tool without a model, under the same spending guard.
  `docs/scripting.md` has the envelope, the estimate path and every refusal.
- Icons and the `vendor` declaration for ElevenLabs, and the Jelly declaration for all 191 tools: the 190 ElevenLabs tools
  and `elevenlabs_save_media`.

### Changed

- **Every tool is allowed by default.** The `access` option restricts that: `"all"` (the default) runs everything, spending
  included; `"ask-changes"` runs the reads and asks for everything else; `"read-only"` runs the reads and denies everything
  else. The default rules for each value are printed in full in the README and in `docs/configuration.md`. A tool
  ElevenLabs adds later follows the same `elevenlabs_*` rule.
