# Flag Flash Duration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `flagFlashDurationMs` global setting (default 5000 ms, range 0-15000, step 500) that auto-stops the flag-overlay flash after the configured duration. `0` = flash forever (today's behaviour). New flag transitions restart the timer.

**Architecture:** The Zod schema gains one numeric field. `BaseAction` gains a sibling auto-stop `setTimeout` next to its existing flash interval. A new private `endFlagFlashVisual()` stops the visual without clearing the cached `lastFlagStateKey`, so the same flag continuing in telemetry doesn't immediately re-trigger the flash. A new `global-flag-flash.ejs` accordion partial is included by every per-action template that already includes `global-common-settings`.

**Tech Stack:** TypeScript, Zod, Vitest with fake timers, EJS, sdpi-components (`<sdpi-range>`).

**Spec:** `docs/superpowers/specs/2026-05-02-flag-flash-duration-design.md`.

---

## File Structure

| File | Responsibility | New/Modify |
|------|---------------|------------|
| `packages/deck-core/src/global-settings.ts` | Zod schema field for `flagFlashDurationMs`. | Modify |
| `packages/deck-core/src/global-settings.test.ts` | Schema cases (default, bounds, string coercion). | Modify |
| `packages/deck-core/src/base-action.ts` | Auto-stop timer field + `endFlagFlashVisual()` + modified `startFlagFlash`/`stopFlagFlash`. | Modify |
| `packages/deck-core/src/base-action.test.ts` | Five timer-behaviour tests with `vi.useFakeTimers()`. | New |
| `packages/pi-components/partials/global-flag-flash.ejs` | New "Flag Flash" accordion partial. | New |
| `packages/iracing-actions/src/actions/<each>/<each>.ejs` (×34) | Add `<%- include('global-flag-flash') %>` between `global-graphic-defaults` and `global-common-settings`. | Modify |
| `packages/website/src/content/docs/docs/features/flags-overlay.md` | Document the new setting. | Modify |

---

## Working directory

All work happens inside the existing worktree:

```text
C:/Users/nikla/Coding/iRaceDeck/ir-490
```

Branch: `490-flag-flash-duration`. The worktree was created off `master` (commit `1ee4c736`) and the spec is already committed (`a5c6267c`). All `git` commands below assume the working directory is `C:/Users/nikla/Coding/iRaceDeck/ir-490`.

---

## Build / verification commands

Workspace root commands (run from any directory inside the worktree):

```bash
pnpm --filter @iracedeck/deck-core test
pnpm --filter @iracedeck/deck-core test -- base-action.test.ts
pnpm --filter @iracedeck/deck-core test -- global-settings.test.ts
pnpm build
pnpm lint:fix
pnpm format:fix
```

**Build strategy:** Before running `pnpm build` manually, ask the user whether a watcher (`pnpm dev` or `rollup -w`) is already running — running `pnpm build` while a watcher is active interferes with the watcher's incremental state and the watcher already produces fresh output. If the watcher is running, skip the manual build and verify by checking watcher output instead. (See user feedback `feedback_ask_about_build.md`.)

---

## Task 1: Add `flagFlashDurationMs` to the global settings schema (TDD)

**Files:**
- Modify: `packages/deck-core/src/global-settings.ts:62-279` (`GlobalSettingsSchema` block)
- Test: `packages/deck-core/src/global-settings.test.ts` (append a new `describe` block)

- [ ] **Step 1.1: Write the failing schema tests**

Append this block to `packages/deck-core/src/global-settings.test.ts` (after the last existing `describe` block):

