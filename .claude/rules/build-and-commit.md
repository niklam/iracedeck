---
# Build & Commit Conventions

Build

- Install and build with pnpm: `pnpm install` then `pnpm build` (or package-specific build scripts).
- Useful shortcuts:

```bash
pnpm build:stream-deck
pnpm watch:stream-deck
```

Committing

- Use Conventional Commits. Scope should usually be the package name.
- Do not reference Claude or other AI tools in commit messages.
- Do not add AI co-authors such as `Co-Authored-By: Claude Opus`.
