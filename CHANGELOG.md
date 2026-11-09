# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org).

## [0.0.0] - Unreleased

### Added

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
