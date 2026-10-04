# Code Style & Conventions

- Use consistent formatting and linting. Run `pnpm lint:fix` and `pnpm format:fix` before committing.
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
- The only `build/` directories ESLint and Prettier ignore are node-gyp's output roots, `build/` and `packages/*/build/`, matching `.gitignore`. Never widen that to `**/build/**`: `packages/audio-assets/src/build/` and `packages/pi-components/src/build/` are source, and the bare pattern hid both from lint and format with nothing red (#1125). `scripts/lint-format-ignores.test.mjs` checks every tracked file under a `build/` directory against both tools.
- No raw control bytes in a text file — tab, LF and CR only. Write any other as an escape (`\x00`, `\u001f`). A literal NUL makes git classify the file as binary, so `git diff`, `gh pr diff` and CodeRabbit show no content and every change to it ships unreviewed (#1103). The PreToolUse hook refuses the byte in an Edit or Write, and `scripts/no-control-bytes.test.mjs` scans every tracked file that `.gitattributes` does not declare `binary` — the explicit attribute, never git's content sniffing. A new binary type gets its `binary` line there (by path for a one-off), never an exemption in the test.

Markdown

- All fenced code blocks must include a language identifier (e.g., `bash`, `typescript`, `json`, `text`, `markdown`). Use `text` for directory trees and plain output. Never use bare ` ``` ` fences.
