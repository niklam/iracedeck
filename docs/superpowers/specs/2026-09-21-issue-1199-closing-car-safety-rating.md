> **Issue:** [#1199](https://github.com/niklam/iracedeck/issues/1199) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: the licence and safety rating of a car closing on you

## The problem

The issue carries the what and the why. Two facts shape the design. First, the licence and safety rating in the session roster are the only cleanliness signal an official race exposes about an opponent: in the capture the issue cites (`local/telemetry-snapshot-20260623-202105-132.json`, series 483, Legends at Lakeland), every opponent's `CurDriverIncidentCount` and `TeamIncidentCount` reads `-1`, and every `ResultsPositions[].Incidents` reads `0`, including the player's, although the player had 4. Second, the moment is physical. The car in question is the one about to be beside you, in any class and on any lap. That is not the class-standings neighbour that the gap engine (#933) and the briefing (#1117) follow, and not the faster-class car that #1119 times.

## What ships

In a race, when the nearest car directly ahead or behind on the road comes within 2.0 s, the Race Engineer reads out its licence and safety rating, and adds a tail below 2.5:

> "Car behind: B licence, safety rating three point one."
> "Car ahead: C licence, safety rating two point three. Be careful with that car."
> "Car behind: A licence, safety rating one point six. Their safety rating is low. Watch out."

Once a car has been announced, it is not announced again until it has been more than 10 s away on the road, or until someone else is driving it. There is no time limit. There are two opt-ins, both on by default under the Race Engineer master: `calloutEnabledClosingCarReadout` (2.5 and above) and `calloutEnabledClosingCarWarning` (below 2.5).

## Decisions

### 1. The car is found in road order and measured with the gap engine's clock

**Which car.** `findNearestCarOnTrack` (`@iracedeck/iracing-sdk` `track-utils.ts`) is the project's only track-order primitive (`race-positions.md`). It already ignores laps and classes: it walks `CarIdxLapDistPct` around the lap and judges presence with `carInWorld`. The new diff calls it for `"ahead"` and `"behind"` from the player's car. Its `skipIdx` drops three kinds of car:

- the pace car;
- spectators;
- any car whose `CarIdxTrackSurface` is not `TrkLoc.OnTrack`. A car in its stall or on pit lane sits at a lap distance beside the track and is not racing you. A car off track is a hazard for the spotter, not a driver to introduce.

A missing surface array leaves the car eligible, which is the #936 "don't punish missing data" rule. AI cars stay in the walk, because an AI car directly ahead is the car directly ahead. It simply carries no rating, so it produces no line. The walk runs only when the player's own lap distance is valid. When the reference car has no position, `findNearestCarOnTrack` falls back to the car nearest start/finish, which here would introduce a stranger.

Only the nearest car on each side is considered. In a pack, the other cars are announced when they become the nearest car on a side while within 2.0 s.

**How close.** The road gap is the #933 crossing-time gap, read in road order instead of standings order. It is the time since the leading car of the pair passed the point where the trailing car is now. The lookup is made on the leading car's own progress trace, at `leadingProgress − roadFraction`, where `roadFraction` is the forward `CarIdxLapDistPct` distance from the trailing car to the leading one, folded around the lap. Because the lookup subtracts a road distance from the leading car's own progress, it holds for a car a lap up or down. The standings lookup (`getLiveGapBetween`) deliberately does not. The traces already exist for every live car: `diffGaps` records them each tick in exactly the sessions this callout speaks in. One pure helper beside `crossingTimeAt` in `gap-utils.ts` does the lookup (proposed name `roadGapSeconds(trace, leadingProgress, roadFraction, now)`). It applies the existing crossing-time model at a different point, so the repo does not gain a gap calculation.

Three alternatives were weighed against it:

- **`CarIdxEstTime`**, the arrival model #1113 and #1119 plan, is ruled out by a capture. It measures time on each car's own class's reference lap. In the official multiclass race `local/telemetry-snapshot-20260728-182929-223.json` (Monza, GTP and GTD), GTP #11 and GTD #27 (car indices 5 and 29) were 6.5 m apart and their values differed by 5.38 s. Four cross-class pairs, each no more than 22 m apart, differed by 4.4–5.5 s, in line with the gap between their classes' `CarClassEstLapTime`. So subtracting two classes' values does not give a gap, and cars of other classes are the case this callout exists for. This finding bears on the arrival model that #1113 and #1119 plan. Their specs are not amended here.
- **The #936 coarse gap** (`coarseForwardGapSeconds`: road distance ÷ the player's current speed) suits #936's window but not this trigger. The same 100 m reads 5 s in a hairpin and 1.25 s on a straight, so a 2.0 s trigger measured this way would fire mostly on straights.
- **`CarLeftRight`** reports only overlap. That is the spotter's moment, and by then this line should already be over.

A pair whose leading car is crawling produces no line. Crawling means running below half the trailing car's recent pace, the #933 ETA-regime rule (`GAP_ETA_LEADER_SLOW_FACTOR` in `diff/gaps.ts`). The crossing-time gap stops tracking the separation there, and a crawling car is the spotter's business, not a driver to introduce.

### 2. The trigger: the road gap falls to 2.0 s

A side triggers when its nearest car's road gap is at or below `CLOSING_CAR_TRIGGER_S` (2.0 s, the maintainer's value). There is no early bound for fast closers.

The condition must hold with the same car for `CLOSING_CAR_STABLE_TICKS` (10 ticks, about 170 ms), the #933 `GAP_STABLE_TICKS_FOR_CALLOUTS` figure. A gap step between two ticks larger than #933's `GAP_GLITCH_JUMP_S` resets the count. Both are #933's measured values, so neither needs a new capture. The debounce exists because one bad telemetry frame read a 2.4 s gap as 0.9 s in #933, and here that would announce a car that was never close.

One consequence of the 2.0 s trigger is worth stating. A car closing 60 km/h faster at 50 m/s is about 100 m back at 2.0 s, which is about six seconds from alongside. That is roughly as long as the warning line takes to say. In fast multiclass closing, the line can therefore still be playing when the car arrives. Decision 6 covers what happens then: the spotter cuts it, and it replays after "Clear."

### 3. Once per approach: announced again only after the car has been 10 s away

A car is announced once per **approach**. An approach ends when the car's road gap to the player goes past `CLOSING_CAR_RELEASE_S` (10 s). The cause does not matter: the car dropping back, the car pulling away, either car's pit stop, or being lapped. The car's next time within 2.0 s is a new approach and is announced again. A car that stays within 10 s is one approach however long it lasts, and there is no time limit.

**A driver change also starts a new approach.** When the roster shows a different `UserID` for a `CarIdx`, which happens at a team-race driver swap, the next time within 2.0 s is announced again, because a new driver brings a new rating. It is unverified that the roster entry takes on the new driver's `UserID` and `LicString` at a swap. The capture that settles it is a team race recorded across a driver swap, with the session info from before and after.

**Where the state lives.** The translator owns where an approach ends, and the audio layer owns whether it was announced. This follows #1137/#1138: a claim is committed only in `speakGate`.

- The translator gives every car an **approach id**. It takes a new one from a counter each time the car's road gap rises past 10 s from within it, and each time its `UserID` changes. The counter only ever goes up and is never reset for the life of the translator instance, so an id is never reused, not even across a session change or a reconnect. The per-car approach state is preserved across `wipeStateForReplay`, the #622 precedent, so glancing at a replay does not re-announce the car beside you. It is recreated on a session change, but under fresh ids.
- The road gap used for the release is measured for every in-world car on its nearer side (the smaller of the two road gaps). Each measurement is one binary search on a trace. It runs on every tick the traces are recorded, independent of the announcing gates in decision 5. A car that pits under a caution, or drops back on the opening lap, is released the same way.
- The audio layer keeps, per `CarIdx`, the last approach id announced. `where:` asks the pure `isApproachAnnounced(carIdx, approachId)`. `admit` calls `tryClaimApproach(carIdx, approachId)` last, which only a fire certain to play reaches. The store lives in the family file and never needs clearing, because ids are never reused.

**A line that is never played leaves the approach unannounced.** That covers an opt-in switched off, a caution, the racing-moment gate in `where:`, a gate refusal at speak time, an expansion that aborts, and a queued fire displaced from the single pending slot. Since the translator cannot know whether a line played, it offers the car again: while the same car stays nearest on a side, within 2.0 s and in the same approach, it re-emits every `CLOSING_CAR_REOFFER_S` (5 s). The audio layer drops every offer of an approach already announced, at `where:`, before any work. So a car whose line was lost to an incident moment is announced a few seconds later if it is still close. A driver who switches an opt-in on mid-battle hears the car on the next offer.

**A line cut by the spotter counts as announced.** It had passed the gate, and the driver heard its start. It replays whole after the spotter, as decision 6 describes. If the car is no longer beside the player by then, the replay aborts and the approach stays announced.

**Short tracks.** On a track whose lap is under about 20 s, no car can be more than 10 s away on the nearer side. Each car there is therefore announced once per session and driver. That is the 10 s rule applied as ruled, and is recorded here so nobody takes it for a bug.

### 4. A new diff, a new event and a live snapshot

The work sits in `packages/sim-events-iracing/src/diff/closing-car.ts` (`diffClosingCar`). `handleTick` calls it directly after `diffGaps`, because it reads the traces `diffGaps` has just appended. It emits:

```ts
"closingCar.entered": SimEvent<
  "closingCar.entered",
  {
    side: GapSide; // "ahead" | "behind", the existing gap-event type
    carIdx: number;
    approachId: number; // decision 3
    driver: DriverRating | null; // decision 7; null for an AI car or an unreadable rating
    gapSeconds: number; // road gap at emission
  }
>;
```

It emits when a car becomes the nearest on a side within 2.0 s, or triggers there after the debounce, and again every 5 s while that holds. When both sides emit on one tick, the ahead side goes first, because that is the car the driver is looking at. The event is generic: it reports that a road neighbour is close and who drives it, and leaves the decision to speak to the audio layer. A later consumer can use it without a second diff. The payload freezes the identity, as the gap events do with their `carIdx`. Every var reads the fire's own event (the `gaps.ts` rule), so a fire waiting in the pending slot cannot be repointed at another car.

A reader, `getRoadNeighbors()`, is exported from `@iracedeck/sim-events-iracing` beside `getLiveGaps()`. It returns the diff's live snapshot, `{ ahead, behind }`, each side `{ carIdx, approachId, gapSeconds } | null`. It returns `null` whenever the diff is gated. It reaches the catalog as a `PitCrewDeps` entry, `getRoadNeighbors?: RoadNeighborsResolver`, which defaults to `() => null` and serves the speak-time reads in decisions 6 and 8.

The per-side state lives in `TranslatorState`: the nearest car, the stability count, and the last emission. It is re-seeded across `wipeStateForReplay` and `resetPerSessionState`. The per-car approach state is kept as decision 3 says.

### 5. Races only, never under a caution, and not on the first green lap

The diff announces only when all of these hold:

- the session is a race (`isRaceSession`);
- the green has flown (`!isPreGreen`) and the player has not taken the checkered (`!isPostRace`);
- the session is not replay-only (the `replayOnlySession` parameter, the `diffPitsOpen` precedent);
- the player is on track (`PlayerTrackSurface === TrkLoc.OnTrack`, `LapCompleted ≥ 0`);
- the translator's own caution phase (`state.cautionPhase`) is `"none"`.

It also stays silent from each green, the start and every restart, until the player has completed one full lap under it. The field is nose to tail there and every neighbour is inside 2.0 s. The start and the restart already have their own callouts, and the spotter is at its busiest. A car that is still close when that lap ends is announced then. These gates hold back announcements only. The release measurement in decision 3 keeps running.

Practice and qualifying are left out. A car you catch there is on a different programme, a readout for every car caught on a busy server would be constant chatter, and the rating matters when you are about to race wheel to wheel. The gap, opponent-pit and opponent-flag families and #1117 make the same choice.

The caution silence matches #1117 and #1171, for the same reason: the cars around you under yellow are a lineup, not a fight. The audio side checks the caution again (decision 8), as #1171 does for the gap calls, so a line queued before the caution came out cannot play under it.

### 6. It waits for the spotter, and the spotter never waits for it

- **Weights below the spotter's focus floor.** The readout is `WEIGHT.CHATTER` and the warning `WEIGHT.NORMAL`. While any car is alongside, the spotter holds `acquireFocus(AudioBus.Voice, …, WEIGHT.SAFETY)`, so both lines wait instead of talking over its reminders. At `SAFETY` they would break through that floor.
- **`queueable: true`, `interrupt: false`.** A line that cannot take the bus waits for idle instead of being dropped, and it never cuts anything.
- **Cut by the spotter, replayed whole.** A car coming alongside mid-sentence fires `pit-crew.spotter-call` at `WEIGHT.PROXIMITY` with `interrupt: true`, which cuts this line. A proximity call is never delayed (#867). The cut line is kept and replays from the top once the spotter releases its floor. It is not `resumable`: "…safety rating three point one" resumed after "Car left" would be a fragment about a car the driver can no longer place.
- **No family**, the #622 opponent-pit precedent. Consecutive lines are about different cars, and same-family preemption would let the second cut the first mid-sentence. The approach rule and the single pending slot are the repeat control.
- **Before the cars are alongside, where possible.** At 2.0 s that holds for same-class traffic and most lapping, but not always for fast multiclass closing (decision 2). If the line misses, it replays after "Clear."
- The line keeps the default radio frame.

A deferred or replayed fire can arrive after the cars have moved, so the side is read live. `closingCar.side` names the side on which the event's car is a road neighbour now, so a car that passed during the spotter episode is introduced as "Car ahead:". When the car is no longer a neighbour on either side, the var resolves to nothing and the callout aborts (#835): a car that has driven off is not introduced. When there is no snapshot at all, `getRoadNeighbors()` returns `null`, as it does in the harness, and the var falls back to the event's side. The same function answers the gate's "still beside you" check in decision 8, so the side and the gate cannot disagree about a fire.

### 7. Licence and safety rating: one parser for three consumers

The roster read lives in `@iracedeck/iracing-sdk`, in a proposed `license-utils.ts`, because #1117 and #944 read the same fields and must not parse them differently. It offers `parseLicenseString` for one `LicString` value, and `resolveDriverRatings(sessionInfo)`, which returns a `Map<carIdx, DriverRating>` over `DriverInfo.Drivers[]`:

```ts
type LicenseClass = "rookie" | "d" | "c" | "b" | "a";

type DriverRating = {
  userId: number | null; // DriverInfo.Drivers[].UserID when positive
  licenseClass: LicenseClass | null;
  safetyRatingHundredths: number; // 291 means 2.91
};
```

The event bus carries a structurally identical type, because it has no SDK dependency (the `RadioFrameSwitches` precedent). The translator memoises the map per session-info object (the `cautionLineupMemo` shape), reads `userId` from it for the driver-change rule in decision 3, and exposes `getDriverRating(carIdx)` for the two consumers that read at speak time.

- **Who gets an entry.** A car with `CarIsPaceCar === 1`, `IsSpectator === 1` or `CarIsAI === 1` gets none. The pace car is matched by the roster's own flag as well as by `resolvePaceCarIdx`: in the Lakeland capture, `DriverInfo.PaceCarIdx` reads 62 while the roster's pace-car entry is `CarIdx` 64.
- **`LicString` is the source and `LicSubLevel` the cross-check.** `LicString` is a letter token, a space and the rating to two decimals (`"B 2.90"`). It can arrive as a YAML number or blank (the #869 rule), so it is normalised to a string first. Its rating ×100 must agree with `LicSubLevel` to within one hundredth. They agreed for all 84 roster entries in the three captures read for this spec: the Lakeland race and the two multiclass races, Monza above and `local/telemetry-snapshot-20260810-211132-084.json` at Fuji. If both are present and disagree, the rating is unknown. If one is missing, the other stands.
- **A zero rating is unknown.** The pace car carries `R 0.00`. A zero or missing rating produces no entry, so no line. A new account's `R 2.50` is a real rating and gets the plain readout.
- **Letters.** `R`, `D`, `C`, `B` and `A` map to the five classes. What a Pro or Pro/WC licence prints in `LicString` is unverified, because no capture holds one. Any other token therefore keeps the rating and drops the licence (`licenseClass: null`). The line then reads "Car ahead: safety rating three point one." Once a capture shows the Pro string, recognising it is one table entry.
- **Bands are decided in hundredths.** 250 and above is plain, 200–249 is careful, below 200 is low. They do not change with the licence class (the maintainer's ruling; see *Alternatives rejected*).
- **The spoken figure is cut to one decimal, never rounded.** 2.49 is spoken as "two point four". The band edges sit on tenths, so a cut figure always falls in the same band as the real one. Rounding would say "two point five. Be careful with that car." about a 2.49, which breaks the rule the driver knows. Integer arithmetic on the hundredths (`Math.floor(h / 10)`) keeps floating point out of it.

### 8. The contracts

There are two contracts on `closingCar.entered`, split by band so that each opt-in governs one: `pit-crew.closing-car-readout` (the plain band) and `pit-crew.closing-car-warning` (careful or low).

**`where:`** is pure. It requires:

- `!isApproachAnnounced(carIdx, approachId)`, first, so the repeated offers of an announced approach cost nothing;
- `liveRaceCar`, `!getRaceFinishedFired()` and `!getUnderFullCourseCaution()`;
- a non-null `driver` whose band is the contract's;
- the racing-moment gate: `overtakeContextAllows` without its alongside clause, as a new sibling predicate in `overtake-gate.ts`. Being off track, crawling below 50 km/h, on pit road, or within ten seconds of an incident all suppress the line. A car alongside does not: that is the spotter's moment, and the focus floor already holds the line back until it passes.

**`speakGate`** (#1138) has the description "The car is still the nearest car directly ahead or behind in the same approach, and no caution is out; speaking it marks this approach as announced." `admit` checks the caution, then checks the car and its approach id against `getRoadNeighbors()` (it admits when there is no snapshot), and calls `tryClaimApproach` last.

**Vocabulary**, under the family name `closingCar`:

- `closingCar.side` (var): "Car ahead:" or "Car behind:", from `driver-rating/car-ahead` or `driver-rating/car-behind`, with the side read live as in decision 6.
- `closingCar.license` (var): the licence, from `driver-rating/license-r` (spoken "Rookie licence") through `driver-rating/license-a`. It resolves to nothing when the letter was not recognised.
- `closingCar.ratingWhole` (var): the whole part of the cut rating, from the lap-time-second group (lap-time-second/3 is "three", recorded to lead into "point").
- `closingCar.ratingTenth` (var): the tenth, from the safety-rating-decimal group (safety-rating-decimal/1 is "point one.").
- `closingCar.band` (case, keys `plain`, `careful` and `low`): the band from decision 7.

Each description names its group, which is how `descriptionNamesGroup` credits the lines to the var. The reference voice's script, with `comment` and `test` left out:

```json
{
  "fragments": {
    "closing-car-identity": [
      "{{closingCar.side}}",
      { "optional": ["{{closingCar.license}}"] },
      "pool:driver-rating/safety-rating",
      "{{closingCar.ratingWhole}}",
      "{{closingCar.ratingTenth}}"
    ]
  },
  "scenarios": {
    "pit-crew.closing-car-readout": { "sequence": ["@closing-car-identity"] },
    "pit-crew.closing-car-warning": {
      "sequence": [
        "@closing-car-identity",
        { "case": "closingCar.band", "of": { "careful": ["pool:closing-car/careful"], "low": ["pool:closing-car/low"] } }
      ]
    }
  }
}
```

The licence is an optional clause because dropping it still leaves a true sentence. The rating is not optional, because a readout without its number says nothing.

### 9. Clips

Whichever of #1117 and #1199 lands first creates the shared clips, once, for both:

- **`driver-rating`**: `car-ahead` ("Car ahead:"), `car-behind` ("Car behind:"), `license-r` ("Rookie licence,"), `license-d` through `license-a` ("D licence," through "A licence,"), and `safety-rating` ("safety rating").
- **`safety-rating-decimal`**: `0` through `9` ("point zero." through "point nine."), a value group shaped like `lap-time-decimal` but without "seconds".
- The whole part reuses `lap-time-second` 0–4, whose takes were recorded to lead into "point", the gap readout's pattern. It does not use `session-start-temp-numbers`, which #1117 first planned to use, because #1187 deletes that group.

For #1199 alone, in `closing-car`: `careful` ("Be careful with that car.") and `low` ("Their safety rating is low. Watch out.").

The phrase clips take the generator's `-01` suffix; `safety-rating-decimal` is a value group and does not. Generation is scoped with `--group` after a dry run. The pack version is bumped, and `pack:voice default` and `generate:pack-reference` are run.

Identifiers and clip names use US spelling, as the code and the website do. The spoken words keep the maintainer's "licence", since spelling does not reach the voice.

### 10. Settings and the settings window

`calloutEnabledClosingCarReadout` and `calloutEnabledClosingCarWarning` go into `GlobalSettingsSchema`, default true, with `.catch`. `CLOSING_CAR_CALLOUT_SETTING_KEYS` maps them over `ClosingCarCalloutId = "readout" | "warning"`, and a `getClosingCarCalloutEnabled` dep reads them live. On the Race Engineer card, `race-engineer-callouts.ejs` gains a "Closing Cars" item between the Gaps block and the Spotter, with the rows "Safety rating readout" and "Low safety rating warning".

There is no setting for the 2.0 s trigger or the 10 s release. Both are the maintainer's values.

### 11. Harness

`event-names.ts` gains an entry for `closingCar.entered`. Three shortcuts go under a "Closing Car" category, one per line in the issue: B 3.10 behind, C 2.30 ahead and A 1.60 behind. Each needs a race preset with the mock SDK connected and the car on track (`liveRaceCar`).

Two harness details follow from the design:

- The harness does not wire `getRoadNeighbors`. Its mock field would not list the shortcut's car as a road neighbour, so the speak-time check would silence the button for the wrong reason.
- Shortcut data is static, and a second press with the same `approachId` would be dropped as already announced. So the harness server stamps a fresh `approachId` on every publish of `closingCar.entered`, and every press is a new approach.

The shortcuts audition the wording; the diff tests prove the translator's decision.

## Alternatives rejected

- **Counting incidents in the session, as Crew Chief does.** The count is hidden in official races (the capture above). If a hosted capture shows it populated, a count clause is its own issue.
- **A composite danger score** (account age, history). It needs the iRacing web API, which is closed to new applications, and the rating is already in the roster.
- **A clause in #1117's briefing.** A briefing on a lap cadence over class standings and a proximity trigger in any class are different shapes. They share the parser and the clips instead.
- **A per-driver time window shared with #1117** (at most once every ten minutes, this spec's first draft). The maintainer replaced it with the distance rule. What should be announced once is an encounter, not a slot of time: a car that stays within 10 s for twenty minutes is one encounter, and a car that laps you twice in ten minutes is two. Sharing a "last mentioned" with #1117 went with it, because #1117 is a periodic briefing with its own cadence.
- **An early bound for fast closers** (announce at twelve seconds from contact, this spec's first draft). It was dropped with the 2.0 s ruling. Decision 2 states what that costs in fast multiclass closing.
- **Thresholds relative to the licence class.** The premise is that a higher class needs a better incident rate to hold the same rating, so an A 1.8 may drive cleaner than an R 2.6. That premise is unverified, and "below 2.0 is bad" is the rule drivers already use. The bands are flat.
- **iRating.** It measures pace, not how cleanly someone drives.
- **A family-wide cooldown between lines.** It would drop the car that matters behind one that did not. The approach rule and the single pending slot already limit how often the Race Engineer speaks.
- **Arm state held only in the translator**, marking a car announced at emission. The translator cannot know whether the line played, so a line lost to an opt-in, an incident moment or a displaced queue would silence the car for the rest of the encounter. That is the #1137 failure. Decision 3 splits the state instead.
- **`CarIdxEstTime`, the coarse #936 gap and `CarLeftRight`.** See decision 1.

## Out of scope

- Practice and qualifying sessions.
- Session incident counts, until a hosted capture shows them.
- Re-announcing a car that stays close, on any timer. Only a new approach announces a car again.
- Considering any car other than the nearest on each side.
- Naming the car's number or the driver's name. #1172's planned `getCarNumber` could add the number later; names depend on #941.
- A visual display of the ratings around you, such as a Session Info mode, which would be its own issue.
- Wording for Pro and Pro/WC licences, until a capture shows the string.
- The order of this line and #1119's faster-class warnings. Both can concern one car within seconds: #1119 says when, this callout says who. #1119 is not built yet, and its implementation is where that order is decided.
- A user-tunable trigger or release distance.
- Whether #944 skips a car this callout has already announced, which belongs in #944's own spec.

## Testing

- **Parser** (`iracing-sdk`):
  - every string in the three captures (`R 2.70`, `D 2.61`, `C 1.91`, `B 2.90`, `A 2.33`, `A 3.50`, `A 1.25` and the rest);
  - a numeric YAML scalar, a blank value and a missing field;
  - an unknown token (`P 3.45`, `WC 4.99`), which keeps the rating and drops the class;
  - `LicSubLevel` agreeing, disagreeing and missing, and a zero rating;
  - the roster skips by `CarIsPaceCar`, `IsSpectator` and `CarIsAI`, including a `PaceCarIdx` that disagrees with the roster's flagged entry;
  - `userId` present and absent.
- **Road-gap helper** (`gap-utils.ts`): the same lap, a lapped car ahead and behind, across start/finish, and a trace that does not cover the lookup.
- **Diff, trigger**:
  - neighbour selection skips pit-lane, stall and off-track cars and the pace car, and selects a car of another class and a lapped car;
  - an AI neighbour emits with `driver: null`;
  - the trigger at 2.00 s and not at 2.01 s, after the ten-tick count, and the glitch reset;
  - a pack: a second car within 2.0 s emits when it becomes the nearest on its side, and not before;
  - the re-offer every 5 s while the same car stays nearest and within 2.0 s, and at most one emission per 5 s from a gap hovering at 2.0 s;
  - ahead before behind on one tick;
  - a crawling leading car produces nothing;
  - every announcing gate: practice, pre-green, the first green lap after the start and after a restart, caution, post-race, replay-only, the player on pit road or off track, and an invalid player lap distance that must never reach the start/finish fallback.
- **Diff, approach**:
  - the id holds while the car stays within 10 s, however long;
  - a new id after the road gap passes 10 s by dropping back, by pulling away, by the car's pit stop, by the player's pit stop, and by being lapped;
  - a new id when the roster's `UserID` for the car changes;
  - the release is still measured under a caution and on the opening lap;
  - ids are not reused after a session change or a reconnect, and are preserved across a replay glance;
  - on a lap shorter than 20 s the id never changes.
- **Scenario**:
  - band routing at 199/200 and 249/250;
  - cutting the rating: 2.49, 1.99 and 2.95;
  - the licence clause dropped for an unknown letter;
  - the claim made only in `admit`, never in `where:`;
  - an announced approach not re-announced on the other side after a pass, and a new approach announced;
  - an approach left unannounced, and announced at the next offer, when the line was dropped by an opt-in, the caution, the racing-moment gate, a refused gate, an aborted expansion or a displaced queue;
  - a line cut by the spotter counts as announced; its whole replay after release; the replay's abort once the car is gone;
  - the live side after a pass;
  - both lines of one tick playing in order;
  - the two opt-ins.
- **Completeness**: `CATALOG_FLOOR` in `bundled-scripts.test.ts` goes up by two; `script-coverage.test.ts` covers the new groups; the two exhaustive literals in `simhub-service.test.ts` gain the keys.
- **Manual**, on hardware in an official race: being lapped by a faster class and lapping a slower one, a restart, a car staying close for many laps (announced once), the same car announced again after dropping back beyond 10 s, and a line cut by "Car left".

## Affected artifacts

- `@iracedeck/iracing-sdk`: `license-utils.ts`, and `roadGapSeconds` in `gap-utils.ts`.
- `@iracedeck/event-bus`: `closingCar.entered`, `DriverRating` and `LicenseClass`.
- `@iracedeck/sim-events-iracing`: `diff/closing-car.ts`, its per-side and per-car state, the `handleTick` call after `diffGaps`, `getRoadNeighbors()` and `getDriverRating()`.
- `@iracedeck/audio-scenarios`: `closing-car.ts` with its approach store, the racing-moment predicate in `overtake-gate.ts`, and the `index.ts` wiring and deps.
- `@iracedeck/audio-assets`: the three groups, the script entries and the fragment in `configs/default.voice.json`; the regenerated `callouts.json`, manifest and catalog entry; the pack version; `pnpm generate:pack-reference`.
- `@iracedeck/deck-core`: two schema fields. Also the settings-window partial, the `plugin.ts` of all three plugins (the opt-in closure and the two readers), and the harness (`event-names.ts`, three shortcuts, the fresh `approachId` per publish).
- Website: a "Closing cars" section on the Pit Crew page (`docs/actions/audio-voice/pit-crew.md`), two rows in its callout table, and the changelog.
- Rules: an entry in `race-engineer-callout-examples.md`, and this diff added to the track-order consumer list in `race-positions.md`.

## Settled with the maintainer (2026-09-21)

1. The source is `DriverInfo.Drivers[]`: `LicString`, cross-checked with `LicSubLevel` (the rating ×100). Session incident counts cannot be used in official races (capture `telemetry-snapshot-20260623-202105-132`); hosted sessions have not been captured.
2. iRating is not used.
3. Every rating is read out, with a tier tail added below 2.5. The thresholds are flat. The three lines and both tails are the maintainer's wording.
4. The trigger is the car directly ahead or behind on the road, in any class, lapped cars included, whose road gap to the player falls to 2.0 s. The pace car, spectators and AI cars are skipped. A Rookie 2.50 gets the plain readout.
5. There is no time limit. A car announced once is not announced again until its road gap to the player has gone past 10 s, whatever the cause. The rule is per car, and nothing is shared with #1117.
6. There are two opt-ins, both on by default under the Race Engineer master: the readout (2.5 and above) and the warning (below 2.5).
