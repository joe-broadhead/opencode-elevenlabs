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
  subscription read; the doctor fetches ElevenLabs' own discovery documents. What the *model* sends to ElevenLabs is a
  separate matter: its tool calls go to ElevenLabs' own server, and one of those tools, `get_more_tools`, exists to
  carry a free-text sentence the model wrote itself. See Permissions below.
- **Redaction.** Text from OpenCode or the network is cut to one line, at most 160 characters, with URL credentials,
  queries and fragments removed and token shapes replaced, before it reaches status, the dialog or the session.

## Permissions

**Every tool is allowed by default.** With `access: "all"` an agent can, without asking:

- **Spend your credits.** Twelve tools bill the workspace you signed in with: speech, images, video, image editing,
  generating inside a flow, running a flow's nodes, transcription, voice design, running an agent test, indexing a
  knowledge-base document, running a RAG query, and building a brand kit from a website. The last three are counted as
  spending because ElevenLabs' catalogue says neither way and each describes work it plausibly bills; silence is read
  against your money rather than for it. An image or
  video call returns **four variations by default** and speech returns **two takes**, so one call can be four billable
  generations, and asking for a retry starts and charges another. **Transcription bills too**, and it is a *change*,
  not a read: `access: "read-only"` denies it along with every other tool that can spend. The plugin prices each call
  before sending it by asking ElevenLabs for an estimate of that exact call, reserves the figure, and prints a cost
  line; the caps (`sessionCreditCap`, `dailyCreditCap`) are the only bound, and they bound this plugin, not your
  account. Five of the twelve have no estimate — `creative_design_voice`, `agents_run_tests`,
  `agents_compute_kb_rag_index`, `agents_query_knowledge_base_rag` and `creative_create_brand_kit_from_website` — so
  while a cap is on they are refused rather than run unpriced.
- **An estimate is a call of its own.** It costs nothing — measured against a real workspace, two of them moved the
  balance by zero — but each one creates a flow and a node in the workspace. The plugin asks for one per set of
  arguments, keeps it for ten minutes, and sends it only where the paid call is permitted: under `ask-changes` you are
  asked once, for the generation, and under `read-only` nothing is estimated because nothing may be generated.
- **What a cap cannot decide.** Exactly: **within one OpenCode the caps are exact; across OpenCodes a cap is crossed
  by at most one call's reservation for each one deciding before its read of the others' holds lands, so eight of them
  at 3,000 credits a call can spend 31,000 against a 10,000 cap; every OpenCode reads the store behind each call it
  admits and every five seconds besides, so none decides on a book older than that; a settled charge is never lost.**
  The crossing needs overlap: calls that wait for one another see one another, and those same eight, run one after the
  next, spend only the 9,000 that fits. A cap is not a
  lock: `ctx.storage` offers `get`, `set`, `remove` and `scan`, and no compare-and-set, so two OpenCodes running at once
  on one data directory each admit against what they have read. Nothing is lost to that race, because every hold and
  every charge has its own key that only its own OpenCode rewrites and a total is a scan and a sum, not a merge. The
  check and the hold are taken in memory with nothing awaited between them, so two calls in one process cannot both
  pass; the hold's key is then written and awaited before the call is dispatched, and a write that fails refuses the
  call. Set the caps with the bound you can afford to be crossed once per extra OpenCode, not as a hard limit on the
  account; the account's own limits are at ElevenLabs. A cap also binds one server entry: the `elevenlabs` entry this plugin manages. A second MCP
  entry pointing at ElevenLabs under another name serves its tools under that name's prefix, which this plugin's hooks
  never see, so its calls are priced by nothing here. `/elevenlabs-status` names such an entry when one exists.
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
- **Send your audio to ElevenLabs.** The reference-file and asset-upload tools send what you point them at.
  `creative_transcribe_audio` does not: it takes no file and no path, and transcribes a node already on a flow in the
  workspace. No price in this plugin reads a file on this machine.
- **Write outside the project.** `elevenlabs_save_media` writes under `mediaRoot`. It asserts both its own action and
  OpenCode's `external_directory` rule for that folder before it fetches anything, so a session that denies
  `external_directory` writes nothing.
- **Ask ElevenLabs to build new tools, in words the model writes itself.** `get_more_tools` takes one free-text
  argument, `capability`, and ElevenLabs uses it to decide which tools get built next. It is the one tool that carries
  a sentence the model composed out of the workspace. It carries no workspace data, returns no tool and adds nothing at
  run time, but under `access: "all"` it goes out without a prompt. `ask-changes` asks for it; `read-only` denies it.
- **Use a tool ElevenLabs adds later.** The `elevenlabs_*` rule allows it, and status names it as unknown. While either
  credit cap is on it cannot spend unpriced: a name this release does not classify is refused `PRICE_UNKNOWN` before it
  is sent, whatever it is called — the money gate is the tool table, not a name prefix. With **both caps set to
  `null`** that gate is off, and a new tool runs unpriced. A new deleting tool still runs until it is classified,
  because permission is a separate axis from money: `ask-changes` and `read-only` are what bound it.

One line restricts all of it: set `"access": "ask-changes"` (reads run, everything else asks) or `"access": "read-only"`
(reads run, everything else is denied), or add a rule for one tool, such as
`{ "action": "elevenlabs_agents_delete", "resource": "*", "effect": "deny" }`.

In an unattended run such as `opencode run`, a tool that asks is refused rather than left waiting.
