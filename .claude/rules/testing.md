# Testing Conventions

- All new code must include unit tests. Use Vitest with `describe`/`it`/`expect`.
- Test file naming: `foo.ts` → `foo.test.ts`.
- Keep tests focused and fast. Mock external dependencies where appropriate.
- Add CI-friendly commands to `package.json` scripts to run tests non-interactively.

Common commands

```bash
pnpm test
pnpm test:watch
pnpm typecheck              # the type gate: tsc --noEmit per package (#987)
```

`pnpm test` does not typecheck: Vitest transforms through esbuild, which strips types without checking them. Neither did `pnpm build`, for the rollup-built packages — that gap is what #987 closed. `pnpm typecheck` is the explicit gate; its turbo task declares `dependsOn: ["^build"]` because packages resolve each other's types through emitted `dist/`, so it builds what it needs and needs no separate build step first.

**What it reaches**, stated so nobody has to infer it from a green run. `scripts/typecheck-script-coverage.test.mjs` discovers a package if it has TypeScript sources **or** a `tsconfig.json` — a union, so a config-only package is included too. The reason it is not keyed on the config alone is that doing so let three packages escape as absences rather than as exclusions. Every package is in the gate, and since #1078 so is every test file: both of the guard's allow-lists (`NO_TYPECHECK_SCRIPT`, `TYPECHECK_EXCLUDES_TESTS`) are empty and deliberately kept. A package that skips the gate has to be named in the first; one whose plain `tsc -p` program leaves a test file out has to be named in the second, with the size of what it hides; and a package checked by anything other than `tsc` (the website's `astro check`) gets no list at all — the guard measures it by planting a test-shaped file that cannot compile, so an exclusion there fails outright. That probe is gitignored (#1394), so `git status` and `git add -A` never see it, and the run holds a per-checkout lock (`node_modules/.cache/typecheck-coverage-probe.lock`, `scripts/lib/probe-lock.mjs`) across its clean and probed typechecks, so two runs in one checkout take turns; a probe left by a killed run is removed by the next run, under that lock, before its clean check. The walker that finds the test files has a smoke test of its own, because with both lists empty it is the only thing standing between a re-added exclusion and a green suite: its callers return early on an empty result. The last entry to go was `iracing-actions`' 76 test files, excluded by their tsconfig: **541 errors across 34 of them** (measured 2026-09-01, unchanged on 2026-09-06), every one in test code and none needing a production signature to move. Two patterns accounted for 456 of them and are now the convention for action tests — see *Settings literals and protected members* in `action-tests.md`.

Two things worth knowing about the gate's shape rather than its edges:

