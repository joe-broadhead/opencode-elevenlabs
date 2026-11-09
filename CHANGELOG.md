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
- A spending guard: ElevenLabs' published credit rates price speech, music, sound effects and transcription at most; image
  and video are priced by ElevenLabs' own `estimate_only` call before they run; a call that may spend and cannot be priced
  is refused; a call that does not fit is refused before it is sent; the generation count is cut to what the budget
  affords, in the field the caller used; the price is reserved before dispatch and settled into a charge afterwards, so
  two calls that start together cannot spend one budget; the rolling 24-hour ledger is kept per session in the plugin's
  storage, survives a reload, and is written one charge at a time; and every paid result carries a cost line and a
  structured `cost`.
- `sessionCreditCap` (2,000 credits) and `dailyCreditCap` (10,000), both on by default, both settable to `null`.
- `elevenlabs_save_media`, the plugin's own tool, saves a generated file from its signed link under `mediaRoot`
  (`~/Downloads/elevenlabs` by default) and reports the path, size, sha256 and duration. It asserts its own permission and
  OpenCode's `external_directory` rule before it fetches anything. Only ElevenLabs' generated-file host, on the default
  https port, is fetched, redirects included; only an image, audio or video type is written; the file is published
  atomically after a symlink and identity check.
- `conversations`, with `full`, `summary` and `off`, enforced by deny rules on the exact tool names and on patterns, so
  a conversation tool ElevenLabs adds later is denied too.
- An optional `ElevenLabs API key` entry in `/connect` for the one subscription read that shows the workspace balance.
- `/elevenlabs-status`, `/elevenlabs` and the `elevenlabs/status` RPC, with the region, spend and conversation rows.
- `/elevenlabs-doctor`, which checks the region's discovery documents, the scopes, the server, the tools, the skills and
  the media folder.
- Three skills: `elevenlabs` (agents), `elevenlabs-creative` (generation and saving) and `elevenlabs-calls` (transcripts
  and personal data).
- The tools RPC `elevenlabs.tools`, so a script can call every known tool with no model, under the same spending guard.
- Icons and the `vendor` declaration for ElevenLabs, and the Jelly declaration with all 41 tools.

### Changed

- A caller-typed duration, take count or file size cannot lower a price. Transcription is priced from the file about to
  be sent; a file that cannot be measured is refused. A price of 0 is a refusal. Speech stays at two takes unless the
  caller asks for more.
- `elevenlabs_save_media` reports how long a saved MP4 or M4A is again, from the `mvhd` the container states, through a
  walk bounded by the file's own bytes. It is a display figure: nothing prices a call from it, and a cap still measures
  a PCM WAV or refuses.
- A `creative_*` tool the price table does not price is refused while a cap is on. There is no keyword list.
- Every priced tool has an argument allowlist, not transcription alone: while a cap is on, an argument whose effect on
  the bill this plugin does not know refuses the call by name, on the table path and the server-estimate path alike.
  `docs/architecture.md` lists every allowlist. A `composition_plan` is priced at the sum of its sections' durations,
  or at a longer stated length; a plan whose durations cannot be read is refused.
- A failed call, and a hold still open after ten minutes, is charged the reserved price. A later higher figure may replace
  that charge. A zero or a missing result does not free the budget.
- A reported figure above the reserved price is always the charge, however far above, clamped at the daily cap so one
  absurd figure blocks spending for a single window at most; the cost line flags a raise of more than ten times. A
  figure below it is believed only when the result attests it as this call's charge, in whole credits, and at least a
  tenth of the hold.
- A recorded charge only ever rises. One attested figure inside that tenth-band may settle a live hold below itself;
  every settlement after that, for the same call, may only raise the charge. A result delivered twice, and a figure
  arriving for a call whose hold expired into a charge, are ignored unless they are higher.
- The architecture guide's argument allowlists are derived from the enforced ones. The prose promised every priced call
  the five count keys, which a transcription refuses: it bills for the audio it is sent, once. The sentence now says
  so, and a test reads every name in that section back out of `PRICED_ARGUMENTS`, in both directions, so the documented
  allowlist cannot drift from the one the guard applies again.
- A refusal names the argument that caused it, and never denies a rate the plugin prints. A music call whose length
  field holds something no number can be read out of used to be told music had "no published credit price and no
  remembered estimate" and offered `estimate_only`, which music does not take; it now names the field and says what to
  pass. `priceObstacle` covers every branch that gives up on a price — the length, text, take and count fields as well
  as the files — and the "no published credit price" wording is kept for image and video, the only tools that have none.
- The cap's bound is stated as it really is, in the three files that print it. The old sentence gave the two-process
  case as the general rule; the real bound is one call's reservation for each OpenCode past the first — eight at 3,000
  credits a call can spend 31,000 against a 10,000 cap — and a Code Mode call, which cannot read the store before it
  decides, lets an OpenCode that has read nothing since it started admit a whole cap of its own. Both crossings need
  the calls to overlap. "A settled charge is never lost" is back, now that it is true.
- A measured price is bound to the file it measured. Every file a transcription names is stamped — device, inode, size
  and last modification — before the measurement reads a byte and again immediately before the hold; a file that moved
  in between refuses the call with `PRICE_UNKNOWN` and reserves nothing. The window after the dispatch, while
  ElevenLabs' server reads the file itself, is not one this plugin can close.
- A WAV holding more than one `data` chunk is not measured. CoreAudio reads the last such chunk and Python's `wave`
  the first, so the file's length depends on which decoder opens it: a call that needs it is refused with
  `PRICE_UNKNOWN`, and a saved file shows no duration. One `data` chunk is measured as before, whatever follows it.
- A generation count multiplies the price of every priced tool, not sound effects alone: speech, music and ElevenLabs'
  own estimate are all priced per generation. `num_outputs` joins the count keys; a call naming two counts is priced
  from the larger and clamped in both; a count written as a string is read as the number it spells, and one nothing can
  be read out of refuses the call. Where a published rate and a remembered estimate both price a call, the dearer of
  the two is what the cap sees.
- One priced call per session and method is in flight on the script path.
- The daily cap is one total for this data directory. Two machines do not share it.
- Conversation denies match without regard to case, and cover `get_call`, `list_calls` and `export_history`.
- **Every tool is allowed by default**, with the `access` option: `"all"` (the default), `"ask-changes"` and
  `"read-only"`. The generated block is printed in full in the README and the configuration guide for each value, and a
  tool ElevenLabs adds later follows the same namespace rule.
