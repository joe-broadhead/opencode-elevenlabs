# Agent notes

This repository is an OpenCode plugin. Read the README for what it does; this file is for working on it.

## Layout and checks

- `src/` is the plugin, `test/` the suites, `scripts/` the checks. `npm run check` runs typecheck, unit, conformance,
  kit, build, icons, host, pack, forbidden, copies, whitelist and actionlint, in that order.
- `npm run check` with `OPENCODE_BIN_2_2_3` to `OPENCODE_BIN_2_2_6` set runs the host and pack stages against every
  tested release; once unset it falls back to the locked SDK with a notice.
- `npm run drift` compares the plugin's tool table with `test/fixtures/live-tools.json`.
- The host suite needs Bun 1.4.4 and Node 24. It starts an embedded OpenCode, so it must not run against a real account:
  the fake server is loopback only, and any fetch that leaves loopback fails the run. On 2.3.1 and later the harness
  builds that host through `PromiseSdk.create`, which `OpenCode.create` calls, with the SDK's `overrides` so that its
  Automation service also runs the scheduler, as `opencode serve` does: Code Mode with nobody present runs there as an
  automation's code action (`unattended` in `test/host/harness.ts`).

## Forbidden in this repository

Checked by `scripts/check-forbidden.mjs` across `src/`, `test/`, `scripts/` and `dist/`:

- fork-only markers (`dispatch-lease`, `catalog-ownership`, text-only response markers), `options.mcp` delegation,
  `Plugin.image`, imported OAuth grants;
- the V1 plugin API (`@opencode-ai/*`), V1 hooks (`tool.execute.before`, `chat.message`, `permission.ask`),
  `ctx.generate.text`, `experimental.policies`, and `@opencode/ai`;
- a permission hook other than the tools RPC's one evaluate hook;
- private host source paths and host checkouts;
- machine-local home and temp paths;
- internal process wording: who decided what, lane names, ticket references of our own.

## House rules

- The tools RPC's transport is source-contract's `tools-rpc` module (`@we-the-rebel-alliance/source-contract`, a dev
  dependency pinned to a tag and bundled into `dist/index.js`); `src/host/tools-rpc.ts` is ElevenLabs' part of it.
  `test/support/jelly-kit.ts` and `test/support/jelly-settings.ts` are copies every plugin shares: `npm run check`
  fails the copies stage when either differs.
- The source `elevenlabs.conversations` (`src/events.ts`, `package.json`'s `sources`) is metadata only: the callers are
  other people, so an event never carries a caller, a transcript, a summary, a score or feedback, and its `text` stays
  empty. It reads only `agents_list_conversations`, `agents_list` and `agents_get`, all free reads (the last two for
  each agent's retention, which decides its `gap`); every tool it adds must be a free read, `permission.operations`
  must name exactly what it reads, and the conformance stage (`npm run conformance`) fails otherwise.
- The tool table is `src/elevenlabs-tools.ts` and nothing else: the default rules, the tools RPC, status, the spending
  guard, the Jelly declaration and the tests all derive from it.
- Every error the plugin raises has a code from `PLUGIN_CODES`, and the README's and the configuration guide's tables
  must match it exactly.
- The plugin never sees the OAuth token, and never prints one. Anything read from the network goes through
  `src/redact.ts` before it reaches status or the session.
- A tool that writes asserts its own permission inside `execute`; a declared `permission` alone does not ask.
- The tool table and the estimate's shape were measured in live reconcile 1 (`test/fixtures/README.md`): the catalogue
  is the live one, an estimate costs nothing but creates a flow, and its figure is the batch total and may be
  fractional. One fact is still unverified, and the README's Known limits is the one place that says so: whether a paid
  result reports what it really cost, and in which field. Do not state that as settled, and do not call the tool table
  provisional.
- The icon `assets/icon.svg` (and the two PNGs rendered from it) is ElevenLabs' own "11" symbol, the published
  `elevenlabs-symbol.svg` from https://elevenlabs.io/brand in its own 876 canvas: the two black bars exactly as published,
  on a white holding square three times their height, as the brand page asks. `opencode.vendor.mark` is `true`. Do not
  recolour, redraw or combine it, and keep the README's trademark line.
- Releases come only from `.github/workflows/release.yml` ("Releasing" in [CONTRIBUTING.md](CONTRIBUTING.md)). A
  release-prep PR sets `version` in `package.json` and the install specs and runs `node scripts/changelog.mjs release`;
  once it is on `master` and CI passed, start the release with
  `gh workflow run release.yml --ref master -f sha=<its full sha>`. The workflow builds `dist/`, makes the release
  commit on a temporary `release/v<version>` branch, checks and stages everything, and waits for the owner to approve
  the `release` environment; only then does it create the tag `v<version>` and the GitHub Release. Never push a tag or a
  `release/*` branch, and never commit, tag or publish a release by hand. Agents never approve a release, never call the
  deployment-approval API, and never bypass a ruleset or the environment.
- No personal email in anything we publish. Every commit is authored and committed as
  `joe-broadhead <91376460+joe-broadhead@users.noreply.github.com>`, except the release commit and tag, which the
  release workflow makes as `github-actions[bot]`. Before committing or tagging, check that
  `git config user.email` is that address: a fresh clone inherits the machine's global identity, which is not that
  address. Never commit, tag or publish with a work or personal address, or with a local hostname.
