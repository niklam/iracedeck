# Issue #871 — Suppress the session/race intro brief on a mid-session connect with the car on track

**Date:** 2026-07-26
**Issue:** [#871](https://github.com/niklam/iracedeck/issues/871)
**Status:** Approved (layer decision: scenario `where:` predicates)

## Problem

When the plugin connects mid-session (deck host auto-update, crash recovery, manual restart), the translator synthesizes `session.changed { from: -1, to: N }` so the intro briefs can fire on a fresh connect (#568 race, #668 practice/qualifying). The practice/qualifying synthesis deliberately fires during green (`SessionState.Racing` — those sessions sit there their whole duration), but nothing checks whether the driver is already driving. Reconnecting mid-practice/mid-qualifying with the car on track therefore replays the whole session brief ("Ok, `<name>`," … temperatures … wetness) to a driver already lapping.

The race path is narrower: the translator already latches silently on a race at/after green ("too late to brief"), so a mid-race reconnect emits nothing today. But the rule "don't race-brief a race already underway" lives only in the translator's synthesis gate — the race-start scenario itself would happily brief a mid-race synthetic event (harness-fired, or if the translator gate ever changes).

## Decision: suppression lives in the scenario `where:` predicates

Per the issue's preferred shape and the #480 precedent (scenario-layer `isLiveOnTrack` gates): the translator's synthesis stays **untouched** — it keeps serving any other `session.changed` consumer, and the event stays harness-firable. The scenarios own their own firing conditions:

- The synthetic event is self-identifying: `e.data.from === -1`. Genuine transitions (`from >= 0`) are untouched.
- Telemetry is read from the event envelope (`e.telemetry`), i.e. the synthesis-tick state — semantically "what was true at connect", the exact question the suppression asks. This matches the #480 gates (`liveRaceCar` in `start-lights.ts`) and works in the scenario harness, which attaches its live mock telemetry to every published event.

### session-start (`pit-crew.session-start`, practice/qualifying)

`where:` additionally rejects when:

```text
e.data.from === -1 && e.telemetry.IsOnTrack === true
```

- A direct `IsOnTrack` read — deliberately NOT `isLiveOnTrack` (the issue's originally named signal): its `IsReplayPlaying !== true` conjunct encodes "actively driving", but the question here is "session already underway". A connect tick carrying `IsReplayPlaying: true` with the car on track (in-session replay view open, or the #604 transient replay tick) is still mid-session — `isLiveOnTrack` would let it evade the gate and replay the brief over a live session.
- Connecting in the garage mid-practice/mid-qualifying still briefs (the #668 case the synthesis was built for).
- Session state is deliberately not consulted — practice/qualifying sit in `Racing` throughout, so on-track state is the only meaningful "already underway" signal there.

### race-start (`pit-crew.race-start`, race)

`where:` additionally rejects when:

```text
e.data.from === -1 && (SessionState === Racing || isPostRace(e.telemetry))
```

- Explicit positive state set (the #647 house style — never a `!== Racing` negation), so a missing/Invalid `SessionState` briefs rather than suppresses.
- A restart while sitting on the pre-green grid (GetInCar/Warmup/ParadeLaps) **still briefs** — starting position + conditions are still actionable (the issue's grid nuance). On-track state is deliberately not consulted for race: being in the car on the grid must not suppress.
- This is defense-in-depth relative to the translator's existing "too late to brief" latch, and makes the scenario own the rule for harness-fired events.

## No new opt-in

Firing-condition fix of the existing `calloutEnabledSessionStart` / `calloutEnabledRaceStart` callouts (#572 modifier precedent). No schema, PI, plugin, bus, or translator changes.

## Scenario harness

- Session Start: a second composer fire button — "Fire as Fresh Connect" — publishes `session.changed { from: -1, to: 0 }` (the synthetic-connect shape); apply the `hot-lap` / `in-garage` telemetry preset first to hear the suppressed vs still-briefing case. (Shipped as a composer button rather than standalone shortcuts — the composer already owns the session-start snapshot.)
- Race Start: two "Fresh connect" shortcuts (pre-green grid → briefs; mid-race → suppressed). Descriptions instruct QA to apply the race session preset plus the matching telemetry preset first (the `where:` gates read the envelope telemetry, which the harness fills from the live mock state; the race-session preset matters because the race-start `where:` rejects non-race sessions before the #871 gate is reached).
- Preset support: add `SessionState` to `hot-lap` (`4` = Racing) and `on-grid` (`2` = Warmup) telemetry presets so the race cases are reproducible; `hot-lap` / `in-garage` already cover `IsOnTrack` for the practice cases.

## Tests

Extend `session-start.test.ts` / `race-start.test.ts` `where:` coverage:

- session-start: synthetic + on-track → rejected; synthetic + on-track + replay view (`IsReplayPlaying: true`) → rejected; synthetic + in-garage → passes; genuine transition (`from >= 0`) + on-track → passes; synthetic + null telemetry → passes (don't punish missing data).
- race-start: synthetic + `Racing` → rejected; synthetic + `Checkered`/`CoolDown` → rejected; synthetic + pre-green (`Warmup`) → passes; genuine transition + `Racing` → passes; synthetic + missing `SessionState` → passes.

## Docs

- Header notes in `session-start.ts` / `race-start.ts` (the fresh-connect paragraphs) describe the new suppression.
- `.claude/rules/race-engineer-callout-examples.md`: new #871 entry (synthesis semantics unchanged, so the #668 context in the session-start entry gets a pointer, not a rewrite).
- Website changelog `2.3.0` → **Bug Fixes** entry.
