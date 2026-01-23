---
# Code Style & Conventions

- Use consistent formatting and linting. Run `pnpm lint:fix` and `pnpm format:fix` before committing.
- Prefer explicit types and interfaces when they improve readability; use `type` for simple data shapes.
- Use `zod` (with `z.coerce` when appropriate) for action settings validation.
- Avoid side effects in constructors and public methods; prefer returning new state.
- Tests are required for all new code (see `testing.md`).
- Use clear, descriptive filenames and group related utilities under packages.

Formatting

- Project formatter/linter configuration is authoritative. Don’t reformat unrelated files in a single change.
