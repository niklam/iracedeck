# Class position support in Session Info position mode (#234)

## Summary

Add a `positionType` setting to the Session Info action's **Position** mode so users
can display their **class** position in multi-class races, not just overall race
position. Class position is the default. Both render with the `P` prefix; the
optional "Show Total Cars" count is scoped to the chosen type (overall field size
vs. cars in the player's class).

## Motivation

Issue #234: in multi-class races, overall position is noise — drivers care about
where they sit within their own class. The position mode currently only shows
overall race position.

## Decisions (settled during brainstorming)

- **Setting:** `positionType: "class" | "overall"`, default **`"class"`**.
- **Class semantics — explicit:** when "Class" is selected the action always shows
  class position, even in a single-class race (where the class rank equals the
  overall rank — only the scoped total differs).
- **Display format — `P` prefix for both.** Class does not get a distinct prefix;
  it differs only in which position number and which total are shown:
  - Overall → `P5` / `P5/24` (overall field size)
  - Class → `P2` / `P2/8` (cars in the player's class)
- **Sourcing — Approach B (adopt `getLivePosition()`).** In a race, on track, the
  numbers come from `@iracedeck/sim-events-iracing`'s `getLivePosition()`, which
  returns the **frozen** overall race position (#603 — handles blipped / retired /
  teleported cars) and a **live class position derived from that same frozen
  order**. This deliberately upgrades the existing on-track-race **overall** number
  to the frozen calc so the button matches the Race Engineer's voice.
- **Class is derived, not read from iRacing's official field (follow-up).** The
  first implementation took class position from iRacing's `PlayerCarClassPosition`,
  but that field only refreshes at the start/finish line, so the (default) class
  display looked frozen between crossings. There is no existing function that
  computes a *live* class position — every existing class source is the official
  field. So `getLivePosition().classPosition` now reuses the **existing** overall
  order (`calculateFrozenRacePositions`) and counts same-class cars (`CarIdxClass`)
  ranked ahead — the new `classPositionFromOrder` glue in `@iracedeck/iracing-sdk`,
  the same counting `resolveStartingClassPosition` (#599) does for the grid. It
  falls back to `PlayerCarClassPosition` only when `CarIdxClass` is unavailable.
  Because the Race Engineer also reads `getLivePosition().classPosition`, its spoken
  class position becomes live too (overtake *detection* in `diffOvertakes` is
  unchanged — it still reads `PlayerCarClassPosition` directly).

## Architecture

The whole change lives in the shared `@iracedeck/iracing-actions` package plus its
PI template and the docs. No new global setting, no plugin wiring, no manifest /
icon changes. Both plugins (Stream Deck + Mirabox) inherit it automatically because
they register the same action and compile the same shared PI template.

### Data sources

`@iracedeck/sim-events-iracing` already exports `getLivePosition(): LivePosition | null`:

```ts
type LivePosition = {
  position: number;      // 1-based frozen overall race position (#603)
  classPosition: number; // 1-based, derived from the frozen order via classPositionFromOrder;
                         // falls back to PlayerCarClassPosition; 0 when unavailable
  isMultiClass: boolean;
};
```

It is a translator-singleton read (no args) and returns `null` when telemetry /
session info / player car index aren't resolvable, or the computed overall
position is 0 (inactive). It is **not** session-type aware — its `position` is the
on-track lap-order, which is *not* the standings in practice/qualifying — so it is
gated to race sessions only.

`@iracedeck/iracing-actions` already declares `@iracedeck/sim-events-iracing` as a
dependency, so the import adds no new package coupling.

## Detailed behavior

### Settings schema (`session-info.ts`)

Add to `SessionInfoSettings`:

```ts
positionType: z.enum(["class", "overall"]).default("class"),
```

### Position branch of `extractDisplayValue`

Replace the current position branch with logic that resolves both an overall and a
class number, then picks based on `positionType`:

```text
isClass = settings.positionType === "class"

if isRaceSession(telemetry):
  if telemetry.OnPitRoad:                      # keep existing pit special-case
    overall = telemetry.PlayerCarPosition
    klass   = telemetry.PlayerCarClassPosition
  else:
    live    = getLivePosition()                # singleton; null when unavailable
    overall = (live && live.position > 0)      ? live.position      : telemetry.PlayerCarPosition
    klass   = (live && live.classPosition > 0) ? live.classPosition : telemetry.PlayerCarClassPosition
else:                                          # non-race: standings, not lap order
  overall = telemetry.PlayerCarPosition
  klass   = telemetry.PlayerCarClassPosition

pos = isClass ? klass : overall

if pos === undefined: return settings.positionShowTotal ? "P-/-" : "P-"

if settings.positionShowTotal:
  total = isClass ? countActiveDriversInPlayerClass(sessionInfo)
                  : countActiveDrivers(sessionInfo)        # existing
  return total > 0 ? `P${pos}/${total}` : `P${pos}`

return `P${pos}`
```

Notes:
- The `no telemetry` early-return block already produces `P-` / `P-/-`; it stays as
  is (the `P` prefix is shared by both types).
- `getLivePosition()` is called only in the race + on-track branch. Pits and
  non-race read official telemetry, preserving today's overall-in-pits behavior.
- Class position from `getLivePosition().classPosition` is identical to
  `PlayerCarClassPosition` — the official field — so class is authoritative in all
  branches.

### New helper (`session-info.ts`, `@internal` for testing)

```ts
export function countActiveDriversInPlayerClass(sessionInfo: SessionInfo | null): number
```

- Resolve the player's `CarClassID` from `DriverInfo.Drivers` (match
  `CarIdx === DriverInfo.DriverCarIdx`).
- Count drivers sharing that `CarClassID`, excluding pace car (`CarIsPaceCar === 1`)
  and spectators (`IsSpectator === 1`) — same filter as `countActiveDrivers`.
- Return `0` when the player's class can't be resolved (so the `/total` is dropped,
  mirroring the overall path's `total > 0` guard).

The action wraps it in a private `countCarsInPlayerClass()` paralleling the existing
`countActiveCars()`.

### Property Inspector (`session-info.ejs`)

Add a Position Type dropdown inside the existing `#position-settings` group (which is
already shown/hidden by the position-mode visibility JS — no new wiring), placed
above "Show Total Cars":

```html
<sdpi-item id="position-type-settings" label="Position Type" class="hidden">
  <sdpi-select setting="positionType" default="class">
    <option value="class">Class</option>
    <option value="overall">Overall</option>
  </sdpi-select>
</sdpi-item>
```

Extend `updateVisibility()` to toggle `#position-type-settings` on `mode === "position"`
alongside the existing `#position-settings`.

## Files touched

1. `packages/iracing-actions/src/actions/session-info/session-info.ts`
   - `positionType` schema field
   - rewritten position branch in `extractDisplayValue`
   - `countActiveDriversInPlayerClass` helper + private `countCarsInPlayerClass()`
   - `getLivePosition` import from `@iracedeck/sim-events-iracing`
2. `packages/iracing-actions/src/actions/session-info/session-info.ejs`
   - Position Type dropdown + visibility toggle
3. `packages/iracing-actions/src/actions/session-info/session-info.test.ts`
   - mock `@iracedeck/sim-events-iracing` `getLivePosition`
   - rewrite on-track-race position tests to the new source
   - add: default-is-class, class number, class total, overall unchanged, fallback paths
   - extend the `CommonSettings` mock defaults/coercion with `positionType`
4. `packages/website/src/content/docs/docs/actions/display-session/session-info.md`
   - document the Position Type setting under the Position mode
5. `docs/reference/actions.json`
   - tweak the `position` mode description to mention class/overall

Not touched: no new global setting (`deck-core`), no `plugin.ts` (both plugins), no
`manifest.json`, no icons, no `README` (not a new action or mode — mode count stays
7). Compiled `ui/*.html` is gitignored build output (regenerated by build, never
committed).

## Testing strategy

Unit tests (Vitest) in `session-info.test.ts`:

- **Schema:** `positionType` defaults to `"class"`; parses `"overall"`.
- **Class, race, on track:** `getLivePosition()` returns `{ classPosition: 2, ... }`
  → renders `P2`; with Show Total and a 8-car class → `P2/8`.
- **Overall, race, on track:** uses `getLivePosition().position` (frozen) → `P5`;
  with Show Total → `P5/24`.
- **Pits:** class → `PlayerCarClassPosition`; overall → `PlayerCarPosition`
  (getLivePosition not consulted).
- **Non-race:** both read official telemetry.
- **Fallbacks:** `getLivePosition()` null → official; `classPosition === 0` →
  `PlayerCarClassPosition`.
- **`countActiveDriversInPlayerClass`:** mixed-class driver list, pace-car /
  spectator exclusion, unresolved player class → 0, null session info → 0.
- **Placeholders:** no telemetry → `P-` / `P-/-` for both types.

`getLivePosition` is mocked via `vi.mock("@iracedeck/sim-events-iracing", ...)`; the
existing real `@iracedeck/iracing-sdk` mock stays for `calculateRacePositions` /
enums used elsewhere.

## Verification

```bash
pnpm install
pnpm build        # tsc — catches type issues vitest's esbuild path misses
pnpm test
pnpm lint:fix
pnpm format:fix
```

Then manual iRacing test (multi-class session: confirm class vs overall numbers and
scoped totals) before any push / PR.

## Out of scope / non-goals

- No calculated (hand-rolled) class position — `PlayerCarClassPosition` is
  authoritative and the codebase's established class source.
- No adaptive class/overall switching — "Class" is explicit per the brainstorming
  decision.
- No new distinct prefix for class (`P` shared) — per the brainstorming decision.
- No change to other Session Info modes.