```typescript
describe("flagFlashDurationMs (issue #490)", () => {
  it("defaults to 5000 when not specified", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed.flagFlashDurationMs).toBe(5000);
  });

  it("accepts the lower bound (0 = flash forever)", () => {
    const parsed = GlobalSettingsSchema.parse({ flagFlashDurationMs: 0 }) as Record<string, unknown>;
    expect(parsed.flagFlashDurationMs).toBe(0);
  });

  it("accepts the upper bound (15000 ms)", () => {
    const parsed = GlobalSettingsSchema.parse({ flagFlashDurationMs: 15000 }) as Record<string, unknown>;
    expect(parsed.flagFlashDurationMs).toBe(15000);
  });

  it("coerces a numeric string from the Property Inspector slider", () => {
    const parsed = GlobalSettingsSchema.parse({ flagFlashDurationMs: "7500" }) as Record<string, unknown>;
    expect(parsed.flagFlashDurationMs).toBe(7500);
  });

  it("rejects values below 0", () => {
    expect(() => GlobalSettingsSchema.parse({ flagFlashDurationMs: -1 })).toThrow();
  });

  it("rejects values above 15000", () => {
    expect(() => GlobalSettingsSchema.parse({ flagFlashDurationMs: 15001 })).toThrow();
  });
});
```

- [ ] **Step 1.2: Run the new tests to verify they fail**

Run:

```bash
pnpm --filter @iracedeck/deck-core test -- global-settings.test.ts
```

Expected: the new `flagFlashDurationMs` tests fail (default test expects `5000` but field is missing → `undefined`; the bounds tests pass trivially because `passthrough()` accepts any value as-is rather than validating).

- [ ] **Step 1.3: Add the schema field**

In `packages/deck-core/src/global-settings.ts`, inside `GlobalSettingsSchema` (the `z.object({ ... })` block that ends at line 278 with `.passthrough()`), add the field after `calloutEnabledPitServiceRequests` (around line 277):

```typescript
    /**
     * Duration in milliseconds the flag overlay flashes after a new flag
     * transition (issue #490). The flash auto-stops after this duration even
     * while the underlying iRacing flag is still raised, so long full-course
     * yellows don't turn into sustained visual noise. A new flag transition
     * during or after the window starts a fresh timer.
     *
     * `0` disables the auto-stop and reverts to the original behaviour
     * (flash continuously while the flag is raised). Range 0–15000, default
     * 5000 (5 seconds). The blink rate (`FLAG_FLASH_INTERVAL_MS`) is a
     * separate concept and stays a constant.
     */
    flagFlashDurationMs: z.coerce.number().min(0).max(15000).default(5000),
```

- [ ] **Step 1.4: Run the schema tests again — they should pass**

Run:

```bash
pnpm --filter @iracedeck/deck-core test -- global-settings.test.ts
```

Expected: all `flagFlashDurationMs` cases pass; all pre-existing tests still pass.

- [ ] **Step 1.5: Commit**

```bash
git add packages/deck-core/src/global-settings.ts packages/deck-core/src/global-settings.test.ts
git commit -m "feat(deck-core): add flagFlashDurationMs global setting (#490)"
```

---

## Task 2: Refactor `BaseAction` flag flash with a duration auto-stop (TDD)

**Files:**
- Modify: `packages/deck-core/src/base-action.ts:80-95` (private fields), `:447-494` (`startFlagFlash`/`stopFlagFlash`)
- Test: `packages/deck-core/src/base-action.test.ts` (NEW)

This is the largest task. It is structured TDD-first: each behaviour gets a failing test, then the minimal change to pass.

### Step 2.1: Create the test scaffolding (no production code yet)

- [ ] **Create `packages/deck-core/src/base-action.test.ts` with this content:**

