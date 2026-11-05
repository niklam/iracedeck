---
paths:
  - "packages/iracing-actions/**"
  - "packages/deck-iracing/src/**"
  - "packages/deck-core/src/**/*.test.ts"
  - "packages/plugin-runtime/src/**/*.test.ts"
  - "packages/race-engineer-wiring/src/**/*.test.ts"
  - "packages/iracing-plugin-*/src/**/*.test.ts"
---

# Action tests

How a test mocks `@iracedeck/deck-core`, `@iracedeck/settings` and `@iracedeck/deck-iracing`, and how it types what it hands an action — for whoever writes an action or a test that mocks those packages. The paths are every package whose tests do (95 test files in `iracing-actions`, 20 in `plugin-runtime`, 8 in `deck-core`, 2 each in `deck-iracing` and `race-engineer-wiring`, 1 in `iracing-plugin-stream-deck`, counted 2026-11-02). Moved out of `@.claude/rules/testing.md` in #1501 to keep the always-loaded set inside its budget; that rule keeps the conventions every test follows.

## Mocking deck-core and settings

Stream Deck actions require mocking `@iracedeck/deck-core`, and `@iracedeck/settings` for the global-settings names. For testable pure functions (icon generation, constants), export them with `@internal` JSDoc:

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

## Action Test Structure

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
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn() };
    updateConnectionState = vi.fn();
    isBindingMissing = vi.fn(() => false);
    setActiveBinding = vi.fn();
    tapBinding = vi.fn().mockResolvedValue(true);
    holdBinding = vi.fn().mockResolvedValue(undefined);
    releaseBinding = vi.fn().mockResolvedValue(undefined);
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
  },
  formatKeyBinding: vi.fn((b: { key: string; modifiers: string[] }) =>
    b.modifiers?.length ? `${b.modifiers.join("+")}+${b.key}` : b.key),
  getKeyboard: vi.fn(() => ({
    sendKeyCombination: vi.fn().mockResolvedValue(true),
  })),
  LogLevel: { Info: 2 },
  parseKeyBinding: vi.fn(),
  resolveIconColors: vi.fn((_svg: string, _global: unknown, _overrides: unknown) => ({})),
  assembleIcon: vi.fn(({ graphicSvg, title }: { graphicSvg: string; title?: { titleText: string } }) =>
    `data:image/svg+xml,${encodeURIComponent(`<svg>${graphicSvg}${title?.titleText ?? ""}</svg>`)}`),
  renderIconTemplate: vi.fn((_t: string, data: Record<string, string>) =>
    `<svg>${data.mainLabel || ""}${data.subLabel || ""}</svg>`),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

