# Car Selector Generalization (#790) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the `iRaceDeck Race Admin Cars` profile to `iRaceDeck Car Selector` (with legacy-name compatibility) and add a camera-focus flow: a new Camera Controls mode opens the selector grid with a per-device in-memory intent, car presses focus the camera and stay on the grid with the watched car highlighted.

**Architecture:** The `select-car` Race Admin mode stays where it is; a new shared in-memory intent module (`Map<deviceId, SelectIntent>`) is written by the Camera Controls entry mode, read by select-car presses/renders, and cleared by every Switch Profile press. The profile rename ships as a file/manifest rename plus a legacy-alias map in `resolveProfileNameForDevice`. `SELECTED_CAR_KEY` becomes `_selectedCar` with a read fallback.

**Tech Stack:** TypeScript monorepo (pnpm + turbo), Zod settings schemas, Vitest, EJS Property Inspector templates, Elgato Stream Deck SDK behind `IDeckPlatformAdapter`.

## Global Constraints

- Work in the worktree `C:/Users/Niklas/Projects/iRaceDeck/ir-790` (branch `ir-790`). All paths below are relative to that root. Run all commands from that root (the shell cwd resets between calls — always `cd C:/Users/Niklas/Projects/iRaceDeck/ir-790 && …` or use absolute paths).
- New profile display name (exact): `iRaceDeck Car Selector`. Legacy display name: `iRaceDeck Race Admin Cars`. The admin commands profile `iRaceDeck Race Admin Per Car` is NOT renamed.
- Selection state key (exact): `_selectedCar`; legacy key `_raceAdminSelectedCar` remains readable (fallback only, never written).
- Focus camera call (exact): `getCommands().camera.switchNum(carNumberRaw, 0, 0)` — group 0 / camera 0 keeps the current camera (Replay Control driver-walk precedent).
- The new Camera Controls mode value (exact): `focus-select-car`, PI label `Focus Car (pick from grid)`, key title `FOCUS\nPICK CAR`.
- No `GlobalSettingsSchema` change anywhere in this plan (the intent is in-memory; `_selectedCar` is a passthrough key needing no schema field).
- No comms-catalog change: `camera-focus` is intentionally absent from `comms-catalog.ts` (see its header comment), so the new mode gets no catalog entry, no `ird-binding-status` line, and no icon warning.
- Elgato-only gating: PI additions are wrapped in `locals.platform?.features?.profiles !== false`; runtime paths are safe elsewhere because `requestProfileSwitch` no-ops without a registered switcher.
- Conventional commits, each referencing `(#790)` is NOT required per-commit (the squash-merged PR title carries it), but keep types accurate (`feat`/`improve`/`docs`/`chore`).
- Test command shape: `npx vitest run <file>` from the worktree root. Full gate: `pnpm install && pnpm build && pnpm test && pnpm lint:fix && pnpm format:fix`. NOTE: a running UlanziStudio / Stream Deck host locks `iracing_native.node` and makes full `pnpm build` fail with EPERM — quit the host app first if that happens.
- Do NOT push or open a PR — Niklas validates manually in iRacing first (hard rule).

---

### Task 1: deck-core — `CAR_SELECTOR_PROFILE` constant + legacy profile-name alias

**Files:**
- Modify: `packages/deck-core/src/device-profiles.ts`
- Test: `packages/deck-core/src/device-profiles.test.ts`

