---
paths:
  - "packages/iracing-sdk/**"
  - "packages/sim-events-iracing/**"
  - "packages/iracing-actions/**"
  - "packages/audio-scenarios/**"
---

# Race Positions — Single Source of Truth

There is **one** canonical race order in the project, and every feature that needs a car's race position, the running order, a position-relative neighbour, or a class position MUST consume it. **Never invent a second way to compute positions.** Multiple orderings drift and collide — blending the live order with iRacing's official `CarIdxPosition` produced duplicate ranks and mis-resolved `race_ahead`/`race_behind` (issue #710).

## The canonical source

The live running order is computed by the iRacing translator and exposed as a per-car, 1-based array indexed by `carIdx` (`0` = not classified):

- `getLiveRacePositions(): number[] | null` — the whole field's order.
- `getLivePosition(): LivePosition | null` — the player's slot (overall + class) derived from that same order.

Both live in `@iracedeck/sim-events-iracing` (`translator.ts`) and are built on `calculateFrozenRacePositions` (`diff/race-finish.ts`), which ranks by lap progress (`CarIdxLapCompleted + CarIdxLapDistPct`) and **freezes** towed / finished / left-world cars at their last-known rank. The base lap-progress ranking, `calculateRacePositions`, lives in `@iracedeck/iracing-sdk` `position-utils.ts` and is the **only** place that primitive computation exists — it is called by the translator's frozen calc and nowhere else.

`classPositionFromOrder(order, CarIdxClass, carIdx)` (`position-utils.ts`) derives class position from that same order — class is never sourced independently.

## Rules

- **Consume, don't recompute.** If you need position/standings data, read the canonical order. Do not call `calculateRacePositions` directly, do not sort cars yourself, and do not blend the order with `CarIdxPosition`.
- **Dependency direction.** `@iracedeck/iracing-sdk` sits *below* the translator and can't import it, so the order is **injected**: `SDKController.setLivePositionsProvider(() => getLiveRacePositions())` (wired in every plugin's `plugin.ts`), and the template context reads it via `getLiveRacePositions()` / `getCurrentTemplateContext`. A new consumer at or below that layer takes the order the same way; a consumer above it can call the translator directly.
- **Live track order everywhere.** The canonical value is the live track order for *every* car, including the player and cars in the pits. Do **not** add per-consumer overlays (official-position-on-pit-road, qualifying-grid-pre-green, etc.) to the canonical number — a car in the pits shows its live track slot. A specific *display* (e.g. the Session Info Position key) may layer its own polish on top of the canonical value for presentation, but it must start from the canonical order, not a parallel computation.
- **Official counters are fallback only.** `CarIdxPosition` / `CarIdxClassPosition` are used per-car **only** when there is no live order at all — non-race sessions (where lap-progress order isn't the standings) or before the order is available. Once a live order exists it is authoritative: a car **absent from it** (rank `0` — garaged / not in the world) renders **blank**, never a stale official rank. A non-positive (`0` = not classified) official value also renders blank, not `"0"`.
- **One coherent order has no duplicate ranks.** Because the canonical order is a strict `1..N` ranking, position-relative selection (`findDriverByRacePosition`) can never hit a tie — which is the property that fixes #710. Keep it that way: don't reintroduce a merged/blended array.
- **Physical track order is a different concept, with its own single helper.** "The car physically ahead / behind on the road" (`CarIdxLapDistPct` circular distance, regardless of lap count or standings) is NOT a race position, so the canonical-order rule does not apply to it — but the same don't-recompute discipline does: `findNearestCarOnTrack` (`@iracedeck/iracing-sdk` `track-utils.ts`) is the only track-order primitive. Its consumers are the SDK's `findNearestDriverOnTrack` (`template-context.ts`, behind the `track_ahead`/`track_behind` template variables — pace car and spectators filtered), the Camera Controls dial's track-order mode (via `computeTrackOrderTarget` in `iracing-actions/src/shared/car-cycling.ts`, #886 — filtered to the car-number competitor set), and Replay Control's dial handler (`findAdjacentCarOnTrack`, unfiltered; dormant since the #640 dial de-claim); never sort cars by lap distance yourself. Note the primitive's in-world test is lap distance + track surface only (no `CarIdxLapCompleted` condition, #307) — it is NOT `carPresence`.

## Current consumers

- **Session Info → Position** — `getLivePosition()`.
- **Telemetry Display / Chat / Race Admin** driver-info template prefixes (`self`, `track_ahead/behind`, `race_ahead/behind`, `focused`) — the injected order via `buildTemplateContextFromData` (`@iracedeck/iracing-sdk` `template-context.ts`).
- **Race Engineer** position callouts — `getLivePosition()`.
- **Opponent-pit callouts (#622)** — the translator diff classifies pitting cars against the frozen order (`classPositionFromOrder` for class space), and the spoken "P{n}" resolves at speak time via `getLiveCarPosition(carIdx)` (the per-car sibling of `getLivePosition()`), with the emit-time payload as fallback.
- **iRating estimate (#268, #872)** — `estimateIRatingChanges` (`@iracedeck/iracing-sdk` `irating-utils.ts`) takes the order as an argument: the template variables (`irating_change` / `irating_new` / `session.sof`) consume the injected order in `buildTemplateContextFromData`; the Session Info → iRating mode consumes `getLiveRacePositions()` directly. Both route it through `resolveIRatingEstimateOrder` (same module), which tries the live order (race sessions only — authoritative), then the official `CarIdxPosition` counters (qualifying / race pre-green), then the session-YAML `QualifyResultsInfo` grid — anchored on `playerCarIdx`, so the first source that classifies the PLAYER wins and the pre-green value holds through the green-flag run to the line (#647's churn lesson); with no player-classifying source the first usable one applies (spectating). This is an ESTIMATE-ONLY order input; the canonical position order and its consumers are unaffected.

- **Gap tracking (#933)** — `diffGaps` receives the frozen order from `handleTick` (the same array passed to `diffOvertakes`) and resolves class-standings neighbors from it via `resolveClassNeighbors` (`@iracedeck/iracing-sdk` `gap-utils.ts`, with explicit pace-car exclusion); Session Info's Gaps mode consumes `getLiveGaps()`, and `getLiveGapBetween()` is the reusable any-two-cars gap accessor.
- **Opponent-flag callouts (#936)** — `diffOpponentFlags` receives the frozen order `handleTick` computes and uses `classPositionFromOrder` for its class-space relations (the #588/#622 slot); `diffLeaderWhite` receives the same order only to identify the **overall** leader (no class-position classification). `getLiveOpponentFlags()` is the reusable per-car flag-data seam (raw decoded truth, no announcement policy) future features should read rather than re-deriving from `CarIdxSessionFlags`.

When you add a position-aware feature, wire it to the canonical source and add it to this list.
