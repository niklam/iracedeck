# Mouse to Sim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Mouse to Sim" one-shot to the View Adjustment action that focuses the iRacing window and parks the OS mouse pointer inside it, so a VR driver never has to hunt for an invisible pointer across multiple monitors.

**Architecture:** A new Win32 primitive in `@iracedeck/iracing-native` moves the cursor into the sim's client area at caller-supplied fractional coordinates. A new `@iracedeck/deck-core` singleton (`window-service.ts`) wraps that primitive plus the existing focus primitive behind injected delegates, replacing three byte-identical per-plugin `window-focus.ts` modules. A small shared helper in `@iracedeck/iracing-actions` composes "focus, then move" once, and both the keypad mode and the dial gesture call it.

**Tech Stack:** TypeScript, C++/N-API (node-gyp), Zod, Vitest, EJS Property Inspector templates, pnpm + turbo monorepo.

**Spec:** `docs/superpowers/specs/2026-08-15-issue-926-mouse-to-sim-design.md`

## Global Constraints

- Worktree `C:/Users/Niklas/Projects/iRaceDeck/ir-926`, branch `feat/926-mouse-to-sim`, based on `origin/master` `3f7fabd2`. Target branch for the PR is `master` (version `2.5.0-dev.0`, milestone 2.5.0).
- **Shell cwd resets to the master checkout between calls** — always use absolute paths or `git -C`.
- Exact dependency versions only (no `^`/`~`). No new dependencies are added by this plan.
- The mode's settings value is `mouse-to-sim`; the user-facing label is exactly **`Mouse to Sim`**; the key title is exactly `MOUSE\nTO SIM`.
- Pointer target constants: `DEFAULT_POINTER_X_FRACTION = 0.5`, `DEFAULT_POINTER_Y_FRACTION = 0.125`.
- The PI mode-selector `<sdpi-item>` label MUST be exactly `Mode` (`.claude/rules/terminology-and-refs.md`).
- The new mode gets **no** comms-catalog descriptor in either the `view-adjustment` or `view-adjustment-dial` map (it issues no iRacing command).
- Existing dial gesture defaults must not change: `pressAction` stays `recenter-vr`; `longPressAction`, `tapAction`, `longTouchAction` stay `none`.
- Markdown code fences always carry a language identifier.
- Every native export must be mirrored across `addon.cc` → `src/index.ts` → `src/mock-impl.ts` → `packages/iracing-native/CLAUDE.md`.
- Native rebuilds fail with `EPERM` while a deck host app (UlanziStudio / Stream Deck) holds `iracing_native.node` — close them before any `pnpm build` that touches the addon.
- Verify builds with `set -o pipefail` when piping to `tail`, or the exit code is `tail`'s.

---

### Task 1: Native pointer primitive + TS mirror

