---
# Testing Conventions

- All new code must include unit tests. Use Vitest with `describe`/`it`/`expect`.
- Test file naming: `foo.ts` → `foo.test.ts`.
- Keep tests focused and fast. Mock external dependencies where appropriate.
- Add CI-friendly commands to `package.json` scripts to run tests non-interactively.

Common commands

```bash
pnpm test
pnpm test:watch
```
