---
name: elevenlabs-creative
description: Generate and keep speech, images, video, music and sound effects with the user's ElevenLabs workspace, and transcribe audio, through the hosted MCP server. Use when the request is to make or edit media, to price a generation before paying for it, or to save a generated file the user wants to keep. Spend credits carefully - every generation is charged. Not for managing agents (the elevenlabs skill), not for the user's own meetings and recordings (Granola, Wispr Flow, Plaud), and not for building generation into the user's own code, which needs the SDK and an API key.
license: MIT
---

# ElevenLabs generation

Generations land on a **Flow**, the editable canvas that holds the prompt and the results. They **spend the workspace's
credits**, so read this first. Every tool takes a `context` parameter: one short line naming the goal.

## Price it before you spend

- Speech, music, sound effects and transcription have a published credit price, and every paid result carries a cost
  line such as `Credits: at most 1,200 (600 characters, 2 takes)`. **Transcription is billed too** (330 credits a minute).
  The plugin prices it from the audio file it is about to send. A duration you type can raise that price, not lower it.
  A file it cannot measure is refused while a cap is on.
- **Image and video have no published price.** They depend on the model, the resolution and the duration, so the only
  price is ElevenLabs'. Call the same tool with `estimate_only: true` first:

  ```json
  { "prompt": "a ceramic mug on marble, morning light", "generations_count": 1, "estimate_only": true }
  ```

  The answer is a price. Say the price and what it buys, then make the paid call. Whether the estimate itself is free, and
  whether its number is for the whole batch, is being measured against a real workspace; the cost line says "at most"
  when it is divided across generations, so treat it as a ceiling rather than a receipt:

  ```js
  const priced = await tools.elevenlabs.creative_generate_image({ prompt, generations_count: 1, estimate_only: true, context: "price the mug shot" })
  ```
- `generations_count` defaults to **4** for image and video, and a request for four costs four times one. Pass `1` unless
  the user asked for options.
- **Never call a generating tool twice to "retry".** A retry starts and charges a second generation. Poll
  `creative_get_flow_run_status` with the `flow_id` until it reports `all_completed` or `has_failures`.
- The plugin also caps this: a call over the remaining budget is refused before it is sent, the generation count is cut
  to what fits, a call it cannot price is refused `PRICE_UNKNOWN`, and the price is held against the budget before the
  call is sent. The caps bound this plugin, not the account.
- `creative_edit_image` is not known to take `estimate_only`: it runs from a remembered price for those arguments, or
  when both caps are `null`. Never retry it for a price.

## Speech, music and sound

`creative_generate_speech` needs `text`; `creative_generate_music` takes `duration_seconds` or `music_length_ms`;
`creative_generate_sound_effect` takes `prompt` and a generation count. Call `creative_list_voices` first; `voice_id` only
ever comes from there or from the user. The default speech model is `eleven_multilingual_v2`, or `eleven_v3` when the
script has audio tags such as `[whispering]`. Speech returns two takes by default and each is charged.

## Images and video

`creative_generate_image` and `creative_generate_video` take `prompt`, and video also takes `duration_seconds`; `creative_edit_image` also takes `connect_from` (a node on the same flow).
`gemini-2.5-flash-image` is the general default; `gpt-image-2` for rendered text, infographics and reference-driven
edits; `flux-2-pro` for fine detail. `creative_get_model_guide` explains how to prompt one model, and
`creative_get_flow_node_types` lists what the workspace can run.

## Chaining on one flow

Nodes on different flows cannot be connected. Call `creative_create_flow` first, then pass that `flow_id` to every
related call and wire with `connect_from` (a `node_id` from a tool result or `creative_get_flow`, never invented).

## Keeping a file

A result carries a signed link on `elevenlabsusercontent.com` that **expires in about two hours**, plus a canvas `url`
that does not. To keep the file, call `elevenlabs_save_media` with the link:

```json
{ "url": "https://…elevenlabsusercontent.com/…", "name": "intro-voiceover.mp3" }
```

It answers with the path, size, sha256 and, when the container states one, the duration. Files go under the plugin's
`mediaRoot` (status shows it; the default is `~/Downloads/elevenlabs`). Never paste the bytes into the conversation, never
put a generated file in a git repository unless the user asks, and never re-generate to "refresh" an expired link: fetch
the generation again, or open the flow.

## Transcription

`creative_transcribe_audio` uploads audio to ElevenLabs and returns text. Say that the audio leaves the machine before the
first call if the user has not said it is fine.

## Not this skill

Agent settings are the `elevenlabs` skill. What callers said to an agent is `elevenlabs-calls`.
