---
name: cross-platform-development
description: Use when working with native dependencies, handling platform differences, or when build/install/test issues arise on non-Windows platforms
---

# Cross-Platform Development

## Why the mock exists

`@iracedeck/iracing-native` wraps the iRacing SDK (Windows-only C++ N-API addon). Without the mock layer, `pnpm install`, `pnpm build`, and `pnpm test` all fail on macOS/Linux because:
- `node-gyp` can't compile the Windows-specific C++ code
- `keysender` (native keyboard module) is Windows-only
- Package `"os"` restrictions blocked installation entirely

## Architecture

### Platform detection in `iracing-native/src/index.ts`

```
platform() === "win32"?
  ├── Yes → try loading native .node addon
  │         ├── Success → use real addon
  │         └── Failure → fall back to IRacingNativeMock
  └── No  → use IRacingNativeMock (never attempts to load .node)
```

- `platform()` check is the primary guard
- `try/catch` around `require()` is the safety net
- No top-level await — synchronous module loading preserved
- `IRacingNative` class delegates to either `addon` or `IRacingNativeMock` transparently

### Native dependencies

- `keysender` is in `optionalDependencies` — silently fails to install on macOS
- A type shim at `stream-deck-shared/src/keysender.d.ts` provides TypeScript types when keysender isn't installed
- `node-gyp` is skipped on non-Windows via `iracing-native/scripts/build.mjs`

## When adding new native methods

You must update the mock alongside the native addon:

1. `addon.cc` — C++ implementation
2. `src/index.ts` — Add delegation in `IRacingNative` class (both `addon` and `getMock()` paths)
3. `src/mock-impl.ts` — Add mock implementation to `IRacingNativeMock`
4. Continue with the standard cross-package sync (keyboard-service, plugin.ts, tests, rules)

## Mock data

Located in `packages/iracing-native/src/mock-data/`:

| File | Content |
|------|---------|
| `session-info.ts` | YAML string — Spa practice, 3 drivers |
| `telemetry.ts` | Variable headers with computed offsets, `buildTelemetryBuffer()` |
| `snapshots.ts` | 3 rotating snapshots (mid-straight, braking, pit entry) |

Mock data is placeholder. To update with real telemetry, capture snapshots on Windows using the telemetry-snapshot CLI tool in `@iracedeck/iracing-sdk`.

## Build scripts

| Script | Behavior |
|--------|----------|
| `pnpm build` (root) | Cross-platform: `turbo run build` |
| `pnpm build:win` (root) | Windows: stops Stream Deck, builds, restarts Stream Deck |
| `iracing-native build` | Runs `node-gyp rebuild` on Windows, skips on other platforms; always runs `tsc` |

## Design doc

See `docs/plans/2026-03-01-cross-platform-native-mock-design.md` for the full design rationale.