**Files:**
- Modify: `packages/iracing-native/src/addon.cc` (window section ~line 570-660; `getElevationStatus` ~line 1051; `Init()` ~line 1130)
- Modify: `packages/iracing-native/src/index.ts` (`FocusResult` enum ~line 26; window management method ~line 224)
- Modify: `packages/iracing-native/src/mock-impl.ts` (~line 106)
- Modify: `packages/iracing-native/CLAUDE.md`
- Test: `packages/iracing-native/src/mock-impl.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `IRacingNative.moveMouseToIRacingWindow(xFraction: number, yFraction: number): number` and `export enum PointerMoveResult { Moved = 0, WindowNotFound = 1, Failed = 2 }` from `@iracedeck/iracing-native`.

- [ ] **Step 1: Write the failing mock test**

Append to `packages/iracing-native/src/mock-impl.test.ts` (match the file's existing `describe` structure):

```typescript
describe("moveMouseToIRacingWindow", () => {
  it("reports a successful move", () => {
    const mock = new IRacingNativeMock();
    expect(mock.moveMouseToIRacingWindow(0.5, 0.125)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && pnpm exec vitest run packages/iracing-native/src/mock-impl.test.ts`
Expected: FAIL — `mock.moveMouseToIRacingWindow is not a function`.

- [ ] **Step 3: Add the mock implementation**

In `packages/iracing-native/src/mock-impl.ts`, directly after `focusIRacingWindow()`:

```typescript
  moveMouseToIRacingWindow(xFraction: number, yFraction: number): number {
    console.debug(`[IRacingNativeMock] moveMouseToIRacingWindow(${xFraction}, ${yFraction})`);

    return 0; // Moved
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && pnpm exec vitest run packages/iracing-native/src/mock-impl.test.ts`
Expected: PASS.

- [ ] **Step 5: Extract the shared window lookup in `addon.cc`**

Replace the two open-coded `FindWindowA(NULL, "iRacing.com Simulator")` calls (in `focusIRacingWindow()` and `getElevationStatus()`) with a shared helper. Add this immediately above `focusIRacingWindow()`, in the `Window Management Functions` section:

```cpp
/** The iRacing simulator's main window title — the only handle we have on the process. */
static const char *kIRacingWindowTitle = "iRacing.com Simulator";

/**
 * Locate the iRacing simulator's main window.
 *
 * @returns the window handle, or NULL when iRacing is not running.
 */
static HWND findIRacingWindow()
{
    return FindWindowA(NULL, kIRacingWindowTitle);
}
```

Then in `focusIRacingWindow()` change `HWND hwnd = FindWindowA(NULL, "iRacing.com Simulator");` to `HWND hwnd = findIRacingWindow();`, and make the identical change in `getElevationStatus()`.

- [ ] **Step 6: Add the native pointer function**

In `addon.cc`, after the `FocusIRacingWindow` N-API wrapper and still inside the `Window Management Functions` section:

```cpp
/**
 * Pointer move result codes returned by moveMouseToIRacingWindow().
 *
 * 0 = Moved          — the cursor was placed inside the sim's client area
 * 1 = WindowNotFound — no window with the expected title exists
 * 2 = Failed         — the window was found but a Win32 call failed, or its
 *                      client area has no usable size (a minimized window)
 */
static const int POINTER_MOVED = 0;
static const int POINTER_WINDOW_NOT_FOUND = 1;
static const int POINTER_FAILED = 2;

/** Clamp a caller-supplied fraction into [0,1], mapping NaN to the fallback. */
static double clampFraction(double value, double fallback)
{
    if (value != value) // NaN
    {
        return fallback;
    }
    if (value < 0.0)
    {
        return 0.0;
    }
    if (value > 1.0)
    {
        return 1.0;
    }
    return value;
}

/**
 * Move the OS mouse pointer to a point inside the iRacing window's client area.
 *
 * The target is expressed as fractions of the client area so the caller owns the
 * placement policy (iRaceDeck parks the pointer horizontally centered, one eighth
 * down from the top) and the addon stays a plain OS primitive.
 *
 * @param xFraction - horizontal position, 0 = left edge, 1 = right edge
 * @param yFraction - vertical position, 0 = top edge, 1 = bottom edge
 * @returns int status code (see POINTER_* constants above)
 */
static int moveMouseToIRacingWindow(double xFraction, double yFraction)
{
    HWND hwnd = findIRacingWindow();
    if (!hwnd)
    {
        return POINTER_WINDOW_NOT_FOUND;
    }

    RECT client;
    if (!GetClientRect(hwnd, &client))
    {
        return POINTER_FAILED;
    }

    const LONG width = client.right - client.left;
    const LONG height = client.bottom - client.top;

    // A minimized window reports an empty client rect; there is nowhere to point.
    if (width <= 0 || height <= 0)
    {
        return POINTER_FAILED;
    }

    POINT target;
    target.x = client.left + (LONG)(width * clampFraction(xFraction, 0.5));
    target.y = client.top + (LONG)(height * clampFraction(yFraction, 0.125));

    // Client coordinates -> virtual-desktop coordinates, which is what
    // SetCursorPos consumes. This is what makes multi-monitor setups work.
    if (!ClientToScreen(hwnd, &target))
    {
        return POINTER_FAILED;
    }

    if (!SetCursorPos(target.x, target.y))
    {
        return POINTER_FAILED;
    }

    return POINTER_MOVED;
}

/**
 * N-API wrapper: move the mouse pointer into the iRacing window.
 *
 * Both arguments are read as doubles (never Uint32Value(), which would let a
 * negative value wrap) and default when absent or non-numeric.
 *
 * @returns number - status code (0=moved, 1=not found, 2=failed)
 */
Napi::Value MoveMouseToIRacingWindow(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    double xFraction = 0.5;
    double yFraction = 0.125;

    if (info.Length() > 0 && info[0].IsNumber())
    {
        xFraction = info[0].As<Napi::Number>().DoubleValue();
    }
    if (info.Length() > 1 && info[1].IsNumber())
    {
        yFraction = info[1].As<Napi::Number>().DoubleValue();
    }

    return Napi::Number::New(env, moveMouseToIRacingWindow(xFraction, yFraction));
}
```

Register it in `Init()` directly under the existing focus registration:

```cpp
    exports.Set("moveMouseToIRacingWindow", Napi::Function::New(env, MoveMouseToIRacingWindow));
```

- [ ] **Step 7: Mirror in the TypeScript wrapper**

In `packages/iracing-native/src/index.ts`, after the `FocusResult` enum:

```typescript
/**
 * Result codes from moveMouseToIRacingWindow().
 */
export enum PointerMoveResult {
  /** The cursor was placed inside the sim's client area */
  Moved = 0,
  /** No window with the expected title exists */
  WindowNotFound = 1,
  /** The window was found but the move failed (including a minimized window) */
  Failed = 2,
}
```

And in the `Window Management` section of the `IRacingNative` class, after `focusIRacingWindow()`:

```typescript
  /**
   * Move the OS mouse pointer into the iRacing window's client area.
   *
   * The target is given as fractions of the client area (0..1, clamped natively),
   * so placement policy stays in TypeScript.
   *
   * @param xFraction - horizontal position, 0 = left edge, 1 = right edge
   * @param yFraction - vertical position, 0 = top edge, 1 = bottom edge
   * @returns PointerMoveResult status code (0=moved, 1=not found, 2=failed)
   */
  moveMouseToIRacingWindow(xFraction: number, yFraction: number): number {
    return addon
      ? addon.moveMouseToIRacingWindow(xFraction, yFraction)
      : this.getMock().moveMouseToIRacingWindow(xFraction, yFraction);
  }
```

- [ ] **Step 8: Document the export**

In `packages/iracing-native/CLAUDE.md`, under `## Window Management Functions`, after the `focusIRacingWindow` entry, add a `### moveMouseToIRacingWindow(xFraction: number, yFraction: number): number` section covering: the client-rect → `ClientToScreen` → `SetCursorPos` sequence; the three result codes; the empty-client-rect (minimized) guard; native clamping of both fractions with a NaN fallback to 0.5 / 0.125; why the position is a parameter rather than a constant (policy belongs to the TS caller, matching `sendChatMessage` delays and `sendScanKeySequence`'s `holdMs`); and the note that it is **not** a keyboard function, so keyboard-service sync steps 3–5 do not apply (the `getElevationStatus` precedent). Also update the opening paragraph of the same section to mention that a shared `findIRacingWindow()` helper now backs focus, elevation, and pointer lookups.

- [ ] **Step 9: Build the native package and run its tests**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && pnpm --filter @iracedeck/iracing-native build && pnpm exec vitest run packages/iracing-native/src/mock-impl.test.ts`
Expected: node-gyp compiles cleanly (close UlanziStudio / Stream Deck first if it reports `EPERM`), then PASS.

- [ ] **Step 10: Commit**

```bash
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 add packages/iracing-native
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 commit -m "feat(native): add moveMouseToIRacingWindow and share the window lookup (#926)"
```

---

### Task 2: deck-core window service

**Files:**
- Create: `packages/deck-core/src/window-service.ts`
- Create: `packages/deck-core/src/window-service.test.ts`
- Modify: `packages/deck-core/src/index.ts` (after the clipboard export block, ~line 245)

**Interfaces:**
- Consumes: nothing from Task 1 at compile time — the delegates are injected, so deck-core never imports `@iracedeck/iracing-native`.
- Produces: `initializeWindowService`, `getWindowService`, `isWindowServiceInitialized`, `_resetWindowService`, `focusIRacingIfEnabled`, `IWindowService`, `WindowFocuser`, `SimPointerMover`, `WindowFocusResult`, `PointerMoveResult`, `DEFAULT_POINTER_X_FRACTION`, `DEFAULT_POINTER_Y_FRACTION` — all from `@iracedeck/deck-core`.

- [ ] **Step 1: Write the failing tests**

Create `packages/deck-core/src/window-service.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetWindowService,
  DEFAULT_POINTER_X_FRACTION,
  DEFAULT_POINTER_Y_FRACTION,
  focusIRacingIfEnabled,
  getWindowService,
  initializeWindowService,
  isWindowServiceInitialized,
  PointerMoveResult,
  WindowFocusResult,
} from "./window-service.js";

vi.mock("./global-settings.js", () => ({
  getGlobalSettings: vi.fn(() => ({ focusIRacingWindow: true })),
  isGlobalSettingsInitialized: vi.fn(() => true),
}));

const { getGlobalSettings, isGlobalSettingsInitialized } = await import("./global-settings.js");

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withLevel: vi.fn(),
  createScope: vi.fn(),
};

describe("Window Service", () => {
  beforeEach(() => {
    _resetWindowService();
    vi.clearAllMocks();
    vi.mocked(isGlobalSettingsInitialized).mockReturnValue(true);
    vi.mocked(getGlobalSettings).mockReturnValue({ focusIRacingWindow: true } as never);
  });

  describe("initialization", () => {
    it("starts uninitialized", () => {
      expect(isWindowServiceInitialized()).toBe(false);
    });

    it("throws if initialized twice", () => {
      initializeWindowService(mockLogger, {});
      expect(() => initializeWindowService(mockLogger, {})).toThrow(/already initialized/);
    });

    it("throws when getWindowService is called before init", () => {
      expect(() => getWindowService()).toThrow(/not initialized/);
    });

    it("focusIRacingIfEnabled is a silent no-op before init", () => {
      expect(() => focusIRacingIfEnabled()).not.toThrow();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe("focus", () => {
    it("returns the focuser's result code", () => {
      initializeWindowService(mockLogger, { focuser: () => WindowFocusResult.Focused });
      expect(getWindowService().focus()).toBe(WindowFocusResult.Focused);
    });

    it("warns when the window is not found", () => {
      initializeWindowService(mockLogger, { focuser: () => WindowFocusResult.WindowNotFound });
      expect(getWindowService().focus()).toBe(WindowFocusResult.WindowNotFound);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("not found"));
    });

    it("reports WindowNotFound and warns when no focuser is configured", () => {
      initializeWindowService(mockLogger, {});
      expect(getWindowService().focus()).toBe(WindowFocusResult.WindowNotFound);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("catches a throwing focuser", () => {
      initializeWindowService(mockLogger, {
        focuser: () => {
          throw new Error("boom");
        },
      });
      expect(getWindowService().focus()).toBe(WindowFocusResult.WindowNotFound);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    });
  });

  describe("focusIfEnabled", () => {
    it("focuses when the global setting is on", () => {
      const focuser = vi.fn(() => WindowFocusResult.Focused);
      initializeWindowService(mockLogger, { focuser });
      getWindowService().focusIfEnabled();
      expect(focuser).toHaveBeenCalledTimes(1);
    });

    it("does nothing when the global setting is off", () => {
      vi.mocked(getGlobalSettings).mockReturnValue({ focusIRacingWindow: false } as never);
      const focuser = vi.fn(() => WindowFocusResult.Focused);
      initializeWindowService(mockLogger, { focuser });
      getWindowService().focusIfEnabled();
      expect(focuser).not.toHaveBeenCalled();
    });

    it("does nothing when global settings are not initialized", () => {
      vi.mocked(isGlobalSettingsInitialized).mockReturnValue(false);
      const focuser = vi.fn(() => WindowFocusResult.Focused);
      initializeWindowService(mockLogger, { focuser });
      getWindowService().focusIfEnabled();
      expect(focuser).not.toHaveBeenCalled();
    });
  });

  describe("movePointerToSim", () => {
    it("uses the default fractions when none are given", () => {
      const pointerMover = vi.fn(() => PointerMoveResult.Moved);
      initializeWindowService(mockLogger, { pointerMover });
      expect(getWindowService().movePointerToSim()).toBe(PointerMoveResult.Moved);
      expect(pointerMover).toHaveBeenCalledWith(DEFAULT_POINTER_X_FRACTION, DEFAULT_POINTER_Y_FRACTION);
    });

    it("passes explicit fractions through verbatim", () => {
      const pointerMover = vi.fn(() => PointerMoveResult.Moved);
      initializeWindowService(mockLogger, { pointerMover });
      getWindowService().movePointerToSim(0.25, 0.75);
      expect(pointerMover).toHaveBeenCalledWith(0.25, 0.75);
    });

    it("warns when the window is not found", () => {
      initializeWindowService(mockLogger, { pointerMover: () => PointerMoveResult.WindowNotFound });
      expect(getWindowService().movePointerToSim()).toBe(PointerMoveResult.WindowNotFound);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("not found"));
    });

    it("warns when the move fails", () => {
      initializeWindowService(mockLogger, { pointerMover: () => PointerMoveResult.Failed });
      expect(getWindowService().movePointerToSim()).toBe(PointerMoveResult.Failed);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it("catches a throwing pointer mover", () => {
      initializeWindowService(mockLogger, {
        pointerMover: () => {
          throw new Error("boom");
        },
      });
      expect(getWindowService().movePointerToSim()).toBe(PointerMoveResult.Failed);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    });

    it("reports Failed and warns when no mover is configured", () => {
      initializeWindowService(mockLogger, {});
      expect(getWindowService().movePointerToSim()).toBe(PointerMoveResult.Failed);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe("result code contract", () => {
    it("matches the native FocusResult numbering", () => {
      expect(WindowFocusResult.AlreadyFocused).toBe(0);
      expect(WindowFocusResult.Focused).toBe(1);
      expect(WindowFocusResult.WindowNotFound).toBe(2);
      expect(WindowFocusResult.FocusTimedOut).toBe(3);
    });

    it("matches the native PointerMoveResult numbering", () => {
      expect(PointerMoveResult.Moved).toBe(0);
      expect(PointerMoveResult.WindowNotFound).toBe(1);
      expect(PointerMoveResult.Failed).toBe(2);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && pnpm exec vitest run packages/deck-core/src/window-service.test.ts`
Expected: FAIL — cannot resolve `./window-service.js`.

- [ ] **Step 3: Implement the service**

Create `packages/deck-core/src/window-service.ts`:

```typescript
/**
 * Window Service Singleton
 *
 * Owns every OS-level interaction with the iRacing window: bringing it to the
 * foreground and placing the mouse pointer inside it. The platform calls are
 * supplied at init time by the plugin entry point (typically the
 * `@iracedeck/iracing-native` implementations), keeping deck-core
 * platform-agnostic.
 *
 * Replaces the three byte-identical per-plugin `shared/window-focus.ts` modules
 * (issue #926): the pointer feature is reachable from action code, which those
 * modules were not.
 *
 * Usage:
 * 1. Call initializeWindowService() once at plugin startup
 * 2. Register focusIRacingIfEnabled() on the adapter's key/dial events
 * 3. Use getWindowService() in action code for explicit window/pointer control
 *
 * @example
 * // In plugin.ts (entry point)
 * const native = new IRacingNative();
 * initializeWindowService(logger, {
 *   focuser: () => native.focusIRacingWindow(),
 *   pointerMover: (x, y) => native.moveMouseToIRacingWindow(x, y),
 * });
 * adapter.onKeyDown(() => focusIRacingIfEnabled());
 */
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

import { getGlobalSettings, isGlobalSettingsInitialized } from "./global-settings.js";

/**
 * Result codes returned by the window focuser.
 *
 * Declared here rather than imported from `@iracedeck/iracing-native` so
 * deck-core stays platform-agnostic — the same reason `ScanKeySender` and
 * friends are declared locally. The numbering is the cross-package contract and
 * is asserted by tests on both sides.
 */
export enum WindowFocusResult {
  /** Window was already in the foreground */
  AlreadyFocused = 0,
  /** Window was found and successfully focused */
  Focused = 1,
  /** No window with the expected title exists */
  WindowNotFound = 2,
  /** Window was found but focus did not transfer within the native timeout */
  FocusTimedOut = 3,
}

/** Result codes returned by the pointer mover. See {@link WindowFocusResult} on the numbering contract. */
export enum PointerMoveResult {
  /** The cursor was placed inside the sim's client area */
  Moved = 0,
  /** No window with the expected title exists */
  WindowNotFound = 1,
  /** The window was found but the move failed (including a minimized window) */
  Failed = 2,
}

/** Brings the iRacing window to the foreground. Returns a {@link WindowFocusResult} code. */
export type WindowFocuser = () => number;

/**
 * Moves the OS mouse pointer into the iRacing window's client area.
 * Both arguments are fractions of the client area (0 = left/top, 1 = right/bottom).
 * Returns a {@link PointerMoveResult} code.
 */
export type SimPointerMover = (xFraction: number, yFraction: number) => number;

/** Horizontally centered in the sim's client area. */
export const DEFAULT_POINTER_X_FRACTION = 0.5;

/**
 * One eighth down from the top of the client area. This lands on iRacing's own
 * top-of-screen UI band rather than the middle of the track view, so the pointer
 * arrives where there is something to click.
 */
export const DEFAULT_POINTER_Y_FRACTION = 0.125;

/** Platform calls injected by the plugin entry point. */
export interface WindowServiceDelegates {
  focuser?: WindowFocuser;
  pointerMover?: SimPointerMover;
}

/**
 * Interface for the window service.
 */
export interface IWindowService {
  /**
   * Bring the iRacing window to the foreground, regardless of the
   * `focusIRacingWindow` global setting. For explicit user intent.
   */
  focus(): WindowFocusResult;

  /**
   * Bring the iRacing window to the foreground only when the
   * `focusIRacingWindow` global setting is enabled. For the plugin-level
   * before-every-action listeners.
   */
  focusIfEnabled(): void;

  /**
   * Move the OS mouse pointer into the iRacing window's client area.
   *
   * @param xFraction - horizontal position, defaults to {@link DEFAULT_POINTER_X_FRACTION}
   * @param yFraction - vertical position, defaults to {@link DEFAULT_POINTER_Y_FRACTION}
   */
  movePointerToSim(xFraction?: number, yFraction?: number): PointerMoveResult;
}

class WindowService implements IWindowService {
  constructor(
    private readonly logger: ILogger,
    private readonly delegates: WindowServiceDelegates,
  ) {}

  focus(): WindowFocusResult {
    const focuser = this.delegates.focuser;

    if (!focuser) {
      this.logger.warn("Window service has no focuser configured");

      return WindowFocusResult.WindowNotFound;
    }

    let result: number;

    try {
      result = focuser();
    } catch (error) {
      this.logger.warn(`Failed to focus iRacing window: ${error instanceof Error ? error.message : error}`);

      return WindowFocusResult.WindowNotFound;
    }

    this.logFocusResult(result);

    return result as WindowFocusResult;
  }

  focusIfEnabled(): void {
    if (!isGlobalSettingsInitialized()) return;

    if (!getGlobalSettings().focusIRacingWindow) return;

    this.focus();
  }

  movePointerToSim(
    xFraction: number = DEFAULT_POINTER_X_FRACTION,
    yFraction: number = DEFAULT_POINTER_Y_FRACTION,
  ): PointerMoveResult {
    const pointerMover = this.delegates.pointerMover;

    if (!pointerMover) {
      this.logger.warn("Window service has no pointer mover configured");

      return PointerMoveResult.Failed;
    }

    let result: number;

    try {
      result = pointerMover(xFraction, yFraction);
    } catch (error) {
      this.logger.warn(`Failed to move pointer to iRacing window: ${error instanceof Error ? error.message : error}`);

      return PointerMoveResult.Failed;
    }

    this.logPointerResult(result);

    return result as PointerMoveResult;
  }

  private logFocusResult(result: number): void {
    switch (result) {
      case WindowFocusResult.AlreadyFocused:
        this.logger.debug("iRacing window already focused");
        break;
      case WindowFocusResult.Focused:
        this.logger.debug("iRacing window focused successfully");
        break;
      case WindowFocusResult.WindowNotFound:
        this.logger.warn("iRacing window not found — is iRacing running?");
        break;
      case WindowFocusResult.FocusTimedOut:
        this.logger.warn("iRacing window found but focus timed out (1000ms)");
        break;
      default:
        this.logger.warn(`Unexpected focus result: ${result}`);
        break;
    }
  }

  private logPointerResult(result: number): void {
    switch (result) {
      case PointerMoveResult.Moved:
        this.logger.debug("Mouse pointer moved into the iRacing window");
        break;
      case PointerMoveResult.WindowNotFound:
        this.logger.warn("iRacing window not found — is iRacing running?");
        break;
      case PointerMoveResult.Failed:
        this.logger.warn("iRacing window found but the pointer could not be moved (is it minimized?)");
        break;
      default:
        this.logger.warn(`Unexpected pointer move result: ${result}`);
        break;
    }
  }
}

let windowService: WindowService | null = null;

/**
 * Initialize the window service singleton.
 * Should be called once at plugin startup.
 *
 * @param logger - Optional logger for window service logging
 * @param delegates - Optional platform calls. A missing delegate degrades that
 *   operation to a logged no-op rather than throwing.
 * @returns The initialized window service
 * @throws Error if called more than once
 */
export function initializeWindowService(
  logger: ILogger = silentLogger,
  delegates: WindowServiceDelegates = {},
): IWindowService {
  if (windowService) {
    throw new Error("Window service already initialized. initializeWindowService() should only be called once.");
  }

  windowService = new WindowService(logger, delegates);

  return windowService;
}

/**
 * Get the window service.
 *
 * @returns The window service instance
 * @throws Error if the window service hasn't been initialized
 */
export function getWindowService(): IWindowService {
  if (!windowService) {
    throw new Error(
      "Window service not initialized. Call initializeWindowService() first in your plugin entry point.",
    );
  }

  return windowService;
}

/**
 * Check if the window service has been initialized.
 */
export function isWindowServiceInitialized(): boolean {
  return windowService !== null;
}

/**
 * Focus the iRacing window if the `focusIRacingWindow` global setting is enabled.
 *
 * A free function rather than a bare `getWindowService()` call because the
 * plugin-level onKeyDown/onDialDown/onDialRotate listeners run before every
 * action and must never throw: this is a silent no-op when the service has not
 * been initialized.
 */
export function focusIRacingIfEnabled(): void {
  windowService?.focusIfEnabled();
}

/**
 * Reset the window service singleton (for testing purposes only).
 * @internal
 */
export function _resetWindowService(): void {
  windowService = null;
}
```

- [ ] **Step 4: Export from the deck-core barrel**

In `packages/deck-core/src/index.ts`, immediately after the clipboard export block:

```typescript
// Window service singleton (focus + pointer placement, issue #926)
export {
  initializeWindowService,
  getWindowService,
  isWindowServiceInitialized,
  focusIRacingIfEnabled,
  _resetWindowService,
  WindowFocusResult,
  PointerMoveResult,
  DEFAULT_POINTER_X_FRACTION,
  DEFAULT_POINTER_Y_FRACTION,
  type IWindowService,
  type WindowServiceDelegates,
  type WindowFocuser,
  type SimPointerMover,
} from "./window-service.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && pnpm exec vitest run packages/deck-core/src/window-service.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 add packages/deck-core
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 commit -m "feat(deck-core): add the window service for focus and pointer placement (#926)"
```

---

### Task 3: Migrate all three plugins onto the service

**Files:**
- Delete: `packages/iracing-plugin-stream-deck/src/shared/window-focus.ts`
- Delete: `packages/iracing-plugin-mirabox/src/shared/window-focus.ts`
- Delete: `packages/iracing-plugin-ulanzi/src/shared/window-focus.ts`
- Modify: `packages/iracing-plugin-stream-deck/src/shared/index.ts` (last line — the window-focus re-export)
- Modify: `packages/iracing-plugin-stream-deck/src/plugin.ts:202,946`
- Modify: `packages/iracing-plugin-mirabox/src/plugin.ts:207,904`
- Modify: `packages/iracing-plugin-ulanzi/src/plugin.ts:209,907`
- Modify: `.claude/rules/plugin-structure.md`
- Modify: `.claude/rules/keyboard-shortcuts.md`
- Modify: `.claude/CLAUDE.md` (deck-core package blurb)

**Interfaces:**
- Consumes: `initializeWindowService` / `focusIRacingIfEnabled` from Task 2; `native.focusIRacingWindow()` and `native.moveMouseToIRacingWindow()` from Task 1.
- Produces: a running plugin in which `getWindowService()` is available to action code.

- [ ] **Step 1: Delete the three duplicated modules**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-926
git rm packages/iracing-plugin-stream-deck/src/shared/window-focus.ts
git rm packages/iracing-plugin-mirabox/src/shared/window-focus.ts
git rm packages/iracing-plugin-ulanzi/src/shared/window-focus.ts
```

- [ ] **Step 2: Repoint the Stream Deck shared barrel**

In `packages/iracing-plugin-stream-deck/src/shared/index.ts`, replace the final block:

```typescript
// Window focus service (depends on @iracedeck/iracing-native)
export { initWindowFocus, focusIRacingIfEnabled } from "./window-focus.js";
```

with a re-export from deck-core (add these names to the existing `from "@iracedeck/deck-core"` export block instead of creating a second one, keeping the file's single-block shape):

```typescript
  // Window service (focus + pointer placement, #926)
  initializeWindowService,
  getWindowService,
  isWindowServiceInitialized,
  focusIRacingIfEnabled,
```

- [ ] **Step 3: Update all three plugin.ts files**

In `packages/iracing-plugin-stream-deck/src/plugin.ts`, delete line 202 (`import { focusIRacingIfEnabled, initWindowFocus } from "./shared/index.js";`) and add `initializeWindowService` plus `focusIRacingIfEnabled` to the existing `@iracedeck/deck-core` import block (alphabetical position, next to `initializeSimHub`). Replace line 946:

```typescript
// Initialize the window service (focus + pointer placement, #926)
initializeWindowService(adapter.createLogger("WindowService"), {
  focuser: () => native.focusIRacingWindow(),
  pointerMover: (x, y) => native.moveMouseToIRacingWindow(x, y),
});
```

Make the identical change in `packages/iracing-plugin-mirabox/src/plugin.ts` (import at line 207, init at line 904) and `packages/iracing-plugin-ulanzi/src/plugin.ts` (import at line 209, init at line 907). The three `adapter.onKeyDown/onDialDown/onDialRotate(() => focusIRacingIfEnabled())` registrations below each init call stay exactly as they are.

- [ ] **Step 4: Verify no references to the deleted module remain**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && grep -rn "initWindowFocus\|window-focus" packages/ .claude/ docs/ --include=*.ts --include=*.md | grep -v node_modules`
Expected: only the rule-file hits that Step 5 fixes; no `.ts` hits at all.

- [ ] **Step 5: Update the rules that describe the old shape**

- `.claude/rules/plugin-structure.md` — in the `plugin.ts` init-order snippet, replace the `initWindowFocus(...)` step with the `initializeWindowService(...)` call above, import it from `@iracedeck/deck-core`, and remove the bullet claiming `initWindowFocus` / `focusIRacingIfEnabled` come from the plugin's own `src/shared/window-focus.ts`. Add a bullet: the window service must be initialized before `adapter.connect()` and before any action that calls `getWindowService()`.
- `.claude/rules/keyboard-shortcuts.md` — in *Plugin Setup for Keyboard Support*, step 1 currently says `initWindowFocus` and `focusIRacingIfEnabled` are **per-plugin** modules that do NOT live in deck-core. Rewrite it to say both now come from `@iracedeck/deck-core` via `initializeWindowService`, and update the code sample.
- `.claude/CLAUDE.md` — extend the `@iracedeck/deck-core` package blurb to mention the window service (focus + pointer placement) alongside the keyboard service.

- [ ] **Step 6: Build all three plugins**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && set -o pipefail && pnpm build 2>&1 | tail -25`
Expected: exit 0, all packages built. (Close UlanziStudio / Stream Deck first — a running host locks the native `.node`.)

- [ ] **Step 7: Commit**

```bash
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 add -A
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 commit -m "refactor(plugins): replace the per-plugin window-focus modules with the deck-core window service (#926)"
```

---

### Task 4: The shared feature helper

**Files:**
- Create: `packages/iracing-actions/src/shared/mouse-to-sim.ts`
- Create: `packages/iracing-actions/src/shared/mouse-to-sim.test.ts`

**Interfaces:**
- Consumes: `getWindowService`, `WindowFocusResult`, `PointerMoveResult` from `@iracedeck/deck-core` (Task 2).
- Produces: `bringPointerToSim(logger: ILogger): void` from `../../shared/mouse-to-sim.js` — called by both the keypad action (Task 5) and the dial surface (Task 6).

- [ ] **Step 1: Write the failing tests**

Create `packages/iracing-actions/src/shared/mouse-to-sim.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const focus = vi.fn();
const movePointerToSim = vi.fn();

vi.mock("@iracedeck/deck-core", () => ({
  getWindowService: () => ({ focus, movePointerToSim }),
  WindowFocusResult: { AlreadyFocused: 0, Focused: 1, WindowNotFound: 2, FocusTimedOut: 3 },
  PointerMoveResult: { Moved: 0, WindowNotFound: 1, Failed: 2 },
}));

const { bringPointerToSim } = await import("./mouse-to-sim.js");

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  withLevel: vi.fn(),
  createScope: vi.fn(),
};

describe("bringPointerToSim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    focus.mockReturnValue(1); // Focused
    movePointerToSim.mockReturnValue(0); // Moved
  });

  it("focuses the window before moving the pointer", () => {
    const order: string[] = [];
    focus.mockImplementation(() => {
      order.push("focus");

      return 1;
    });
    movePointerToSim.mockImplementation(() => {
      order.push("move");

      return 0;
    });

    bringPointerToSim(logger);

    expect(order).toEqual(["focus", "move"]);
  });

  it("moves the pointer with the service defaults", () => {
    bringPointerToSim(logger);
    expect(movePointerToSim).toHaveBeenCalledWith();
  });

  it("skips the pointer move when the window is not found", () => {
    focus.mockReturnValue(2); // WindowNotFound

    bringPointerToSim(logger);

    expect(movePointerToSim).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("still moves the pointer when focus times out", () => {
    focus.mockReturnValue(3); // FocusTimedOut

    bringPointerToSim(logger);

    expect(movePointerToSim).toHaveBeenCalledTimes(1);
  });

  it("logs success at info", () => {
    bringPointerToSim(logger);
    expect(logger.info).toHaveBeenCalled();
  });

  it("never throws when the service throws", () => {
    focus.mockImplementation(() => {
      throw new Error("boom");
    });

    expect(() => bringPointerToSim(logger)).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && pnpm exec vitest run packages/iracing-actions/src/shared/mouse-to-sim.test.ts`
Expected: FAIL — cannot resolve `./mouse-to-sim.js`.

- [ ] **Step 3: Implement the helper**

Create `packages/iracing-actions/src/shared/mouse-to-sim.ts`:

```typescript
/**
 * Mouse to Sim (issue #926) — the single definition of the "bring the pointer
 * into iRacing" behavior, shared by the View Adjustment keypad mode and its dial
 * gesture so neither surface reimplements the policy.
 *
 * The composition order (focus first, then move) and the decision to focus
 * unconditionally are FEATURE policy, which is why they live here rather than in
 * deck-core's window service: pressing this key is explicit user intent, so it
 * deliberately ignores the `focusIRacingWindow` global setting that gates the
 * plugin-level before-every-action focus.
 *
 * Best-effort throughout: every failure is logged and swallowed. Moving a pointer
 * has no side effect on the car, so a no-op is always safe.
 *
 * Note: the focus call blocks the JS main thread for up to 1000 ms while Windows
 * confirms the foreground change. This is not new — the plugin-level
 * `focusIRacingIfEnabled()` already does exactly this on every key press when the
 * global setting is on.
 */
import { getWindowService, PointerMoveResult, WindowFocusResult } from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";

/**
 * Focus the iRacing window and park the mouse pointer inside it.
 *
 * @param logger - Logger for the outcome lines
 */
export function bringPointerToSim(logger: ILogger): void {
  try {
    const windowService = getWindowService();
    const focusResult = windowService.focus();

    // Nothing to point at — the service already warned about the missing window,
    // and a second warning for the same cause would just be noise.
    if (focusResult === WindowFocusResult.WindowNotFound) {
      return;
    }

    const moveResult = windowService.movePointerToSim();

    if (moveResult === PointerMoveResult.Moved) {
      logger.info("Mouse pointer brought to the iRacing window");
    }
  } catch (error) {
    logger.warn(`Failed to bring the mouse pointer to the sim: ${error instanceof Error ? error.message : error}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && pnpm exec vitest run packages/iracing-actions/src/shared/mouse-to-sim.test.ts`
Expected: PASS. If the "skips the pointer move" case reports `logger.warn` 0 times, note that the *service* emits that warning — assert on `movePointerToSim` not being called and drop the warn assertion rather than double-warning in the helper.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 add packages/iracing-actions/src/shared
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 commit -m "feat(actions): add the shared bringPointerToSim helper (#926)"
```

---

### Task 5: The keypad mode + icon

**Files:**
- Create: `packages/icons/view-adjustment/mouse-to-sim.svg`
- Create: `packages/icons/preview/view-adjustment/mouse-to-sim.svg` (generated)
- Modify: `packages/iracing-actions/src/actions/view-adjustment/view-adjustment.ts`
- Modify: `packages/iracing-actions/src/actions/data/icon-defaults.json` (generated)
- Test: `packages/iracing-actions/src/actions/view-adjustment/view-adjustment.test.ts`

**Interfaces:**
- Consumes: `bringPointerToSim` from Task 4.
- Produces: the `"mouse-to-sim"` value of `AdjustmentType`; `VIEW_ADJUSTMENT_GLOBAL_KEYS` narrowed to `Partial<Record<AdjustmentType, Record<DirectionType, string>>>`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/iracing-actions/src/actions/view-adjustment/view-adjustment.test.ts`, matching the file's existing mock setup and `describe` layout:

```typescript
describe("mouse-to-sim mode", () => {
  it("has no global key binding", () => {
    expect(VIEW_ADJUSTMENT_GLOBAL_KEYS["mouse-to-sim"]).toBeUndefined();
  });

  it("renders an icon for both directions", () => {
    for (const direction of ["increase", "decrease"] as const) {
      const svg = generateViewAdjustmentSvg({ adjustment: "mouse-to-sim", direction } as never);
      expect(svg).toContain("data:image/svg+xml");
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && pnpm exec vitest run packages/iracing-actions/src/actions/view-adjustment/view-adjustment.test.ts`
Expected: FAIL — the icon lookup falls back to `fov-increase`, or the type rejects the new value.

- [ ] **Step 3: Author the icon**

Create `packages/icons/view-adjustment/mouse-to-sim.svg` — a window frame with a cursor arrow landing at the top-center, which is literally where the pointer goes. Safe SVG feature set only, `<desc>` colors matching its siblings, viewBox trimmed to the artwork extent plus the 1-unit anti-clip margin:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 81.5 65.5">
  <desc>{"colors":{"backgroundColor":"#1a2a3a","textColor":"#ffffff","graphic1Color":"#ffffff","graphic2Color":"#4fc3f7"},"title":{"text":"MOUSE\nTO SIM"},"border":{"color":"#3a5a6a"}}</desc>
  <g transform="translate(-7.25 -9.25)">
    <rect x="10" y="12" width="76" height="60" rx="4" fill="none" stroke="{{graphic1Color}}" stroke-width="3.5"/>
    <rect x="12" y="14" width="72" height="8" fill="{{graphic2Color}}" opacity="0.5"/>
    <circle cx="34" cy="56" r="2.2" fill="{{graphic2Color}}" opacity="0.4"/>
    <circle cx="40" cy="50" r="2.6" fill="{{graphic2Color}}" opacity="0.6"/>
    <circle cx="46" cy="44" r="3" fill="{{graphic2Color}}" opacity="0.8"/>
    <polygon points="44,22 44,42 48.8,37.6 52.2,45 55.6,43.4 52.2,36 58,35.6" fill="{{graphic2Color}}" stroke="{{graphic1Color}}" stroke-width="2" stroke-linejoin="round"/>
  </g>
</svg>
```

- [ ] **Step 4: Regenerate the icon previews and defaults**

```bash
cd C:/Users/Niklas/Projects/iRaceDeck/ir-926/packages/icons
node scripts/generate-icon-previews.mjs
node scripts/generate-icon-defaults.mjs
```

Expected: a new `preview/view-adjustment/mouse-to-sim.svg`; `icon-defaults.json` unchanged for `view-adjustment` (the new icon reuses the family's colors).

- [ ] **Step 5: Wire the mode into the action**

In `packages/iracing-actions/src/actions/view-adjustment/view-adjustment.ts`:

1. Import the icon next to its siblings: `import mouseToSimIconSvg from "@iracedeck/icons/view-adjustment/mouse-to-sim.svg";` and `import { bringPointerToSim } from "../../shared/mouse-to-sim.js";`
2. Extend the type: `type AdjustmentType = "fov" | "horizon" | "driver-height" | "recenter-vr" | "ui-size" | "mouse-to-sim";`
3. Add to `VIEW_ADJUSTMENT_ICONS`:

```typescript
  "mouse-to-sim-increase": mouseToSimIconSvg,
  "mouse-to-sim-decrease": mouseToSimIconSvg,
```

4. Add to `VIEW_ADJUSTMENT_TITLES` (the map wins over the icon `<desc>` title at runtime, so both must agree):

```typescript
  "mouse-to-sim": {
    increase: "MOUSE\nTO SIM",
    decrease: "MOUSE\nTO SIM",
  },
```

5. Narrow the key map — the new mode taps no binding, so it deliberately has **no** entry:

```typescript
export const VIEW_ADJUSTMENT_GLOBAL_KEYS: Partial<Record<AdjustmentType, Record<DirectionType, string>>> = {
```

6. Add `"mouse-to-sim"` to the Zod `adjustment` enum.
7. Make `setActiveBinding` tolerate the missing entry — both call sites become:

```typescript
    this.setActiveBinding(VIEW_ADJUSTMENT_GLOBAL_KEYS[settings.adjustment]?.[settings.direction] ?? null);
```

8. Branch in `executeAdjustment`, before the binding lookup:

```typescript
    // A native window/pointer call, not an iRacing command — so it has no binding
    // and no comms descriptor (the Telemetry Control `snapshot` precedent).
    if (adjustment === "mouse-to-sim") {
      bringPointerToSim(this.logger);

      return;
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && pnpm exec vitest run packages/iracing-actions/src/actions/view-adjustment/`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 7: Commit**

```bash
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 add packages/icons packages/iracing-actions
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 commit -m "feat(actions): add the Mouse to Sim mode to View Adjustment (#926)"
```

---

### Task 6: The dial gesture

**Files:**
- Modify: `packages/iracing-actions/src/actions/view-adjustment/view-adjustment-dial-surface.ts`
- Test: `packages/iracing-actions/src/actions/view-adjustment/view-adjustment-dial-surface.test.ts`

**Interfaces:**
- Consumes: `bringPointerToSim` from Task 4.
- Produces: `"mouse-to-sim"` as a member of `GESTURE_ACTIONS` / `GestureSlot`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/iracing-actions/src/actions/view-adjustment/view-adjustment-dial-surface.test.ts`:

```typescript
describe("mouse-to-sim gesture", () => {
  it("is offered as a gesture slot", () => {
    expect(GESTURE_ACTIONS).toContain("mouse-to-sim");
  });

  it("is not offered as a rotation setting", () => {
    expect(ROTATION_SETTINGS).not.toContain("mouse-to-sim" as never);
  });

  it("names the gesture in the trigger description", () => {
    const description = buildTriggerDescription(DialSettings.parse({ pressAction: "mouse-to-sim" }));
    expect(description.push).toBe("Mouse to Sim");
  });

  it("keeps the existing defaults", () => {
    const defaults = DialSettings.parse({});
    expect(defaults.pressAction).toBe("recenter-vr");
    expect(defaults.longPressAction).toBe("none");
    expect(defaults.tapAction).toBe("none");
    expect(defaults.longTouchAction).toBe("none");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && pnpm exec vitest run packages/iracing-actions/src/actions/view-adjustment/view-adjustment-dial-surface.test.ts`
Expected: FAIL — `GESTURE_ACTIONS` does not contain `mouse-to-sim`.

- [ ] **Step 3: Add the gesture**

In `view-adjustment-dial-surface.ts`:

1. `import { bringPointerToSim } from "../../shared/mouse-to-sim.js";`
2. Extend the gesture list and its doc comment:

```typescript
/**
 * Gesture slots. `recenter-vr` taps the shared View Adjustment Recenter VR
 * binding; `mouse-to-sim` focuses iRacing and parks the mouse pointer inside it
 * (#926) — a native window call, so it taps no binding.
 */
export const GESTURE_ACTIONS = ["recenter-vr", "mouse-to-sim", "none"] as const;
```

3. Add the label:

```typescript
    case "mouse-to-sim":
      return "Mouse to Sim";
```

4. Add the dispatch in `doGesture`:

```typescript
    if (action === "mouse-to-sim") {
      bringPointerToSim(this.host.logger);

      return;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && pnpm exec vitest run packages/iracing-actions/src/actions/view-adjustment/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 add packages/iracing-actions
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 commit -m "feat(actions): offer Mouse to Sim as a View Adjustment dial gesture (#926)"
```

---

### Task 7: Property Inspector

**Files:**
- Modify: `packages/iracing-actions/src/actions/view-adjustment/view-adjustment.ejs`

**Interfaces:**
- Consumes: the `mouse-to-sim` settings value (Tasks 5 and 6).
- Produces: no code interface — a compiled `ui/view-adjustment.html` in all three plugins.

- [ ] **Step 1: Rename both mode selector labels**

Change `<sdpi-item label="Adjustment">` to `<sdpi-item label="Mode">` in **both** the `#keypad-settings` and the `#dial-settings` blocks, per `.claude/rules/terminology-and-refs.md`.

- [ ] **Step 2: Add the keypad option and its help text**

In the keypad mode select, after the `recenter-vr` option:

```html
					<option value="mouse-to-sim">Mouse to Sim</option>
```

And directly after the keypad `<ird-binding-status>` line:

```html
			<div class="ird-supporting-text hidden" id="mouse-to-sim-help">
				Focuses the iRacing window and moves the mouse pointer into it, near the top
				centre of the sim window. Useful in VR, where the pointer is invisible and can
				be anywhere across your monitors. This mode uses no iRacing command and needs
				no key binding.
			</div>
```

- [ ] **Step 3: Add the option to all four dial gesture selects**

Add `<option value="mouse-to-sim">Mouse to Sim</option>` to `dial.pressAction`, `dial.longPressAction`, `dial.tapAction`, and `dial.longTouchAction`. Keep each select's existing option order convention (Press/Long Press list `recenter-vr` first; Tap/Long Touch list `none` first) and do not touch any `default` attribute.

- [ ] **Step 4: Generalize the Direction-hiding logic**

Replace the `updateVisibility` function with a set-driven version so the next non-directional mode is a one-line change:

```javascript
			// Modes that are non-directional one-shots — they have no Direction.
			const NON_DIRECTIONAL = new Set(["recenter-vr", "mouse-to-sim"]);

			function updateVisibility(adjustment) {
				const directionItem = document.getElementById("direction-item");
				directionItem?.classList.toggle("hidden", NON_DIRECTIONAL.has(adjustment));

				const mouseHelp = document.getElementById("mouse-to-sim-help");
				mouseHelp?.classList.toggle("hidden", adjustment !== "mouse-to-sim");
			}
```

- [ ] **Step 5: Confirm the binding-status line tolerates the unmapped mode**

The comms catalog gets **no** `mouse-to-sim` descriptor. Verify `ird-binding-status` renders nothing (rather than throwing or showing a stale line) for a mode key absent from its `comms` map:

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && grep -n "modes\[" -A 6 packages/pi-components/src/components/binding-status.ts | head -40`
Expected: the component early-returns / clears its content when the lookup is undefined. If it does not, add that guard plus a unit test in `packages/pi-components` — do not work around it in the template.

- [ ] **Step 6: Rebuild and inspect the generated HTML**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && set -o pipefail && pnpm --filter @iracedeck/iracing-plugin-stream-deck build 2>&1 | tail -5 && grep -c "mouse-to-sim" packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/ui/view-adjustment.html`
Expected: build succeeds; the count is 6 (1 keypad option + 4 dial options + 1 help div id) plus any occurrences inside the inline script.

- [ ] **Step 7: Commit**

```bash
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 add packages/iracing-actions packages/pi-components
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 commit -m "feat(actions): add Mouse to Sim to the View Adjustment PI and fix the Mode label (#926)"
```

---

### Task 8: Documentation

**Files:**
- Modify: `packages/website/src/content/docs/docs/actions/view-camera/view-adjustment.md`
- Modify: `packages/website/src/content/docs/changelog.mdx`
- Modify: `docs/reference/actions.json`
- Modify: `.claude/skills/iracedeck-actions/SKILL.md`
- Modify: `README.md` (only if it carries an affected count)

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1-7.
- Produces: no code interface.

- [ ] **Step 1: Website action page**

In `view-adjustment.md`, add a `Mouse to Sim` mode section in the page's established per-mode format (see `.claude/rules/website-action-docs.md`; canonical example `tire-service.md`). It must state: Communication Method **no iRacing command** (a native window call — no key binding needed); that it focuses iRacing **even when the global "Focus iRacing window" setting is off**, because pressing the key is explicit intent; where the pointer lands (horizontally centred, one eighth of the window height from the top — on iRacing's own top-of-screen UI band); that it moves the pointer only and never clicks; that nothing happens (with a log warning) when iRacing is not running; and the elevation caveat — if iRacing runs as Administrator and the deck app does not, see the existing elevation-mismatch guidance. Also add the mode to the page's dial gesture option list, noting the defaults are unchanged.

Then check the page for the word "Adjustment" used as the PI control name and change it to "Mode" to match Task 7.

- [ ] **Step 2: Changelog**

In `changelog.mdx`, under the top (in-development) version's `**Features**` list, one self-contained line:

```markdown
- View Adjustment gained a **Mouse to Sim** mode that focuses the iRacing window and moves your mouse pointer into it — for VR drivers who can't see where the pointer went. Available on the keypad and as a dial gesture.
```

If the top section has no `**Features**` header yet, add one in the fixed category order. Do not add a second line for any follow-up fix to this feature in the same release.

- [ ] **Step 3: `docs/reference/actions.json`**

In the `com.iracedeck.sd.core.view-adjustment` entry, add to `modes`:

```json
            { "adjustment": "mouse-to-sim", "label": "Mouse to Sim" }
```

and extend the `description` to cover the new mode (a native window/pointer call, no iRacing command, no key binding, also available as a dial gesture).

- [ ] **Step 4: `iracedeck-actions` skill**

Update the View Adjustment row in the actions table: mode count 5 → 6, list `mouse-to-sim` among the keypad modes, and change the dial gesture set from `{Recenter VR, None}` to `{Recenter VR, Mouse to Sim, None}` in both the table row and the dial narrative paragraph. Update the View & Camera category total and the overall mode total wherever the file states them.

- [ ] **Step 5: Check README counts**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && grep -n "modes\|actions" README.md | head -20`
Expected: adjust only if a stated count changes; a bare action count does not (no new action was added).

- [ ] **Step 6: Verify the website builds**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && set -o pipefail && pnpm --filter @iracedeck/website build 2>&1 | tail -10`
Expected: exit 0. MDX is strict — a bare `<` or `{` breaks it.

- [ ] **Step 7: Commit**

```bash
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 add -A
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 commit -m "docs: document the View Adjustment Mouse to Sim mode (#926)"
```

---

### Task 9: Full verification

**Files:** none created; this task fixes whatever the checks surface.

**Interfaces:**
- Consumes: everything from Tasks 1-8.
- Produces: a branch that is green and ready for manual testing.

- [ ] **Step 1: Install and full build**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && pnpm install && set -o pipefail && pnpm build 2>&1 | tail -30`
Expected: exit 0. `pnpm build` catches type errors that vitest's esbuild path does not. If `node_modules` looks corrupt (missing `tsc`), `rm -rf node_modules && pnpm install`.

- [ ] **Step 2: Full test suite**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && set -o pipefail && pnpm test 2>&1 | tail -30`
Expected: exit 0. The comms freshness test and the icon-preview freshness test both cover files this plan touches.

- [ ] **Step 3: Lint and format**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && pnpm lint:fix && pnpm format:fix && set -o pipefail && pnpm lint 2>&1 | tail -20`
Expected: exit 0, no warnings. Fix every issue surfaced, including any that predate this branch in the files touched.

- [ ] **Step 4: Confirm the generated comms JSON has no new descriptor**

Run: `cd C:/Users/Niklas/Projects/iRaceDeck/ir-926 && pnpm generate:action-comms && grep -c "mouse-to-sim" packages/iracing-actions/src/actions/data/action-comms.json`
Expected: `0`, and `git status` shows no change to the generated file.

- [ ] **Step 5: Commit any fixes**

```bash
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 add -A
git -C C:/Users/Niklas/Projects/iRaceDeck/ir-926 commit -m "chore: lint, format, and build fixes for #926"
```

- [ ] **Step 6: Hand off for manual testing**

Report to Niklas: the build/test/lint results, the three manual checks the spec calls out (elevation mismatch, a non-primary monitor, fullscreen vs windowed), and how to load the branch. Do **not** push or open a PR before manual testing passes.

---

## Manual test checklist (Niklas drives)

1. Keypad button set to **Mouse to Sim** with iRacing in the foreground → the pointer jumps to the top-centre band of the sim window.
2. Same, with iRacing behind another window → the sim comes forward **and** the pointer lands inside it.
3. Same, with the global **Focus iRacing window** setting **off** → still focuses and moves (explicit intent).
4. iRacing not running → nothing happens; the log shows one warning, and no crash.
5. iRacing on a **non-primary monitor** → the pointer lands on that monitor, not the primary.
6. iRacing **fullscreen** and **windowed** → correct in both.
7. iRacing running **as Administrator** while the deck app is not → record whether the pointer still moves; the docs get the observed answer.
8. Stream Deck+ dial with **Press = Mouse to Sim** → the gesture fires; the encoder trigger description reads "Mouse to Sim".
9. Existing modes (FOV, Horizon, Driver Height, Recenter VR, UI Size) still work on both surfaces, and the PI's Direction row still hides for Recenter VR.
