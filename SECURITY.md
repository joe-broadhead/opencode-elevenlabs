# Security

Unofficial; not affiliated with ElevenLabs.

## Supported versions

OpenCode `>=2.2.3 <2.3.0`. Tested on 2.2.3, 2.2.4, 2.2.5 and 2.2.6. macOS and Linux.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting on
<https://github.com/joe-broadhead/opencode-elevenlabs>. Do not open a public issue for a security problem.

## Data handling

- **The OAuth token is OpenCode's.** The plugin never reads, stores, logs or prints it; the MCP transport and every
  refresh are OpenCode's. Nothing the plugin writes contains a token, an authorization code or a signed link's query.
- **Transcripts are other people's personal data.** `agents_get_conversation` returns a caller's words, the identifier
  your integration gave them, the phone number they called from, whatever the agent extracted, and the variables their
  app passed in. It lands in the model's context and in the session history on disk. There is no redaction: the point of
  reading a call is what was said. `conversations: "summary"` denies the words and keeps the metadata; `"off"` denies the
  history too. The match ignores case. `"off"` denies a name containing `conversation` or `transcript`, a name containing
  `call` and `recording`, and the shapes `get_call`, `list_calls` and `export_history`. It does not deny a generation or
  a transcription: those names do not match. `"summary"` denies the transcript tools and the transcript patterns.
- **Generated files stay on your disk.** `elevenlabs_save_media` writes under `mediaRoot` and returns a path, a size, a
  sha256 and, when the container states one, a duration. The bytes never enter the conversation, and nothing is
  uploaded anywhere.
- **The optional API key** is stored by OpenCode's credential store, is used for one read (`GET /v1/user/subscription`),
  and is never printed: not in status, not in an error, not in a log. Remove it in `/connect` at any time.
- **Nothing is sent anywhere else.** The plugin's only outbound requests are the media download you ask for and that
  subscription read; the doctor fetches ElevenLabs' own discovery documents.
- **Redaction.** Text from OpenCode or the network is cut to one line, at most 160 characters, with URL credentials,
  queries and fragments removed and token shapes replaced, before it reaches status, the dialog or the session.

## Permissions

**Every tool is allowed by default.** With `access: "all"` an agent can, without asking:

- **Spend your credits.** Speech, images, video, music and sound effects bill the workspace you signed in with. An image
  or video call returns **four variations by default** and speech returns **two takes**, so one call can be four billable
  generations, and asking for a retry starts and charges another. **Speech to Text bills too**, at 330 credits a minute,
  and it is a *read*: `access: "read-only"` denies the generations and **still allows transcription**, so a read-only
  agent can spend. Running an agent test (`agents_create_test`) may also bill the agent's LLM usage; that is not capped
  until the live reconcile. The plugin prices each call before sending it, reserves the price, and prints a cost line;
  the caps (`sessionCreditCap`, `dailyCreditCap`) are the only bound, and they bound this plugin, not your account.
- **What a cap cannot decide.** A cap is exact inside one OpenCode, parallel turns and locations included, and every
  charge it writes survives another writer's merge. It is not a lock: `ctx.storage` offers `get`, `set`, `remove` and
  `scan`, and no compare-and-set, so two OpenCodes running at once on one data directory each admit against what they
  have read and can together go over the cap by about one call each before they see each other's charges. The model
  path narrows that window — it re-reads the store before it reserves, and the hold reaches the store before the call
  is dispatched. The script path cannot: the shared shaper contract is synchronous, so its reservation is written one
  tick after the call goes out, and a crash inside that tick loses the hold for a call that ran. Set the caps with the
  bound you can afford to be crossed once per extra OpenCode, not as a hard limit on the account; the account's own
  limits are at ElevenLabs.
- **Change live agents.** `agents_update` publishes straight to the branch it targets, `main` by default. It is not
  staged as a draft, and the plugin cannot undo it. A prompt edit changes what a production agent says to real callers on
  the next call.
- **Delete permanently.** `agents_delete`, `agents_delete_tool`, `agents_delete_phone_number` and
  `agents_bulk_delete_knowledge_base` cannot be reversed.
- **Publish and deploy.** `agents_create_deployment` moves live traffic; `agents_duplicate` and `agents_create_branch`
  create entities that can be deployed.
- **Grant access from outside.** `agents_get_link` mints a shareable link; anyone with it can use the agent or the test
  session.
- **Read callers' calls.** Every transcript and its extracted fields, as above.
- **Send your audio to ElevenLabs.** `creative_transcribe_audio` and the reference-file tools upload what you point them
  at.
- **Write outside the project.** `elevenlabs_save_media` writes under `mediaRoot`. It asserts both its own action and
  OpenCode's `external_directory` rule for that folder before it fetches anything, so a session that denies
  `external_directory` writes nothing.
- **Use a tool ElevenLabs adds later.** The `elevenlabs_*` rule allows it, and status names it as unknown. A new
  `creative_*` tool is priced or refused while a cap is on, so it does not spend unpriced. A new deleting tool still runs
  until it is classified.

One line restricts all of it: set `"access": "ask-changes"` (reads run, everything else asks) or `"access": "read-only"`
(reads run, everything else is denied), or add a rule for one tool, such as
`{ "action": "elevenlabs_agents_delete", "resource": "*", "effect": "deny" }`.

In an unattended run such as `opencode run`, a tool that asks is refused rather than left waiting.
