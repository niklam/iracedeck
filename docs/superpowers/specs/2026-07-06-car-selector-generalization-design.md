# Car Selector generalization — rename + camera-focus flow — Design

**Issue:** not filed yet (create before implementation; the branch/worktree takes its number).

**Goal:** Turn the Race Admin car-selector grid into a generic "pick a car" surface. The bundled profile `iRaceDeck Race Admin Cars` is renamed to **`iRaceDeck Car Selector`**, and a new flow lets the user focus the replay camera on a picked car, initiated from the Replay profile. Race admin remains the default behavior, fully backward compatible.

## Approved decisions

| Question | Decision |
|----------|----------|
| Scope | Generic pick-a-car surface; race admin and camera focus now, future consumers possible |
| Mechanism | Selection **intent** set by the entry key; no intent = legacy race-admin behavior |
| Focus flow after pick | Camera focuses immediately; **stay on the grid** to hop car-to-car; Back returns to Replay |
| Profile name | `iRaceDeck Car Selector` (matches existing "car selector" terminology) |
| Entry key | New **Camera Controls** mode ("Focus Car — pick from grid") |
| Code structure | `select-car` stays a Race Admin mode (approach C): no new action UUID, state keys renamed generically |
| Shared state | Focus presses do **not** write the selection; only the admin (no-intent) press does |
| Polish | Highlight the currently focused car (`CamCarIdx`) on the grid while a focus intent is active |

## Architecture

### The two flows

- **Admin (unchanged):** Switch Profile key → Car Selector grid → press a car → selection stored → switch to `iRaceDeck Race Admin Per Car` → commands target it.
- **Focus (new):** Replay profile → Camera Controls "Focus Car" key → sets a focus intent for that device and switches to the Car Selector profile (page 0) → each car press calls `getCommands().camera.switchNum(carNumberRaw, 0, 0)` — group 0 / camera 0 keeps the current camera, with the same padded-car-number handling as Replay Control's driver walk — and stays on the grid → the grid's Back key returns to Replay.

### Selection intent — in-memory, per device

A new shared module `packages/iracing-actions/src/actions/car-select-intent.ts` holds a `Map<deviceId, SelectIntent>` with `SelectIntent = { action: "focus-camera" }` (extensible record). All actions run in one plugin process, so no persistence is needed.

**Deliberately in-memory, not a `_`-prefixed global setting:** a restart can never resurrect a stale intent, nothing transient lands in persisted settings, and multi-device setups stay independent.

Lifecycle:

- **Set** by the Camera Controls entry mode, immediately before its `requestProfileSwitch`.
- **Read** by `select-car` keys at press time (dispatch branch) and render time (highlight).
- **Cleared** by every Switch Profile press on that device (named switch and Back) — leaving the grid or entering it via plain navigation always drops a lingering intent. Optional safety net, included only if `profile-switcher.ts` can expose a visibility callback without restructuring: clear when a `notifyProfileVisible` report shows a non-Car-Selector profile on the device (covers manual app-side profile changes). Skipping it is acceptable — the Switch Profile clearing rule already covers every bundled navigation path.

### Selection state rename

`SELECTED_CAR_KEY` changes from `_raceAdminSelectedCar` to **`_selectedCar`** (still a passthrough key, no schema field). Writes go to the new key only; reads fall back to the legacy key when the new one is absent (single `??`), so an in-flight selection survives a mid-session plugin upgrade. The existing carIdx↔carNumber staleness guard (`resolveSelectedCar`) is unchanged.

## Profile rename & migration

### Legacy-name alias

`deck-core/src/device-profiles.ts` gains a legacy map, consulted by `resolveProfileNameForDevice` after suffix-stripping:

```typescript
const LEGACY_PROFILE_NAMES: Record<string, string> = {
  "iRaceDeck Race Admin Cars": "iRaceDeck Car Selector",
};
```

So a stored `iRaceDeck Race Admin Cars XL` (or the bare legacy display name) resolves to this device's `iRaceDeck Car Selector <suffix>` manifest name. Unknown names still return `undefined`. `DEFAULT_SELECTOR_TARGET_PROFILE` (`iRaceDeck Race Admin Per Car`) and the Per Car profile are untouched.