```typescript
/**
 * Tests for BaseAction flag-overlay duration auto-stop (issue #490).
 *
 * The harness mocks getController so the flag-overlay subscription
 * registers a callback the test can drive directly via fake timers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BaseAction } from "./base-action.js";
import type { IDeckActionContext, IDeckDidReceiveSettingsEvent, IDeckWillAppearEvent } from "./types.js";

type TelemetryCallback = (telemetry: { SessionFlags?: number } | undefined, isConnected: boolean) => void;

const { mockSubscribe, mockUnsubscribe, getCapturedCallback } = vi.hoisted(() => {
  let captured: TelemetryCallback | null = null;
  return {
    mockSubscribe: vi.fn((_id: string, cb: TelemetryCallback) => {
      captured = cb;
    }),
    mockUnsubscribe: vi.fn(() => {
      captured = null;
    }),
    getCapturedCallback: () => captured,
  };
});

const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn<() => Record<string, unknown>>(() => ({})),
}));

vi.mock("./sdk-singleton.js", () => ({
  getController: () => ({
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
  }),
}));

vi.mock("./global-settings.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getGlobalSettings: mockGetGlobalSettings,
    onGlobalSettingsChange: vi.fn(() => () => {}),
  };
});

// iRacing flag bitfield values used by resolveAllActiveFlags.
// Mirrors @iracedeck/iracing-native Flags enum (Yellow = 0x08, Blue = 0x20).
const FLAG_YELLOW = 0x08;
const FLAG_BLUE = 0x20;

class TestAction extends BaseAction {
  // Expose the protected `flagOverlayActive` set for assertions.
  getOverlayActive(): Set<string> {
    return (this as unknown as { flagOverlayActive: Set<string> }).flagOverlayActive;
  }

  // Expose protected setKeyImage so tests can register a context — the
  // overlay code skips contexts that aren't in `this.contexts`.
  registerKey(ev: IDeckWillAppearEvent<Record<string, unknown>>, svg: string): Promise<void> {
    return (this as unknown as { setKeyImage: (e: unknown, s: string) => Promise<void> }).setKeyImage(ev, svg);
  }
}

interface TestContext {
  action: TestAction;
  fakeAction: IDeckActionContext;
  setImageSpy: ReturnType<typeof vi.fn>;
  driveTelemetry: (sessionFlags: number | undefined) => void;
}

function createTestContext(): TestContext {
  const action = new TestAction();
  const setImageSpy = vi.fn().mockResolvedValue(undefined);
  const fakeAction: IDeckActionContext = {
    id: "ctx-1",
    isKey: () => true,
    setImage: setImageSpy,
    setTitle: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
  };

  const willAppear = {
    action: fakeAction,
    payload: { settings: {} },
  } as unknown as IDeckWillAppearEvent<Record<string, unknown>>;

  // Synchronous part of onWillAppear runs before the function's first await
  // (skipped here because plugin-config is not initialized in tests). Safe
  // to fire-and-forget.
  void action.onWillAppear(willAppear);

  // Register the context in `this.contexts` so applyFlagOverlayToContexts
  // can find it. Synchronous side effect (contexts.set) happens before the
  // awaited setImage call, so void-await is safe here too.
  void action.registerKey(willAppear, "<svg/>");

  // Opt the context into flag overlay + ensure telemetry subscription registers.
  const settingsEvent = {
    action: fakeAction,
    payload: { settings: { flagsOverlay: true } },
  } as unknown as IDeckDidReceiveSettingsEvent<Record<string, unknown>>;

  void action.onDidReceiveSettings(settingsEvent);

  return {
    action,
    fakeAction,
    setImageSpy,
    driveTelemetry: (sessionFlags) => {
      const cb = getCapturedCallback();
      if (!cb) throw new Error("Telemetry callback was never captured — subscription did not register");
      cb(sessionFlags === undefined ? undefined : { SessionFlags: sessionFlags }, sessionFlags !== undefined);
    },
  };
}

describe("BaseAction flag flash duration (issue #490)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetGlobalSettings.mockReturnValue({ flagFlashDurationMs: 5000 });
  });

  it("auto-stops the flash after flagFlashDurationMs", () => {
    const ctx = createTestContext();

    ctx.driveTelemetry(FLAG_YELLOW);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);

    vi.advanceTimersByTime(5000);

    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);
  });
});
```

- [ ] **Step 2.2: Run the scaffolding test to verify it fails for the right reason**

Run:

```bash
pnpm --filter @iracedeck/deck-core test -- base-action.test.ts
```

