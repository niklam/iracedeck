> **Issue:** [#943](https://github.com/niklam/iracedeck/issues/943) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Places gained by passing pitted cars

## Context

The overtake diff (`diff/overtakes.ts`, #574) announces every sustained gain of the player's effective position as `overtake.completed`. The catalog answers it with a reaction ("Nice pass.", about one time in three below the podium) and the shared "We're currently P…" readout. The diff silences a swap only while the player is on pit road, under a caution, before the green, or when a car ahead has dropped out of the order (`fromRetirement`, #603). A car the player drives past while that car sits in its box or rolls down the pit lane is still ranked by its live lap progress (`race-positions.md`: "a car in the pits shows its live track slot"). So the player crosses it in the canonical order when driving past it, and that crossing is announced as a racing pass.

Niklas decided on 2026-11-22 (issue comment): no overtake reaction and no ordinary readout for a car passed while it is on pit road; one announcement once the player is past the pits, "We gained a position by passing a pitted car." or "We gained positions by passing pitted cars.", followed by the existing "We're currently P6." readout; no count in the line. #1756 is the mirror (places lost during the player's own stop), and the two must never announce the same stop twice.

### Dependencies

- **#1722** (milestone 3.10.0, on `fix/1722-no-position-calls-pit-road`, not merged when this was written). Its predicate `playerOnPitRoadOrOutOfCar`, its gate builder `buildPositionReadoutSpeakGate` and its end `POSITION_READOUT_ENDS_ON` (`pitLane.entered`) are used below.
- **#1758**, which lands before this issue. It moves multi-class overtake detection off `PlayerCarClassPosition` and onto the canonical order's class projection (`standingPosition` / `classPositionFromOrder`, `race-positions.md`). After it, the effective position the diff detects on comes from the same order the crossings below are read from, so a class gain and the crossing that caused it fall on the same tick. Retirement classification then works in multi-class too, and the `overtake.completed` catalog doc that names `PlayerCarClassPosition` is corrected there.

This spec is also the owner of the shared position window's redesign (decision 7), which #1756 uses and points at.

## Decisions

### 1. Every crossing of the player in the canonical order gets a cause

On every tick the overtake diff runs past its gates (a race, past the green, no caution, not held for the player's own stop, initialized), it compares the previous tick's canonical order (`lastFrozenPositions`, already kept) with this tick's. A car `c` is a **gained crossing** when it ranked ahead of the player on the previous tick and ranks behind on this one. It is a **lost crossing** the other way round. None of these is a crossing:

- the player;
- the pace car (`resolvePaceCarIdx`);
- a car unranked on either tick (rank `0`);
- in a multi-class race, a car the shared class screen in `diff/standings.ts` rejects (#950: a readable class that differs from the player's never counts).

A lapped car, or a car a lap ahead, sitting in the pits never produces a crossing. The order ranks lap progress, and the player does not overtake it in that order by driving past its box. That is how the issue's "lapped traffic in the pits is not a gain" holds without a rule of its own.

A pure classifier, `classifyCrossing`, in a new module `diff/crossing-cause.ts`, gives each crossing one cause, decided on the tick of the crossing:

- **`pit`**: either of these holds:
  - the car is in the world, not frozen, and its `CarIdxTrackSurface` this tick passes `isPitLaneSurface` (decision 8), meaning it is in the box or anywhere in the pit lane from the approach to the blend line;
  - the car is out of the world (`NotInWorld`, a remote blink) and its last in-world surface passed `isPitLaneSurface`.
- **`retirement`**: the car is frozen in the self-managed order for any other reason (a tow or teleport freeze, a disconnect, a finisher), or it was released from the freeze on this tick (`positionJustReleased`, #697). A car towed to its box is frozen at its pre-tow anchor on the circuit. The player crosses it where it crashed, not at the pits, so it stays a retirement.
- **`racing`**: anything else.

Per-car pit state comes from `CarIdxTrackSurface` and never from `CarIdxOnPitRoad`. Captures show `CarIdxOnPitRoad` reading `true` for cars on the racing surface and `false` for cars in their box (`diff/race-finish.ts`, `diff/track-surface.ts`, the Spa capture in `diff/__fixtures__/README.md`). The previous and current surfaces come from the shared surface tracker (decision 8).

The existing `isRetirementGain` rule and the `fromRetirement` field are unchanged. The classifier only adds the `pit` label and a per-crossing record.

### 2. A pending change carries its own crossings

A pending gain or loss collects the crossings in its direction from the tick it opens until it confirms or is dropped: `{ carIdx, cause }`. After #1758 the crossing that moves the effective position is on the opening tick itself, so there is no time window and no lookback. A pending gain that deepens adds the deeper tick's crossings. When the pending closes, its list is consumed (on confirmation) or discarded (when the place is given back).

At confirmation, after the existing hold (`OVERTAKE_HOLD_MS`, 3 s), physical-gap and round-trip rules, the gain or loss is decided from its own crossings:

- **Pit-cycle gain.** A confirmed gain with at least one `pit` crossing and no `racing` crossing. A `retirement` crossing in the same gain rides along: it is rare, and one line is better than two. A pit-cycle gain publishes **no** `overtake.completed`. The reaction, the overtake readout and any future consumer of a pass (#942) therefore never hear about it, with no filter in any of them.
- **Ordinary pass.** A gain with any `racing` crossing. `overtake.completed` is published exactly as today, `fromRetirement` included, and the readout that follows states the live position, the pitted car's place with it. A gain that carries no crossing at all is also published as today, so a gap in the record can only fall back to the status quo.
- **Pit-cycle loss.** A confirmed loss is one when every crossing in it is either:
  - a `pit` crossing (a car in the pit lane got past a slow player), or
  - a car this feature counted into a pit-cycle gain less than `PIT_CYCLE_RECROSS_MS` (15 s) earlier. This is the car the player passed in the exit lane at the pit speed limit, coming back past on fresh tires.

  A pit-cycle loss publishes no `overtake.lost`. While a burst is open, it subtracts its places from the burst.

`lastCalledPosition` (#597) moves only when something is published. When the burst is announced it moves to the burst's final position. A withheld gain or loss moves nothing. A burst given back to nothing is then a round trip, and a later return to the last announced position stays silent, as #597 intends.

`diffOvertakes` returns the crossings that this tick's confirmation consumed, with their direction and cause (`readonly ConsumedCrossing[]`, empty on a tick with no confirmation), as a value valid for that tick only. It runs as `let consumedCrossings: readonly ConsumedCrossing[] = []; steps.live("diffOvertakes", pending, () => { consumedCrossings = diffOvertakes(...); })`, so a throw hands on an empty list. `handleOrderSteps` hands that value to #942's diff when #942 lands (decision 10).

### 3. One burst per pass of the pits, closed once the player is past the pit lane

The first pit-cycle gain opens a **burst**. The burst records the overall and class positions before that gain (the pending gain's previous positions) and counts places:

- every later pit-cycle gain adds its places (the effective delta the overtake event would have carried);
- every pit-cycle loss subtracts its places.

The burst closes on the first tick on which no pending gain is open and one of these holds:

- **Past the pit lane (preferred).** The pit-lane landmarks are known for this track, and the player's `LapDistPct` lies outside the forward span from `approachStart` to `blendEnd`.
  - The landmarks are `approachStart` and `blendEnd` from #1112's learner. They are handed to the diff as a value read through `resolvePitLaneLandmarks(self.pitLaneLearner)`, the same reader the traffic pit-exit detector uses.
  - A landmark kept from before a track rebuild (`source: "previous"`) does not count.
  - Every pitted car the player can pass sits inside that span, since its surface reads `AproachingPits` or `InPitStall` only there. Once the player is outside the span, the burst is complete.
- **Quiet (fallback).** Without that landmark pair, `PIT_CYCLE_QUIET_MS` (10 s) have passed since the burst's last pit-cycle gain. Ten seconds covers the far ends of a long pit lane at racing speed. The landmark rule makes the call sooner wherever the pit lane is learned.
- **Cap.** `PIT_CYCLE_MAX_OPEN_MS` (60 s) after the burst opened, whatever else holds, so a burst can never stay open indefinitely.

On close, a burst whose net places are at least one publishes `position.pittedCarsPassed` (decision 5) and sets `lastCalledPosition`. A burst that netted nothing closes silently.

The settling window Niklas asked about in the issue is therefore "until the player is past the pit lane", with a timed fallback, rather than a fixed couple of seconds. A fixed window either splits a long pit lane into two calls or waits needlessly on a short one.

### 4. Where nothing is counted

In these cases the pending crossings and the burst are dropped silently and nothing is published:

- **The player on pit road, or the player's own stop.** The diff resets on `OnPitRoad` today. With #1756 it also takes the `heldForPitStop` value for #1756's stop window, whatever its length, and behaves exactly as on pit road while that value is true.
  - Passing cars in their boxes while driving down the pit lane (the issue's "not while we are pitting ourselves") is therefore part of #1756's net and never a burst.
  - If this issue lands before #1756, the `OnPitRoad` reset alone covers the pit lane itself.
- **Under a caution or before the green.** The existing silent branch (`Caution`, `CautionWaving`, `Yellow`, `YellowWaving`, `isPreGreen`) drops an open burst.
  - Under a full-course caution, the caution sequence's own last-lap position call states the race position (#1127).
  - A pit cycle under yellow is not news the engineer can phrase correctly while the field is reordering behind the pace car.
- **Outside a race.** Practice and qualifying never run this path.

Frozen and retired cars keep their #603 / #697 handling (decision 1).

### 5. The bus event: `position.pittedCarsPassed`

The event is a new catalog entry in `@iracedeck/event-bus`. It is a published contract, so it is reviewed at `xhigh`. It sits in the `position` namespace beside #1756's `position.pitStopSettled`, and the two use the same before/after field names.

```typescript
/**
 * The player gained places on cars that were in the pits, and is now past the
 * pit lane (issue #943). One event per pass of the pits: every place gained on a
 * car in its box or the pit lane since the first one is folded in, and the event
 * is published once the player is past the pit lane (or the gains have been
 * quiet). `places` is the net number of places gained on such cars, at least 1,
 * counted in class position in a multi-class race and in overall position
 * otherwise. Never published for a gain that also passed a car racing on the
 * circuit, which stays an `overtake.completed`. Race sessions only, never
 * pre-green, never under a caution, never while the player is on pit road or in
 * their own pit stop.
 */
"position.pittedCarsPassed": SimEvent<
  "position.pittedCarsPassed",
  {
    /** Net places gained on pitted cars; class position in a multi-class race; at least 1. */
    places: number;
    /** Overall race position before the first of these gains (1-based). */
    positionBefore: number;
    /** Overall race position now (1-based). */
    position: number;
    /** Class position before the first of these gains, when class info is available. */
    classPositionBefore?: number;
    /** Class position now, when class info is available. */
    classPosition?: number;
    /** True iff the current session has more than one car class on track. */
    isMultiClass?: boolean;
  }
>;
```

The event carries no car indices. Nothing reads them, and #942 takes its passed car from `diffOvertakes`' returned crossings (decision 2). The event joins `OVERTAKES_EVENTS`, so its row in `TICK_ORDER` is the existing `diffOvertakes` row. It gets an `src/event-names.ts` template in the scenario harness.

### 6. The audio contract

One contract, `pit-crew.overtake-pitted-cars`, in `overtake.ts`:

- **Trigger.** `when: { event: "position.pittedCarsPassed", where }`. The `where:` admits the event when all of these hold:
  - `places` is at least 1 and the effective position is known;
  - the race is not finished for the player (`getRaceFinishedFired`);
  - the player is in the car and off pit road (`playerOnPitRoadOrOutOfCar` on the latest tick, #1722);
  - no full-course caution is out (`getUnderFullCourseCaution`, #1127).

  The clean-moment gate (`overtakeContextAllows`) is deliberately not applied. The gain is not a racing move, so a car alongside or a recent incident does not make the news less true.
- **`speakGate`.** Built on `buildPositionReadoutSpeakGate` with `window: () => "stamp"` (decision 7). It asks the pit-road and out-of-car check, then the caution. It never refuses on the window. It stamps the window with the number this fire's stash holds, which `positionReadout.number` wrote at expansion, so the readouts within the next 20 s defer to this line.
- **Scheduling.**
  - `weight: WEIGHT.CHATTER`.
  - `queueable: true`, because this is a one-shot edge (the #923 rule).
  - `maxQueueWaitMs: 20_000`. The line stays true while it waits, and its gate re-checks pit road and the caution at speak time; this follows the caution calls' 20 s precedent.
- **No `family`.** In the `overtake` family, a "Nice pass." for the next racing pass would replace this line in flight and lose it for good. In a family of its own it has nothing to share. A reaction arriving while it plays waits, as any heavier line without `interrupt` does.
- **`supersedeGroup` left at its default** (the contract id). Joining the readouts' `position` group would let a newer ordinary readout replace this waiting news line.
- **`endsOn: POSITION_READOUT_ENDS_ON`** (`pitLane.entered`), #1722's end for every line that says the position.
  - The trigger comes from `diffOvertakes`, which runs after `diffPitLane` on a tick. So the pair needs an entry in `ends-on-order.test.ts`'s `TRIGGER_AFTER_END_EXEMPTIONS`: `position.pittedCarsPassed` / `pitLane.entered`, trigger stage `diffOvertakes`, end stage `diffPitLane`.
  - The proof cited by that entry is an `overtakes.test.ts` case: the overtake step publishes nothing on a tick `OnPitRoad` turns true, because it resets on that tick.

Vocabulary, registered in `registerOvertakeVocabulary`:

- **Case `overtake.pittedCarsCount`**, keys `one` ("One net place was gained on cars in the pits.") and `several` ("Two or more net places were gained on cars in the pits."). It is resolved from the fire's own `position.pittedCarsPassed` payload, and is `null` for any other fire. This is a lookup over a closed set, so it is a case with declared keys rather than a ladder of conditions.
The readout reuses `positionReadout.number` (the live position at speak time, class in a multi-class race; it writes the number into the fire's stash, decision 7) and the `position-intro-worse/currently` clip directly, because Niklas's wording always says "We're currently". No new var is needed.

The bundled script for both first-party voices:

```json
[
  {
    "case": "overtake.pittedCarsCount",
    "of": {
      "one": ["pool:position-overtake/passed-pitted-car"],
      "several": ["pool:position-overtake/passed-pitted-cars"]
    }
  },
  "pool:position-intro-worse/currently",
  "{{positionReadout.number}}"
]
```

The readout is required and always said (Niklas, 2026-11-22). That holds even when the race lap readout ("We're currently P6.") said the same number a few seconds earlier, which is common because the pit lane crosses start/finish at most tracks: the line is the news, and the position belongs to it.

`OVERTAKE_CLIP_SOURCES` gains the two new bases and `position-intro-worse/currently`, which this script addresses directly.

### 7. The shared position window records the number it covers

`position-readout.ts` owns the window every position line shares. Today it records only a time, `lastPositionAnnouncedAt`. It changes so that it covers a number:

- **The window records the number with the time.** `tryClaimPositionAnnouncement(now, n)` claims it as today and records `n`. A new `stampPositionAnnouncement(now, n)` records the time and number without asking. The number makes the record say what the window covers, for the Telemetry Snapshot and for any later reader. Nothing in this issue reads it to skip a line, by Niklas's ruling (decision 6).
- **Every readout gate passes the number it speaks.** That covers the lap call, the race status, the caution sequence's position call, both overtake readouts, this issue's line and #1756's line. The number comes from the fire's own stash, never from a fresh read in the gate.
- **The per-fire stash carries the number.** The existing stash keyed by the fire's `ScenarioContext` (`stashIntroDecision` / `takeIntroDecision`, #1138) gains the number the expansion resolved. It is written by `positionReadout.number`, which this line and #1756's speak through. The other number vars that speak the player's race position (`position.number`'s race branch, `raceStatus.number`, `caution.racePosition`) write it too, so that every gate above has a number to pass.
- **One builder option replaces `claimsWindow`.** In `buildPositionReadoutSpeakGate`, `window: (ctx) => "claim" | "stamp" | "none"` replaces #1722's `claimsWindow`:
  - `"claim"` (the default, and the race branch of the lap call) refuses when the window is held and records the stash's number when it claims.
  - `"stamp"` (this line and #1756's) never refuses and stamps only when the fire's stash shows a number.
  - `"none"` (the lap call in qualifying) neither asks nor records.
- **The intro is committed only from a stash, never asserted in code.** A line whose script says the "We're currently" clip directly (this one, #1756's) records no intro decision. The next readout's bare-or-full choice (#603) then simply does not count it, which errs toward the full intro.

The window and its reader are reported by `readPositionReadoutDebugState()` with the number beside the time.

### 8. Translator state

- **The `overtakes` slice.** The overtake fields are still a flat cluster (`LEGACY_FLAT_MEMBERS`' `Overtakes` entry in `state-slices.test.ts`). This issue changes the family in substance, so by the #1588 rule the cluster becomes an `overtakes` slice in the same change, its fields without the prefix (`pendingGainPos`, `lastCalledPosition`, …).
- **The `trackLength` slice.** The two track-length fields in the same pin entry are the track-length cache, which every length consumer reads. They become a slice of their own, `trackLength: TrackLengthState { meters, key }`, so the `Overtakes` pin entry is deleted whole and no flat field is re-homed. The diff keeps taking the length as a value.
- **The freeze sets.** `positionFrozen` and `positionJustReleased` arrive as values from `handleOrderSteps`.
- **The `pitCycle` slice.** The new concern is a slice of its own, `pitCycle: PitCycleState`, with `createPitCycleState()` in `state.ts`. It holds:
  - the pending gain's and pending loss's crossing lists;
  - the recent pit-cycle members (car index and time, for the re-cross rule);
  - the burst (open flag, opened time, last-gain time, places, previous overall and class positions).

  It is wiped whole at the replay wipe. A burst is a run of live facts that a replay glance breaks, as the traffic episodes are.
- **The shared surface tracker.** The per-car last in-world surface is today the opponent-pit diff's own baseline (`opponentPitLastSurface`). It is hoisted into one slice, `carSurface: CarSurfaceState`, owned by a tracker step, `trackCarSurfaces`, that runs in `handleOrderSteps` right before `diffOpponentPit`.
  - The step returns a read-only `CarSurfaceTick` view, valid for that tick only, the #1572 `CarProgressTick` precedent: each car's previous last-in-world surface and its current surface.
  - Both consumers read the view: the opponent-pit diff for its pit-entry edge, and `classifyCrossing` for a blinking car's last surface.
  - The tracker writes its baseline last, so a throw hands on `null` and leaves the previous view to the next tick, which then sees the edge.
  - Opponent-pit's per-car retry after a throw keeps its behaviour through a pending-edge list of its own. A car whose unit threw is re-evaluated on the next tick against the edge it had, since the shared baseline has already advanced.
- **`isPitLaneSurface(surface)`** joins `isRacingSurface` in `diff/track-surface.ts`: `InPitStall` or `AproachingPits`. The five existing copies of that test move onto it under #1742, not here.
- **What `diffOvertakes` is handed.** It gains these values from `handleOrderSteps`:
  - the pit-lane landmark pair (`null` when unknown);
  - the pace car index;
  - the surface view;
  - `heldForPitStop` from #1756 (`false` until #1756 lands).

  It keeps writing its baselines last, after the work that can throw (#1559).

### 9. Opt-in

`OVERTAKE_CALLOUTS` in `@iracedeck/callout-settings` gains `pittedCars: { key: "calloutEnabledOvertakePittedCars", label: "Gained on cars in the pits" }`, with no `default`, since new Race Engineer functionality ships on. `SCENARIO_ID_TO_OVERTAKE_ID` maps the contract to it, and `OVERTAKE_SCENARIO_IDS` lists it.

With the opt-in off, a pit-cycle gain is silent. The translator withholds `overtake.completed` whatever the audio settings, so the gain is never announced as a pass, which is the ruling.

### 10. Shared with #942

#942 (the pull-away call) must suppress itself after a pit-cycle or incident gain. The classifier and `diffOvertakes`' returned crossings are the shared part:

- `classifyCrossing` is the one statement of why a place changed hands.
- `handleOrderSteps` hands the tick's consumed crossings to #942's diff, which takes the passed car and its cause from them on the tick `overtake.completed` is published.

The incident cause (a spun or crawling car) is #942's to add to the classifier. Nothing else in #942 is decided here.

## How #943 and #1756 never announce the same stop twice

- **One owner per window.** From the player's pit entry until ten seconds after rejoining (#1756's stop window), every change of the player's position belongs to the stop. The overtake diff is held, so no burst can open, no crossing is collected, and no gain or loss is announced. A burst open when the window opens is dropped. After the window closes, a burst can only be about other cars' stops.
- **Both lines end at pit entry.** Both contracts carry `POSITION_READOUT_ENDS_ON`, so a pitted-cars line still waiting or playing when the player turns into the pits is dropped or cut.
- **The window behind each line.** Both lines stamp the shared window with the number they say, so no ordinary readout repeats the position in the 20 s after either.

## Rejected

- **Keep publishing `overtake.completed` with a `fromPitCycle` flag and filter in the contracts.** Every subscriber would need the filter: today the reaction and the readout, tomorrow #942. One that forgot it would congratulate a pit-cycle gain. The event should mean a pass.
- **A count in the line.** Replaced by Niklas's wording. `places` stays in the payload for the singular or plural choice only.
- **Counting distinct pitted cars instead of net places.** A car passed in the exit lane that comes straight back past is two crossings and no gain. The line says what was gained.
- **Classifying by the passed car's state when the burst closes.** By then the car may have left its box. The surface at the crossing is the fact.
- **`CarIdxOnPitRoad` for the passed car.** Unreliable in captures (decision 1).
- **A crossing log with a time window and a lookback.** It existed only to bridge `PlayerCarClassPosition` moving after the canonical crossing. #1758 removes that gap at its source.
- **A fixed settling window of a couple of seconds.** It splits a long pit lane into two lines or waits needlessly on a short one. The learned pit lane says when the player is past it.
- **The `overtake` family, or the readouts' `position` supersede group.** Decision 6.
- **Asking the shared window before speaking.** The line is one-shot news, and a lap readout a few seconds earlier would silence it for good.
- **Dropping the readout when a lap call said the same number seconds earlier.** Niklas ruled the line always ends with "We're currently P…".
- **Speaking under a caution.** Decision 4.
- **Announcing a loss to a pitted or just-passed pitted car as `overtake.lost`.** "Don't give up positions like that" is wrong for a car leaving the pits on fresh tires, and wrong for a car in the pit lane getting past a stopped or crawling player.
- **A second last-in-world surface baseline beside opponent-pit's.** Two copies of one per-car fact would drift, as the per-car surface tests already have (#1742).

## Sim facts this rests on that no capture confirms

- **A remote car in a race reads `InPitStall` in its box and `AproachingPits` from the pit approach to the blend line.** The Spa capture (`pit-lane-landmarks-spa-20261109.json`) shows it for four cars in one online practice session. No race is captured.
- **A car in the pit lane is ranked by lap progress along the circuit, so the player crosses it in the canonical order on driving past it.** The order rule says a car in the pits keeps its live track slot. The Spa capture shows pit-lane `CarIdxLapDistPct` running continuously through the pit region (approach 0.975, stall exit 0.033, blend 0.063). No capture records the player's crossing of a stopped car.
- **A remote car can blink `NotInWorld` in the pit lane.** Taken from #1212's design, not from a capture cited there.

The capture that confirms all three is a `pnpm telemetry-watch` recording of an AI or online race in which the player stays out while other cars pit, ideally multi-class. It should keep `CarIdxTrackSurface`, `CarIdxLapCompleted`, `CarIdxLapDistPct`, `CarIdxClass`, `PlayerCarIdx`, `OnPitRoad`, `PlayerTrackSurface` and `SessionFlags`. Cut into `diff/__fixtures__/`, it becomes the replay test below.

## Affected artifacts

- `@iracedeck/event-bus`: the event and its doc comment.
- `@iracedeck/sim-events-iracing`:
  - `diff/crossing-cause.ts` (new) and `diff/overtakes.ts`;
  - `diff/track-surface.ts` (`isPitLaneSurface`);
  - the surface tracker step and `diff/opponent-pit.ts` (reads the view; its pending-edge list);
  - `state.ts` (the `overtakes`, `trackLength`, `pitCycle` and `carSurface` slices) and `state-slices.test.ts` (the `Overtakes` pin entry removed);
  - `translator.ts` (`handleOrderSteps` hands the new values and runs the tracker), `tick-order.test.ts`, `TRANSLATOR_REPORTER_MAX_KEYS` for the tracker's step id;
  - its `CLAUDE.md` (the tracker, the returned crossings).
- `@iracedeck/audio-scenarios`:
  - `overtake.ts`;
  - `position-readout.ts` (the numbered window, `stampPositionAnnouncement`, the `window` option, the stash's number);
  - the number vars and gates in `position.ts`, `race-status.ts` and `caution.ts` that now pass their number;
  - `CATALOG_FLOOR` in `bundled-scripts.test.ts`, `register-pit-crew.test.ts`, `callout-settings-coverage.test.ts`.
- `@iracedeck/callout-settings`: `families/overtake.ts`.
- `@iracedeck/audio-assets`:
  - the two lines in `default.voice.json` and `shawn.voice.json`, with the Terse wording drafted for Niklas;
  - the script entries and the regenerated `callouts.json`;
  - clips after Niklas approves the text and hears them on a review page;
  - pack records.
- `@iracedeck/race-engineer-wiring`: the `ends-on-order.test.ts` exemption.
- `@iracedeck/scenario-harness`: the `src/event-names.ts` template and shortcuts for one place and several places.
- Website: the overtake section of the Race Engineer callouts page, the regenerated pack reference, a `Features` changelog fragment.
- Rules:
  - a `race-engineer-callout-examples.md` entry;
  - `race-positions.md` "Current consumers" gains the crossing classifier;
  - `race-engineer-callouts.md` describes the numbered window.

## Out of scope

- Places lost or gained during the player's own stop (#1756).
- The pull-away call and its incident cause (#942).
- Moving multi-class overtake detection onto the canonical class projection: the move itself is #1758, which lands first.
- Changing `isRetirementGain`, which treats any frozen car ahead of the player as a retirement cause, not only a crossed one.
- Moving the other copies of the pit-lane surface test onto `isPitLaneSurface` (#1742).
- A line for places gained or lost on pitted cars under a caution.

## Testing

- **Unit, classifier and tracker:**
  - `classifyCrossing` for a car in its box, in the pit lane, and on the circuit;
  - a car frozen after a tow, sitting `InPitStall`, which is still `retirement`;
  - a car out of the world with a pit-lane last surface (`pit`), and with a circuit last surface;
  - a car released this tick;
  - `isPitLaneSurface` over every `TrkLoc`;
  - the tracker's view holds the previous and current surfaces, a `NotInWorld` tick never overwrites the last in-world surface, and a throw hands on `null` and the edge is seen on the next tick;
  - opponent-pit still announces an entry whose unit threw, on the next tick, through its pending-edge list.
- **Unit, overtake diff:**
  - a pure pit-cycle gain publishes no `overtake.completed`;
  - two pit-cycle gains on one pass of the pits publish one `position.pittedCarsPassed` with `places: 2`, on the tick the player leaves the learned pit-lane span;
  - the same without landmarks closes 10 s after the last gain, and the 60 s cap holds;
  - a mixed gain (a pit crossing and a racing crossing) publishes `overtake.completed` and nothing else;
  - a car passed in the exit lane that re-passes within 15 s nets the burst to zero and publishes neither `overtake.lost` nor the burst; the same re-pass after 15 s is an ordinary `overtake.lost`;
  - a caution, the player's pit entry, and `heldForPitStop` each drop an open burst silently;
  - a lapped car in its box produces no crossing, and an other-class pitted car in a multi-class race is not counted;
  - `lastCalledPosition` moves only on publish;
  - the returned crossings carry the passed car and its cause on the confirmation tick and are empty otherwise.
- **Unit, state and order:**
  - the slice guard passes with the `Overtakes` pin removed and the `trackLength` slice in place;
  - `tick-order.test.ts` sees the new event on the `diffOvertakes` row;
  - the overtake step publishes nothing on the tick `OnPitRoad` turns true (the exemption's proof).
- **Unit, the window:**
  - `tryClaimPositionAnnouncement` and `stampPositionAnnouncement` record the number with the time, and `readPositionReadoutDebugState()` reports both;
  - each readout gate records the number its fire's stash holds;
  - `"stamp"` stamps nothing when the stash holds no number;
  - `"none"` neither refuses nor records.
- **Unit, audio:**
  - the contract fires for `places` 1 and 2 with the singular and plural line;
  - it refuses on pit road, out of the car, under a caution and after the race is finished;
  - it says the readout even when a lap call spoke the same number 5 s earlier;
  - it stamps the window with the number it says, so an ordinary readout 5 s later is refused;
  - it is dropped by `pitLane.entered` while waiting, and is not replaced by a newer ordinary readout;
  - the opt-in silences it;
  - `bundled-scripts.test.ts` passes with the raised `CATALOG_FLOOR`.
- **Replay fixture:** once the capture above exists, a fixture test replays it through the translator and asserts one `position.pittedCarsPassed` per pass of the pits and no `overtake.completed` for those gains.
- **Manual (Stream Deck, AI race), Niklas:**
  - stay out while AI cars pit;
  - hear no "Nice pass." and no "We're currently" while passing the boxes;
  - hear the pitted-cars line once after the pit lane, with the position;
  - make a racing pass right after and hear the normal reaction.
