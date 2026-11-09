# Jelly

Jelly reads the `jelly` section of `package.json` without loading the plugin, so that section must describe the plugin
exactly. 191 tools are declared (83 read-only): the 190 ElevenLabs tools this plugin classifies, and the plugin's own
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
- `rpc` and `views`: empty. `contributes`: empty lists.

**A tool ElevenLabs adds later is not asked about in Jelly.** It is not declared, so Jelly knows nothing about it, and
under the default rules it runs: a spending or deleting tool included. The only way to bound it is the `access` option
or a rule in the agent's own permissions.

Jelly drops a key it does not know rather than refusing the plugin, so a typo in this section is silent. That is why
`test/unit/jelly.test.ts` checks the declaration against the plugin's own rules.
