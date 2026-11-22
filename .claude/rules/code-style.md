# Code Style & Conventions

- Use consistent formatting and linting. Run `pnpm lint:fix` and `pnpm format:fix` before committing.
- What each gate covers: `lint` and `format` (each the same files as its `:fix`) reach every tracked `.ts`, `.mts`, `.mjs` and `.astro` file, `format` also `.json`; the husky pre-commit step `scripts/format-staged.mjs` fixes only the staged paths the commit records, never through lint-staged (#1402). Neither tool reads `.ejs`, Markdown (`.md` / `.mdx`) or the tracked `.js` files — never run Prettier on docs, which get rewritten whole. Per-extension detail and the tests that hold this together: `lint-and-format-internals.md`.
- Prefer explicit types and interfaces when they improve readability; use `type` for simple data shapes.
- Use `zod` (with `z.coerce` when appropriate) for action settings validation.
- Avoid side effects in constructors and public methods; prefer returning new state.
- Tests are required for all new code (see `testing.md`).
- Use clear, descriptive filenames and group related utilities under packages.
- Use exact dependency versions (no `^` or `~` prefixes). `pnpm-workspace.yaml` sets `saveExact: true` to enforce this for `pnpm add` — since pnpm 11 an `.npmrc` `save-exact` is not read.

TypeScript configuration

- `tsconfig.base.json` is the single source of compiler options. A package's own `tsconfig.json` carries only what is genuinely local to it — paths such as `outDir`, `rootDir` and `include`, its `lib`, and any option it deliberately sets **differently** from the base (the plugins' `declaration: false`, for example).
- Never repeat a base value verbatim in a package config. A duplicate silently stops the base governing that package, so editing the base later does nothing and nothing goes red — which is exactly how the repo-wide `TS2823` errors survived a fix aimed at the base (#988). `scripts/tsconfig-base-inheritance.test.mjs` enforces this; if it fails, delete the duplicated key rather than the assertion.

Formatting

- Project formatter/linter configuration is authoritative. Don’t reformat unrelated files in a single change.
- Never widen an ESLint or Prettier ignore to `**/build/**` or a bare `build/`: `packages/audio-assets/src/build/` and `packages/pi-components/src/build/` are source (#1125).
- No raw control bytes in a text file — tab, LF and CR only. Write any other as an escape (`\x00`, `\u001f`): a literal NUL makes git treat the file as binary, so every change to it ships unreviewed (#1103). A new binary type gets its `binary` line in `.gitattributes`, never a test exemption; the guards are in `lint-and-format-internals.md`.

Markdown

- All fenced code blocks must include a language identifier (e.g., `bash`, `typescript`, `json`, `text`, `markdown`). Use `text` for directory trees and plain output. Never use bare ` ``` ` fences.