- **The website is checked by `astro check`, not `tsc`** (#1077). Plain `tsc` cannot check an Astro project. Its `typecheck` script first runs `generate:gallery`, because `src/data/icon-gallery.json` is gitignored and is imported by `routeData.ts` and `IconGallery.astro` — without it the script passes locally and fails on every fresh clone. It deliberately does **not** run `build`'s other generator: `generate:changelog-json` only writes `public/changelog.json`, a statically served asset that no source imports, so running it in the gate would rewrite a file for no checking benefit.
- **For `deck-adapter-mirabox` and `deck-adapter-ulanzi`, `build` and `typecheck` share one config.** Both build with bare `tsc`, so the test exclusion #1078 removed had been keeping test files out of `dist/` as well as out of the gate; their `dist/` now contains compiled tests, matching the 14 other packages that already did (measured 2026-09-01).

## The suite runs against the native mocks (#1084)

`vitest.config.ts` sets `test.env.IRACEDECK_MOCK`, so **no test worker ever loads a compiled native addon** — on any platform, including Windows.

This is not a convenience. `@iracedeck/iracing-native` `require()`s its `.node` in **module scope**, and the same module re-exports `defines.ts`, so importing a plain TypeScript enum such as `Flags` mapped a native binary into the worker. Measured 2026-09-01: **68 of the 301 `.test.ts` files** reached it through an unmocked, non-type-only import, overwhelmingly via `@iracedeck/iracing-sdk` → `penalty-flag-utils.ts`. `@iracedeck/audio-native` has the same shape but is reached by no test today.

Three things to know:

- **`scripts/vitest-native-mock.test.mjs` guards it.** The invariant rests on one config line whose removal produces *no* failing test — the symptom is an intermittently dropped worker, which reads as a flake rather than a regression. The guard asserts the runtime effect, so it survives the setting moving elsewhere.
- **To use the real addon, set `IRACEDECK_REAL_NATIVE=1`.** The hook refuses `IRACEDECK_MOCK=0`, which would still mock — both consumers test `!!process.env.IRACEDECK_MOCK`, so any non-empty string forces it — and the same trap applies in `pnpm test:watch` while iterating on a native change.
- **What it does not cover.** `config.env` reaches test *workers* only, never the main Vitest process, so a future `globalSetup` or Vite plugin could still load an addon. It also propagates to child processes, so anything a `scripts/**/*.test.mjs` shells out to inherits it. And the real `require()` of a `.node` runs in no automated check at all — it was already skipped on Linux CI and is now skipped locally too. The load *decision* around it is unit-tested with a fake loader since #1373 (`loadNativeAddon` in each package).

Whether this removes the cause of #1084 is **unestablished**; it removes a path that could produce it.

## A worker that dies with exit code 3221226505

`Worker exited unexpectedly with exit code 3221226505` (0xC0000409) on Windows is Node 24.15.0's own crash, not a flake: check `node -v` against `.nvmrc` before anything else. The cause, the measurements and the pin are in `node-version.md` (#1444).

## Root `vitest.config.ts` — native config loader

`pnpm test` / `pnpm test:watch` pass `--configLoader native`, so Node imports the root `vitest.config.ts` directly and strips its types itself, rather than Vite bundling the config first (Vite 8 bundles it with rolldown, and emits ESM here because the root package is `"type": "module"`) (issue #1017). Vite has announced that loader as a future default; opting in early means a dependency bump can't flip it for us.

Consequences when editing that file — none of these apply to test files or package sources, only to the config itself:

- Use `import.meta.dirname` / `import.meta.filename`. `__dirname` / `__filename` are not declared in an ES module, so reading one throws a `ReferenceError` — they only ever worked because the bundling loader *defines* them, whatever module format it emits.
- Type-only imports MUST carry the `type` modifier (`import { defineConfig, type Plugin } from "vitest/config"`). Node cannot infer which named imports are types, so an unmarked one becomes a value import of a non-existent export and the config fails to load. Vite's own `configLoader: 'native'` compatibility warning does **not** detect this case — only `__dirname`/`__filename` and import shapes — so the suite failing to start is the only signal.
- No `enum`, `namespace`, decorators, or constructor parameter properties — Node's type stripping cannot handle them.

`eslint.config.js` enforces the first two mechanically for `vitest.config.ts` (`no-restricted-globals` plus `@typescript-eslint/consistent-type-imports`), and `pnpm lint` covers the file, so a re-break is caught before the suite is ever started.

To run a subset, pass the filter through the root script — `pnpm test <path>` — so it keeps the native loader. The hook refuses `pnpm exec vitest`, which silently falls back to the bundling loader.

## Per-package runs (#1021)

`pnpm --filter <pkg> test`, `pnpm --filter <pkg> test:watch` and `pnpm test` inside a package directory all work, and run exactly the root suite filtered to that package. Every package with a `src/**/*.test.ts` carries the same two scripts, byte for byte:

```json
"test": "node ../../scripts/test-package.mjs",
"test:watch": "node ../../scripts/test-package.mjs --watch"
```

`scripts/test-package.mjs` turns the package directory into the filter `packages/<name>/` (the trailing slash keeps `icon` from matching `icons`), takes the Vitest arguments from the root `test` / `test:watch` scripts so `--configLoader native` lives in one place, runs from the workspace root, and forwards anything after the script name to Vitest. Forward options only (`-t "name"`, `--reporter=verbose`): Vitest ORs positional filters, so `pnpm --filter <pkg> test src/foo.test.ts` would add every matching file in every package to the run rather than narrow it. Narrow to a file with `pnpm test <path>` at the root. Never write a package's own `vitest run`: Vitest roots itself at the package directory, where the root-relative `include` globs match nothing, so it exits 1 with "No test files found".

A package with **no** tests has **no** `test` script. That is the one case left where pnpm's behaviour does not matter. It skips a missing `test` silently with exit 0, as if it were a lifecycle name, while any other missing script fails with `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT` (measured on pnpm 12.6.0). So a package that has tests and lacks the script reports a green it never earned. `scripts/package-test-scripts.test.mjs` guards both directions: a package's first test file turns the suite red until the two scripts are added, and a copied `vitest run` does too. For agents, the hook also refuses `pnpm --filter <pkg> <script>` on a package without that script.

Don't use `pnpm -r test`. It starts one full Vitest per package, several at once under pnpm's workspace concurrency, each with its own worker pool, so it oversubscribes the CPU and is slower than the root run. Root `pnpm test` stays the command for the whole suite and for CI.

## Typing test doubles

Two rules for every test file, from the #1078 sweep that brought test files into the type gate. A `vi.fn(impl)` whose implementation takes no parameters types `mock.calls` as `[]` (a bare `vi.fn()` is `any[][]` and never trips this), so a double whose recorded calls are read gets the real signature of what it stands in for — `vi.fn<(mode: ReplayPosMode, frameNumber: number) => boolean>(() => true)` for a replay `setPlayPosition` — rather than a cast of `undefined as number` on the read. And no `@ts-ignore` in a test, which lint already refuses (`@typescript-eslint/ban-ts-comment`, in the recommended set the config spreads), nor an `@ts-expect-error` to make a call compile — lint demands a description on it, and its one honest use is asserting that something does NOT compile. `as any` is the repo's declared exception (`no-explicit-any` is off), and the hundreds already in these files are not this issue's; do not add one for a test's sake. What the gate found once it reached these files was stale fixtures and stale test-local types, which is exactly what it is there to catch.

## Action tests

Tests that mock `@iracedeck/deck-core` or `@iracedeck/settings` — every action test, and those in `deck-core`, `deck-iracing`, `plugin-runtime`, `race-engineer-wiring` and the plugin shells — follow `action-tests.md`: the canonical mock factories, one import path per name (#1351), `@internal` test exports, settings literals parsed through the action's schema and bracket access to protected members (#1078).
