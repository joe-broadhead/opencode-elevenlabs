---
name: elevenlabs-creative
description: Generate and keep speech, images and video with the user's ElevenLabs workspace, edit images, design voices and transcribe audio on a flow, through the hosted MCP server. Use when the request is to make or edit media, to price a generation before paying for it, or to save a generated file the user wants to keep. Spend credits carefully - every generation is charged. Not for managing agents (the elevenlabs skill), not for the user's own meetings and recordings (Granola, Wispr Flow, Plaud), and not for building generation into the user's own code, which needs the SDK and an API key.
license: MIT
---

If no `elevenlabs_*` tools are in this session, no one is signed in: run `/connect`, choose ElevenLabs, and sign in; on Jelly, call `jelly_connection_request` instead.

# ElevenLabs generation

Generations land on a **Flow**, the editable canvas that holds the prompt and the results. They **spend the workspace's
credits**, so read this first. Every tool takes a `context` parameter: one short line naming the goal.

## What spends

Twelve tools bill the workspace: `creative_generate_speech`, `creative_generate_image`, `creative_generate_video`,
`creative_edit_image`, `creative_generate_in_flow`, `creative_run_flow_nodes`, `creative_transcribe_audio`,
`creative_design_voice`, `agents_run_tests`, `agents_compute_kb_rag_index`, `agents_query_knowledge_base_rag` and
`creative_create_brand_kit_from_website`. Everything else on a flow is free to call.

## Price it before you spend

- **ElevenLabs is the only source of a price.** There is no rate card to work from. Send the same call with
  `estimate_only: true` and read the figure that comes back:

  ```json
  { "prompt": "a ceramic mug on marble, morning light", "model_id": "gpt-image-2", "generations_count": 1, "estimate_only": true, "context": "price the mug shot" }
  ```

  ```js
  const priced = await tools.elevenlabs.creative_generate_image({ prompt, model_id: "gpt-image-2", generations_count: 1, estimate_only: true, context: "price the mug shot" })
  ```

  Say the price and what it buys, then make the paid call with the same arguments: the plugin remembers the figure for
  ten minutes and will not ask ElevenLabs again. An estimate charges nothing, but it does create a flow and a node in
  the workspace, so ask for one per set of arguments, not per attempt.
- **The figure is for the whole batch**, not for one generation, and it can be fractional. A paid result carries a cost
  line such as `Credits: 762; 762 credits today.` Repeat that figure to the user.
- `generations_count` defaults to **4** for image, video and image editing, and to **2** for speech. Pass `1` unless the
  user asked for options.
- `creative_design_voice` and `agents_run_tests` take no `estimate_only`, so nothing prices them before they run. Say
  so before calling one, and report the cost line their result carries.
- **Never call a generating tool twice to "retry".** A retry starts and charges a second generation. Poll
  `creative_get_flow_run_status` with the `flow_id` until it reports `all_completed` or `has_failures`.
- The workspace's own credit balance at ElevenLabs is the limit. If the user set a credit cap in this plugin's options,
  a call over it is refused with `SPEND_CAP_REACHED` or `PRICE_UNKNOWN`; pass the refusal's next step on rather than
  working around it.

## Speech

`creative_generate_speech` puts the spoken words in `prompt` — there is no `text` parameter — and needs a `voice_id`
and a `model_id`. Call `creative_list_voices` first; a `voice_id` only ever comes from there or from the user. The
default model is `eleven_multilingual_v2`, or `eleven_v3` when the script has audio tags such as `[whispering]`.
Speech returns two takes by default and each is charged.

## Images and video

`creative_generate_image`, `creative_generate_video` and `creative_edit_image` take `prompt` and `model_id`;
`creative_edit_image` also takes `connect_from`, a node on the same flow. `gemini-2.5-flash-image` is the general
default; `gpt-image-2` for rendered text, infographics and reference-driven edits; `flux-2-pro` for fine detail.
`creative_get_model_guide` explains how to prompt one model, `creative_get_model_schema` gives its parameters, and
`creative_get_flow_node_types` lists what the workspace can run.

## Chaining on one flow

Nodes on different flows cannot be connected. Call `creative_create_flow` first, then pass that `flow_id` to every
related call and wire with `connect_from` (a `node_id` from a tool result or `creative_get_flow`, never invented).
`creative_generate_in_flow` adds and runs a node of a given `node_type`; `creative_run_flow_nodes` re-runs the
`node_ids` you name. Both are charged like any other generation.

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

`creative_transcribe_audio` transcribes a node already on a flow: it takes `connect_from` and a `model_id`, never a file
or a path from this machine. To transcribe audio that is not on a flow yet, put it there first with
`creative_create_asset_upload` and `creative_finalize_asset_upload`, and say that the audio leaves the machine before
doing it. The transcription itself is charged like a generation.

## Not this skill

Agent settings are the `elevenlabs` skill. What callers said to an agent is `elevenlabs-calls`.