Expected: the test fails because `flagOverlayActive.has("ctx-1")` is still `true` after 5000 ms — there is no auto-stop yet.

- [ ] **Step 2.3: Add the auto-stop timer field**

In `packages/deck-core/src/base-action.ts`, after the existing `flagFlashTimer` field declaration (line 80), add:

```typescript
  /** Auto-stop timer that ends the flash visual after the configured duration */
  private flagFlashAutoStopTimer: ReturnType<typeof setTimeout> | null = null;
```

- [ ] **Step 2.4: Schedule the auto-stop in `startFlagFlash`**

In `startFlagFlash()` (currently at line 447), modify the body so it:

1. Clears any existing `flagFlashAutoStopTimer` alongside the existing `flagFlashTimer` clear.
2. After starting the blink interval, schedules `setTimeout(() => this.endFlagFlashVisual(), durationMs)` when `durationMs > 0`.

Replace the existing `startFlagFlash` method (the whole `private startFlagFlash(): void { ... }` block) with:

```typescript
  /**
   * Start or restart the flag flash timer.
   * Schedules an auto-stop after `flagFlashDurationMs` (issue #490).
   */
  private startFlagFlash(): void {
    // Clear existing timers to prevent leaks
    if (this.flagFlashTimer) {
      clearInterval(this.flagFlashTimer);
    }
    if (this.flagFlashAutoStopTimer) {
      clearTimeout(this.flagFlashAutoStopTimer);
      this.flagFlashAutoStopTimer = null;
    }

    this.logger.debug(
      `Starting flag flash: flags=[${this.currentFlags.map((f) => f.label).join(",")}], contexts=${this.flagOverlayContexts.size}`,
    );

    // Immediately show first flag
    this.applyFlagOverlayToContexts();

    this.flagFlashTimer = setInterval(() => {
      this.flagFlashTick++;

      if (this.flagFlashTick % 2 === 0) {
        // Even tick: show flag color
        this.applyFlagOverlayToContexts();
      } else {
        // Odd tick: restore original image
        this.restoreAllFlagOverlayImages();
      }
    }, BaseAction.FLAG_FLASH_INTERVAL_MS);

    // Auto-stop after configured duration. `0` keeps the flash running
    // indefinitely (issue #490 escape hatch — backwards-compat).
    const durationMs = getGlobalSettings().flagFlashDurationMs;
    if (durationMs > 0) {
      this.flagFlashAutoStopTimer = setTimeout(() => {
        this.flagFlashAutoStopTimer = null;
        this.endFlagFlashVisual();
      }, durationMs);
    }
  }
```

- [ ] **Step 2.5: Add the `endFlagFlashVisual` method**

Insert this method directly before the existing `stopFlagFlash` method (currently around line 476):

```typescript
  /**
   * Stop the visual flash without clearing the cached flag state.
   * Called by the duration auto-stop (issue #490): subsequent telemetry
   * ticks with the same flag set are short-circuited by `lastFlagStateKey`,
   * so the flash doesn't immediately retrigger.
   */
  private endFlagFlashVisual(): void {
    if (this.flagFlashTimer) {
      clearInterval(this.flagFlashTimer);
      this.flagFlashTimer = null;
    }

    for (const contextId of this.flagOverlayActive) {
      this.restoreFlagOverlayImage(contextId);
    }

    this.flagOverlayActive.clear();
    this.flagFlashTick = 0;

    // INTENTIONAL: lastFlagStateKey and currentFlags stay set so the same
    // flag still in telemetry doesn't retrigger the flash via
    // onFlagTelemetryUpdate's state-key short-circuit. stopFlagFlash() is
    // the only path that wipes that cache (called when flags actually clear).
    this.logger.debug("Flag flash auto-stopped after duration");
  }
```

- [ ] **Step 2.6: Update `stopFlagFlash` to delegate visual cleanup and clear the auto-stop timer**

Replace the existing `stopFlagFlash` method body so it calls `endFlagFlashVisual()` for the visual cleanup, then resets the cached state. Replace the whole `private stopFlagFlash(): void { ... }` block with:

