# Agent notes

This repository is an OpenCode plugin. Read the README for what it does; this file is for working on it.

## Layout and checks

- `src/` is the plugin, `test/` the suites, `scripts/` the checks. `npm run check` runs typecheck, unit, build, icons,
  host, pack, forbidden, copies, whitelist and actionlint, in that order.
- `npm run check` with `OPENCODE_BIN_2_2_3` to `OPENCODE_BIN_2_2_6` set runs the host and pack stages against every
  tested release; once unset it falls back to the locked SDK with a notice.
- `npm run drift` compares the plugin's tool table with `test/fixtures/live-tools.json`.
- The host suite needs Bun 1.4.4 and Node 24. It starts an embedded OpenCode, so it must not run against a real account:
  the fake server is loopback only, and any fetch that leaves loopback fails the run.

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

- `src/host/tools-rpc.ts` is a copy of a module several plugins share. Edit only between its `PLUGIN-SPECIFIC` markers;
  `npm run check` fails the copies stage otherwise. The same goes for `test/support/jelly-kit.ts`.
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
- The icon `assets/icon.svg` (and the two PNGs rendered from it) is ElevenLabs' "11" symbol from https://elevenlabs.io/brand,
  used under those guidelines: the symbol unmodified (black, only scaled, its path data pre-scaled to the family's 48 grid)
  on a neutral holding shape whose height is three times the symbol's. Do not recolour, redraw or combine it, and keep the
  README's trademark line.
- No personal email in anything we publish. Every commit, tag and package is authored and committed as
  `joe-broadhead <91376460+joe-broadhead@users.noreply.github.com>`. Before committing or tagging, check that
  `git config user.email` is that address: a fresh clone inherits the machine's global identity, which is not that
  address. Never commit, tag or publish with a work or personal address, or with a local hostname.