### Bundles to re-author/re-export in the Stream Deck app (manual)

1. **Car Selector** (SD, XL): internal name renamed; host-profile markers updated to the new name; export as `iRaceDeck Car Selector SD/XL.streamDeckProfile`.
2. **Default** (SD, XL, Plus XL): Switch Profile key retargeted to the new name.
3. **Replay** (SD, XL, Plus XL): add the new Camera Controls focus-entry key.
4. Update `manifest.json` `Profiles[]` to the new file names; run `pnpm generate:action-profiles`.

## Code changes by package

- **`deck-core/device-profiles.ts`** — legacy alias map + resolution, tests in `device-profiles.test.ts`.
- **`iracing-actions/race-admin/`** — key rename with read fallback; press dispatch: focus intent → resolve slot car → `camera.switchNum`, no selection write, no profile switch; no intent → legacy path. `generateSelectorSvg` gains a `highlighted` input (border highlight); the action compares each slot car's `carIdx` to telemetry `CamCarIdx` on its existing tick-driven re-render while a focus intent is active.
- **`iracing-actions/camera-controls/`** — new mode `focus-select-car` ("Focus Car — pick from grid"): PI `ird-profile-select` target (default display name `iRaceDeck Car Selector`), Elgato-gated via the `profiles` platform feature flag (same as select-car); press sets the intent and calls `requestProfileSwitch(deviceId, <resolved name>, 0)`; mode icon; comms-catalog entry (`api`) + `pnpm generate:action-comms`.
- **`iracing-actions/switch-profile/`** — clear the pressing device's intent on every press; `PROFILE_ICONS` adds `"iRaceDeck Car Selector"` (icon file renamed `race-admin-cars.svg` → `car-selector.svg`) and keeps the legacy display name mapped to the same icon for old keys.
- **New** `iracing-actions/src/actions/car-select-intent.ts` — set/get/clear per device.

No new action UUID; plugin `manifest.json` action entries unchanged (only the Elgato `Profiles[]` block changes). Mirabox/Ulanzi unaffected: both new behaviors sit behind the Elgato-only `profiles` gating and `switchToProfile` is a no-op there.

## Error handling & edge cases

- **Focus press fails** (`camera.switchNum` returns `false`): warn log (car number at debug), `showAlert` on the pressed key where supported; no state change, no switch.
- **Empty slot press** with focus intent: no-op (as in the admin flow today).
- **Not connected:** existing `ConnectionStateAwareAction` handling; no special casing.
- **Stale intent:** impossible across restarts (in-memory); cleared by any Switch Profile press; `notifyProfileVisible` safety net covers manual app-side switches.
- **Session change on the grid:** slot cars re-resolve every render as today; the highlight just follows `CamCarIdx`.

## Tests

- `car-select-intent.test.ts` — set/get/clear, per-device independence.
- `device-profiles.test.ts` — legacy alias resolution (bare + suffixed legacy names → new manifest names; unknown names → `undefined`).
- `race-admin` tests — intent press: `switchNum` called, no selection write, no switch; no-intent press: legacy path; `_raceAdminSelectedCar` read fallback; highlight on/off render.
- `camera-controls` tests — new mode sets intent + requests switch with page 0; comms freshness test.
- `switch-profile` tests — press clears the device's intent; new + legacy icon mapping.

## Artifacts to update (same PR)

- Rules: `.claude/rules/profiles-and-devices.md` (names, flows), `.claude/rules/global-settings.md` (`_selectedCar` reference).
- Docs: Race Admin + Camera Controls action docs; website action pages; changelog entry (`changelog.mdx`, in-development section).
- Skills: `iracedeck-actions` (new Camera Controls mode).

## Manual validation (cannot be unit-tested)

Profile bundles import and switch correctly in the Stream Deck app; full loop on hardware: Replay → Focus Car key → grid with highlight → hop several cars → Back → Replay. No push/PR before this manual iRacing test passes.