```typescript
  /**
   * Stop the flag flash and reset cached state.
   * Called when flags clear (`flags.length === 0`) or the action
   * unsubscribes from telemetry — anywhere a fresh transition should
   * be allowed to retrigger the flash next.
   */
  private stopFlagFlash(): void {
    if (this.flagFlashAutoStopTimer) {
      clearTimeout(this.flagFlashAutoStopTimer);
      this.flagFlashAutoStopTimer = null;
    }

    this.endFlagFlashVisual();

    // Reset cached state so the next transition (including the same flag
    // re-appearing later) restarts the flash.
    this.lastFlagStateKey = "";
    this.currentFlags = [];
  }
```

- [ ] **Step 2.7: Run the auto-stop test — it should pass**

Run:

```bash
pnpm --filter @iracedeck/deck-core test -- base-action.test.ts
```

Expected: the "auto-stops the flash after flagFlashDurationMs" test passes.

- [ ] **Step 2.8: Add the "forever (0)" test**

Append to the `describe("BaseAction flag flash duration (issue #490)", ...)` block in `base-action.test.ts`:

```typescript
  it("does not auto-stop when flagFlashDurationMs is 0 (forever)", () => {
    mockGetGlobalSettings.mockReturnValue({ flagFlashDurationMs: 0 });

    const ctx = createTestContext();
    ctx.driveTelemetry(FLAG_YELLOW);

    // Advance well past the default duration; flash must still be active.
    vi.advanceTimersByTime(60_000);

    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);
  });
```

- [ ] **Step 2.9: Run — it should pass on the first try**

Run:

```bash
pnpm --filter @iracedeck/deck-core test -- base-action.test.ts
```

Expected: both tests pass. The implementation already gates the `setTimeout` on `durationMs > 0`.

- [ ] **Step 2.10: Add the "retrigger restarts the window" test**

Append:

```typescript
  it("restarts the auto-stop timer on a new flag transition", () => {
    const ctx = createTestContext();

    ctx.driveTelemetry(FLAG_YELLOW);
    vi.advanceTimersByTime(4000);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);

    // New transition (Yellow + Blue is a different state-key than Yellow alone).
    ctx.driveTelemetry(FLAG_YELLOW | FLAG_BLUE);

    // 4000 ms after the FIRST trigger, but only 0 ms into the SECOND window.
    vi.advanceTimersByTime(4000);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);

    // Another 1500 ms (5500 ms into the second window) — now past the limit.
    vi.advanceTimersByTime(1500);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);
  });
```

- [ ] **Step 2.11: Run — it should pass on the first try**

Run:

```bash
pnpm --filter @iracedeck/deck-core test -- base-action.test.ts
```

Expected: pass. `startFlagFlash` already clears the existing auto-stop timer before scheduling a new one.

- [ ] **Step 2.12: Add the "same-flag tick after auto-stop is a no-op" test**

This is the test that validates the `endFlagFlashVisual` design (state preservation):

```typescript
  it("does not retrigger when the same flag continues in telemetry after auto-stop", () => {
    const ctx = createTestContext();

    ctx.driveTelemetry(FLAG_YELLOW);
    vi.advanceTimersByTime(5000);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);

    const callsBeforeRetick = ctx.setImageSpy.mock.calls.length;

    // Same telemetry value comes in again — onFlagTelemetryUpdate should
    // short-circuit because lastFlagStateKey is still "YELLOW".
    ctx.driveTelemetry(FLAG_YELLOW);

    expect(ctx.setImageSpy.mock.calls.length).toBe(callsBeforeRetick);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);
  });
```

- [ ] **Step 2.13: Run — it should pass**

Run:

```bash
pnpm --filter @iracedeck/deck-core test -- base-action.test.ts
```

