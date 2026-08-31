---
# Code Style & Conventions

- Use consistent formatting and linting. Run `pnpm lint:fix` and `pnpm format:fix` before committing.
- Prefer explicit types and interfaces when they improve readability; use `type` for simple data shapes.
- Use `zod` (with `z.coerce` when appropriate) for action settings validation.
- Avoid side effects in constructors and public methods; prefer returning new state.
- Tests are required for all new code (see `testing.md`).
- Use clear, descriptive filenames and group related utilities under packages.
- Use exact dependency versions (no `^` or `~` prefixes). The `.npmrc` has `save-exact=true` to enforce this for `pnpm add`.

TypeScript configuration

- `tsconfig.base.json` is the single source of compiler options. A package's own `tsconfig.json` carries only what is genuinely local to it — paths such as `outDir`, `rootDir` and `include`, its `lib`, and any option it deliberately sets **differently** from the base (the plugins' `declaration: false`, for example).
- Never repeat a base value verbatim in a package config. A duplicate silently stops the base governing that package, so editing the base later does nothing and nothing goes red — which is exactly how the repo-wide `TS2823` errors survived a fix aimed at the base (#988). `scripts/tsconfig-base-inheritance.test.mjs` enforces this; if it fails, delete the duplicated key rather than the assertion.

Formatting

- Project formatter/linter configuration is authoritative. Don’t reformat unrelated files in a single change.

Markdown

- All fenced code blocks must include a language identifier (e.g., `bash`, `typescript`, `json`, `text`, `markdown`). Use `text` for directory trees and plain output. Never use bare ` ``` ` fences.
