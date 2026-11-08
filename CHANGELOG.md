# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org).

## [0.0.0] - Unreleased

### Added

- ElevenLabs' hosted MCP server as an OpenCode server, signed in from `/connect` with a client metadata document: no
  client ID and no API key ship with the plugin. The sign-in asks for seven scopes and never for `ads_read`.
- A `region` option: `global` (the default), `us`, `eu`, `in` and `sg`. A change needs a new sign-in, and status names
  the entry a change leaves behind.
- The 40 tools ElevenLabs' own MCP skills name, classified in one table, with the story for every class in the README.
- A spending guard: ElevenLabs' published credit rates price speech, music and sound effects exactly; image and video are
  priced by ElevenLabs' own `estimate_only` call before they run; a call that does not fit is refused before it is sent;
  `generations_count` is cut to what the budget affords; a rolling 24-hour ledger is kept in the plugin's storage; and
  every paid result carries a cost line and a structured `cost`.
- `sessionCreditCap` (2,000 credits) and `dailyCreditCap` (10,000), both on by default, both settable to `null`.
- `elevenlabs_save_media`, the plugin's own tool, saves a generated file from its signed link under `mediaRoot`
  (`~/Downloads/elevenlabs` by default) and reports the path, size, sha256 and duration. Only ElevenLabs' generated-file
  host is fetched, redirects included; the file is published atomically after a symlink and identity check.
- `conversations`, with `full`, `summary` and `off`, enforced by deny rules on the exact tool names.
- An optional `ElevenLabs API key` entry in `/connect` for the one subscription read that shows the workspace balance.
- `/elevenlabs-status`, `/elevenlabs` and the `elevenlabs/status` RPC, with the region, spend and conversation rows.
- `/elevenlabs-doctor`, which checks the region's discovery documents, the scopes, the server, the tools, the skills and
  the media folder.
- Three skills: `elevenlabs` (agents), `elevenlabs-creative` (generation and saving) and `elevenlabs-calls` (transcripts
  and personal data).
- The tools RPC `elevenlabs.tools`, so a script can call every known tool with no model, under the same spending guard.
- Icons and the `vendor` declaration for ElevenLabs, and the Jelly declaration with all 41 tools.

### Changed

- **Every tool is allowed by default**, with the `access` option: `"all"` (the default), `"ask-changes"` and
  `"read-only"`. The generated block is printed in full in the README and the configuration guide for each value, and a
  tool ElevenLabs adds later follows the same namespace rule.