Expected: pass. `endFlagFlashVisual` deliberately keeps `lastFlagStateKey` set, so the next telemetry update with the same bitfield short-circuits in `onFlagTelemetryUpdate` (the `if (stateKey === this.lastFlagStateKey) return;` guard).

If this test fails, the most likely cause is that `endFlagFlashVisual` was inadvertently resetting `lastFlagStateKey` or `currentFlags` — fix by removing those resets from `endFlagFlashVisual` (they belong only in `stopFlagFlash`).

- [ ] **Step 2.14: Add the "clear-then-restart fully resets" test**

```typescript
  it("restarts the flash when the same flag returns after a clear", () => {
    const ctx = createTestContext();

    ctx.driveTelemetry(FLAG_YELLOW);
    vi.advanceTimersByTime(5000); // auto-stop fires

    ctx.driveTelemetry(0); // flags clear → stopFlagFlash() resets cache

    ctx.driveTelemetry(FLAG_YELLOW); // fresh transition — should retrigger
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);
  });
```

- [ ] **Step 2.15: Run — it should pass**

Run:

```bash
pnpm --filter @iracedeck/deck-core test -- base-action.test.ts
```

Expected: pass. The `flags.length === 0` branch of `onFlagTelemetryUpdate` calls `stopFlagFlash()`, which resets `lastFlagStateKey` to `""`, so the subsequent `FLAG_YELLOW` is recognised as a transition.

- [ ] **Step 2.16: Run the full deck-core suite to make sure nothing else regressed**

Run:

```bash
pnpm --filter @iracedeck/deck-core test
```

Expected: all tests pass (existing + 5 new BaseAction tests + 6 new schema tests).

- [ ] **Step 2.17: Commit**

```bash
git add packages/deck-core/src/base-action.ts packages/deck-core/src/base-action.test.ts
git commit -m "feat(deck-core): auto-stop flag flash after configured duration (#490)"
```

---

## Task 3: Create the `global-flag-flash` PI partial

**Files:**
- Create: `packages/pi-components/partials/global-flag-flash.ejs`

- [ ] **Step 3.1: Create the partial**

Create `packages/pi-components/partials/global-flag-flash.ejs` with this content:

```ejs
<!--
  Global Flag Flash Settings

  Plugin-wide flag-flash behaviour in a collapsible "Flag Flash" accordion.
  Settings are stored in global settings (shared across all action instances).
  Collapsed by default. See issue #490.
-->
<%- include('accordion', {
  title: 'Flag Flash',
  accordionId: 'Global Flag Flash',
  open: false,
  content: `
    <sdpi-item label="Duration (ms)">
      <sdpi-range setting="flagFlashDurationMs" default="5000" min="0" max="15000" step="500" global showlabels></sdpi-range>
    </sdpi-item>
    <div style="padding: 0 16px 8px; font-size: 11px; color: #999;">
      How long the flag overlay flashes after a new flag transition.
      Set to 0 to flash continuously while the flag is raised.
    </div>
  `
}) %>
```

- [ ] **Step 3.2: Verify EJS partial syntax matches the existing global accordions**

Read `packages/pi-components/partials/global-graphic-defaults.ejs` and confirm the structure matches (accordion call signature, content string format). Adjust if anything differs (e.g., quote style).

- [ ] **Step 3.3: Commit**

```bash
git add packages/pi-components/partials/global-flag-flash.ejs
git commit -m "feat(pi-components): add global-flag-flash accordion partial (#490)"
```

---

## Task 4: Include the new partial in every per-action template