**Interfaces:**
- Produces: `export const CAR_SELECTOR_PROFILE = "iRaceDeck Car Selector"` (exported from `@iracedeck/deck-core` via the package's existing barrel — check `packages/deck-core/src/index.ts` re-exports `device-profiles.ts` with `*`; if it enumerates, add the export). `resolveProfileNameForDevice` now maps legacy display names through `LEGACY_PROFILE_NAMES` before re-suffixing. Tasks 6, 7, 9 import `CAR_SELECTOR_PROFILE` from `@iracedeck/deck-core`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("resolveProfileNameForDevice", …)` block in `packages/deck-core/src/device-profiles.test.ts` (it defines an `available` array near line 188 — add a local one for these tests so the existing cases stay untouched):

```typescript
  it("maps the legacy Race Admin Cars name to the renamed Car Selector profile", () => {
    const availableRenamed = ["iRaceDeck Car Selector XL", "iRaceDeck Race Admin Per Car XL"];

    // Bare legacy display name (pre-#753 persisted value)
    expect(resolveProfileNameForDevice("iRaceDeck Race Admin Cars", DeviceType.StreamDeckXL, availableRenamed)).toBe(
      "iRaceDeck Car Selector XL",
    );
    // Legacy name suffixed for this device
    expect(
      resolveProfileNameForDevice("iRaceDeck Race Admin Cars XL", DeviceType.StreamDeckXL, availableRenamed),
    ).toBe("iRaceDeck Car Selector XL");
    // Legacy name suffixed for ANOTHER device still resolves to this device's variant
    expect(
      resolveProfileNameForDevice("iRaceDeck Race Admin Cars SD", DeviceType.StreamDeckXL, availableRenamed),
    ).toBe("iRaceDeck Car Selector XL");
    // The new name resolves normally
    expect(resolveProfileNameForDevice("iRaceDeck Car Selector", DeviceType.StreamDeckXL, availableRenamed)).toBe(
      "iRaceDeck Car Selector XL",
    );
  });

  it("exports the Car Selector display name", () => {
    expect(CAR_SELECTOR_PROFILE).toBe("iRaceDeck Car Selector");
  });
```

Add `CAR_SELECTOR_PROFILE` to the test file's import from `./device-profiles.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/deck-core/src/device-profiles.test.ts`
Expected: FAIL — `CAR_SELECTOR_PROFILE` is not exported; the legacy-name cases return `undefined`.

- [ ] **Step 3: Implement**

In `packages/deck-core/src/device-profiles.ts`, add below the `PROFILE_NAMES` block:

```typescript
/**
 * Display name of the generic car-selector profile (issue #790) — the renamed
 * `iRaceDeck Race Admin Cars`. Exported so consumers (Camera Controls' focus
 * entry mode, Switch Profile's marker check) share one source of truth.
 */
export const CAR_SELECTOR_PROFILE = "iRaceDeck Car Selector" as const;

/**
 * Legacy display name → current display name (issue #790). Consulted by
 * `resolveProfileNameForDevice` after suffix-stripping, so names persisted by
 * older installs (bare or suffixed for any device) keep resolving after a
 * bundled profile is renamed.
 */
const LEGACY_PROFILE_NAMES: Record<string, string> = {
  "iRaceDeck Race Admin Cars": CAR_SELECTOR_PROFILE,
};
```

Replace the body of `resolveProfileNameForDevice` (keep its doc comment, appending one sentence: `Legacy display names renamed since the value was persisted are mapped through \`LEGACY_PROFILE_NAMES\` (#790).`):

```typescript
export function resolveProfileNameForDevice(
  name: string,
  deviceType: number | undefined,
  availableNames: readonly string[],
): string | undefined {
  if (availableNames.includes(name)) {
    return name;
  }

  const display = profileDisplayName(name);
  const canonical = LEGACY_PROFILE_NAMES[display] ?? display;
  const suffixed = deviceProfileName(canonical, deviceType);

  return availableNames.includes(suffixed) ? suffixed : undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/deck-core/src/device-profiles.test.ts`
Expected: PASS (all existing cases plus the two new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/deck-core/src/device-profiles.ts packages/deck-core/src/device-profiles.test.ts
git commit -m "feat(deck-core): legacy profile-name alias + CAR_SELECTOR_PROFILE constant"
```

---

### Task 2: Shared per-device selection-intent module

**Files:**
- Create: `packages/iracing-actions/src/shared/car-select-intent.ts`
- Test: `packages/iracing-actions/src/shared/car-select-intent.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 5, 6, 7, 9):
  - `interface SelectIntent { action: "focus-camera" }`
  - `setSelectIntent(deviceId: string | undefined, intent: SelectIntent): void`
  - `getSelectIntent(deviceId: string | undefined): SelectIntent | undefined`
  - `clearSelectIntent(deviceId: string | undefined): void`
  - `_resetSelectIntents(): void` (test seam)

- [ ] **Step 1: Write the failing test**

Create `packages/iracing-actions/src/shared/car-select-intent.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";

import { _resetSelectIntents, clearSelectIntent, getSelectIntent, setSelectIntent } from "./car-select-intent.js";

describe("car-select-intent", () => {
  beforeEach(() => {
    _resetSelectIntents();
  });

  it("stores and returns an intent per device", () => {
    setSelectIntent("dev-1", { action: "focus-camera" });

    expect(getSelectIntent("dev-1")).toEqual({ action: "focus-camera" });
    expect(getSelectIntent("dev-2")).toBeUndefined();
  });

  it("clears only the given device's intent", () => {
    setSelectIntent("dev-1", { action: "focus-camera" });
    setSelectIntent("dev-2", { action: "focus-camera" });
    clearSelectIntent("dev-1");

    expect(getSelectIntent("dev-1")).toBeUndefined();
    expect(getSelectIntent("dev-2")).toEqual({ action: "focus-camera" });
  });

  it("normalizes an undefined deviceId to the empty-string group", () => {
    setSelectIntent(undefined, { action: "focus-camera" });

    expect(getSelectIntent(undefined)).toEqual({ action: "focus-camera" });
    expect(getSelectIntent("")).toEqual({ action: "focus-camera" });

    clearSelectIntent(undefined);
    expect(getSelectIntent("")).toBeUndefined();
  });

  it("clearing an absent intent is a no-op", () => {
    expect(() => clearSelectIntent("nope")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/iracing-actions/src/shared/car-select-intent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/iracing-actions/src/shared/car-select-intent.ts`:

```typescript
/**
 * Per-device car-selection intent (issue #790).
 *
 * The Car Selector grid (the Race Admin `select-car` mode) is a generic
 * "pick a car" surface: what a press MEANS is decided by the key that took the
 * user there. An entry key (e.g. Camera Controls' focus-select-car mode) sets
 * an intent for its device before switching to the selector profile; the
 * select-car keys read it at press time (and at render time, for the
 * focused-car highlight). No intent = the legacy race-admin behavior.
 *
 * Deliberately IN-MEMORY, not a `_`-prefixed global setting: every action runs
 * in the same plugin process, a restart can never resurrect a stale intent,
 * and nothing transient lands in persisted settings. Keyed by deviceId so
 * multi-deck setups stay independent; hosts that report no device id group
 * under "" (the same normalization as the selector's context tracking).
 *
 * Cleared by every Switch Profile press on the device (leaving the grid, or
 * entering it via plain navigation), and by host-profile-marker reports of a
 * non-selector profile becoming visible.
 */

/** What selecting a car should do. Extensible record — future consumers add actions. */
export interface SelectIntent {
  action: "focus-camera";
}

const intents = new Map<string, SelectIntent>();

function normalize(deviceId: string | undefined): string {
  return deviceId ?? "";
}

/** Set the device's pending selection intent (overwrites any previous one). */
export function setSelectIntent(deviceId: string | undefined, intent: SelectIntent): void {
  intents.set(normalize(deviceId), intent);
}

/** The device's pending selection intent, or `undefined` when none is set. */
export function getSelectIntent(deviceId: string | undefined): SelectIntent | undefined {
  return intents.get(normalize(deviceId));
}

/** Drop the device's pending selection intent. No-op when none is set. */
export function clearSelectIntent(deviceId: string | undefined): void {
  intents.delete(normalize(deviceId));
}

/** @internal Reset for tests. */
export function _resetSelectIntents(): void {
  intents.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/iracing-actions/src/shared/car-select-intent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-actions/src/shared/car-select-intent.ts packages/iracing-actions/src/shared/car-select-intent.test.ts
git commit -m "feat(actions): shared per-device car-selection intent module"
```

---

### Task 3: Profile rename — bundle files, manifest, profiles.json, Switch Profile icon map

**Files:**
- Rename: `packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/iRaceDeck Race Admin Cars SD.streamDeckProfile` → `…/iRaceDeck Car Selector SD.streamDeckProfile`
- Rename: `packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/iRaceDeck Race Admin Cars XL.streamDeckProfile` → `…/iRaceDeck Car Selector XL.streamDeckProfile`
- Rename: `packages/icons/switch-profile/race-admin-cars.svg` → `packages/icons/switch-profile/car-selector.svg`
- Modify: `packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/manifest.json` (two `Profiles[].Name` values)
- Modify: `packages/iracing-actions/src/actions/data/profiles.json` (regenerated)
- Modify: `packages/iracing-actions/src/actions/switch-profile/switch-profile.ts`
- Test: `packages/iracing-actions/src/actions/switch-profile/switch-profile.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent of Tasks 1–2 at build time, but Task 1's alias is what keeps old persisted names working against the renamed `profiles.json`).
- Produces: `profiles.json` entries named `iRaceDeck Car Selector SD/XL` with `displayName: "iRaceDeck Car Selector"`; `PROFILE_ICONS` rows for both new and legacy display names.

**Note:** renaming a `.streamDeckProfile` file does NOT change the user-facing name inside the bundle (that's Niklas' manual re-export at the end). The file name is what `Profiles[].Name` and `switchToProfile` use, so this task makes the plugin-side rename complete and buildable.

- [ ] **Step 1: Rename the files (git mv keeps history)**

```bash
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-790"
git mv "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/iRaceDeck Race Admin Cars SD.streamDeckProfile" "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/iRaceDeck Car Selector SD.streamDeckProfile"
git mv "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/iRaceDeck Race Admin Cars XL.streamDeckProfile" "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/iRaceDeck Car Selector XL.streamDeckProfile"
git mv packages/icons/switch-profile/race-admin-cars.svg packages/icons/switch-profile/car-selector.svg
```

- [ ] **Step 2: Update the manifest `Profiles[]` entries**

In `packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/manifest.json`, change exactly two `Name` values (keep every other field):
- `"iRaceDeck Race Admin Cars XL"` → `"iRaceDeck Car Selector XL"`
- `"iRaceDeck Race Admin Cars SD"` → `"iRaceDeck Car Selector SD"`

- [ ] **Step 3: Regenerate profiles.json and its previews**

```bash
pnpm generate:action-profiles
node scripts/generate-icon-previews.mjs
git rm packages/icons/preview/switch-profile/race-admin-cars.svg
```

Expected: `packages/iracing-actions/src/actions/data/profiles.json` now lists `iRaceDeck Car Selector SD/XL` with `displayName: "iRaceDeck Car Selector"`; a new preview `packages/icons/preview/switch-profile/car-selector.svg` exists (the old preview file is removed — the generator does not delete stale outputs).

- [ ] **Step 4: Update Switch Profile's icon/title maps**

In `packages/iracing-actions/src/actions/switch-profile/switch-profile.ts`:

Replace the icon import:

```typescript
import carSelectorIconSvg from "@iracedeck/icons/switch-profile/car-selector.svg";
```

(remove the `raceAdminCarsIconSvg` import of `race-admin-cars.svg`). Update `PROFILE_ICONS` — keep a legacy row so a stale persisted name still renders its artwork:

```typescript
const PROFILE_ICONS: Record<string, string> = {
  "iRaceDeck Replay": replayIconSvg,
  "iRaceDeck Chat": chatIconSvg,
  "iRaceDeck Car Selector": carSelectorIconSvg,
  // Legacy display name (pre-#790 rename) — old persisted keys keep their icon.
  "iRaceDeck Race Admin Cars": carSelectorIconSvg,
  "iRaceDeck Race Admin Per Car": raceAdminPerCarIconSvg,
  [PREVIOUS_PROFILE_VALUE]: previousIconSvg,
};
```

Update `PROFILE_TITLES` the same way:

```typescript
const PROFILE_TITLES: Record<string, string> = {
  "iRaceDeck Car Selector": "CAR\nSELECTOR",
  "iRaceDeck Race Admin Cars": "CAR\nSELECTOR",
  "iRaceDeck Race Admin Per Car": "RACE ADMIN\nPER CAR",
};
```

- [ ] **Step 5: Update switch-profile tests**

In `packages/iracing-actions/src/actions/switch-profile/switch-profile.test.ts`:
- Find the `vi.mock("@iracedeck/icons/switch-profile/race-admin-cars.svg", …)` line (grep for `race-admin-cars`) and change the mocked path to `@iracedeck/icons/switch-profile/car-selector.svg` (keep the mock's return string; if it says `RACE ADMIN CARS`, rename the string to `CAR SELECTOR` and update any assertion that matched it).
- In the `vi.mock("../data/profiles.json", …)` fixture, rename any `iRaceDeck Race Admin Cars` entries to `iRaceDeck Car Selector` (both `name` and `displayName`), and update assertions that referenced the old names.
- Add a test asserting the legacy display name still maps to the car-selector icon:

```typescript
    it("renders the car-selector artwork for the legacy Race Admin Cars name", () => {
      const svg = generateSwitchProfileSvg({ profile: "iRaceDeck Race Admin Cars XL" } as never);

      expect(svg).toContain(encodeURIComponent("CAR SELECTOR").slice(0, 8));
    });
```

(Adapt the assertion to how the existing icon tests in that file assert artwork — they assert on the mocked SVG content string; mirror the nearest existing `generateSwitchProfileSvg` test's expectation style exactly.)

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/iracing-actions/src/actions/switch-profile/switch-profile.test.ts scripts/generate-action-profiles.test.mjs packages/deck-core/src/device-profiles.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "improve(profiles): rename Race Admin Cars profile to iRaceDeck Car Selector"
```

---

### Task 4: Selection-key rename — `_selectedCar` with legacy read fallback

**Files:**
- Modify: `packages/iracing-actions/src/actions/race-admin/race-admin-selector.ts`
- Modify: `packages/iracing-actions/src/actions/race-admin/race-admin.ts`
- Test: `packages/iracing-actions/src/actions/race-admin/race-admin.test.ts`, `packages/iracing-actions/src/actions/race-admin/race-admin-selector.test.ts`

**Interfaces:**
- Produces: `SELECTED_CAR_KEY = "_selectedCar"`, new export `LEGACY_SELECTED_CAR_KEY = "_raceAdminSelectedCar"` (both from `race-admin-selector.ts`).

- [ ] **Step 1: Write the failing test**

In `packages/iracing-actions/src/actions/race-admin/race-admin-selector.test.ts`, find where `SELECTED_CAR_KEY` is asserted (grep `SELECTED_CAR_KEY`) and update/add:

```typescript
  it("uses the generic selection key with the legacy key exported for fallback", () => {
    expect(SELECTED_CAR_KEY).toBe("_selectedCar");
    expect(LEGACY_SELECTED_CAR_KEY).toBe("_raceAdminSelectedCar");
  });
```

(Import `LEGACY_SELECTED_CAR_KEY` alongside `SELECTED_CAR_KEY`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/iracing-actions/src/actions/race-admin/race-admin-selector.test.ts`
Expected: FAIL — `LEGACY_SELECTED_CAR_KEY` not exported / old key value.

- [ ] **Step 3: Implement**

In `race-admin-selector.ts`, replace the `SELECTED_CAR_KEY` declaration (keep the doc comment, updating it to mention the rename):

```typescript
/**
 * Internal passthrough global-settings key holding the currently selected admin
 * target as a `{ carIdx, carNumber }` record (renamed from
 * `_raceAdminSelectedCar` in #790 — the selector is now a generic pick-a-car
 * surface). Follows the `_`-prefixed convention for shared internal state
 * (like `_warnings` / `_lastSeenVersion`) — no schema field. The car number is
 * stored alongside the CarIdx as a staleness guard: CarIdx assignments are
 * session-scoped while global settings persist across sessions, so a reader
 * must treat the selection as void when the CarIdx no longer resolves to the
 * stored number (see `resolveSelectedCar`). Focus-intent presses never write
 * it — only the admin (no-intent) press does.
 */
export const SELECTED_CAR_KEY = "_selectedCar" as const;

/**
 * Pre-#790 name of {@link SELECTED_CAR_KEY}. Read as a fallback (never
 * written) so an in-flight selection survives a mid-session plugin upgrade.
 */
export const LEGACY_SELECTED_CAR_KEY = "_raceAdminSelectedCar" as const;
```

In `race-admin.ts`, add `LEGACY_SELECTED_CAR_KEY` to the `./race-admin-selector.js` import list, and change `resolveSelectedCarNumber` to:

```typescript
  private resolveSelectedCarNumber(): string | null {
    const settings = getGlobalSettings() as Record<string, unknown>;
    const raw = settings[SELECTED_CAR_KEY] ?? settings[LEGACY_SELECTED_CAR_KEY];

    return resolveSelectedCar(raw, (carIdx) =>
      getCarNumberFromSessionInfo(this.sdkController.getSessionInfo(), carIdx),
    );
  }
```

In `race-admin.test.ts`, update the `vi.mock("./race-admin-selector.js", …)` factory: change `SELECTED_CAR_KEY: "_raceAdminSelectedCar"` to `SELECTED_CAR_KEY: "_selectedCar"` and add `LEGACY_SELECTED_CAR_KEY: "_raceAdminSelectedCar"`. Update any test asserting `updateGlobalSettings` was called with `_raceAdminSelectedCar` to expect `_selectedCar` (grep the test file for `_raceAdminSelectedCar`). Add a fallback test near the existing selected-car tests (mirror their mock setup for `getGlobalSettings`):

```typescript
    it("reads the legacy _raceAdminSelectedCar key when _selectedCar is absent", async () => {
      const legacyRecord = { carIdx: 7, carNumber: "42" };
      vi.mocked(getGlobalSettings).mockReturnValue({ _raceAdminSelectedCar: legacyRecord } as never);
      // Drive any path that resolves the shared target — the cheapest is a
      // keyDown on a driver-targeted mode with driverTarget "selected-car"
      // (copy the event construction from the file's existing selected-car
      // dispatch test verbatim).

      expect(resolveSelectedCar).toHaveBeenCalledWith(legacyRecord, expect.any(Function));
    });

    it("prefers _selectedCar over the legacy key when both exist", async () => {
      const newRecord = { carIdx: 3, carNumber: "11" };
      vi.mocked(getGlobalSettings).mockReturnValue({
        _selectedCar: newRecord,
        _raceAdminSelectedCar: { carIdx: 7, carNumber: "42" },
      } as never);
      // Same drive as above.

      expect(resolveSelectedCar).toHaveBeenCalledWith(newRecord, expect.any(Function));
    });
```

`getGlobalSettings` and `resolveSelectedCar` are both already mocked in this file (deck-core mock and selector mock respectively) — import them into the test via `vi.mocked(...)` on the existing imports. Copy the event construction from the file's existing selected-car dispatch test verbatim for the "drive" step.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/iracing-actions/src/actions/race-admin/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-actions/src/actions/race-admin/
git commit -m "improve(actions): rename the shared selection key to _selectedCar with legacy read fallback"
```

---

### Task 5: Race Admin — focus-intent press dispatch

**Files:**
- Modify: `packages/iracing-actions/src/actions/race-admin/race-admin.ts`
- Test: `packages/iracing-actions/src/actions/race-admin/race-admin.test.ts`

**Interfaces:**
- Consumes: `getSelectIntent` (Task 2), `getCarNumberRawFromSessionInfo(sessionInfo, carIdx): number | null` from `@iracedeck/iracing-sdk`, `getCommands().camera.switchNum(num, group, camera): boolean`.
- Produces: with a `focus-camera` intent active for the pressing device, a select-car press focuses the camera and does NOT write the selection or switch profiles.

- [ ] **Step 1: Write the failing tests**

In `race-admin.test.ts`:
- Extend the `vi.mock("@iracedeck/iracing-sdk", …)` factory with `getCarNumberRawFromSessionInfo: vi.fn(() => 24),`.
- Find the deck-core mock's `getCommands` (grep `getCommands` in the file) and extend its returned object with `camera: { switchNum: vi.fn(() => true) }` — export a handle the tests can reach the same way the existing chat mock is reached (mirror how `chat.sendMessage` assertions are written in the existing select/admin tests).
- Import the real intent module at the top (it is NOT mocked — same package):

```typescript
import { _resetSelectIntents, setSelectIntent } from "../../shared/car-select-intent.js";
```

- Add to the existing select-car describe block (mirror the existing "executeSelect" test's event construction — same `makeKeyDownEvent`-style helper with `deviceId`):

```typescript
    describe("focus-camera intent (#790)", () => {
      beforeEach(() => {
        _resetSelectIntents();
      });

      it("focuses the camera on the slot car and stays on the grid", async () => {
        setSelectIntent("device-1", { action: "focus-camera" });
        // press a select-car key on device-1 exactly as the existing
        // select-car press test does (mode: "select-car")
        // …existing event/act code…

        expect(cameraSwitchNumMock).toHaveBeenCalledWith(24, 0, 0);
        expect(updateGlobalSettings).not.toHaveBeenCalled();
        expect(requestProfileSwitch).not.toHaveBeenCalled();
      });

      it("without an intent the press stores the selection and switches (legacy path)", async () => {
        // same press, no intent set
        expect(updateGlobalSettings).toHaveBeenCalledWith({ _selectedCar: { carIdx: 5, carNumber: "24" } });
        expect(requestProfileSwitch).toHaveBeenCalled();
        expect(cameraSwitchNumMock).not.toHaveBeenCalled();
      });

      it("alerts and does nothing when the camera switch fails", async () => {
        setSelectIntent("device-1", { action: "focus-camera" });
        cameraSwitchNumMock.mockReturnValueOnce(false);
        // press; then:
        expect(showAlertMock).toHaveBeenCalled();
        expect(updateGlobalSettings).not.toHaveBeenCalled();
      });

      it("alerts when the car number cannot be resolved to a raw number", async () => {
        setSelectIntent("device-1", { action: "focus-camera" });
        vi.mocked(getCarNumberRawFromSessionInfo).mockReturnValueOnce(null);
        // press; then:
        expect(cameraSwitchNumMock).not.toHaveBeenCalled();
        expect(showAlertMock).toHaveBeenCalled();
      });
    });
```

Fill the "press" arrangement by copying the existing select-car press test verbatim (it constructs the willAppear + keyDown events with coordinates and `deviceId`); ensure the event's `deviceId` matches `"device-1"` (use whatever device id string the existing helper produces and set the intent for that id).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/iracing-actions/src/actions/race-admin/race-admin.test.ts`
Expected: the new tests FAIL (camera never called / selection still written).

- [ ] **Step 3: Implement**

In `race-admin.ts`:

Imports — add `getSelectIntent` and `getCarNumberRawFromSessionInfo`, and the `SlotCar` type:

```typescript
import { getSelectIntent } from "../../shared/car-select-intent.js";
```

Add `getCarNumberRawFromSessionInfo` to the existing `@iracedeck/iracing-sdk` import list, and `type SlotCar` to the `./race-admin-selector.js` import list.

In `executeSelect`, insert the intent branch immediately after the empty-slot guard (before the target-profile resolution):

```typescript
    // A pending focus intent (set by the entry key that opened the selector,
    // #790) redefines the press: focus the camera on this car and stay on the
    // grid — no selection write, no profile switch. The admin flow below is
    // the no-intent default, so plain navigation into the selector behaves
    // exactly as before.
    if (getSelectIntent(ev.action.deviceId)?.action === "focus-camera") {
      await this.executeFocusSelect(ev, car);

      return;
    }
```

Add the method after `executeSelect`:

```typescript
  /**
   * Focus the replay/live camera on a picked car (#790): resolve the car's raw
   * number and switch the camera to it, keeping the current camera group
   * (group 0 / camera 0 — the Replay Control driver-walk precedent). Failures
   * alert on the key and change nothing.
   */
  private async executeFocusSelect(ev: IDeckKeyDownEvent<RaceAdminSettings>, car: SlotCar): Promise<void> {
    const sessionInfo = this.sdkController.getSessionInfo();
    const carNumberRaw = sessionInfo ? getCarNumberRawFromSessionInfo(sessionInfo, car.carIdx) : null;

    if (carNumberRaw === null) {
      this.logger.warn("Focus select: car number not found in session info");
      await ev.action.showAlert?.();

      return;
    }

    const success = getCommands().camera.switchNum(carNumberRaw, 0, 0);

    if (!success) {
      this.logger.warn("Focus select: camera switch failed");
      await ev.action.showAlert?.();

      return;
    }

    this.logger.info("Camera focused on selected car");
    this.logger.debug(`Focused CarIdx ${car.carIdx} (#${car.carNumber})`);
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/iracing-actions/src/actions/race-admin/race-admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-actions/src/actions/race-admin/
git commit -m "feat(actions): focus-camera intent dispatch on the car-selector press"
```

---

### Task 6: Race Admin — focused-car highlight on the grid

**Files:**
- Modify: `packages/iracing-actions/src/actions/race-admin/race-admin-selector.ts` (`generateSelectorSvg` gains `highlighted`)
- Modify: `packages/iracing-actions/src/actions/race-admin/race-admin.ts` (CamCarIdx tracking + highlight resolution + dedupe)
- Test: both test files

**Interfaces:**
- Consumes: `getSelectIntent` (Task 2).
- Produces: `generateSelectorSvg(car, settings, highlighted?: boolean)`; `generateRaceAdminSvg(mode, settings, resolvedCar?, highlighted?)`.

- [ ] **Step 1: Write the failing selector test**

In `race-admin-selector.test.ts`, next to the existing `generateSelectorSvg` tests (they decode the data URI — mirror their decode helper):

```typescript
  it("renders a highlight ring when highlighted", () => {
    const svg = decodeURIComponent(
      generateSelectorSvg({ carNumber: "24", lastName: "Doe" }, {}, true).replace("data:image/svg+xml,", ""),
    );

    expect(svg).toContain('stroke="#2ecc71"');
  });

  it("renders no highlight ring by default", () => {
    const svg = decodeURIComponent(
      generateSelectorSvg({ carNumber: "24", lastName: "Doe" }, {}).replace("data:image/svg+xml,", ""),
    );

    expect(svg).not.toContain('stroke="#2ecc71"');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/iracing-actions/src/actions/race-admin/race-admin-selector.test.ts`
Expected: FAIL (extra argument ignored, no ring).

- [ ] **Step 3: Implement the selector side**

In `race-admin-selector.ts`, change `generateSelectorSvg`'s signature and number-content assembly:

```typescript
export function generateSelectorSvg(
  car: SelectorDisplayCar | null,
  settings: SelectorRenderSettings,
  highlighted = false,
): string {
```

and where `numberContent` is computed:

```typescript
  // Focused-car highlight (#790): while a focus intent is active, the key
  // whose car the camera is on renders a green ring — the grid doubles as a
  // "who am I watching" display. Drawn inside the number layer so themes and
  // the border pipeline are unaffected. Safe SVG Tiny 1.2 features only.
  const highlightContent =
    highlighted && car
      ? `<rect x="6" y="6" width="132" height="132" rx="20" fill="none" stroke="#2ecc71" stroke-width="8"/>\n    `
      : "";

  const numberContent = highlightContent + (car ? carDisplayContent(car, textColor) : "");
```

(Replace the existing `const numberContent = car ? carDisplayContent(car, textColor) : "";` line.)

- [ ] **Step 4: Implement the action side**

In `race-admin.ts`:

1. `generateRaceAdminSvg` — add the parameter and pass it through:

```typescript
export function generateRaceAdminSvg(
  mode: RaceAdminMode,
  settings: RaceAdminSettings,
  resolvedCar: SelectorDisplayCar | null = null,
  highlighted = false,
): string {
  if (mode === "select-car") {
    return generateSelectorSvg(resolvedCar, settings, highlighted);
  }
  // …rest unchanged…
```

2. Add a per-context camera-car map next to `viewedCarNumbers`:

```typescript
  /** CamCarIdx from the latest tick per context (−1 = unknown), for the focus highlight (#790). */
  private camCarIdxByContext = new Map<string, number>();
```

Set it in `updateViewedCar` (first line of the method body):

```typescript
    this.camCarIdxByContext.set(contextId, camCarIdx);
```

(`camCarIdx` is already computed there.) Delete the entry in `onWillDisappear` next to the other `.delete(ev.action.id)` calls.

3. Add the highlight resolver after `resolveIconCar`:

```typescript
  /**
   * Whether this select-car key should render the focused-car highlight
   * (#790): a focus intent is pending for the key's device AND the camera is
   * currently on this key's car. Always false for non-selector modes, empty
   * slots, and cars without a known CarIdx.
   */
  private selectorHighlighted(contextId: string, settings: RaceAdminSettings, car: SelectorDisplayCar | null): boolean {
    if (settings.mode !== "select-car" || !car) return false;

    const carIdx = (car as Partial<SlotCar>).carIdx;

    if (typeof carIdx !== "number") return false;

    const deviceId = this.selectorContexts.get(contextId)?.deviceId;

    if (getSelectIntent(deviceId)?.action !== "focus-camera") return false;

    const camCarIdx = this.camCarIdxByContext.get(contextId) ?? -1;

    return camCarIdx >= 0 && camCarIdx === carIdx;
  }
```

4. Fold the highlight into the dedupe key and every render path. Change `displayCarKey`:

```typescript
  /** Stable dedupe key for a resolved display car + highlight state. */
  private static displayCarKey(car: SelectorDisplayCar | null, highlighted = false): string | null {
    return car ? `${car.carNumber} ${car.lastName ?? ""}|${highlighted ? 1 : 0}` : null;
  }
```

In `updateDisplay`:

```typescript
    const car = this.resolveIconCar(ev.action.id, settings);
    const highlighted = this.selectorHighlighted(ev.action.id, settings, car);
    const svg = generateRaceAdminSvg(settings.mode, settings, car, highlighted);
    await this.setKeyImage(ev, svg);
    this.lastDynamicCar.set(ev.action.id, RaceAdmin.displayCarKey(car, highlighted));
    this.setRegenerateCallback(ev.action.id, () => {
      const currentCar = this.resolveIconCar(ev.action.id, settings);

      return generateRaceAdminSvg(
        settings.mode,
        settings,
        currentCar,
        this.selectorHighlighted(ev.action.id, settings, currentCar),
      );
    });
```

In `refreshDynamicIcon`'s scheduled callback:

```typescript
      const car = this.resolveIconCar(contextId, current);
      const highlighted = this.selectorHighlighted(contextId, current, car);
      const key = RaceAdmin.displayCarKey(car, highlighted);

      if (this.lastDynamicCar.has(contextId) && this.lastDynamicCar.get(contextId) === key) return;

      const svg = generateRaceAdminSvg(current.mode, current, car, highlighted);
```

- [ ] **Step 5: Add an action-level test**

In `race-admin.test.ts` (the selector mock's `generateSelectorSvg` already accepts extra args — extend the mock to record them: `generateSelectorSvg: vi.fn((car, _settings, highlighted) => \`data:selector,${car?.carNumber ?? ""},${highlighted ? "H" : ""}\`)`), add to the focus-intent describe block:

```typescript
      it("highlights the key whose car the camera is on while the intent is active", async () => {
        setSelectIntent("device-1", { action: "focus-camera" });
        // appear a select-car key on device-1 (as in the existing tests), then
        // drive a telemetry tick with CamCarIdx === 5 (the mocked slot car's
        // carIdx) via the captured sdkController.subscribe callback — mirror
        // how the existing dynamic-icon tests fire ticks.

        expect(generateSelectorSvg).toHaveBeenLastCalledWith(
          expect.objectContaining({ carIdx: 5 }),
          expect.anything(),
          true,
        );
      });
```

Copy the tick-driving arrangement from the file's existing telemetry-refresh test (it captures the subscribe callback from the mocked `sdkController`), passing `{ CamCarIdx: 5 }` as the telemetry object.

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/iracing-actions/src/actions/race-admin/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/iracing-actions/src/actions/race-admin/
git commit -m "feat(actions): focused-car highlight on the car-selector grid"
```

---

### Task 7: Switch Profile — clear the intent on every press + marker safety net

**Files:**
- Modify: `packages/iracing-actions/src/actions/switch-profile/switch-profile.ts`
- Test: `packages/iracing-actions/src/actions/switch-profile/switch-profile.test.ts`

**Interfaces:**
- Consumes: `clearSelectIntent` (Task 2), `CAR_SELECTOR_PROFILE` (Task 1), `profileDisplayName` (already imported).

- [ ] **Step 1: Write the failing tests**

In `switch-profile.test.ts` (the deck-core mock at ~line 26: add `CAR_SELECTOR_PROFILE: "iRaceDeck Car Selector",` to the factory's returned object; `profileDisplayName` is already provided there — verify by grep, and if the mock re-implements it, leave as is). Import the real intent module:

```typescript
import { _resetSelectIntents, getSelectIntent, setSelectIntent } from "../../shared/car-select-intent.js";
```

Add tests (mirror the file's existing keyDown/appear event construction):

```typescript
  describe("car-select intent clearing (#790)", () => {
    beforeEach(() => {
      _resetSelectIntents();
    });

    it("clears the pressing device's intent on every press", async () => {
      setSelectIntent("dev-9", { action: "focus-camera" });
      // fire onKeyDown for a key on device "dev-9" (any profile selection)
      expect(getSelectIntent("dev-9")).toBeUndefined();
    });

    it("clears the intent when a non-selector host profile reports visible", async () => {
      setSelectIntent("dev-9", { action: "focus-camera" });
      // fire onWillAppear with settings { hostProfile: "iRaceDeck Replay" } on "dev-9"
      expect(getSelectIntent("dev-9")).toBeUndefined();
    });

    it("keeps the intent when the Car Selector profile itself reports visible", async () => {
      setSelectIntent("dev-9", { action: "focus-camera" });
      // fire onWillAppear with settings { hostProfile: "iRaceDeck Car Selector" } on "dev-9"
      expect(getSelectIntent("dev-9")).toEqual({ action: "focus-camera" });
    });
  });
```

Fill the event arrangements by copying the file's existing onKeyDown / hostProfile tests (they exist for #762 — grep `hostProfile`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/iracing-actions/src/actions/switch-profile/switch-profile.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

In `switch-profile.ts`:
- Add `CAR_SELECTOR_PROFILE` to the `@iracedeck/deck-core` import list and add:

```typescript
import { clearSelectIntent } from "../../shared/car-select-intent.js";
```

- First line of `onKeyDown` (before parsing settings):

```typescript
    // Any profile navigation invalidates a pending car-selection intent
    // (#790): leaving the selector, or entering it via plain navigation,
    // must never leave a stale focus intent behind.
    clearSelectIntent(ev.action.deviceId);
```

- In `sync`, replace the `if (settings.hostProfile) { notifyProfileVisible(…) }` block with:

```typescript
    if (settings.hostProfile) {
      // The bundled profiles carry clean (unsuffixed) marker values; resolve to
      // this device's manifest name so the history holds switchable names
      // (#753). An unresolvable marker is reported as stored.
      const visibleProfile =
        resolveProfileNameForDevice(
          settings.hostProfile,
          ev.action.deviceType,
          availableProfilesForDevice(ev.action.deviceType),
        ) ?? settings.hostProfile;

      notifyProfileVisible(ev.action.deviceId, visibleProfile);

      // Safety net for the car-selection intent (#790): a marker key reporting
      // any profile OTHER than the Car Selector means the user left the grid
      // through a path that didn't go through a Switch Profile press (manual
      // app-side navigation) — drop the pending intent.
      if (profileDisplayName(visibleProfile) !== CAR_SELECTOR_PROFILE) {
        clearSelectIntent(ev.action.deviceId);
      }
    }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/iracing-actions/src/actions/switch-profile/switch-profile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-actions/src/actions/switch-profile/
git commit -m "feat(actions): clear the car-selection intent on profile navigation"
```

---

### Task 8: New camera-focus icon — `focus-select-car.svg`

**Files:**
- Create: `packages/icons/camera-focus/focus-select-car.svg`
- Regenerate: `packages/icons/preview/camera-focus/focus-select-car.svg`, `packages/iracing-actions/src/actions/data/icon-defaults.json`

- [ ] **Step 1: Author the icon**

Create `packages/icons/camera-focus/focus-select-car.svg` — a 2×2 grid of selector keys with the picked key filled and carrying a focus ring, in the camera-focus family style (trimmed viewBox, `{{graphic1Color}}` artwork, standard `#2a3a4a` background):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 68 68" stroke-width="0.5" stroke="#fff" fill="#fff">
  <desc>{"colors":{"backgroundColor":"#2a3a4a","textColor":"#ffffff","graphic1Color":"#ffffff"},"title":{"text":"FOCUS\nPICK CAR"},"border":{"color":"#5a6a7a"}}</desc>

    <rect x="4" y="4" width="26" height="26" rx="5" fill="none" stroke="{{graphic1Color}}" stroke-width="4"/>
    <rect x="38" y="4" width="26" height="26" rx="5" fill="none" stroke="{{graphic1Color}}" stroke-width="4"/>
    <rect x="4" y="38" width="26" height="26" rx="5" fill="none" stroke="{{graphic1Color}}" stroke-width="4"/>
    <rect x="38" y="38" width="26" height="26" rx="5" fill="{{graphic1Color}}" stroke="none"/>
    <circle cx="51" cy="51" r="15" fill="none" stroke="{{graphic1Color}}" stroke-width="3"/>

</svg>
```

Safe SVG Tiny 1.2 features only (rect/circle) — renders on every platform; only Elgato shows it anyway.

- [ ] **Step 2: Regenerate previews and PI defaults**

```bash
node scripts/generate-icon-previews.mjs
node scripts/generate-icon-defaults.mjs
```

Expected: a new `packages/icons/preview/camera-focus/focus-select-car.svg`; `icon-defaults.json` unchanged or trivially updated (commit whatever the scripts produce).

- [ ] **Step 3: Verify the icon freshness test passes**

Run: `npx vitest run packages/icons`
Expected: PASS (preview freshness test sees matching preview).

- [ ] **Step 4: Commit**

```bash
git add packages/icons/ packages/iracing-actions/src/actions/data/icon-defaults.json
git commit -m "feat(icons): focus-select-car camera-focus icon"
```

---

### Task 9: Camera Controls — `focus-select-car` mode

**Files:**
- Modify: `packages/iracing-actions/src/actions/camera-controls/camera-controls.ts`
- Test: `packages/iracing-actions/src/actions/camera-controls/camera-controls.test.ts`

**Interfaces:**
- Consumes: `setSelectIntent` (Task 2); `CAR_SELECTOR_PROFILE`, `requestProfileSwitch`, `resolveProfileNameForDevice` from `@iracedeck/deck-core` (Task 1); `availableProfilesForDevice`, `deviceProfileEntries` from `../race-admin/race-admin-selector.js`; the Task 8 icon.
- Produces: mode value `focus-select-car`; setting `focusSelectorProfile` (string, default `CAR_SELECTOR_PROFILE`); `_deviceProfiles` push for the PI dropdown.

- [ ] **Step 1: Write the failing tests**

In `camera-controls.test.ts`:
- Add the icon mock next to the other camera-focus icon mocks: `vi.mock("@iracedeck/icons/camera-focus/focus-select-car.svg", () => ({ default: "<svg>focus-select-car</svg>" }));` (mirror the exact mock shape of `focus-your-car.svg` in that file).
- Extend the file's deck-core mock factory with: `requestProfileSwitch: vi.fn()`, `resolveProfileNameForDevice: vi.fn((name: string) => \`${name} XL\`)`, `CAR_SELECTOR_PROFILE: "iRaceDeck Car Selector"` (grep the existing mock for what it already provides — only add what's missing).
- Mock the selector helpers:

```typescript
vi.mock("../race-admin/race-admin-selector.js", () => ({
  availableProfilesForDevice: vi.fn(() => ["iRaceDeck Car Selector XL"]),
  deviceProfileEntries: vi.fn(() => [{ name: "iRaceDeck Car Selector XL", label: "iRaceDeck Car Selector" }]),
}));
```

- Import the real intent module and add tests (mirror the file's existing keyDown event construction — it has helpers for events with settings):

```typescript
import { _resetSelectIntents, getSelectIntent } from "../../shared/car-select-intent.js";
import { requestProfileSwitch } from "@iracedeck/deck-core";

describe("focus-select-car mode (#790)", () => {
  beforeEach(() => {
    _resetSelectIntents();
  });

  it("sets the focus intent and switches to the Car Selector profile on page 0", async () => {
    // keyDown with settings { target: "focus-select-car" } on device "dev-1"
    expect(getSelectIntent("dev-1")).toEqual({ action: "focus-camera" });
    expect(requestProfileSwitch).toHaveBeenCalledWith("dev-1", "iRaceDeck Car Selector XL", 0);
  });

  it("does not set an intent when no selector profile resolves for the device", async () => {
    vi.mocked(resolveProfileNameForDevice).mockReturnValue(undefined);
    // keyDown as above
    expect(getSelectIntent("dev-1")).toBeUndefined();
    expect(requestProfileSwitch).not.toHaveBeenCalled();
  });

  it("ignores dial presses for focus-select-car", async () => {
    // dialDown with settings { target: "focus-select-car" }
    expect(requestProfileSwitch).not.toHaveBeenCalled();
    expect(getSelectIntent("dev-1")).toBeUndefined();
  });

  it("generates an icon for the new target", () => {
    const svg = generateCameraControlsSvg({ target: "focus-select-car" });

    expect(svg).toContain("data:image/svg+xml");
  });
});
```

Fill the event arrangements from the file's existing onKeyDown/onDialDown tests.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/iracing-actions/src/actions/camera-controls/camera-controls.test.ts`
Expected: new tests FAIL (unknown target value).

- [ ] **Step 3: Implement**

In `camera-controls.ts`:

1. Imports — extend the `@iracedeck/deck-core` import with `CAR_SELECTOR_PROFILE`, `requestProfileSwitch`, `resolveProfileNameForDevice`; add:

```typescript
import focusSelectCarSvg from "@iracedeck/icons/camera-focus/focus-select-car.svg";
import { availableProfilesForDevice, deviceProfileEntries } from "../race-admin/race-admin-selector.js";
import { setSelectIntent } from "../../shared/car-select-intent.js";
```

2. Add the target value:

```typescript
const FOCUS_TARGET_VALUES = [
  "focus-your-car",
  "focus-on-leader",
  "focus-on-incident",
  "focus-on-most-exciting",
  "focus-select-car",
  "switch-by-position",
  "switch-by-car-number",
  "set-camera-state",
] as const;
```

3. Settings schema — add to `CameraControlsSettings`:

```typescript
  // focus-select-car (#790): the profile the press switches to. May hold a
  // device-suffixed manifest name, a legacy name, or a name suffixed for
  // another device — resolved at press time.
  focusSelectorProfile: z.string().default(CAR_SELECTOR_PROFILE),
  /**
   * Runtime-populated list of profiles available for this button's device,
   * pushed for the PI dropdown as `{ name, label }` entries (#753 shape).
   * Not user-editable.
   */
  _deviceProfiles: z.array(z.union([z.string(), z.object({ name: z.string(), label: z.string() })])).optional(),
```

4. Icon + title maps:

```typescript
  "focus-select-car": focusSelectCarSvg,   // in FOCUS_ICONS
  "focus-select-car": "FOCUS\nPICK CAR",  // in FOCUS_TITLES
```

5. Add the `profileEntriesEqual` helper (module level, above the class — same one Race Admin / Switch Profile carry):

```typescript
/** Whether a persisted `_deviceProfiles` value already equals the entries we'd push. */
function profileEntriesEqual(
  current: readonly unknown[],
  entries: readonly { name: string; label: string }[],
): boolean {
  return (
    current.length === entries.length &&
    current.every((value, i) => {
      const entry = entries[i];

      return (
        typeof value === "object" &&
        value !== null &&
        (value as { name: string }).name === entry.name &&
        (value as { label: string }).label === entry.label
      );
    })
  );
}
```

6. Dispatch. In `onKeyDown`, before the existing branches:

```typescript
    if (settings.target === "focus-select-car") {
      await this.executeFocusSelectCar(ev, settings);

      return;
    }
```

In `onDialDown`, before the existing branches (keypad-only, like the selector itself):

```typescript
    if (settings.target === "focus-select-car") return;
```

7. Add the method (after `executeFocus`):

```typescript
  /**
   * focus-select-car press (#790): arm the per-device focus intent and open
   * the Car Selector profile — each car press there focuses the camera and
   * stays on the grid; the grid's Back key returns here. The intent is only
   * set when a selector profile actually resolves for this device, so a
   * device without bundled profiles never carries a dangling intent.
   */
  private async executeFocusSelectCar(
    ev: IDeckKeyDownEvent<CameraControlsSettings>,
    settings: CameraControlsSettings,
  ): Promise<void> {
    const stored = settings.focusSelectorProfile.trim() || CAR_SELECTOR_PROFILE;
    const available = availableProfilesForDevice(ev.action.deviceType);
    const profile =
      resolveProfileNameForDevice(stored, ev.action.deviceType, available) ??
      resolveProfileNameForDevice(CAR_SELECTOR_PROFILE, ev.action.deviceType, available);

    if (!profile) {
      this.logger.warn(
        `No car-selector profile available for device ${ev.action.deviceId ?? "(unknown)"}; ignoring press`,
      );

      return;
    }

    setSelectIntent(ev.action.deviceId, { action: "focus-camera" });
    this.logger.info("Focus car selector opened");
    this.logger.debug(`Switching device ${ev.action.deviceId ?? "(unknown)"} to profile "${profile}"`);
    // Page 0: named switches always open a profile on its first page (#754).
    await requestProfileSwitch(ev.action.deviceId, profile, 0);
  }
```

8. `_deviceProfiles` push. Add the method and call it from BOTH `onWillAppear` and `onDidReceiveSettings` (right after `this.activeContexts.set(…)`):

```typescript
  /**
   * Push the device-filtered profile list for the focus-select-car PI dropdown
   * (guarded against the setSettings→onDidReceiveSettings echo loop by only
   * writing on change — the Switch Profile pattern).
   */
  private async pushDeviceProfiles(
    ev: IDeckWillAppearEvent<CameraControlsSettings> | IDeckDidReceiveSettingsEvent<CameraControlsSettings>,
    settings: CameraControlsSettings,
  ): Promise<void> {
    if (settings.target !== "focus-select-car") return;

    const entries = deviceProfileEntries(ev.action.deviceType);
    const raw = (ev.payload.settings ?? {}) as Record<string, unknown>;
    const current = Array.isArray(raw._deviceProfiles) ? (raw._deviceProfiles as unknown[]) : [];

    if (profileEntriesEqual(current, entries)) return;

    try {
      await ev.action.setSettings({ ...raw, _deviceProfiles: entries });
    } catch (err) {
      this.logger.warn(`Failed to push device profiles: ${err instanceof Error ? err.message : err}`);
    }
  }
```

Call sites: `await this.pushDeviceProfiles(ev, settings);` in both lifecycle handlers.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/iracing-actions/src/actions/camera-controls/camera-controls.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-actions/src/actions/camera-controls/
git commit -m "feat(actions): Camera Controls focus-select-car mode opens the Car Selector with a focus intent"
```

---

### Task 10: Camera Controls PI — mode option + profile dropdown

**Files:**
- Modify: `packages/iracing-actions/src/actions/camera-focus/camera-focus.ejs`

- [ ] **Step 1: Add the gated mode option**

At the top of `<body>` (after the section-header include), add the gate variable, then the option inside the Mode `<sdpi-select>` after `focus-on-most-exciting`:

```ejs
	<%# The car-selector focus mode rides on Stream Deck profiles, so it is gated to Elgato (see platform-feature-flags.md). %>
	<% var showFocusSelectCar = locals.platform?.features?.profiles !== false; %>
```

```ejs
				<option value="focus-on-most-exciting">Focus on Most Exciting</option>
				<% if (showFocusSelectCar) { %>
				<option value="focus-select-car">Focus Car (pick from grid)</option>
				<% } %>
```

- [ ] **Step 2: Add the hidden profile setting**

After the `camera-state-item` sdpi-item, add:

```ejs
		<% if (showFocusSelectCar) { %>
		<div id="focus-select-car-section" class="hidden">
			<sdpi-item label="Selector Profile">
				<ird-profile-select setting="focusSelectorProfile" profiles="_deviceProfiles" placeholder="Default (iRaceDeck Car Selector)"></ird-profile-select>
			</sdpi-item>
			<div class="ird-supporting-text">
				Opens the Car Selector profile with one key per car in the session. Press a car to focus the camera on it — the selector stays up so you can hop car to car; its Back key returns here.
			</div>
		</div>
		<% } %>
```

- [ ] **Step 3: Wire visibility**

In the `updateVisibility(target)` function inside the page's `<script>`, add alongside the other toggles:

```javascript
					var focusSelectCarSection = document.getElementById("focus-select-car-section");
					if (focusSelectCarSection) {
						focusSelectCarSection.classList.toggle("hidden", target !== "focus-select-car");
					}
```

- [ ] **Step 4: Build the Stream Deck plugin to compile the PI and eyeball the HTML**

```bash
pnpm --filter @iracedeck/iracing-plugin-stream-deck build
grep -c "focus-select-car" "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/ui/camera-focus.html"
```

Expected: build succeeds; grep count ≥ 3 (option, section id, visibility JS). Also verify the Mirabox PI omits it: `grep -c "focus-select-car" packages/iracing-plugin-mirabox/*/ui/camera-focus.html` after `pnpm --filter @iracedeck/iracing-plugin-mirabox build` → `0` (option gated out; the JS toggle line may remain — the null-check makes it inert — so grep the `<option` line specifically if needed).

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-actions/src/actions/camera-focus/camera-focus.ejs
git commit -m "feat(pi): focus-select-car mode option + selector-profile dropdown (Elgato only)"
```

---

### Task 11: Docs, rules, skills, website, changelog, counts

**Files:**
- Modify: `.claude/rules/profiles-and-devices.md`, `.claude/rules/global-settings.md`
- Modify: `.claude/skills/iracedeck-actions/SKILL.md`, `docs/reference/actions.json`
- Modify: `packages/website/src/content/docs/docs/features/stream-deck-profiles.md`, `…/docs/actions/stream-deck/switch-profile.md`, `…/docs/actions/communication/race-admin.md`, the Camera Controls action page (find it: `grep -rl "Focus on Most Exciting" packages/website/src/content/docs/docs/actions/`), `…/docs/actions/overview.md`, `packages/website/src/content/docs/index.mdx`, `packages/website/src/content/docs/changelog.mdx`, `README.md`

- [ ] **Step 1: Rules**

`profiles-and-devices.md` — replace every `iRaceDeck Race Admin Cars` with `iRaceDeck Car Selector` (bundled-templates list, #732 selector section, bundle names). In the "Race Admin car selector (#732)" section, append a short paragraph:

> **Focus intent (#790).** The selector is a generic pick-a-car surface: an in-memory per-device intent (`packages/iracing-actions/src/shared/car-select-intent.ts`) set by the entry key decides what a car press means. Camera Controls' `focus-select-car` mode sets `{ action: "focus-camera" }` and opens the selector; with the intent active a press focuses the camera (`camera.switchNum(raw, 0, 0)`) and stays on the grid (the key whose car matches `CamCarIdx` renders a green highlight ring); without it the press is the legacy admin flow. Every Switch Profile press clears the device's intent, as does a host-profile marker reporting a non-selector profile. Legacy profile names resolve via `LEGACY_PROFILE_NAMES` in `device-profiles.ts`; the selection key is `_selectedCar` (legacy `_raceAdminSelectedCar` read as fallback).

`global-settings.md` — update the `_raceAdminSelectedCar` mention (grep for it) to `_selectedCar` with a note that the legacy key is read as fallback.

- [ ] **Step 2: Skill + actions.json**

`.claude/skills/iracedeck-actions/SKILL.md`:
- Category table: View & Camera modes `88` → `89`; total modes `298` → `299`.
- Camera Controls row: modes `12` → `13`; append `focus-select-car (Elgato-only: opens the iRaceDeck Car Selector profile with a focus intent; car presses focus the camera and stay on the grid)` to its mode values.
- Race Admin row + Stream Deck row: rename `iRaceDeck Race Admin Cars` mentions to `iRaceDeck Car Selector`.

`docs/reference/actions.json`: add to the `com.iracedeck.sd.core.camera-focus` entry's `modes` array:

```json
{ "value": "focus-select-car", "label": "Focus Car (pick from grid)", "description": "Opens the iRaceDeck Car Selector profile with a focus intent — pressing a car key focuses the camera on that car and stays on the grid (Elgato Stream Deck only)." }
```

- [ ] **Step 3: Website pages**

- `stream-deck-profiles.md`: rename the bundled-profiles bullet to **iRaceDeck Car Selector**, describing both uses (race-control target picking AND camera focus from the Replay profile).
- `switch-profile.md`: key-icon example `RACE ADMIN CARS` → `CAR SELECTOR`.
- `race-admin.md`: rename all `iRaceDeck Race Admin Cars` references (Select Car section + the "run race control on one car at a time" workflow).
- Camera Controls page: add a `### Focus Car (pick from grid)` mode section following the page's existing per-mode format (`#### Details`: Method `iRacing API` — the camera switch; Dial `No rotation support`; Default binding `No keyboard binding`; Telemetry-aware icon `No`), with `#### Setting: Selector Profile` documenting the default (`iRaceDeck Car Selector`) and the Elgato-only scope. Update the page's mode-count badge if it has one.
- `overview.md`: total modes `266` → `267`; View & Camera row modes +1.
- `index.mdx`: stats row Modes `266` → `267`.
- `README.md`: `264+` → `265+` modes; View & Camera row modes +1.

- [ ] **Step 4: Changelog (edit existing lines — same unreleased release)**

In `changelog.mdx` under `## 1.24.0` (Unreleased): the car selector and profiles shipped in THIS version, so per the one-change-one-line rule EDIT the existing bullets rather than adding rename notes:
- In the profiles Features bullet and the Race Admin car-selector Features bullet, replace `**iRaceDeck Race Admin Cars**` with `**iRaceDeck Car Selector**` (keep `Per Car` as is).
- Append one new Features bullet after the car-selector one:

> - The Car Selector doubles as a camera director (Elgato): a new Camera Controls mode — **Focus Car (pick from grid)** — opens the selector with one key per car, and each press focuses the camera on that car. You stay on the grid to hop car to car, the key of the car you're watching is highlighted, and the Back key returns you to where you came from — ideal alongside the Replay profile.

- [ ] **Step 5: Verify the website builds**

```bash
pnpm --filter @iracedeck/website build
```

Expected: build passes.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: rename Car Selector profile across docs/website/skills and document the focus flow"
```

---

### Task 12: Full verification gate

- [ ] **Step 1: Full install + build + test** (quit UlanziStudio / Stream Deck first if the native build hits EPERM)

```bash
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-790"
pnpm install && pnpm build && pnpm test
```

Expected: all green. (`pnpm build` matters — vitest's esbuild is more permissive than tsc.)

- [ ] **Step 2: Lint + format**

```bash
pnpm lint:fix && pnpm format:fix
git status --short
```

Commit any fixups: `git add -A && git commit -m "chore: lint/format fixups"` (skip if clean).

- [ ] **Step 3: Grep for stragglers**

```bash
grep -rn "Race Admin Cars" --include="*.ts" --include="*.ejs" --include="*.json" --include="*.md" packages .claude docs README.md | grep -v "legacy\|Legacy\|pre-#790\|changelog-archive"
```

Expected: only deliberate legacy-compat mentions (the alias map, PROFILE_ICONS legacy row, test fixtures for legacy resolution, historical changelog sections for already-released versions). Fix anything else.

---

## Manual steps (Niklas — after code review, before release)

Not automatable; the plugin-side rename is complete without them (the legacy alias keeps everything working), but the app's profile list shows the old user-facing name until the bundles are re-exported:

1. In the Stream Deck app, re-author/re-export per `.claude/rules/profiles-and-devices.md` authoring workflow:
   - **Car Selector** (SD + XL): rename the internal profile name to `iRaceDeck Car Selector`, update every Switch Profile key's *Placed in profile* marker to the new name, export, rename files to `iRaceDeck Car Selector SD/XL.streamDeckProfile`, replace the ones in the plugin folder.
   - **Default** (SD + XL): retarget its Switch Profile key from `iRaceDeck Race Admin Cars` to `iRaceDeck Car Selector`, re-export, replace.
   - **Replay** (SD + XL): add a Camera Controls key in `Focus Car (pick from grid)` mode, re-export, replace.
   (No Plus XL bundles exist yet — SD and XL only.)
2. Hardware validation: Replay → Focus Car key → grid appears with cars → press several cars (camera follows, watched car highlighted, grid stays) → Back → Replay. Then the admin flow unchanged: Default → Car Selector → press car → Per Car targets it.
3. Only after the manual iRacing test passes: push + PR (`feat(actions): generalize the car selector — rename profile + camera-focus flow (#790)`).
