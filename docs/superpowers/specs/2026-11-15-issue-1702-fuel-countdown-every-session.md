# Fuel laps-left countdown in every session kind

> **Issue:** [#1702](https://github.com/niklam/iracedeck/issues/1702) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Where it stands

The laps-of-fuel-left countdown (#838) is race-only because of one early return in the translator: `diffFuelLapsLeft` returns when `isRaceSession` is false, and the translator computes that as `resolveSessionType(...) === "Race"`, an exact match. Everything after that return assumes a race: the final-lap silence, the race-coverage suppression (#866, #880, #1405) and the `fuel.lapsLeft.raceCovered` reassurance.

Three things already work outside races and need no change:

- **The fuel tracker** (`diffFuelLaps`) records and validates laps on every tick of every session, so practice and qualifying already have the average the estimate reads.
- **The countdown state** (`state.fuelCallout`: the announce floor, the reassurance latch) is rebuilt by `createInitialState()` in `resetPerSessionState` on every session change, so a floor reached in practice never silences qualifying.
- **The Telemetry Snapshot's `fuel.lapsLeft.now`** (`resolveLapsLeftNow`, `sim-state.ts`) already computes the count in every session and reports `coverageSkipped: "not-a-race-session"` outside races.

## Decisions

### 1. The translator emits the countdown in every live session

`diffFuelLapsLeft` stops returning early outside a race. Sampling, the live-in-car check and the chequered silence (`isPostRace`) run in every session: after a practice or qualifying chequered flag a "box this lap" is as wrong as after a race's. Replays stay silent with no new code: the diff is a `steps.live` step behind `handleTick`'s replay guard, which reads the debounced replay state (#1324), and its own `isLiveOnTrack` check is the second line.

The diff then splits on `isRaceSession` (still the exact `"Race"` match), which now decides which branch runs rather than whether the diff runs:

**A race:** unchanged. The sticky final-lap latch, the coverage verdict, the 10-lap endgame reassurance and the floor-clearing behave as today.

**Any other session** gets the parts of the race logic that mean something there, and nothing else:

- **Final-lap silence.** Outside a race iRacing shows the white flag when the *player* starts their own final lap (`diff/flags.ts`, the comment on the two-stage white), but the sticky `playerFinalLapStarted` latch is set only in races. The translator hands the diff one value, `finalLapStarted`: in a race the sticky latch as today, elsewhere whether the white flag is shown on this tick. It is computed in the translator and passed as a value, under the slice convention, so the diff never reads flag state of its own. The #866 trade-off carries over: a final-lap shortage call is more often noise than a real chance to pit.
- **Lap-counter coverage.** A lap-limited qualifying session (Lone Qualify always is) counts the player's own laps in `SessionLapsRemainEx` (#776). When that counter is a real count, not the unlimited sentinel, the remaining laps are compared with the tank through the same `isFuelRaceCovered` verdict, and a covered tank speaks no warning. That way a qualifier fuelled for exactly their counted laps does not hear "two laps of fuel left" on a flying lap. The timed half of `resolveFuelRaceCoverage` (the leader's chequered prediction, #1405) is race-only and not used: there is no leader to finish behind in qualifying, and a clock-bound practice session has no distance worth covering. A practice session with no lap limit gets no coverage check at all.
- **No reassurance.** `fuel.lapsLeft.raceCovered` is never emitted outside a race; its line says "finish the race".

**Heat races and warmups** are not `"Race"` today, so they take the non-race branch: the lap-counter coverage where they have a lap limit, and the tank alone otherwise. That is a widening, not a regression: today they get no countdown at all. Whether the race's leader-relative coverage holds for a heat race is a separate question (*Out of scope*).

### 2. The session-kind choice is the Race Engineer's, not the translator's

The four toggles are callout opt-ins: they decide whether a line is spoken, which is the Race Engineer's job everywhere else. The per-count opt-ins (`calloutEnabledFuelLapsLeft*`) are already checked on that side, and the translator already advances its floor past a count whose opt-in is off. A session toggle that is off behaves the same way: the floor still advances, and switching the toggle on mid-session speaks the next lower count, never a stale one.

Rejected: reading the toggles in the translator through a closure, the way `getFuelLapsLeftMarginLaps` reads the margin. The margin changes what the estimate *is*, so it belongs where the estimate is made. A toggle only mutes it, and a muted session should still put the countdown on the bus for any other consumer (a deck display, #749). It is also the shape a second sim needs: the translator emits a sim fact in every session, and the catalog decides whether to speak it.

### 3. `SessionClass` learns to tell testing from practice

The catalog reads the session through `SimRuntime.getSessionClass()`, the one classifier the Race Engineer reads (#1587). It folds testing into `practice`, so on its own it cannot drive a separate Test toggle.

`SessionClass` gains one field, `testing: boolean`: true for a session the player runs alone to test, with no event around it. That covers iRacing's `"Offline Testing"`, and the concept exists in other sims too (a private test day). `classifySession` sets it from the same `"Testing"` match that already maps such a session to `practice`, through a fifth frozen constant, and it is false for every other session. The shape follows `soloQualifying`: a qualifier within one category, so every consumer that reads `category` keeps working unchanged. That `{ category: "race", testing: true }` cannot occur is a convention, as `soloQualifying` outside qualifying is today.

Rejected:

- **A fourth `category`, `"test"`.** Every reader that treats testing as practice today (the session-start brief, the corner gate, the checkered practice read) would need a new arm, and a missed one would change behaviour silently.
- **A session kind on the `fuel.lapsLeft.crossed` payload.** That is a second classification beside `SessionClass`, the split #1587 removed.
- **`classifySessionKind`** (`session-kind.ts`, #1111). It is the profile switch's table, deliberately different (exact strings, `null` for an unknown type, Warmup as practice). The Race Engineer reads one classifier, and this issue does not change which.

So Warmup and Heat Race map to the **Race** toggle, because `classifySession` calls them race. The issue's task list said Warmup counts as Practice; this spec overrides it, so the Race Engineer keeps one answer to "what kind of session is this". The catalog and the translator read "race" differently here (the class's `race` category against the exact `"Race"` match); that split predates this issue and is documented in `sim-events-iracing/CLAUDE.md`.

### 4. Four registry opt-ins, default on, and no migration

The toggles are a new `callout-settings` family, `fuel-countdown-sessions`, with ids in the order the Settings window lists them:

| Id | Key | Session (by `SessionClass`) | Default |
| --- | --- | --- | --- |
| `race` | `calloutEnabledFuelCountdownRace` | `category: "race"` | on |
| `practice` | `calloutEnabledFuelCountdownPractice` | `category: "practice"`, `testing: false` | on |
| `qualifying` | `calloutEnabledFuelCountdownQualifying` | `category: "qualifying"`, solo or not | on |
| `test` | `calloutEnabledFuelCountdownTest` | `category: "practice"`, `testing: true` | on |

The registry already holds family-wide gates (`calloutEnabledPitServiceRequests` over all 24 toggle confirmations, `calloutEnabledStartCountdown` over four contracts), so these follow the same path: the schema field, the bool-or-string parse, the Settings-window checkbox and its default, and the append-only baseline (#1376) all come from the registry. Hand-written schema keys and checkboxes were rejected because they would be a second opt-in path, outside `grep calloutEnabled` and outside the baseline that guards persisted keys. The four keys are rows appended to `callout-settings-baseline.json` and a persisted contract from the moment they ship.

**The per-count toggles stay shared** across session kinds. This is what makes "inherit the race choice" free: an existing install's countdown is its per-count toggles, which now apply in every session with every kind on. A driver who chose 5, 3, 2, 1 and Box hears those in practice too; one who switched every count off stays silent everywhere. No migration runs, and nothing the user chose is copied or rewritten.

Rejected: a separate set of count toggles per session kind (44 checkboxes). The request is about *where* the countdown speaks, not *which counts*, and the extra grid buys little for its size.

**`Enough fuel to finish` also needs the Race toggle.** It is the race countdown's closing line, retracting warnings: with the Race toggle off it would retract warnings that were never spoken.

A session `getSessionClass()` cannot classify (`null`, no session info yet) speaks nothing. The countdown samples once per lap, so no line is lost before the session is known.

### 5. Where the check lives

`registerPitCrew` wraps the fuel contracts in one family-wide gate, shaped like `wrapPitServiceRequestsScenario`. It is consulted in `where:` on every event arrival, before the contract's own count filter, and it reads two things the catalog already has: `d.getSessionClass()` and the four opt-ins through `isCalloutEnabled`. One pure function maps `SessionClass | null` to a family id (`race`, `practice`, `qualifying`, `test`) or `null`, with its own tests. A `where:` check rather than a `speakGate` is enough, because the session is known when the event fires and the queue is cleared on `session.changed`.

No new `PitCrewDeps` key and no `race-engineer-wiring` change: the contracts in `fuel-laps-left.ts` stay static.

### 6. The Settings window

The new family is placed in `CALLOUT_PI_GROUPS` just before the fuel family. `race-engineer-callouts.ejs` renders it with `calloutGroupItem(...)` under a **Speak in** heading, as four checkboxes: Race, Practice, Qualifying, Test. The margin slider stays where it is.

### 7. Contract and documentation wording

- The `fuel.lapsLeft.crossed` doc in the event-bus catalog drops "race only" and says the translator emits it in every live session, with the coverage and final-lap silence described per branch. `fuel.lapsLeft.raceCovered` stays a race event.
- `SessionClass`'s doc names `testing`, and so do the "classified session" bullet in `sim-events-iracing/CLAUDE.md` and the radar and spotter section of `audio-scenarios/CLAUDE.md`. `session-type.ts`'s "one of four frozen values" becomes five.
- The eleven contract descriptions in `fuel-laps-left.ts` drop "in a race" for the countdown, and the diff's header comment ("Race sessions only") says which parts are race-only. The descriptions feed the pack-author reference, so `pnpm generate:pack-reference` is rerun (`race-engineer-callouts.md`, step 9).
- `sim-state.ts`'s comment on the skipped coverage ("which `diffFuelLapsLeft` returns on first") no longer holds and is rewritten.
- The callout-settings coverage test's list of families gated other than one contract per key names the new family.
- The website's fuel section in `pit-crew.md` names the four toggles and says which race checks do not apply elsewhere. A Features changelog fragment.
- A `race-engineer-callout-examples.md` entry: the first *user-selectable* session filter (start lights, the formation flags, corner names and the session-start brief already gate on the session by design), and why it lives on the Race Engineer side.

## Out of scope

- **Race coverage for heat races and warmups.** They get the non-race branch. Whether the leader-relative coverage, validated against `"Race"` captures (2026-08), holds for a heat race needs a heat-race capture and is its own issue if anyone asks.
- **Persisting fuel history across sessions** (#1081). Practice starts with an empty average and stays silent until the tracker has validated laps, as a race stint does today.
- **The margin default** (#1679) and **liters and lap counting** (#1401). They touch the same diff and Fuel group; whichever lands second rebases.
- **Other race-only callouts.** Nothing here generalises the toggle row to another family.
- **New clips.** The lines are the same; no voice pack changes.

## Testing

Unit, in each owning package:

- `sim-events-iracing` (`fuel-laps-left.test.ts`): in Practice, Lone Qualify and Offline Testing, a falling tank emits `fuel.lapsLeft.crossed` at each descending count, never emits `raceCovered`, and goes silent after the chequered flag. Under the white flag on the player's final lap, nothing. In a lap-limited qualifying session whose tank covers the counted laps, no warning; one lap short, the warning speaks. The existing race cases pass unchanged.
- `sim-events-iracing` (`session-type.test.ts`): `classifySession` sets `testing` for `"Offline Testing"` only, and every existing category result is unchanged.
- `event-bus` (`event-catalog.test.ts`): the exact type pin on `SessionClass` is updated to include `testing`.
- `race-engineer-wiring` (`pit-crew-deps.test.ts`): the `SessionClass` literals gain `testing`.
- `audio-scenarios`: the session mapping for every `SessionClass` and `null`; a contract silenced by its session toggle while the per-count opt-in is on, and the reverse; `Enough fuel to finish` silenced by the Race toggle.
- `callout-settings` / `settings`: the four keys default to `true` through the registry, and the baseline gains exactly four rows.

Harness (`scenario-harness`): the mock SDK boots with no session info, so with this change the existing Fuel shortcuts would go silent until a session preset is applied (the #1167 trap in `scenario-harness/CLAUDE.md`). So:

- a `presets/session/testing.json` with `SessionType: "Offline Testing"` and its own `TrackID`;
- the Fuel shortcuts get a `requires` precondition that refuses, with a reason, while the session is unclassified;
- a harness test over the real translator asserts which fuel lines are heard in practice and in test, and that a line is silent with its toggle off.

Manual, by Niklas in the sim:

1. An offline test session with a small fuel load: the countdown speaks the default counts down to "Box this lap".
2. Switch Test off in the Settings window mid-stint: the next count is silent. Switch it back on: the next lower count speaks.
3. A practice session and a qualifying session: the countdown speaks; after the chequered flag, nothing. A Lone Qualify fuelled for its laps: no warning.
4. A race: unchanged, including "Enough fuel to finish" in the last ten laps. With Race off, neither the countdown nor the reassurance speaks.