**Files (modify, all 34):**
- `packages/iracing-actions/src/actions/ai-spotter-controls/ai-spotter-controls.ejs`
- `packages/iracing-actions/src/actions/audio-controls/audio-controls.ejs`
- `packages/iracing-actions/src/actions/black-box-selector/black-box-selector.ejs`
- `packages/iracing-actions/src/actions/camera-editor-adjustments/camera-editor-adjustments.ejs`
- `packages/iracing-actions/src/actions/camera-editor-controls/camera-editor-controls.ejs`
- `packages/iracing-actions/src/actions/camera-focus/camera-focus.ejs`
- `packages/iracing-actions/src/actions/car-control/car-control.ejs`
- `packages/iracing-actions/src/actions/chat/chat.ejs`
- `packages/iracing-actions/src/actions/cockpit-misc/cockpit-misc.ejs`
- `packages/iracing-actions/src/actions/force-feedback/force-feedback.ejs`
- `packages/iracing-actions/src/actions/fuel-service/fuel-service.ejs`
- `packages/iracing-actions/src/actions/look-direction/look-direction.ejs`
- `packages/iracing-actions/src/actions/media-capture/media-capture.ejs`
- `packages/iracing-actions/src/actions/pit-crew/pit-crew.ejs`
- `packages/iracing-actions/src/actions/pit-quick-actions/pit-quick-actions.ejs`
- `packages/iracing-actions/src/actions/race-admin/race-admin.ejs`
- `packages/iracing-actions/src/actions/replay-control/replay-control.ejs`
- `packages/iracing-actions/src/actions/replay-navigation/replay-navigation.ejs`
- `packages/iracing-actions/src/actions/replay-speed/replay-speed.ejs`
- `packages/iracing-actions/src/actions/replay-transport/replay-transport.ejs`
- `packages/iracing-actions/src/actions/session-info/session-info.ejs`
- `packages/iracing-actions/src/actions/setup-aero/setup-aero.ejs`
- `packages/iracing-actions/src/actions/setup-brakes/setup-brakes.ejs`
- `packages/iracing-actions/src/actions/setup-chassis/setup-chassis.ejs`
- `packages/iracing-actions/src/actions/setup-engine/setup-engine.ejs`
- `packages/iracing-actions/src/actions/setup-fuel/setup-fuel.ejs`
- `packages/iracing-actions/src/actions/setup-hybrid/setup-hybrid.ejs`
- `packages/iracing-actions/src/actions/setup-traction/setup-traction.ejs`
- `packages/iracing-actions/src/actions/splits-delta-cycle/splits-delta-cycle.ejs`
- `packages/iracing-actions/src/actions/telemetry-control/telemetry-control.ejs`
- `packages/iracing-actions/src/actions/telemetry-display/telemetry-display.ejs`
- `packages/iracing-actions/src/actions/tire-service/tire-service.ejs`
- `packages/iracing-actions/src/actions/toggle-ui-elements/toggle-ui-elements.ejs`
- `packages/iracing-actions/src/actions/view-adjustment/view-adjustment.ejs`

- [ ] **Step 4.1: Insert the include in each template**

For each file in the list above, add a single line `<%- include('global-flag-flash') %>` immediately after the existing `<%- include('global-graphic-defaults') %>` line and before `<%- include('global-common-settings') %>`.

The standard pattern after the change should look like (taken from `look-direction.ejs`, lines 31-35):

```ejs
		<%- include('global-title-defaults') %>
		<%- include('global-color-defaults') %>
		<%- include('global-border-defaults') %>
		<%- include('global-graphic-defaults') %>
		<%- include('global-flag-flash') %>
		<%- include('global-common-settings') %>
```

Match the existing indentation in each file (some use tabs, some may differ).

If any of the 34 files does **not** have a `global-graphic-defaults` line (unlikely but possible), insert the new include directly before `global-common-settings` instead. If a file has neither, do not modify it — flag the discrepancy and stop the task to ask the user.

- [ ] **Step 4.2: Verify the count of inclusions**

Run:

```bash
grep -rl "global-flag-flash" packages/iracing-actions/src/actions/ | wc -l
```

Expected output: `34`.

Also confirm that no per-action template double-includes the partial:

```bash
grep -c "global-flag-flash" packages/iracing-actions/src/actions/look-direction/look-direction.ejs
```

Expected output: `1`.

- [ ] **Step 4.3: Build the plugins to confirm the EJS templates compile**

Ask the user first whether a `pnpm dev` watcher is already running. If not, run:

