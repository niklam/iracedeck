# Estimated iRating gain/loss — Session Info mode + template variables (#268)

## Summary

Show the driver's **estimated iRating change** ("if the race ended now") on a Stream Deck
key and expose the same data as template variables. The estimate uses the
community-documented Elo-style formula over the field's iRatings (from
`SessionInfo.DriverInfo.Drivers`) and the canonical live running order. Two surfaces:

1. **Session Info → new `irating` mode** — shows `+31` (green) / `-15` (red) / `0`
   (neutral), blank when no estimate is possible.
2. **Template variables** — `irating_change` and `irating_new` on every driver prefix
   (`self`, `race_ahead`, `race_behind`, `track_ahead`, `track_behind`, `focused`) plus
   `session.sof` (Strength of Field of the player's class). Usable in Telemetry
   Display / Chat / Race Admin, including `{{= … }}` expressions.

Post-race *official* iRating change is not available in the real-time SDK; this is an
estimate and is documented as such.

## Decisions (settled during brainstorming)

- **Display surface: Session Info mode**, not a new action (the issue's original
  new-action plan predates the current architecture). No new manifests, PI template,
  icons, or action-count churn; both plugins inherit the mode automatically.
- **Template variables: all three** — `irating_change` (all driver prefixes),
  `irating_new` (all driver prefixes; projected `irating + change`), `session.sof`.
- **Architecture: pure calculator in `@iracedeck/iracing-sdk`** (`irating-utils.ts`,
  beside `position-utils.ts`). The template context and the Session Info action both
  call it. No `SDKController` changes, no new injected providers, no plugin wiring.
- **Value shown pre-green**: as soon as a live order exists in a race session the value
  renders (delta for finishing where you currently run). **Implementation reality:** the
  canonical order only classifies cars once `CarIdxLapCompleted >= 0` (crossing the line
  to begin lap 1), so the key is blank on the grid and through the pace lap and populates
  as the field takes the green. Seeding the pre-green order from the qualifying grid would
  need translator support and is deferred as a possible follow-up.

## The formula

Reference implementation: [Turbo87/irating-rs](https://github.com/Turbo87/irating-rs)
(MIT/Apache-2.0), itself derived from the iRacing SOF/iRating calculator spreadsheet.

- `BR = 1600 / ln(2)`
- `chance(a, b)` — probability the driver rated `a` beats the driver rated `b`:
  `((1 − e^(−a/BR)) · e^(−b/BR)) / ((1 − e^(−b/BR)) · e^(−a/BR) + (1 − e^(−a/BR)) · e^(−b/BR))`
- Expected score of driver *i*: `Σⱼ chance(irᵢ, irⱼ) − 0.5` (the self-pair contributes 0.5)
- Change for driver at class rank `p` in a class field of `n` (all cars treated as
  starters for the live estimate):
  `change = ((n − p) − expectedScore − fudge) × 200 / n` with the reference
  implementation's linear fudge term.
- `SOF = BR × ln(n / Σ e^(−irᵢ/BR))`

Exact constants and the fudge term are locked at implementation time against the
reference implementation's published test vectors (28-driver field with known
outputs), which become our unit-test fixtures. Values are rounded to the nearest
integer for display; raw values stay unrounded.

## Semantics & edge cases

- **Field definition**: cars present in the canonical live order (rank > 0), excluding
  the pace car (`CarIsPaceCar === 1`) and spectators (`IsSpectator === 1`), with a
  valid iRating (`IRating > 0`). Cars without a valid iRating are excluded from the
  math entirely (they neither gain nor cost points in the estimate).
- **Multiclass**: iRacing scores each class separately. The calculator groups cars by
  `CarIdxClass` and computes within each class, using class-relative rank derived from
  the same canonical order (never a second ordering — see
  `.claude/rules/race-positions.md`). Every driver prefix gets the value computed
  within *that car's* class. `session.sof` is the **player's class** SOF.
- **DNF / tow / disconnect**: the frozen canonical order pins retired cars at their
  last-known rank; they stay in the field at that position (mirrors iRacing — you keep
  your retirement position and others pass you). Cars that never entered the world are
  absent from the order and excluded.
- **When blank**: non-race sessions (practice/qual/test), no live order yet, player
  (or the prefix's car) not in the field, or fewer than 2 cars in the class field.
  Blank means empty string in template display form and `null` in raw form; the
  Session Info key renders an empty value area (mode label still visible).
- **Update cadence**: the calculator memoizes on its inputs (order + iRatings +
  classes signature); the O(n²) pairwise math re-runs only when positions actually
  change. Session Info's state-key dedupe and Telemetry Display's 10 Hz throttle
  already prevent icon churn.

## Architecture

### New module: `packages/iracing-sdk/src/irating-utils.ts`

Pure functions, no imports from higher layers. The canonical order arrives as a
function argument (injected data, per the race-positions dependency rule).

```ts
/** SOF of a set of iRatings (1600/ln 2 log-mean). */
export function calculateSof(iratings: number[]): number;

export interface IRatingEstimateInput {
  /** Canonical live order: 1-based rank by carIdx, 0 = not classified. */
  order: number[];
  /** Per-car class id (telemetry CarIdxClass). */
  classes: number[];
  /** Per-car iRating by carIdx; null/<=0 = no valid rating (excluded). */
  iratings: (number | null)[];
  /** Per-car exclusion (pace car, spectator). */
  excluded: boolean[];
}

export interface IRatingEstimates {
  /** Estimated change by carIdx; null when the car is not in the field. */
  changes: (number | null)[];
  /** SOF by class id for each class that formed a field. */
  sofByClass: Map<number, number>;
}

export function estimateIRatingChanges(input: IRatingEstimateInput): IRatingEstimates;
```

A single-entry memo keyed on a cheap string signature of the inputs makes repeated
per-tick calls free until the order/field changes.

Exported from the package index beside `position-utils`.

### Consumer 1 — template context (`iracing-sdk/src/template-context.ts`)

`buildTemplateContextFromData` already has everything: `extractDrivers(sessionInfo)`
(IRating + pace-car/spectator flags), `telemetry.CarIdxClass`, and the injected
canonical `order` (already gated to race sessions). It assembles the calculator input
once, then:

- passes the per-car estimate into the shared driver-fields builder so **all six
  prefixes** emit `irating_change` and `irating_new`;
- adds `sof` to `buildSessionFields` (player's class SOF).

Display/raw duality follows the existing convention: display `+31` / `-15` / `0`
(signed, rounded) and e.g. `2350` for SOF; raw = unrounded numbers for expressions.
Blank display + absent/null raw when no estimate.

### Consumer 2 — Session Info action (`iracing-actions/src/actions/session-info/`)

- Mode enum gains `irating`; PI (`session-info.ejs`) gains the dropdown option.
- `extractDisplayValue` case builds the same calculator input from
  `getSessionInfo()` + telemetry + `getLiveRacePositions()` (translator accessor the
  action already imports for position mode) and formats the player's value.
- Value coloring follows the existing per-mode display logic: green (`#2ecc71`) when
  gaining, red (`#e74c3c`) when losing, white at 0.
- Display-only mode → no comms-catalog entry, no binding status line.

No changes to `SDKController`, adapters, or any `plugin.ts`.

## Testing (TDD)

- `packages/iracing-sdk/src/irating-utils.test.ts`
  - Formula correctness against the reference implementation's test vectors.
  - SOF known values; SOF of a uniform field equals that rating.
  - Multiclass grouping (per-class fields and ranks), excluded cars (pace car /
    spectator / no iRating), sub-2-car fields → null, empty order → all null.
  - Memoization: same inputs → same object; changed order → recompute.
- `template-context.test.ts` — new variables in display+raw with correct forms; blank
  when non-race / no order / invalid player iRating; all six prefixes carry them.
- `session-info.test.ts` — new mode: value extraction, +/−/0 color states, blank cases.

## Artifacts to update (same PR)

- `packages/website/…/template-variables.md` — the three new variables.
- Session Info action docs: `docs/` action page + website action page (per-mode
  section per `website-action-docs.md`), noting **estimated, not official** value.
- `packages/website/src/content/docs/changelog.mdx` — one Features line under the
  in-development `2.1.0` section.
- `.claude/skills/iracedeck-actions/SKILL.md` — Session Info mode listing.
- `.claude/rules/race-positions.md` — add the iRating estimator to the "Current
  consumers" list.
- No README action-count change (no new action), no architecture-page change (no new
  package or seam), no manifest changes.

## Out of scope

- Official post-race iRating change (not available in the real-time SDK).
- Race Engineer callouts for iRating changes.
- ttRating / Safety Rating estimation.
- A dedicated standalone action (superseded by the Session Info mode decision).
