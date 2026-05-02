# Flag Flash Duration — Design

Issue: [#490](https://github.com/niklam/iRaceDeck/issues/490) — `feat(deck-core): global setting for flag-flash duration`.

## Problem

`BaseAction.startFlagFlash()` runs the flag-overlay flash for as long as the underlying iRacing flag is raised. On long full-course yellows or sustained debris flags this means the button flashes for minutes, becoming visual noise the driver tunes out. The intent of the feature is "a new event happened" — once the driver has noticed it, the flash should stop.

## Goal

Make the flash a **finite beat** by default. After a user-configurable duration (default 5 s) the flash auto-stops even when the underlying flag is still active. A new flag transition during or after the flash window starts a fresh window. `0` disables the auto-stop (= today's behaviour, kept as an escape hatch).

The blink rate (`FLAG_FLASH_INTERVAL_MS = 500`) is unchanged — that's a separate concept.

## Setting

| Field | Value |
|-------|-------|
| Schema key | `flagFlashDurationMs` |
| Type | number (ms) |
| Range | `0`–`15000` |
| Default | `5000` |
| `0` semantics | Flash continuously while the flag is raised (today's behaviour) |
| Storage location | `GlobalSettingsSchema` (`packages/deck-core/src/global-settings.ts`) |
| PI control | `<sdpi-range step="500">` — slider step 500 ms (≈ 0.5 s) |

Naming follows the codebase convention of an explicit-unit suffix (`OVERTAKE_HOLD_MS`, `FLAG_FLASH_INTERVAL_MS`). The slider stores raw ms; tick labels show the ms value (no unit conversion in `sdpi-range`).

## Timer logic

`BaseAction` gains a sibling timer next to the existing `flagFlashTimer`:

```ts
private flagFlashAutoStopTimer: ReturnType<typeof setTimeout> | null = null;
```

### `startFlagFlash()` (modified)

1. Clear any existing `flagFlashTimer` and `flagFlashAutoStopTimer` (existing pattern: prevent leaks on retrigger).
2. Show the first flag image and start the blink interval (unchanged).
3. Read `getGlobalSettings().flagFlashDurationMs`.
4. If `> 0`, schedule `flagFlashAutoStopTimer = setTimeout(() => endFlagFlashVisual(), durationMs)`.
5. If `0`, skip the auto-stop (= forever).

The duration is read at flash start time, not via `onGlobalSettingsChange` — the user adjusts the slider, it takes effect on the **next** transition. No mid-flash retiming. Simpler, and makes the timer's lifetime obviously bounded by the transition that started it.

### `endFlagFlashVisual()` (new private method)

Called only by the auto-stop timer. Stops the **visual** without clearing the cached flag state.

```ts
private endFlagFlashVisual(): void {
  if (this.flagFlashTimer) {
    clearInterval(this.flagFlashTimer);
    this.flagFlashTimer = null;
  }
  this.flagFlashAutoStopTimer = null;

  for (const contextId of this.flagOverlayActive) {
    this.restoreFlagOverlayImage(contextId);
  }
  this.flagOverlayActive.clear();
  this.flagFlashTick = 0;

  // INTENTIONAL: lastFlagStateKey and currentFlags stay set so the same
  // flag continuing in telemetry doesn't retrigger the flash.
}
```

The load-bearing detail: `lastFlagStateKey` is **not** reset. `onFlagTelemetryUpdate` already short-circuits when `stateKey === this.lastFlagStateKey`, so subsequent telemetry ticks with the same flag set are no-ops. Only a real change (different flag list) re-enters `startFlagFlash`.

### `stopFlagFlash()` (modified)

Real stop, called when flags clear (`flags.length === 0`) or the action unsubscribes. Calls `endFlagFlashVisual()` then resets the cached state (`lastFlagStateKey = ""`, `currentFlags = []`). Also clears `flagFlashAutoStopTimer` defensively (already cleared by `endFlagFlashVisual`, but explicit at the visible call site).

### Why two methods rather than `stopFlagFlash(preserveState: boolean)`

Three call sites today: `onFlagTelemetryUpdate` (flags cleared), `cleanupFlagSubscriptionIfUnneeded` (last overlay context removed), and the new auto-stop. Two of the three need the full reset, one needs the partial. Named methods read better than a boolean flag at the call site; the partial reset is a distinct concept worth its own name.

### Retrigger semantics

"New transition" = any change to the resolved flag-list state key. This matches today's transition detection (`onFlagTelemetryUpdate` already short-circuits on unchanged state key). Examples within a duration window:

| Scenario | Behaviour |
|----------|-----------|
| `[Yellow]` → `[Yellow]` (same telemetry) | No-op (state-key match, short-circuit). |
| `[Yellow]` → `[Yellow, Debris]` | State key changes → `startFlagFlash` retriggers, fresh duration window starts. |
| `[Yellow]` → `[]` | State key changes → `stopFlagFlash` (full reset). |
| `[Yellow]` (auto-stop fires) → `[Yellow]` later in same telemetry session | No-op — `lastFlagStateKey` is still `"Yellow"`. |
| `[Yellow]` (auto-stop fires) → `[]` → `[Yellow]` | Two transitions: first stops fully, second restarts. |

## Property Inspector

New partial: `packages/pi-components/partials/global-flag-flash.ejs`.

```ejs
<%- include('accordion', {
  title: 'Flag Flash',
  accordionId: 'Global Flag Flash',
  open: false,
  content: `
    <sdpi-item label="Duration (ms)">
      <sdpi-range setting="flagFlashDurationMs" default="5000" min="0" max="15000" step="500" global showlabels></sdpi-range>
    </sdpi-item>
    <div style="padding: 0 16px 8px; font-size: 11px; color: #999;">
      How long the flag flash plays after a new flag transition.
      Set to 0 to flash continuously while the flag is raised.
    </div>
  `
}) %>
```

Included from every per-action `.ejs` that already includes `global-common-settings`, matching the existing convention (every other global accordion partial is listed explicitly per action). Mechanical addition across the per-action templates; one extra line each.

## Tests

### `global-settings.test.ts` (existing file)

Append a `flagFlashDurationMs` block:

- Default is `5000` when not specified.
- Parses `0` (escape hatch).
- Parses `15000` (max).
- Coerces `"7500"` (string from PI) to `7500`.
- Rejects out-of-range values via Zod.

### `base-action.test.ts` (new file)

`BaseAction` has no existing test file. The new tests use `vi.useFakeTimers()` and a minimal harness that:

- Mocks `getController()` so `ensureFlagTelemetrySubscription` registers a callback the test can drive directly.
- Mocks `getGlobalSettings()` to return controllable `flagFlashDurationMs`.
- Provides a fake `IDeckPlatformAction` with `setImage` recording calls and `isKey() === true`.

Cases:

1. **Auto-stop** — `flagFlashDurationMs = 5000`, drive a Yellow flag, advance fake timers by 5000 ms, assert `setImage` called with the original (restored) icon and no further blink ticks.
2. **Forever (0)** — `flagFlashDurationMs = 0`, drive a Yellow flag, advance timers by 60 s, assert blink ticks continue (interval is still firing).
3. **Retrigger restarts the window** — duration 5000, drive Yellow, advance 4000 ms, drive Yellow+Debris (new state key), advance another 4000 ms (8000 ms total since first trigger), assert flash still running. Advance another 1500 ms, assert auto-stopped.
4. **Same-flag tick after auto-stop is a no-op** — drive Yellow, advance 5000 ms (auto-stops), drive another telemetry tick with `[Yellow]`, assert no new `setImage` calls (state-key short-circuit).
5. **Flags clear after auto-stop fully resets** — drive Yellow, advance 5000 ms, drive `[]`, then drive Yellow again, assert flash restarts (fresh transition).

## Documentation

`packages/website/src/content/docs/docs/features/flags-overlay.md` — add a section describing the duration setting and its `0 = forever` semantics. Append after the existing "How It Works" section.

## Files Affected

| File | Change |
|------|--------|
| `packages/deck-core/src/global-settings.ts` | Add `flagFlashDurationMs` to `GlobalSettingsSchema`. |
| `packages/deck-core/src/global-settings.test.ts` | Add schema cases. |
| `packages/deck-core/src/base-action.ts` | Add `flagFlashAutoStopTimer`, modify `startFlagFlash`/`stopFlagFlash`, add `endFlagFlashVisual`. |
| `packages/deck-core/src/base-action.test.ts` | New file with the five cases above. |
| `packages/pi-components/partials/global-flag-flash.ejs` | New partial. |
| `packages/iracing-actions/src/actions/*/<action>.ejs` | Add `<%- include('global-flag-flash') %>` to every per-action template that includes `global-common-settings`. |
| `packages/website/src/content/docs/docs/features/flags-overlay.md` | Document the new setting. |

No per-plugin registration needed — schema changes flow automatically via `GlobalSettingsSchema` to both Stream Deck and Mirabox plugins.

## Out of scope

- Mid-flash retiming when the slider changes (takes effect on the next transition instead — simpler, edge case unlikely to matter in practice).
- Per-flag duration overrides (one duration applies to all flags).
- Configuring the blink rate (`FLAG_FLASH_INTERVAL_MS` stays a constant).
- Changing the storage unit to seconds (kept ms per the codebase convention).