```bash
pnpm build
```

Expected: build succeeds. Both Stream Deck and Mirabox plugin `ui/` outputs include the new "Flag Flash" accordion in every action's compiled HTML.

- [ ] **Step 4.4: Spot-check the compiled HTML**

```bash
grep -l "Flag Flash" packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/ui/*.html | wc -l
```

Expected output: `34` (one HTML per action template).

- [ ] **Step 4.5: Commit**

```bash
git add packages/iracing-actions/src/actions/
git commit -m "feat(actions): include global-flag-flash partial in every PI (#490)"
```

---

## Task 5: Update the website documentation

**Files:**
- Modify: `packages/website/src/content/docs/docs/features/flags-overlay.md`

- [ ] **Step 5.1: Append the new section to flags-overlay.md**

After the existing "How It Works" section (the last paragraph ends with "while the flag is flashing."), append:

```markdown

## Flash Duration

By default the flash plays for **5 seconds** after a new flag transition, then stops automatically — even if the flag is still raised. The intent is to give a clear "new event happened" beat without the sustained distraction of a flag flashing for the entire duration of a long full-course yellow.

A new flag transition during the window starts a fresh timer, so the driver always gets the announcement when something changes.

You can change the duration in the **Flag Flash** section under any action's Global Settings (the slider ranges from 0 to 15 000 ms in 500 ms steps). Setting it to **0** disables the auto-stop and reverts to the original behaviour: the flash continues for as long as the flag is raised.
```

- [ ] **Step 5.2: Commit**

```bash
git add packages/website/src/content/docs/docs/features/flags-overlay.md
git commit -m "docs(website): document flag flash duration setting (#490)"
```

---

## Task 6: Final verification

- [ ] **Step 6.1: Run lint and format**

Run:

```bash
pnpm lint:fix
pnpm format:fix
```

Expected: no errors. If anything was auto-fixed, commit:

```bash
git add -u
git commit -m "chore: apply lint/format fixes (#490)"
```

(Skip the commit if `git diff --quiet` reports no changes after the fixes.)

- [ ] **Step 6.2: Run the full test suite**

Run:

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 6.3: Run the full build (ask first about the watcher)**

Ask the user whether a watcher is running. If not, run:

```bash
pnpm build
```

Expected: build succeeds for every package.

- [ ] **Step 6.4: Verify the worktree branch is ready to push**

Run:

```bash
git log --oneline master..HEAD
```

Expected: 5–6 commits — spec doc, schema field, BaseAction refactor, PI partial, per-action template includes, website docs (and optional lint/format commit).

---

## Task 7: Open the pull request

This task involves an external action (creating a PR). **Do not run any of these commands without confirming with the user first.** (See user feedback `feedback_confirm_before_external_actions.md`.)

- [ ] **Step 7.1: Confirm with the user before pushing or opening the PR.**

- [ ] **Step 7.2: Push the branch**

```bash
git push -u origin 490-flag-flash-duration
```

- [ ] **Step 7.3: Open the PR using the repo template**

Read `.github/pull_request_template.md` first and use the same section structure (per `feedback_pr_template.md`). Title: `feat(deck-core): global setting for flag-flash duration (#490)` (conventional-commit prefix matches the issue label flow per `.claude/rules/build-and-commit.md`).

```bash
gh pr create --title "feat(deck-core): global setting for flag-flash duration (#490)" --body "$(cat <<'EOF'
<!-- Use the structure from .github/pull_request_template.md verbatim -->
EOF
)"
```

- [ ] **Step 7.4: Report the PR URL to the user.**

---

## Post-merge

After the PR merges, clean up the worktree per the user feedback `feedback_clean_before_worktree_remove.md`:

```bash
cd C:/Users/nikla/Coding/iRaceDeck/ir-490
git clean -fdx
cd C:/Users/nikla/Coding/iRaceDeck/dev
git worktree remove ../ir-490
git worktree list   # verify ir-490 is gone
```
