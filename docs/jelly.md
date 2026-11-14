# Jelly

Jelly reads the `jelly` section of `package.json` without loading the plugin, so that section must describe the plugin
exactly. 238 tools are declared (100 read-only): the 237 ElevenLabs tools its server served on 14 November 2026, and
the plugin's own `elevenlabs_save_media`. `test/fixtures/live-tools.json` is that capture, with ElevenLabs' own
`readOnlyHint` for each tool, and `test/unit/live-tools.test.ts` fails when the declaration and the capture disagree:
a served tool left undeclared, a declared tool the server no longer serves, or a `readOnly` that differs from the
server's without a reason below.

Every declared effect is `allow`, because that is what the default rules give each tool in OpenCode at the default
`access: "all"`: every tool is allowed, and `access` is how a user restricts them. Jelly applies its own `access`
setting from each tool's declared `readOnly`: at **Allowed** every declared tool runs; at **Ask before changes** a tool
declared read-only runs and every other declared tool asks first; at **Read only** a tool declared read-only runs and
every other declared tool is denied. A read-only helper is never given a tool declared as not read-only.

The declaration holds:

- `title`: `ElevenLabs`, and `summary`: one sentence on what the plugin reaches. The summary says what it touches; it
  states no policy, because what asks first is on the plugin's card.
- `icon`: `assets/icon.svg`, the mark Jelly draws. The same file names the one line in `jelly.summary`, and beside it the
  mark in `jelly.icon`.
- `tools`: the 237 ElevenLabs tools plus `elevenlabs_save_media`, each with its permission action and `readOnly`.
  `readOnly` is true exactly where ElevenLabs marks the tool read-only, except for two that are declared stricter, as
  not read-only, so a read-only helper is never given them and `read-only` access denies them:
  - `elevenlabs_agents_query_knowledge_base_rag`: a RAG query embeds the query, work ElevenLabs plausibly bills, so
    this plugin counts it as spending; read-only access promises to deny every tool that can spend.
  - `elevenlabs_get_more_tools`: it sends the model's own free-text description of a missing capability to ElevenLabs,
    to decide which tools get built next. That is a message out of the workspace, not a read of it.

  `elevenlabs_save_media` is not read-only: it writes a file. Five declared tools reach people outside the
  conversation, and none is read-only: `elevenlabs_agents_submit_batch_call` and `elevenlabs_agents_retry_batch_call`
  place real phone calls (and spend), `elevenlabs_agents_publish_draft` makes staged changes live to callers,
  `elevenlabs_agents_update_whatsapp_account` changes how an agent answers a WhatsApp number, and
  `elevenlabs_agents_request_merge_proposal_review` notifies workspace members.
- `skills`: `elevenlabs`, `elevenlabs-creative`, `elevenlabs-calls`.
- `signIns`: two.
  - `elevenlabs`, on the `elevenlabs` server, with `relay: {}`, which lets Jelly offer its relay to a browser tab that
    cannot reach the engine. ElevenLabs registers no clients and takes a client metadata document as the client id,
    which is what the relay needs, but the relay path has not yet been checked with ElevenLabs (README, Known limits).
  - `balance`, labelled **ElevenLabs API key (optional, balance only)**, on the plugin's own `elevenlabs-balance`
    integration, not required. It is the key `/connect` offers under the same name, used for one read, the workspace's
    credit balance in status, and never to generate.
- `rpc` and `views`: empty. `contributes`: no Home feed, widget or work kind, and six settings, each a top-level option
  of the same name with the parser's own values and bounds:
  - `access`: a choice of **Allowed** (`all`, the default), **Ask before changes** (`ask-changes`) and **Read only**
    (`read-only`), with Jelly's own line for each.
  - `region`: a choice of the five regions, `global` by default. Changing it needs a new sign-in: OpenCode keys the
    server's sign-in by its name and URL, so the card shows **Sign in again**. The earlier region's sign-in stays stored
    in OpenCode, because a plugin cannot delete one; the plugin lists it in `/connect` as "ElevenLabs, old `<region>`
    sign-in (not in use)" and status names it with the command that removes it.
  - `conversations`: a choice of `full` (the default), `summary` and `off`.
  - `sessionCreditCap` and `dailyCreditCap`: whole numbers from 1 to 10,000,000. Jelly saves no `null`, so a cap is no
    cap by being left unset, and neither declares a default.
  - `maxMediaBytes`: a whole number of at least 1024, 200 MB by default. The parser sets no ceiling, so neither does
    the declaration.

  Jelly draws each choice as a choice and each number with its bounds, and saves nothing outside them. A Jelly that
  does not know declared choices or bounds yet refuses the whole declaration. `mediaRoot` and `allowUntestedHost` are
  not declared: they are set in `opencode.json`.

**A tool ElevenLabs adds later is not asked about in Jelly at Allowed.** It is not declared, so Jelly knows only its
`elevenlabs_*` namespace: at **Allowed** it runs, a spending or deleting tool included; at **Ask before changes** the
namespace rule asks first; at **Read only** it is denied. Because it is not declared as not read-only, a read-only
helper is not fenced from it at **Allowed**. The way to bound it is the `access` setting or a rule in the agent's own
permissions; a credit cap, which is opt-in, refuses it unpriced while one is set.

Jelly treats an unknown key differently by level. At the top level of this section it drops the key and logs it, so a
misspelled top-level key is silent. Inside a tool, a sign-in or a `contributes` entry it refuses the key, and with it the
whole declaration, as it does for declared choices or bounds it does not know yet (above). That is why
`test/unit/jelly.test.ts` checks the declaration against the plugin's own rules and Jelly's authors' standard.
