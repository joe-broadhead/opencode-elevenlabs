# Contributing

## Setup

```sh
git clone https://github.com/joe-broadhead/opencode-elevenlabs
cd opencode-elevenlabs
npm ci
```

Requires Node 24 and Bun 1.4.4, the Bun inside the stock OpenCode binaries.

## Checks

```sh
npm run check          # every stage, in order, stopping at the first failure
npm run check unit     # one stage
```

Stages: `typecheck`, `unit`, `build`, `icons`, `host`, `pack`, `forbidden`, `copies`, `whitelist`, `actionlint`.

The `host` and `pack` stages run on every tested OpenCode release when `OPENCODE_BIN_2_2_3` to `OPENCODE_BIN_2_2_6`
point at stock binaries; each is also installed from npm and run in its own temp folder. Unset, the stages use the locked
SDK and print a notice.

`npm pack --dry-run` must show the file list in `scripts/check.mjs` and nothing else.

## ElevenLabs' tools

`src/elevenlabs-tools.ts` holds the 40 tool names ElevenLabs' own MCP skills name; the live list is reconciled after a
sign-in. To reconcile:

1. Save the raw `tools/list` response over `test/fixtures/live-tools.json` (the command is in
   `test/fixtures/README.md`).
2. `npm run drift` names every tool the plugin does not classify, every tool the list has lost, and every tool whose
   annotations disagree with its class.
3. Update `src/elevenlabs-tools.ts`, then `package.json`'s `jelly.tools`, then the README's Permissions section.
4. `npm run check` — a docs test and the Jelly test fail until all three agree.

## Release

1. Set `version` in `package.json` and remove the `private` flag, in one commit whose message names the version.
2. Tag it `v<version>` and push the tag. `release.yml` refuses a private package or a mismatched tag, runs `npm run
   check`, packs, tests that exact tarball, and publishes with npm trusted publishing and provenance after approval in the
   `release` environment. A version already on npm is skipped with a notice.
3. The platform packages, if any, publish before the main one.

## Installing from a checkout

For development only, point OpenCode at the built plugin:

```sh
npm run build
```

```json
{ "plugins": [{ "package": "file:///path/to/opencode-elevenlabs" }] }
```

The published package is what the README describes; a checkout is not.
