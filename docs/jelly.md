# Jelly

Jelly reads the `jelly` section of `package.json` without loading the plugin, so that section must describe the plugin
exactly. 191 tools are declared (81 read-only): the 190 ElevenLabs tools this plugin classifies, and the plugin's own
`elevenlabs_save_media`.

Every declared effect is `allow`, because that is what the default rules give each tool in OpenCode: every tool is
allowed by default, and `access` is how a user restricts them. Jelly writes each declared effect as that tool's default
in its own agents, which have no base allow rule, so a declaration that says `ask` would be stricter than OpenCode.

The declaration holds:

- `title`: `ElevenLabs`, and `summary`: one sentence on what the plugin reaches. The summary says what it touches; it
  states no policy, because what asks first is on the plugin's card.
- `icon`: `assets/icon.svg`, the mark Jelly draws. The same file names the one line in `jelly.summary`, and beside it the
  mark in `jelly.icon`.
- `tools`: the 190 ElevenLabs tools plus `elevenlabs_save_media`, each with its permission action and `readOnly`, which is
  true exactly for the reads. `elevenlabs_save_media` is not read-only: it writes a file.
- `skills`: `elevenlabs`, `elevenlabs-creative`, `elevenlabs-calls`.
- `signIns`: one, `elevenlabs`, on the `elevenlabs` server.
- `rpc` and `views`: empty. `contributes`: no Home feed, widget or work kind, and six settings, each a top-level option
  of the same name with the parser's own values and bounds:
  - `access`: a choice of **Allowed** (`all`, the default), **Ask before changes** (`ask-changes`) and **Read only**
    (`read-only`), with Jelly's own line for each.
  - `region`: a choice of the five regions, `global` by default. Changing it needs a new sign-in.
  - `conversations`: a choice of `full` (the default), `summary` and `off`.
  - `sessionCreditCap` and `dailyCreditCap`: whole numbers from 1 to 10,000,000. Jelly saves no `null`, so a cap is no
    cap by being left unset, and neither declares a default.
  - `maxMediaBytes`: a whole number of at least 1024, 200 MB by default. The parser sets no ceiling, so neither does
    the declaration.

  Jelly draws each choice as a choice and each number with its bounds, and saves nothing outside them. A Jelly that
  does not know declared choices or bounds yet refuses the whole declaration. `mediaRoot` and `allowUntestedHost` are
  not declared: they are set in `opencode.json`.

**A tool ElevenLabs adds later is not asked about in Jelly.** It is not declared, so Jelly knows nothing about it, and
under the default rules it runs: a spending or deleting tool included. The way to bound it is the `access` option or a
rule in the agent's own permissions; a credit cap, which is opt-in, refuses it unpriced while one is set.

Jelly drops a key it does not know rather than refusing the plugin, so a typo in this section is silent. That is why
`test/unit/jelly.test.ts` checks the declaration against the plugin's own rules.
