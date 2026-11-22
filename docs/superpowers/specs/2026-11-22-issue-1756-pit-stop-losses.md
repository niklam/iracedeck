> **Issue:** [#1756](https://github.com/niklam/iracedeck/issues/1756) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Places lost in the player's pit stop

## Context

When the player stops, cars that stay out drive past, and today nothing says what the stop cost. The overtake diff (`diff/overtakes.ts`) resets while `OnPitRoad` reads true. On the first tick off pit road it seeds again, silently, so every place lost in the stop disappears into the new baseline.

#1722 then silences every position line on pit road and refuses the in lap's lap readouts, and its spec rejected a dedicated after-the-stop line. The driver rejoins with no word on the stop's cost until the next ordinary position call, a lap or more away.

Niklas decided on 2026-11-22 (issue body):

- once back on the road, about ten seconds after rejoining, say "We lost a position during the pit." or "We lost positions during the pit.", followed by the existing "We're currently P6." readout;
- nothing when the stop lost no places;
- races only;
- a drive-through and a tow or reset to the pits are out, with the exact edges left to this spec.

He has also ruled that a stop made while a full-course caution is out gets no line. The ten seconds are his decision; the edge they are measured from is decided here. #943 is the mirror (places gained on other cars that pitted), and the two must never announce the same stop twice.

### Dependencies

- **#1722** (milestone 3.10.0, on `fix/1722-no-position-calls-pit-road`, not merged when this was written). This spec uses its predicate `playerOnPitRoadOrOutOfCar`, its gate builder `buildPositionReadoutSpeakGate`, its end `POSITION_READOUT_ENDS_ON` (`pitLane.entered`) and its in-lap refusal of the lap readouts (`lapEnteredPitRoad`).
- **The shared position window's redesign**, owned by the #943 spec (`2026-11-22-issue-943-pitted-car-gains.md`, decision 7). The window records the number it covers. The gate builder takes `window: (ctx) => "claim" | "stamp" | "none"`. The per-fire stash carries the number the expansion resolved. Whichever of #943 and this issue lands first builds it.

### What this changes in the #1722 spec

This spec supersedes two parts of the #1722 spec, for places lost in the player's own stop:

- its decision 3 ("No catch-up line after the stop");
- the second entry of its Rejected section ("A dedicated 'after your stop you're P8' line … #943 owns pit-stop position news").

This issue adds exactly that line. The rest of #1722 stands:

- no position line starts on pit road or out of the car;
- a line queued before pit entry is dropped rather than held;
- holding a queued line until pit exit stays rejected. This line is not a held line; it is a new reading taken once the order has settled.

#943 now owns other cars' stops only. The header keeps `Supersedes: _none_` because the supersession is partial; the #1722 spec is amended separately to point here.

## Decisions

### 1. The stop window opens at the pit lane

The translator keeps a **stop window** in a new slice. It opens in a race, past the green (`isPreGreen` false), with the player in the car, on the first tick the player is in the pit lane after a tick driving on the racing surface.

**In the pit lane** is a new helper, `playerInPitLane(telemetry)`, in `diff/track-surface.ts`:

- It is true when `OnPitRoad` is true, or when `PlayerTrackSurface` passes #943's `isPitLaneSurface` (`AproachingPits` or `InPitStall`). Either read alone is enough, as in #1722's predicate, because the approach lane reads `AproachingPits` before `OnPitRoad` turns true at the speed line.
- It is the pit-lane counterpart of the stall visit's `isDrivingOnCircuit`.
- The two rules deliberately disagree on the approach lane. The stall-visit latch treats the approach lane as circuit, because a car that braked down it still drove in. The stop window does not, because the places lost while braking there are the stop's cost.
- That difference is noted on #1742 (the issue on rules that have two readers).

**On the racing surface** means `PlayerTrackSurface` passes `isRacingSurface` and `OnPitRoad` is false.

The **entry position** is the player's position on the last racing-surface tick:

- overall from the canonical order;
- in a multi-class race, the class position from the shared projection (`standingPosition` in `diff/standings.ts`, #950);
- never `PlayerCarClassPosition` and never the official counters (`race-positions.md`).

The diff records the pair on every racing-surface tick and copies it when the window opens. So the places lost while braking down the approach lane count as the stop's.

Two cases never open the window:

- **A tow or reset.** Its path is `OnTrack → NotInWorld → InPitStall` (the `tire-temps-tow-20261011` capture). The tick before the pit surface is out of the world, not on the racing surface.
- **A pit-lane start.** The car was never on the racing surface first.

### 2. Only a stop the car drove into counts

While the window is open, it latches `stopped` on any tick whose `StallVisit` (`diff/stall-visit.ts`) reads `driveIn: true`. That is the one existing rule for a pit stop as opposed to a placement: a stall visit the car reached from the circuit down pit road.

- **A drive-through** never enters the stall and never latches. The window closes at the rejoin edge with no event.
- **An aborted entry** (into the approach lane and back onto the circuit, as car 14 does in the Spa capture) never latches either.
- **A stop-and-go penalty** is served in the stall, so it latches and counts: the places it cost are real.
- **A tow or reset during the stop** abandons the window: no event, and decision 6's hold ends. On a live tick this shows as the car out of the world.

### 3. The rejoin edge is the blend line, read from the player's own surface

The window's **rejoin edge** is the first tick after the stall departure on which the player is back on the racing surface: `PlayerTrackSurface` passes `isRacingSurface` and `OnPitRoad` is false. That is the blend line, where the exit lane meets the circuit.

The other candidate edges were rejected:

- **The `OnPitRoad` falling edge (`pitLane.exited`).** That is the pit-road speed line, not the track. The car is still in the exit lane accelerating from the limiter, and cars on the circuit keep passing it until it merges. Those places are the stop's cost. Measuring from there would also start the ten seconds while the merge is still happening.
- **The stall departure (`pitStall.departed`).** It leaves the whole pit lane still ahead.
- **#1112's learned `blendEnd` landmark.** It marks the same point, but it must have been learned for this track (`null` until it is, `source: "previous"` after a rebuild). `traffic.pitExitEnded` depends on that landmark too. The player's own surface needs nothing learned.

Ten seconds from the blend line puts the reading past these lines:

- the pit-exit traffic calls and the merge warning (#1113), spoken before or at the blend;
- the exit readback and the tire-wear report, published 4.5 s after the `OnPitRoad` edge.

### 4. Ten seconds after rejoining, one reading

A stopped window reads the player's position `PIT_STOP_POSITION_SETTLE_MS` (10 000 ms) after the rejoin edge, on the translator's tick clock (`now`, like the overtake hold). It publishes `position.pitStopSettled` with the positions before and after (decision 7). The event is published for every stopped window, whether it lost places, gained them or neither; whether to speak is the audio layer's decision. Then the window closes, and decision 6's hold lifts on that tick.

The window closes with no event in these cases:

- **A full-course caution** (`Caution` or `CautionWaving`, the bits the overtake diff reads, without the local yellows) was out on any tick of the window. This is Niklas's ruling. Under a caution the pit cycle reorders the field behind the pace car, and the caution sequence's own last-lap position call states the race position (#1127).
- **The car is out of the world on a live tick** (a tow or reset).
- **The player is out of the car on a live tick**, or the session leaves race.
- **A session change or a disconnect.** Both recreate the state.

**Leaving the car is decided on the first live tick back.** Going to the garage is a replay entry that the translator's replay guard swallows, so the diff never sees the out-of-car ticks. Its slice is kept across the replay wipe (decision 5). On the first live tick after a replay stretch, the diff tells the two cases apart:

- **Placed back in the box.** The car is in its box without having driven there: `PlayerCarInPitStall` with the stall-visit placement signature, a visit that is not a drive-in. The driver left the car and came back through the garage, so the window is abandoned.
- **Still moving.** The car is in the world and moving on the circuit or in the pit lane. The driver only glanced at a replay, so the window continues where it was.

A **second pit entry** before the reading does not open a new window. This covers a stop followed straight away by a drive-through penalty, or a missed box and a second lap of the pit lane.

- The open window continues, keeping its entry position and its `stopped` latch.
- Its rejoin edge is cleared.
- One announcement then covers the whole visit, measured from where the first entry began, ten seconds after the final rejoin.

### 5. Edges that need no rule of their own

- **Multi-class:** entry and settled positions are in class space through the shared projection. A car of another class passing during the stop changes neither.
- **Frozen and retired cars:** the canonical order keeps a towed, disconnected or finished car at its anchor (#603, #697). A car that retires during the stop counts where it froze, the same way at entry and at the reading.
- **The player's own finish:** a race that ends for the player inside the window is refused in the audio layer (`getRaceFinishedFired`), like every position line.
- **Replay glance:** the slice is kept whole across the replay wipe (`preservedAcrossReplay`). The entry position and the `stopped` latch stay true across a glance, following the #771 precedent for a pending one-shot. Decision 4 settles what the first live tick back means.
- **Pre-green:** the window cannot open, so a pit-lane start or a grid shuffle never reads as a stop.

### 6. The stop owns every position change in its window

`handleOrderSteps` runs the new diff, `diffPitStopPosition` (`diff/pit-stop-position.ts`), before `diffOvertakes`. It hands the diff's returned `heldForPitStop` to `diffOvertakes`, because a same-tick flag one step hands another is a returned value (#1559):

```typescript
let heldForPitStop = false;

steps.live("diffPitStopPosition", pending, () => {
  heldForPitStop = diffPitStopPosition(self.state.pitStopPosition, telemetry, values.stallVisit /* , … */, now, emit);
});
```

A throw leaves `false`, which is today's behaviour: the overtake diff seeds at the `OnPitRoad` falling edge.

The step's inputs:

- `OrderStepValues` gains `stallVisit: StallVisit | null`, handed in as `stallVisit.ok ? stallVisit.value : null` from the `updateStallVisit` value `handleLiveSteps` resolves.
- On `null`, the diff latches nothing that tick but still computes the hold.

The hold:

- It is true from the window's opening tick until its closing tick, the pit lane and the ten seconds after rejoining included, for every window whether or not it stopped.
- While it is true, the overtake diff behaves exactly as on pit road today. It resets and returns, so it seeds silently on the tick the hold lifts.

No line can describe a place that changed hands in the window: no `overtake.completed`, no `overtake.lost`, no overtake readout and no #943 pitted-cars burst. Nothing is counted twice. A car that passes the player in the merge, and a car the player passes while driving down the pit lane past other boxes, are both in the net this event carries.

The lap readouts cannot speak in the window either. The lap that holds the pit entry is an in lap, which #1722's `lapEnteredPitRoad` refuses, and the next lap ends a full lap later.

The diff runs in `handleOrderSteps` because it reads the canonical order. So it joins the canonical order's consumers listed in `sim-events-iracing/CLAUDE.md` (the step boundary's `steps.requiredValue` list). It owns its slice and writes its baseline last.

### 7. The bus event: `position.pitStopSettled`

The event is a new catalog entry in `@iracedeck/event-bus`. It is a published contract, reviewed at `xhigh`. It uses the same before/after field names as #943's `position.pittedCarsPassed`.

```typescript
/**
 * The player's position has settled after a pit stop in a race (issue #1756).
 * Published once per stop the car drove into its stall, ten seconds after the
 * car rejoined the circuit at the end of the pit exit lane. `positionBefore` is
 * the position on the last tick on the circuit before the pit lane, `position`
 * the position now; the class fields carry class position in a multi-class
 * race. Published for a loss, a gain or no change alike. Never for a
 * drive-through, an aborted pit entry or a tow or reset to the pits, never when
 * a full-course caution was out during the stop, never pre-green. Positions are
 * the canonical live order; class positions come from that same order.
 */
"position.pitStopSettled": SimEvent<
  "position.pitStopSettled",
  {
    /** Overall race position on the last tick on the circuit before the pit lane (1-based). */
    positionBefore: number;
    /** Overall race position ten seconds after rejoining (1-based). */
    position: number;
    /** Class position before the pit lane, when class info is available. */
    classPositionBefore?: number;
    /** Class position ten seconds after rejoining, when class info is available. */
    classPosition?: number;
    /** True iff the current session has more than one car class on track. */
    isMultiClass?: boolean;
  }
>;
```

The event carries facts, not a verdict, so a later "we gained places in the stop" line or a deck display needs no new event. The rest of the wiring:

- `diff/pit-stop-position.ts` declares `PIT_STOP_POSITION_EVENTS`.
- It gets a `TICK_ORDER` row ahead of `diffOvertakes`, with `via: "pending"`, plus its spy line in `tick-order.test.ts`.
- The scenario harness gets an `src/event-names.ts` template.

### 8. The audio contract

One contract, `pit-crew.position-pit-stop-lost`, in `position.ts`.

**Trigger.** `when: { event: "position.pitStopSettled", where }`. The `where:` computes the places lost in the payload's own projection: class fields when `isMultiClass`, overall otherwise. It admits the event only when all of these hold:

- at least one place was lost, and the settled position is known;
- the race is not finished for the player (`getRaceFinishedFired`);
- the player is in the car and off pit road (`playerOnPitRoadOrOutOfCar`, #1722);
- no full-course caution is out (`getUnderFullCourseCaution`).

**`speakGate`.** Built on `buildPositionReadoutSpeakGate` with `window: () => "stamp"` (the #943 spec, decision 7). It asks the pit-road and out-of-car check, then the caution. It then stamps the window with the number this fire's stash holds, which `positionReadout.number` wrote at expansion. So the readouts within the next 20 s defer to it.

- The window is not asked, because this is one-shot news and decision 6 already keeps every other position line out of the ten seconds before it.
- No intro decision is committed. The script says the intro clip directly, and the intro is committed only from a stash, never asserted in code.

**Scheduling:**

- `weight: WEIGHT.CHATTER`.
- `queueable: true`, because this is a one-shot edge (the #923 rule).
- `maxQueueWaitMs: 20_000`. The news stays true while it waits, the number is read live, and the gate re-checks pit road and the caution at speak time.
- `queueBehind: ["pit-crew.pit-readback-exit", "pit-crew.tire-wear-report"]`, so a slow exit readback or tire report that is still waiting is heard first, as the stop's own lines.
- **No `family`**, and `supersedeGroup` at its default. A heavier line arriving while this one plays waits rather than replacing it. A newer ordinary readout can never replace it while it waits.

**`endsOn: POSITION_READOUT_ENDS_ON`** (`pitLane.entered`). A line still waiting or playing when the player turns into the pits again is dropped or cut.

`diffPitStopPosition` runs after `diffPitLane`, so the pair needs an entry in `ends-on-order.test.ts`'s `TRIGGER_AFTER_END_EXEMPTIONS`:

- trigger `position.pitStopSettled`, end `pitLane.entered`;
- trigger stage `diffPitStopPosition`, end stage `diffPitLane`;
- the proof it cites is `pit-stop-position.test.ts`'s "publishes nothing on a tick the player is in the pit lane". A re-entry continues the window (decision 4), so the reading is never taken on such a tick.

**Vocabulary,** registered in `registerPositionVocabulary`: a case `position.pitStopLoss`, keys `one` ("The stop cost one place.") and `several` ("The stop cost two or more places."). It is resolved from the fire's own `position.pitStopSettled` payload, and is `null` for any other fire. The readout reuses:

- `positionReadout.number`: the live position at speak time, class in a multi-class race. It also writes the number into the fire's stash.
- the `position-intro-worse/currently` clip directly, because Niklas's wording always says "We're currently".

The bundled script for both first-party voices:

```json
[
  {
    "case": "position.pitStopLoss",
    "of": {
      "one": ["pool:position-pit-stop/lost-a-position"],
      "several": ["pool:position-pit-stop/lost-positions"]
    }
  },
  "pool:position-intro-worse/currently",
  "{{positionReadout.number}}"
]
```

The readout is required, as in #943's line. `POSITION_CLIP_SOURCES` gains the two new bases.

### 9. Opt-in

`POSITION_CALLOUTS` in `@iracedeck/callout-settings` gains `pitStopLost: { key: "calloutEnabledPositionPitStopLost", label: "Places lost in a pit stop" }`, with no `default`, since new Race Engineer functionality ships on. `SCENARIO_ID_TO_POSITION_ID` maps the contract to it.

With the opt-in off, the window still holds the overtake diff (decision 6), so a stop's places are never announced as overtakes. The hold is a translator rule, not an audio one.

### 10. Clips

Two new lines go in a new group, `position-pit-stop`, in every first-party voice:

- `lost-a-position-01`: "We lost a position during the pit."
- `lost-positions-01`: "We lost positions during the pit."

These are the `default.voice.json` texts; `shawn.voice.json` gets a Terse wording, drafted for Niklas. Each joins the "We're currently" clip that follows. So both are authored by the "Clips that join other clips" rule in `packages/audio-assets/CLAUDE.md`, as the existing readout lead-ins are.

No clip is generated before Niklas approves the text, and none is committed before he hears it on a review page. The readout itself reuses `position-intro-worse/currently` and `position-number/*`.

## How #1756 and #943 never announce the same stop twice

- **One owner per window.** From the player's pit entry until ten seconds after rejoining, the overtake diff is held (decision 6). So #943 can neither open a burst nor collect a crossing, and every place that changes hands in that time is in this event's net. After the window, #943 can only describe other cars' stops.
- **Both lines end at pit entry,** through the shared `POSITION_READOUT_ENDS_ON`.
- **The window behind each line.** Both lines stamp the shared window with the number they say, so no ordinary readout repeats the position in the 20 s after either.

## Rejected

- **Measuring from the `OnPitRoad` falling edge.** Decision 3.
- **Measuring from the learned `blendEnd` landmark or `traffic.pitExitEnded`.** They mark the same point as the player's surface, but only on a track whose pit lane has been learned.
- **Taking the entry position from the overtake baseline.** That baseline is reset on pit road, and it is not the canonical order this rule requires.
- **Announcing each place lost during the stop as it happens.** #1722's pit-road silence stands, and the order inside the stop is in flux.
- **Letting the overtake diff resume at pit exit and subtracting what it announces.** That gives two lines about one merge, and a "Come on, don't give up positions like that." for a car the player could not hold off from the exit lane.
- **Emitting only on a loss.** The event would then carry the audio layer's policy. Facts let a gain line or a display follow without a new contract.
- **Taking the shared window as a precondition.** The line is one-shot, so a refusal would lose the stop's news for good.
- **A family shared with the overtake reactions, or the readouts' `position` supersede group.** A reaction would replace the line in flight, or a newer readout would replace it while it waits.
- **Counting a drive-through or a tow.** Niklas's ruling. A drive-through is a penalty whose cost the driver knows, and a tow's places are lost to the incident, not the stop.
- **Abandoning the window on the replay entry itself.** The guard swallows those ticks, and a replay glance mid-stop is not leaving the car. Only the first live tick back can tell the two apart.
- **Speaking under a full-course caution.** Niklas's ruling (decision 4).

## Sim facts this rests on that no capture confirms

- **In a race, the player's `PlayerTrackSurface` reads `AproachingPits` through the exit lane and turns `OnTrack` at the blend line.** The Spa capture (`pit-lane-landmarks-spa-20261109.json`) shows the player's surface slot doing this in one online practice session, with `OnPitRoad` synthesised. No race is captured.
- **A drive-through penalty never sets `PlayerCarInPitStall`, and a stop-and-go does.** Not captured.
- **The places lost in the merge are lost within ten seconds of the blend line.** The ten seconds are Niklas's. Whether they cover a slow merge on a long exit lane is not measured.
- **Leaving the car and getting back in ("Drive") arrives on the first live tick with the car already in its box.** The tire-temps capture shows the garage exit as `IsReplayPlaying` true (668.83 s). It ends in the garage, so it does not show the next "Drive".

The tow path (`OnTrack → NotInWorld → InPitStall`) and a drive-in stop's edges are captured (`tire-temps-tow-20261011.json`, `tire-temps-stops-20261011.json`, `tire-wear-stops-20260919.json`).

The capture that confirms the rest is a `pnpm telemetry-watch` recording of an AI race that includes one ordinary stop, one served drive-through, one stop-and-go, and a garage exit and "Drive" during an open window. It should keep `OnPitRoad`, `PlayerTrackSurface`, `PlayerCarInPitStall`, `IsOnTrack`, `IsReplayPlaying`, `SessionFlags`, `SessionState`, `CarIdxLapCompleted`, `CarIdxLapDistPct`, `CarIdxTrackSurface` and `CarIdxClass`. Cut into `diff/__fixtures__/`, it becomes the replay test below.

## Affected artifacts

- `@iracedeck/event-bus`: the event and its doc comment.
- `@iracedeck/sim-events-iracing`:
  - `diff/pit-stop-position.ts` (new), with `PIT_STOP_POSITION_EVENTS`, its `TICK_ORDER` row (`via: "pending"`) and its spy line;
  - `diff/track-surface.ts` (`playerInPitLane`; `isPitLaneSurface` unless #943 added it);
  - `state.ts` (the `pitStopPosition` slice, kept across the replay wipe);
  - `diff/overtakes.ts` (the `heldForPitStop` parameter);
  - `translator.ts` (`handleOrderSteps`, and `OrderStepValues.stallVisit`);
  - `TRANSLATOR_REPORTER_MAX_KEYS` for the new step id;
  - its `CLAUDE.md` (the canonical order's consumer list, and the hold).
- `@iracedeck/audio-scenarios`:
  - `position.ts`;
  - `position-readout.ts` (the numbered window and the `window` option, unless #943 added them);
  - `CATALOG_FLOOR`, `register-pit-crew.test.ts`, `callout-settings-coverage.test.ts`.
- `@iracedeck/callout-settings`: `families/position.ts`.
- `@iracedeck/audio-assets`: the `position-pit-stop` group in both voice configs, the script entries, the regenerated `callouts.json`, clips after approval, and pack records.
- `@iracedeck/race-engineer-wiring`: the `ends-on-order.test.ts` exemption.
- `@iracedeck/scenario-harness`: the `src/event-names.ts` template, and shortcuts for one place lost, several places lost, and a gain (silent).
- Website: the position section of the Race Engineer callouts page, the regenerated pack reference, and a `Features` changelog fragment.
- Rules: a `race-engineer-callout-examples.md` entry. `race-positions.md` "Current consumers" gains the stop reading.
- Issue #1742: a note on the approach-lane difference between `playerInPitLane` and `isDrivingOnCircuit`.

## Out of scope

- Places gained on other cars that pitted (#943).
- A line for places gained, or held, in the stop.
- A line for a drive-through, a stop-and-go's penalty itself, or a tow.
- Any position line on pit road (#1722 stands).
- Changing when the exit readback, the tire-wear report or the pit-exit traffic calls are published.
- Moving the other pit-lane and circuit surface rules onto the shared helpers (#1742).

## Testing

**Unit, diff:**

- An ordinary stop from P5, rejoined at P8, publishes `position.pitStopSettled` (5 → 8) on the first tick 10 s after the blend-line tick, and not before.
- The entry position is the last racing-surface tick's, so a place lost in the approach lane counts.
- A drive-through and an aborted entry publish nothing and lift the hold at the blend line.
- A tow from the circuit never opens a window, and a reset mid-stop abandons it.
- A caution on any tick of the window suppresses the event.
- A second entry during the ten seconds continues the window and publishes once, measured from the first entry.
- A multi-class stop reads class positions from the canonical order, and an other-class car passing changes nothing.
- The hold:
  - it is true from the opening tick to the closing tick;
  - a throw leaves it `false`;
  - with `stallVisit` `null` the diff latches nothing that tick and still holds.
- Nothing is published on a tick the player is in the pit lane (the exemption's proof).
- `playerInPitLane` is true on `OnPitRoad`, `AproachingPits` and `InPitStall` alone, and false on the circuit.

**Garage-exit replay:**

- An open window, then a run of replay-mode ticks (`IsReplayPlaying` true, `IsOnTrack` false), then a first live tick with the car placed in its box: the window is abandoned, nothing is published, and the hold lifts.
- The same run ending on a first live tick with the car moving on the circuit: the window continues and publishes on time.

**Unit, overtakes:** with `heldForPitStop` true the diff publishes nothing and seeds on the tick the hold turns false. A car passing in the merge produces no `overtake.lost`.

**Unit, order:** `tick-order.test.ts` sees the new row ahead of `diffOvertakes`. `ends-on-order.test.ts` passes with the contract registered and the exemption entry in place.

**Unit, audio:**

- The contract fires on a loss of one place and of three places with the singular and plural line, in overall and in class projection.
- It is silent on no change and on a gain.
- It refuses on pit road, out of the car, under a caution, and after the race is finished.
- It waits behind a waiting exit readback and tire-wear report.
- It stamps the window with the number it says, so an overtake readout 5 s later is refused and the window's record holds that number.
- It is dropped by `pitLane.entered` while waiting.
- The opt-in silences it while the translator's hold stays.
- `bundled-scripts.test.ts` passes with the raised `CATALOG_FLOOR`.

**Replay fixture:** once the capture above exists, a fixture test replays it through the translator: one event for the ordinary stop, none for the drive-through, and the stop-and-go counted.

**Manual (Stream Deck, AI race), Niklas:**

- Pit and lose places.
- Hear nothing on pit road or in the merge.
- About ten seconds after joining the track, hear "We lost positions during the pit. We're currently P…" once, with no overtake line in between.
- Pit on a lap where nobody passes, and hear nothing.
