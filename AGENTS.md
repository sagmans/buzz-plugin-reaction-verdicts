# Agent guide

Instructions for coding agents that change this repository. Read
[README.md](README.md) first: it describes the behavior that users and their
agents rely on.

## Layout

| Path | Purpose |
| --- | --- |
| `plugin/manifest.json`, `plugin/plugin.js` | The plugin that Buzz installs, as is. No build step. |
| `scripts/dogfood.mjs` | Runs the plugin with a fake Buzz host and checks every post, wake and skip. |
| `scripts/check` | The repository checks; the git hooks call it. |
| `scripts/setup-hooks`, `.githooks/` (except `*.d/`) | Generic hooks copied from a shared template. Do not edit them here. |
| `.githooks/<hook>.d/` | This repository's hook steps. |

## Rules

- Keep `plugin/plugin.js` one self-contained ES module: no imports, no build,
  plain `React.createElement`. The module top level must stay pure; do all
  work in `apply`, and register cleanups with `ctx.effect`.
- Keep `inject` minimal. Do not add a `host` block to the manifest; the
  dogfood run rejects one, because it gives the plugin native access.
- The default verdict map, the verdict message texts and the
  `OWNER VERDICT` wake prefix are a contract with users' agent rules. Change
  them only on purpose, and update the README contract section with them.
- Put every fixed value in a named constant at the top of the file. Comments
  explain why, not what.
- Validate every value that comes from the relay or from local storage
  before use, and fail closed.
- No personal data in any file or commit: no real names, home paths, host or
  tailnet names, keys, tracker links or ids. Use neutral words such as "the
  user" and `example.ts.net`. `scripts/check personal-data` blocks the common
  forms.
- Do not add dependencies without the maintainer's approval.

## Before you commit

1. Run `scripts/setup-hooks` once per clone.
2. Run `scripts/check` (offline steps) and fix every finding.
3. For a behavior change, add or change a scenario in `scripts/dogfood.mjs`.
   With the default map, the posts and wakes must stay identical to the
   previous revision:

   ```sh
   node scripts/dogfood.mjs --defaults-only --transcript --plugin <old plugin.js> >old.json
   node scripts/dogfood.mjs --defaults-only --transcript >new.json
   diff old.json new.json
   ```

4. For UI changes, also load the `plugin` folder into a test profile of the
   desktop app and try the page and the settings card.
5. Commit with `git commit -s -S`, following `.githooks/GIT_CONVENTION.md`.
   Never use `--no-verify`.
