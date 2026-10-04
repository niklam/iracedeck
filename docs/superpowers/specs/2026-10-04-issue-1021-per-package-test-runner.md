# Per-package test runs through one shared runner

> **Issue:** [#1021](https://github.com/niklam/iracedeck/issues/1021) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The fact that decided it

The issue recommended option A: delete the 16 dead `test` / `test:watch` scripts and document `pnpm test <path>` as the only way. Measured against pnpm 12.6.0 (the pinned version) in a scratch workspace on 2026-10-04, that does not remove the false green — it makes it universal:

| Command, package has no such script | Result |
| --- | --- |
| `pnpm --filter <pkg> test` | nothing printed, exit 0 |
| `pnpm --filter <pkg> run test` | nothing printed, exit 0 |
| `cd packages/<pkg> && pnpm test` | nothing printed, exit 0 |
| `pnpm --filter <pkg> run nosuch` | `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`, exit 1 |

pnpm treats `test` like a lifecycle name and skips it silently when it is missing, while any other missing script fails loudly. So a package without a `test` script is exactly the false-green case the issue calls the real hazard, and option A would extend it from 10 packages to all of them. The hook (`rules-bash.mjs`) refuses the shape for agents, but nothing guards a person at a terminal. The issue's own *Expected* — every way of running a package's tests either runs them or fails loudly — can only be met by giving every package that has tests a `test` script that works.

## Decision

Every package with test files gets the same two scripts, byte-identical across packages:

```json
"test": "node ../../scripts/test-package.mjs",
"test:watch": "node ../../scripts/test-package.mjs --watch"
```

`scripts/test-package.mjs` resolves the package directory it was started in (pnpm runs a script with the package as its cwd) to its workspace-relative form, `packages/<name>/`, and runs the root suite from the workspace root with that directory as the Vitest filter. The Vitest arguments are read from the root `package.json`'s own `test` / `test:watch` scripts, so `--configLoader native` lives in one place and the per-package run cannot drift from the root run. Extra arguments after the script are forwarded to Vitest (`pnpm --filter <pkg> test -t "name"`). The child's exit code is the runner's.

The filter carries a trailing slash, because a Vitest filter is a substring match on the file path and `packages/icon` would otherwise also match `packages/icons` and `packages/icon-composer`.

A package with **no** test files gets **no** `test` script. Its `pnpm --filter <pkg> test` still exits 0 silently, but there is nothing it failed to run — the false green the issue is about is a package whose tests were skipped. This removes the scripts from `iracing-plugin-mirabox` and `iracing-plugin-ulanzi`, which have none.

### The guard

`scripts/package-test-scripts.test.mjs` asserts, for every `packages/*/package.json`: a package with a `src/**/*.test.ts` file has exactly the two scripts above, and a package without one has neither. A new package that gains its first test, and a hand-written `vitest run` copied from an old package, both turn the suite red with the fix named. The runner's pure part (cwd → filter, root script → argument list) is unit-tested, and one test runs the real runner against a one-test package as a positive control — it must report that file and exit 0 — plus one from a directory that is not a package, which must exit non-zero with a message.

### The hook

The `run vitest through the root script` rule stops refusing `pnpm --filter <pkg> test`, which now works; it keeps refusing `pnpm exec vitest` / `npx vitest`, which still drop the native loader. The `pnpm --filter on a script the package does not have` rule already refuses `test` on a package without one, so nothing else changes there.

## Alternatives rejected

- **A — delete the scripts.** Universalises the silent exit 0, per the table above.
- **B as filed — `vitest run --root ../.. packages/<name>` in each package.** Repeats the package's name inside its own manifest and duplicates the root's Vitest flags, so a copied script silently tests the wrong package or drops `--configLoader native`. The shared runner derives the name from the cwd and the flags from the root.
- **C — one Vitest project per package in the root config.** Still needs a `test` script per package to fix the pnpm false green, so it is the shared runner plus a restructuring of the test setup nobody has asked for.

## Out of scope

- A `test` task in `turbo.json` and running tests per package in CI. The root `pnpm test` stays the CI command; this only makes the per-package entry point honest. `pnpm -r test` now works but starts one Vitest per package, so it is slower than the root run and is not recommended anywhere.
- Making a package with no tests fail loudly. See *Decision*.
- Historical records beyond the one copyable command in `docs/plans/2026-04-19-audio-architecture-design.md`, which is corrected to `pnpm test packages/<stage-package>`.

## Testing

- `pnpm test scripts/package-test-scripts.test.mjs scripts/test-package.test.mjs` — the guard, the runner's unit tests and its positive/negative controls; break one package's script by hand to watch the guard fail.
- By hand: `pnpm --filter @iracedeck/deck-core test` and `cd packages/iracing-sdk && pnpm test` run only that package's files and exit 0; a deliberately failing assertion in one makes both exit non-zero; `pnpm --filter @iracedeck/deck-core test:watch` starts watch mode on that package.
- The hook: pipe a `pnpm --filter @iracedeck/deck-core test` payload through `pre-bash.mjs` and see it pass, and a `pnpm exec vitest` one still denied.
