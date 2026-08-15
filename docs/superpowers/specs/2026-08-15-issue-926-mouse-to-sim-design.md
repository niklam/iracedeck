# Issue #926 — Mouse to Sim: focus the iRacing window and park the pointer inside it

**Date:** 2026-08-15
**Issue:** [#926](https://github.com/niklam/iracedeck/issues/926)
**Branch:** `feat/926-mouse-to-sim` (worktree `ir-926`)
**Milestone:** 2.5.0

## Problem

A VR driver (Pimax headset, four-monitor desktop) can route keyboard and SDK commands to iRacing today via the `focusIRacingWindow` global setting, but the OS mouse pointer stays wherever it was left on the desktop. From inside a headset the pointer is invisible, so clicking anything in the sim means blindly hunting it across four screens. The ask is a deck button that brings the pointer into the iRacing window, the same way window focus brings input into it.

Expected: one press focuses iRacing and moves the pointer to a predictable spot inside its client area — horizontally centered, one eighth of the client height down from the top, which lands on iRacing's own top-of-screen UI region rather than the middle of the track view.

## Scope

- A new **Mouse to Sim** mode on the existing **View Adjustment** action (the VR-utility home, where `recenter-vr` already lives) — a non-directional one-shot.
- The same behavior offered as a **dial gesture** on that action's four gesture slots. Existing gesture defaults do not change.
- A new native window/pointer primitive, and a **new deck-core service** that replaces three duplicated per-plugin modules.

Out of scope: a configurable pointer target (fixed for v1 — see *Rejected alternatives*), any click synthesis (the mode moves the pointer only; clicks still come from the physical mouse), and any change to how the `focusIRacingWindow` global setting behaves for other actions.

## Layering

Three layers, each with one responsibility, dependencies pointing inward:

| Layer | Responsibility | Depends on |
|---|---|---|
| `@iracedeck/iracing-native` | Win32 primitives: locate the sim window, focus it, move the cursor into it | Windows only |
| `@iracedeck/deck-core` → `window-service.ts` | Singleton over injected delegates; result interpretation, logging, and the `focusIRacingWindow` setting gate | Nothing native — delegates are injected |
| `@iracedeck/iracing-actions` → `shared/mouse-to-sim.ts` | The feature policy: focus unconditionally, then park the pointer | `deck-core` only |

The compose order — *focus first, then move, regardless of the global focus setting* — is an iRaceDeck feature decision, not a Win32 fact and not a deck-core concern. Putting it in the actions package gives the keypad mode and the dial gesture one shared definition instead of two copies, and keeps deck-core free of action policy.

## Native layer — `packages/iracing-native/src/addon.cc`

### DRY refactor first

`FindWindowA(NULL, "iRacing.com Simulator")` is open-coded in `focusIRacingWindow()` and again in the elevation probe. Extract a `kIRacingWindowTitle` constant and a `static HWND findIRacingWindow()` helper, and route both existing call sites plus the new one through it. (`iracing-native/CLAUDE.md` already claims a shared helper exists; this makes the claim true.)

### New export

```cpp
static const int POINTER_MOVED = 0;
static const int POINTER_WINDOW_NOT_FOUND = 1;
static const int POINTER_FAILED = 2;

static int moveMouseToIRacingWindow(double xFraction, double yFraction);
```

Sequence: `findIRacingWindow()` → `GetClientRect` → reject a zero-or-negative width/height (what a minimized window looks like) → clamp both fractions into `[0,1]` with a NaN guard → compute the client-space point → `ClientToScreen` → `SetCursorPos`. Any Win32 failure returns `POINTER_FAILED`; a missing window returns `POINTER_WINDOW_NOT_FOUND`.

The N-API wrapper reads both arguments as **doubles** (never `Uint32Value()`, which would let a negative value wrap), defaulting to `0.5` / `0.125` when an argument is absent or not a number. Registered in `Init()`.

**Why the position is a parameter and not a C++ constant.** The repo's native convention is already "OS primitive in C++, tuning policy in TS" — `sendChatMessage` takes caller-supplied delays (#581, #589) and `sendScanKeySequence` takes `holdMs` (#818), both clamped natively. Following it here keeps iRacing's UI layout out of the addon and means a future configurable target needs no native rebuild.

### Mirror

Per the cross-package sync rule in `iracing-native/CLAUDE.md`:

- `src/index.ts` — `export enum PointerMoveResult { Moved = 0, WindowNotFound = 1, Failed = 2 }` and the `moveMouseToIRacingWindow(xFraction, yFraction): number` method on `IRacingNative`.
- `src/mock-impl.ts` — returns `Moved`, logging like the existing `focusIRacingWindow()` mock, so macOS/Linux development works unchanged.
- `iracing-native/CLAUDE.md` — documented under *Window Management Functions*.

This is **not** a keyboard function: steps 3–5 of the keyboard cross-package sync (keyboard-service types, `initializeKeyboard` wiring, `keyboard-service.test.ts`) do not apply. This follows the `getElevationStatus` precedent.

## deck-core — `packages/deck-core/src/window-service.ts`

A new singleton replacing the three byte-identical `src/shared/window-focus.ts` files in `iracing-plugin-stream-deck`, `iracing-plugin-mirabox`, and `iracing-plugin-ulanzi`. Those three files are **deleted**.

```ts
export enum WindowFocusResult { AlreadyFocused = 0, Focused = 1, WindowNotFound = 2, FocusTimedOut = 3 }
export enum PointerMoveResult { Moved = 0, WindowNotFound = 1, Failed = 2 }

export type WindowFocuser = () => number;
export type SimPointerMover = (xFraction: number, yFraction: number) => number;

/** Horizontally centered in the sim's client area. */
export const DEFAULT_POINTER_X_FRACTION = 0.5;
/** One eighth down from the top of the client area — iRacing's own UI band, not the middle of the track view. */
export const DEFAULT_POINTER_Y_FRACTION = 0.125;

export interface IWindowService {
  focus(): WindowFocusResult;
  focusIfEnabled(): void;
  movePointerToSim(xFraction?: number, yFraction?: number): PointerMoveResult;
}

export function initializeWindowService(
  logger?: ILogger,
  delegates?: { focuser?: WindowFocuser; pointerMover?: SimPointerMover },
): IWindowService;
export function getWindowService(): IWindowService;      // throws if uninitialized
export function isWindowServiceInitialized(): boolean;
export function _resetWindowService(): void;             // @internal, tests only
export function focusIRacingIfEnabled(): void;           // free fn; safe no-op if uninitialized
```

Shape copied from `clipboard-service.ts`: throw on double init, throw on `get` before init, injected delegate, missing delegate degrades to a logged no-op, delegate exceptions caught and logged rather than propagated, `_reset*` for tests.

`focusIRacingIfEnabled()` stays a free function because the plugin-level `onKeyDown` / `onDialDown` / `onDialRotate` listeners must never throw; it preserves today's exact semantics (no-op when uninitialized, no-op when the global setting is off) and keeps each `plugin.ts` diff to an import line plus the init call.

`focus()` is the unconditional variant used by the new feature. `focusIfEnabled()` is the setting-gated variant used by the plugin listeners; it delegates to `focus()` so result interpretation and logging exist once.

### SOLID rationale

- **SRP** — one module owns "OS-level interaction with the iRacing window". Result-code interpretation and its log lines exist in exactly one place instead of three.
- **DIP** — deck-core depends on two function types, not on `@iracedeck/iracing-native`; the plugins inject the concrete implementations. deck-core stays platform-agnostic and unit-testable with plain fakes.
- **OCP** — a future window operation (restore, query bounds) adds a delegate field without touching existing callers.
- **ISP** — `IWindowService` is three methods; a test double is a literal object.

### Accepted cost

The numeric result contract now exists in both `iracing-native` (`FocusResult`, `PointerMoveResult`) and `deck-core` (`WindowFocusResult`, `PointerMoveResult`). This is the price of deck-core not depending on the native package, and it is the pattern already in use (`ScanKeySender` and friends are declared in deck-core rather than imported from native). Both sides carry tests asserting the numeric values so a drift breaks a test rather than a user.

### Plugin wiring

All three `plugin.ts` files, next to the existing `initializeClipboard(...)` call and replacing the `initWindowFocus(...)` line:

```ts
initializeWindowService(adapter.createLogger("WindowService"), {
  focuser: () => native.focusIRacingWindow(),
  pointerMover: (x, y) => native.moveMouseToIRacingWindow(x, y),
});
```

The three `adapter.on*(() => focusIRacingIfEnabled())` listener registrations are unchanged apart from the import source. `iracing-plugin-stream-deck/src/shared/index.ts` re-exports the new deck-core names in place of the deleted local module, preserving backward compatibility for that package's public surface.

## Feature policy — `packages/iracing-actions/src/shared/mouse-to-sim.ts`

```ts
/** Focuses the iRacing window and parks the pointer inside it. Best-effort: logs, never throws. */
export function bringPointerToSim(logger: ILogger): void;
```

Calls `getWindowService().focus()` then `.movePointerToSim()`. Focus runs unconditionally — pressing this key is explicit intent, so the `focusIRacingWindow` global setting does not gate it. Both steps log at info on success and warn on a not-found/failed result. When the window is missing, the pointer move is skipped and one warning is logged rather than two.

The focus call blocks the JS main thread for up to 1000 ms while Windows confirms the foreground change. This is not new: `focusIRacingIfEnabled()` already does exactly this on every key press when the global setting is on. Accepted, and called out here so it isn't rediscovered as a bug.

Both the keypad mode and the dial gesture call this one function, so the behavior has a single definition.

## Action — `view-adjustment`

### Keypad

- `AdjustmentType` and the Zod `adjustment` enum gain `"mouse-to-sim"`.
- `VIEW_ADJUSTMENT_ICONS` gains `"mouse-to-sim-increase"` and `"mouse-to-sim-decrease"`, both the same SVG (exactly how `recenter-vr` is handled — a non-directional mode still resolves through the `${adjustment}-${direction}` key).
- `VIEW_ADJUSTMENT_TITLES` gains `MOUSE\nTO SIM` under both directions.
- `VIEW_ADJUSTMENT_GLOBAL_KEYS` becomes `Partial<Record<AdjustmentType, Record<DirectionType, string>>>` with **no** entry for the new mode. `setActiveBinding` therefore receives `null` and `isBindingMissing` returns false, so the mode never shows the #612 ⚠️ overlay — correct for a mode with nothing to bind.
- `executeAdjustment` branches to `bringPointerToSim(this.logger)` before the binding lookup.

### Dial surface

- `GESTURE_ACTIONS` gains `"mouse-to-sim"`; `gestureLabel()` returns `"Mouse to Sim"`, which reaches the encoder trigger description for free.
- `doGesture()` gains a case calling the same shared helper.
- `ROTATION_SETTINGS` is untouched — this is a one-shot, not a rotation value, mirroring how `recenter-vr` is a gesture and not a rotation setting.
- All four gesture defaults are unchanged: Press stays `recenter-vr`, the other three stay `none`.

### Comms catalog (#612)

The mode issues **no iRacing command** — it is a native window call — so it gets **no descriptor** in either the `view-adjustment` or the `view-adjustment-dial` map. This follows the Telemetry Control `snapshot` precedent: no PI status line, no binding-warning overlay. A test asserts `ird-binding-status` renders nothing for a mode key absent from its comms map, rather than trusting the precedent by inspection.

### Property Inspector

- New `<option value="mouse-to-sim">Mouse to Sim</option>` in the keypad Mode select and in all four dial gesture selects.
- The Direction row hides for the new mode. The existing `updateVisibility` grows from a single `=== "recenter-vr"` comparison to a `NON_DIRECTIONAL` set, so the next non-directional mode is a one-line addition.
- A short `ird-supporting-text` blurb, shown only for this mode, explains what the press does and where the pointer lands.
- Both mode-selector labels change from **"Adjustment"** to **"Mode"**, per `.claude/rules/terminology-and-refs.md` ("the `<sdpi-item>` label MUST be exactly 'Mode'"). This PI is being rewritten anyway; the rule violation goes with it.

### Icon

New `packages/icons/view-adjustment/mouse-to-sim.svg`: a cursor arrow entering a window frame. Authored to the safe SVG feature set (basic shapes and text only — no filters, masks, or `<style>`), with `<desc>` color and title metadata and a viewBox trimmed to the artwork. The icon library is grepped first to confirm no existing icon uses a cursor motif, per the distinctiveness rule. Then `node scripts/generate-icon-previews.mjs` and `node scripts/generate-icon-defaults.mjs`.

## Testing

New test files:

- `packages/deck-core/src/window-service.test.ts` — the setting gate on and off; each focus result code's log path; each pointer result code's log path; default fractions used when none are passed and explicit fractions passed through verbatim; a throwing delegate is caught; a missing delegate is a logged no-op; `getWindowService()` before init throws; `focusIRacingIfEnabled()` before init is a silent no-op; double init throws.
- `packages/iracing-actions/src/shared/mouse-to-sim.test.ts` — focus is called before the pointer move; the pointer move is skipped when focus reports `WindowNotFound`; focus is attempted even when the `focusIRacingWindow` setting is off; failures log and never throw.

Extended:

- `packages/iracing-native/src/mock-impl.test.ts` — the new mock method returns `Moved`.
- `view-adjustment.test.ts` — icon and title resolve for the new mode; no active binding is declared and no warning overlay is drawn; `onKeyDown` dispatches to the helper and taps no binding.
- `view-adjustment-dial-surface.test.ts` — the gesture appears in the option list; `gestureLabel` and the trigger description carry "Mouse to Sim"; `doGesture` dispatches to the helper; defaults are unchanged.

The generated `data/action-comms.json` is regenerated by `pnpm generate:action-comms`; its freshness test and the key cross-check against `key-bindings.json` guard the no-descriptor decision.

## Documentation

Website (the "well described" requirement):

- `packages/website/src/content/docs/docs/actions/view-camera/view-adjustment.md` — a full mode section: what it does, why a VR driver needs it, exactly where the pointer lands and why that spot, the fact that it focuses iRacing even when the global focus setting is off, the elevation caveat, and the new dial gesture option. Communication method: **no iRacing command**.
- `packages/website/src/content/docs/changelog.mdx` — one Features line under the in-development version.

Repo:

- `docs/reference/actions.json` — View Adjustment gains a mode row (9 → 10) and its description is updated.
- `.claude/skills/iracedeck-actions/SKILL.md` — the View Adjustment row (5 → 6 modes), the dial gesture list, and the View & Camera / total mode counts.
- `packages/iracing-native/CLAUDE.md` — the new native export.
- `.claude/rules/plugin-structure.md` — the init-order entry for `initializeWindowService`, replacing `initWindowFocus`.
- `.claude/rules/keyboard-shortcuts.md` — its plugin-setup snippet states window focus is a per-plugin module that does NOT live in deck-core; that becomes false.
- Root `.claude/CLAUDE.md` — the deck-core package blurb.
- `README.md` — only if it carries an action/mode count affected by this change.

## Risks, verified during manual testing

- **Elevation / UIPI.** `SetCursorPos` is a global cursor operation rather than a per-window message, so it should survive an iRacing-elevated / plugin-not-elevated mismatch even though input injection does not. That is reasoning, not evidence; it gets confirmed on the real rig and the docs record whichever answer we observe. The existing elevation-mismatch warning (#610) already covers diagnosis either way.
- **Multi-monitor.** `ClientToScreen` returns virtual-desktop coordinates and `SetCursorPos` consumes them, so a non-primary monitor should work. Deliberately tested with iRacing on a secondary screen.
- **Fullscreen vs windowed.** `GetClientRect` covers both; both are exercised.
- **Native rebuild file lock.** `node-gyp rebuild` fails with `EPERM` while a deck host app holds `iracing_native.node`; UlanziStudio and the Stream Deck app must be closed for the native build.

## Rejected alternatives

- **A pointer-only deck-core service, leaving the three `window-focus.ts` copies in place.** Smaller diff, but the triplication survives and "focus the sim window" would then have two implementations — the per-plugin module and whatever the new feature used. Rejected on DRY and SRP.
- **Baking the pointer position into C++.** Rejected: it puts iRacing UI-layout policy in the OS primitive and makes a future change a native rebuild, against the established `sendChatMessage` / `sendScanKeySequence` convention.
- **PI sliders for the pointer target.** Rejected for v1 per the issue's own note; the native signature already takes fractions, so adding the UI later touches only TS.
- **A native `bringPointerToIRacingWindow()` that focuses and moves in one call.** Rejected: it would duplicate the focus logic natively and fuse two independent primitives, making both untestable in isolation.
- **A new dedicated action for the feature.** Rejected: one mode does not justify an action, and View Adjustment is already the VR-utility home.
