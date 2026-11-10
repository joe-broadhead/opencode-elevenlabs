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

`src/elevenlabs-tools.ts` classifies the 190 tools the live server lists. The capture in `test/fixtures/live-tools.json` is
what `npm run drift` checks it against. To reconcile after the live list changes:

1. Save the raw `tools/list` response over `test/fixtures/live-tools.json` (the command is in
   `test/fixtures/README.md`).
2. `npm run drift` names every tool the plugin does not classify, every tool the list has lost, and every tool whose
   annotations disagree with its class.
3. Update `src/elevenlabs-tools.ts`, then `package.json`'s `jelly.tools`, then the README's Permissions section.
4. `npm run check` — a docs test and the Jelly test fail until all three agree.

## Release

Every plugin releases as `v0.0.0`, and it installs from that GitHub tag. The release is one commit on top of a `master`
head that CI passed, and the tag points at it.

1. Set `version` to `0.0.0` in `package.json`, date the `## [0.0.0]` entry in `CHANGELOG.md`, then run `npm run check`.
2. Push that commit to `master`, and wait for CI to pass on it.
3. In a clean checkout of `master` at that commit, run `node scripts/release-commit.mjs --ci-sha <its full sha>`. It builds
   `dist/`, removes the lifecycle scripts, and creates the signed commit and the signed annotated tag `v0.0.0`. It never
   pushes; `--dry-run` shows the change first.
4. Push the tag only: `git push origin v0.0.0`.
5. Approve the run in the `release` environment. The release workflow checks the tag and its commit, installs the tag on
   each stock OpenCode host (2.2.3 to 2.2.6), packs it, and creates the GitHub Release with the notes, the tarball and
   `SHA256SUMS`.

A tag that already exists stops step 3. Delete the old tag and its Release first, then start again.

## Installing from a checkout

For development only, point OpenCode at the built plugin:

```sh
npm run build
```

```json
{ "plugins": [{ "package": "file:///path/to/opencode-elevenlabs" }] }
```

The published package is what the README describes; a checkout is not.