// The global-settings names are @iracedeck/settings', so they are mocked there
vi.mock("@iracedeck/settings", () => ({
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
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

The two factories follow deck-core's one-import-path-per-name rule (#1351): a name `@iracedeck/settings` exports — `getGlobalSettings`, `getGlobalColors`, `isCalloutEnabled`, `onGlobalSettingsChange`, `setWarning`, `isSimHubBinding` and the rest of `packages/settings/src/index.ts` — is mocked on `@iracedeck/settings`, with the same implementation and the same `vi.hoisted` handle it would have had on deck-core. An entry left in the deck-core factory no longer reaches the code under test, which imports the name from `@iracedeck/settings`, so the real function runs and the test can stay green while proving nothing. A mock of a package's barrel also cannot reach that package's internal imports: `@iracedeck/settings`' warning store calls its own `getGlobalSettings` by relative path, so mocking the barrel's `getGlobalSettings` does not change what `setWarning` reads. That is why `@iracedeck/settings-window`'s `settings-window-warning-reporter.test.ts` and `@iracedeck/voice-packs`' `voice-script-warning-reporter.test.ts` run over the real settings cache (`initGlobalSettings` over `createMemorySettingsStore`) rather than mocking it. Where a test spread `importOriginal()` on deck-core to keep real behaviour, the same spread now goes on the settings mock (`shared/adjust-styles.test.ts`, `shared/setup-view.test.ts`).

An action that extends `@iracedeck/deck-iracing`'s `SimIRacingAction` (#1351) keeps the same `ConnectionStateAwareAction` mock: `SimIRacingAction` extends the mocked class, and the mock's `sdkController` instance field shadows `SimIRacingAction`'s getter, so the test drives the controller as before. The iRacing names that live in `deck-iracing` rather than `deck-core` — `getCommands`, the fuel and unit helpers — are mocked on `@iracedeck/deck-iracing`, spreading `importOriginal` so the real `SimIRacingAction` still loads:

```typescript
const { mockGetCommands } = vi.hoisted(() => ({
  mockGetCommands: vi.fn(() => ({ pit: { fuel: vi.fn(() => true) } })),
}));

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getCommands: mockGetCommands,
  getFuelUnitSuffix: vi.fn((displayUnits: number | undefined) => (displayUnits === 1 ? "L" : "gal")),
}));
```

**A real implementation past a mocked barrel comes from the package's `./testing` entry, never from a relative path into its `src/` (#1375).** When a factory replaces a barrel but the behaviour under test is one of its helpers — the hold preview's timer, the release classifier, the 10/s throttle, a unit conversion, the store's marker functions — take the real one by package name inside the factory: `const real = await import("@iracedeck/deck-core/testing")` (`createHoldPreview`, `NOOP_HOLD_PREVIEW`, `classifyDialRelease`, `IconUpdateThrottle`); `@iracedeck/deck-iracing/testing` (`celsiusToFahrenheit`, `fuelToDisplayUnits`); `@iracedeck/replay-store/testing` (`addMarker`, `deleteNearestMarker`). Each entry re-exports by relative path inside its own package, so the mock never reaches it, and the root `vitest.config.ts` aliases it to source. A helper not on an entry yet is added to it; a package without one gets a `./testing` export, `src/testing.ts` and its alias (subpath before the bare package). Two root guards hold this: `scripts/cross-package-reach.test.mjs` fails any tracked package source whose relative path — an import, a fixture string, a `join(import.meta.dirname, …)` — lands in another package (deliberate reaches, such as the plugin factory's include globs, are named in its `ALLOWED` with the reason), and `scripts/testing-entries-test-only.test.mjs` fails any non-test source that imports a `./testing` entry, or imports a test-only module (`*.test-support.*`, `*.test-util.*`, `*.fixture-cases.*`, a `test-support/` file) by relative path, through which an entry could be laundered into a bundle.

## Settings literals and protected members (#1078)

Test files are typechecked with their package (`pnpm typecheck`), so a test has to type what it hands the code under test. Two rules cover what used to be the bulk of the errors there:

- **A partial settings literal parses through the action's own schema.** A function typed with the parsed settings (`generateXSvg(settings: XSettings)`) requires every defaulted key — `addedWithVersion`, and `dualPressEnabled` / `dial` on dial actions — so `generateXSvg({ mode: "x" })` does not type-check. Write `generateXSvg(XSettings.parse({ mode: "x" }))`, or use the action's exported `parseXSettings(...)` where one exists (the setup actions, Audio Controls, Fuel Service). The zod *input* type makes the defaulted keys optional, so the call type-checks. Be clear about what it does at runtime, because that depends on the file's mock of `CommonSettings.extend`: under the identity mock most action tests carry (`parse: (data) => ({ ...data })`) it is a typed assertion — the compiler now believes `addedWithVersion` and `dial` are present while the object is the bare literal — and under the real-zod form the setup tests use (`extend: (shape) => z.object(shape).passthrough()`) the action's own defaults are filled but the `CommonSettings` base keys still are not, since that mock drops the base. No mock in the package fills `addedWithVersion`. So pass every key the generator reads: a generator that grows a `settings.dial.x` read throws in the tests that did not, which is the loud failure you want, whereas one that reads `settings.dial?.x ?? fallback` would quietly test only its fallback. Where the schema is not exported yet, export the const **and** its type together, the const carrying `/** @internal Exported for testing */` — one without the other is TS2395. Never widen the production parameter to accept a partial for a test's sake, and never cast the literal; narrowing the parameter to the fields the generator actually reads is a different, legitimate change that #1078 left alone.
- **A protected member of the mocked base class is reached by bracket access, and a mock method through `vi.mocked`.** `action["sdkController"]` bypasses the `protected` check by design, and `vi.mocked(action["sdkController"].getCurrentTelemetry).mockReturnValue({ dcFuelMixture: 5 } as TelemetryData)` replaces the old `as any`. A file that sets telemetry repeatedly keeps one local `mockTelemetry(action, partial)` helper so that cast lives once. Assertions need nothing extra: `expect(action["setKeyImage"]).toHaveBeenCalled()`.

## Reference Implementation

See `packages/iracing-actions/src/actions/splits-delta-cycle/splits-delta-cycle.test.ts` for a complete example.
