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
pnpm typecheck              # the type gate: tsc --noEmit per package (#987)
```

`pnpm test` does not typecheck: Vitest transforms through esbuild, which strips types without checking them. Neither did `pnpm build`, for the rollup-built packages — that gap is what #987 closed. `pnpm typecheck` is the explicit gate; its turbo task declares `dependsOn: ["^build"]` because packages resolve each other's types through emitted `dist/`, so it builds what it needs and needs no separate build step first.

**What it does not reach**, so nobody mistakes a green run for full coverage. `scripts/typecheck-script-coverage.test.mjs` discovers packages by "has TypeScript at all", **not** by having a `tsconfig.json` — keying it on the config was the shortcut that let three packages escape as absences rather than as exclusions. Every package is now in the gate, and one documented gap remains:

- **`iracing-actions` test files.** Its 160 sources are checked (#1078 gave the package a `tsconfig.json`, plus the `svg.d.ts` / `platform-features.d.ts` ambient declarations its program needs), but its tsconfig still sets `"exclude": ["src/**/*.test.ts"]`. Removing that exclusion surfaced **541 errors across 34 test files** when measured on 2026-09-01 — dominated by partial settings literals passed where the full parsed settings type is required (386 `TS2345`) and tests reaching `protected` members (70 `TS2445`). Tracked in #1078; the size is recorded in `TYPECHECK_EXCLUDES_TESTS` as a dated measurement, which nothing re-verifies.

Two things worth knowing about the gate's shape rather than its edges:

- **The website is checked by `astro check`, not `tsc`** (#1077). Plain `tsc` cannot check an Astro project. Its `typecheck` script therefore runs the same two generators its `build` does before checking, because `src/data/icon-gallery.json` is gitignored and is imported by `routeData.ts` and `IconGallery.astro` — without them the script passes locally and fails on every fresh clone.
- **For `deck-adapter-mirabox` and `deck-adapter-ulanzi`, `build` and `typecheck` share one config.** Both build with bare `tsc`, so the test exclusion #1078 removed had been keeping test files out of `dist/` as well as out of the gate; their `dist/` now contains compiled tests, matching the 13 other packages that already did.

These gaps predate #987 and it did not widen them; they are recorded here because a gate is only useful if its edges are known.

## Root `vitest.config.ts` — native config loader

`pnpm test` / `pnpm test:watch` pass `--configLoader native`, so Node imports the root `vitest.config.ts` directly and strips its types itself, rather than Vite bundling the config first (Vite 8 bundles it with rolldown, and emits ESM here because the root package is `"type": "module"`) (issue #1017). Vite has announced that loader as a future default; opting in early means a dependency bump can't flip it for us.

Consequences when editing that file — none of these apply to test files or package sources, only to the config itself:

- Use `import.meta.dirname` / `import.meta.filename`. `__dirname` / `__filename` are not declared in an ES module, so reading one throws a `ReferenceError` — they only ever worked because the bundling loader *defines* them, whatever module format it emits.
- Type-only imports MUST carry the `type` modifier (`import { defineConfig, type Plugin } from "vitest/config"`). Node cannot infer which named imports are types, so an unmarked one becomes a value import of a non-existent export and the config fails to load. Vite's own `configLoader: 'native'` compatibility warning does **not** detect this case — only `__dirname`/`__filename` and import shapes — so the suite failing to start is the only signal.
- No `enum`, `namespace`, decorators, or constructor parameter properties — Node's type stripping cannot handle them.

`eslint.config.js` enforces the first two mechanically for `vitest.config.ts` (`no-restricted-globals` plus `@typescript-eslint/consistent-type-imports`), and `pnpm lint` covers the file, so a re-break is caught before the suite is ever started.

To run a subset, pass the filter through the root script — `pnpm test <path>` — so it keeps the native loader; `pnpm exec vitest run <path>` silently falls back to the bundling loader. The per-package `test` scripts (`packages/*/package.json`) are dead weight: Vitest does find the root config from a package directory (it searches upward), but `root` stays at the package directory, so the root-relative `include` globs match nothing and the script exits 1.

## Testing Stream Deck Actions

Stream Deck actions require mocking `@iracedeck/deck-core`. For testable pure functions (icon generation, constants), export them with `@internal` JSDoc:

```typescript
/**
 * @internal Exported for testing
 */
export const GLOBAL_KEY_NAME = "settingKey";

/**
 * @internal Exported for testing
 */
export function generateIconSvg(): string {
  // ...
}
```

### Action Test Structure

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock deck-core before importing
vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
      };
      return schema;
    },
    parse: (data: Record<string, unknown>) => ({ ...data }),
    safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    updateConnectionState = vi.fn();
    setActiveBinding = vi.fn();
    tapBinding = vi.fn().mockResolvedValue(undefined);
    holdBinding = vi.fn().mockResolvedValue(undefined);
    releaseBinding = vi.fn().mockResolvedValue(undefined);
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
  },
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) =>
    b.modifiers?.length ? `${b.modifiers.join("+")}+${b.key}` : b.key),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: vi.fn(),
  resolveIconColors: vi.fn((_svg: string, _global: unknown, _overrides: unknown) => ({})),
  renderIconTemplate: vi.fn((_t: string, data: Record<string, string>) =>
    `<svg>${data.mainLabel || ""}${data.subLabel || ""}</svg>`),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

import { GLOBAL_KEY_NAME, generateIconSvg } from "./my-action.js";

describe("MyAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("should have correct global key", () => {
      expect(GLOBAL_KEY_NAME).toBe("settingKey");
    });
  });

  describe("generateIconSvg", () => {
    it("should generate valid SVG data URI", () => {
      const result = generateIconSvg();
      expect(result).toContain("data:image/svg+xml");
    });
  });
});
```

### Reference Implementation

See `packages/iracing-actions/src/actions/splits-delta-cycle/splits-delta-cycle.test.ts` for a complete example.
