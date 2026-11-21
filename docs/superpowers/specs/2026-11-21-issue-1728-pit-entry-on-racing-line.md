> **Issue:** [#1728](https://github.com/niklam/iracedeck/issues/1728) · **Related:** #476, #600, #622, #634, #650, #758, #1112, #1201, #1212 · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Pit entry is confirmed before it is announced

## The problem

Both pit-entry signals treat the first tick a car spends in `TrkLoc.AproachingPits` as a pit entry: `diffPitLane` emits `pitLane.approaching` for the player on that tick (road courses and every type but dirt oval, #634, behind the 10 s cooldown of #650), and `diffOpponentPit` emits `opponentPit.entered` on a car's arrival there from the racing surface (#622, arrivals only since #1212). At Oran Park the racing line out of the last corner runs through the zone, so every car on the racing line makes that edge every lap (as reported; see *To confirm with Niklas*). Nothing downstream can undo it: `pitLane.approaching` starts the entry readback (#476), plays the no-limiter entry reminder (#1201), cancels a pending exit readback and drops a waiting tire-wear report (#1108); `opponentPit.entered` speaks "the leader is pitting" and the nearby-car lines.

The issue holds the what and why. This spec decides the confirm rule for both, and what it costs.

## What the sim gives us, and what is measured

- **The zone edge is the same edge for a pitting car and a clipping car.** Both read `OnTrack → AproachingPits`. What separates them comes later: a pitting car goes on to pit road (and usually its stall); a clipping car goes back to `OnTrack` (or `OffTrack`) without either.
- **The player's `OnPitRoad` is trusted.** It flips at the pit-road line and reads `false` on the racing surface in the one session that tested it (the 2026-11-09 Spa online practice, `pit-lane-landmarks.ts` header). That is also the session where the player's own `CarIdxOnPitRoad` read `true` throughout, so the player never reads the per-car array.
- **`CarIdxOnPitRoad` is not trusted as a level.** It reads `true` for cars on the racing surface in several captures (`race-finish.ts`, `pit-lane-landmarks.ts`), which is why `opponent-pit.ts` never keys on it. Its false → true flip on a tick the car reads `AproachingPits` is what #1112 accepts as the `pitRoadStart` edge, and that combination has not been seen on the racing surface. No race session has been captured for either flag.
- **How long an approach is.** The learned track files on the maintainer's machine (`%LOCALAPPDATA%\iRaceDeck\Track Data\iracing\`, not committed; `pitRoadStart` from one to six samples each, so not all published) give the distance from `approachStart` to `pitRoadStart`: Ledenon 39 m, Tsukuba 44 m, Zolder 45 m, Winton 52 m, Spa 89 m, Silverstone 177 m, Bathurst 443 m, Misano 502 m. Most approaches are short; a few are long. There is no Oran Park file.
- **How long a clip is: not measured.** No capture of Oran Park exists. The decision below is made without it, and the capture that settles its one constant is named in *The capture that confirms it*.

## Decisions

### 1. One rule for both: an approach episode, announced only once confirmed

A car's **approach episode** opens on the tick it arrives in `AproachingPits` the way a pit entry does today — for the player, the existing open condition (not from pit road, not straight out of the garage, #1201; not while `approachExitingSuppressed`); for an opponent, from the racing surface against the last in-world surface (#1212). The episode stays open while the car reads `AproachingPits`, and is then:

- **confirmed** by the first of the clauses in decisions 2 and 3 — and only then is the event emitted;
- **closed unconfirmed** when the car reads `OnTrack` or `OffTrack` again (the clip), or when a tick-to-tick move is implausible as a drive (judged as the landmark learner judges an edge: `PIT_LANE_MAX_PLAUSIBLE_SPEED_MPS` over the `SessionTime` span) — a teleport ends it silently.

A closed-unconfirmed episode announces nothing and touches no cooldown, no aggregation window and no `approachAlertFired`. Everything that today follows the announcement keeps following it, now at the confirm tick: the #650 cooldown, the rearm-until-back-on-track, the opponent per-car 30 s cooldown, the 12 s aggregation window and the leader-first order, and the classification of the car against the canonical order, which is read on the confirm tick.

The rule is applied on every track. It is not switched on per track (see *Alternatives rejected*).

### 2. What confirms the player's episode

The first of:

1. **The pit-road line** — `OnPitRoad` false → true while the episode is open.
2. **The confirm distance** — the player has travelled `PIT_APPROACH_CONFIRM_M` (decision 4) along the lap since the episode opened, wrap-aware (`pitLaneSignedDeltaPct` × the cached track length), without the episode closing. With no track length, this clause is off and only the pit-road line confirms.

A stall arrival needs no clause: `OnPitRoad` flips first. The `pitLane.approaching` event keeps its name and payload; its JSDoc in the event catalog changes from "entered the approach zone" to "is confirmed to be entering the pits".

**Dirt ovals are unchanged.** They already fire on the `OnPitRoad` drive-in edge (#634) and never read the approach zone.

### 3. What confirms an opponent's episode

The first of:

1. **The learned pit-road line, when there is one** — the car's `CarIdxLapDistPct` crosses the published `pitRoadStart` (#1112's consumer view, handed to the diff as a value read from `getPitLaneLandmarks()`) while the episode is open. When a `pitRoadStart` is published, clause 2 is not read: the landmark is the same line without the flag.
2. **The accepted pit-road edge, when there is no landmark** — `CarIdxOnPitRoad` false → true on a tick the car reads `AproachingPits`, from `OnTrack` or `AproachingPits`: exactly the edge #1112 accepts as `pitRoadStart`. The predicate is one pure helper both diffs call, never restated. Never the flag's level.
3. **The confirm distance** — as for the player, from the car's own `CarIdxLapDistPct`.
4. **The stall** — the car reads `InPitStall` with the episode open. The backstop for a car whose flag never flips on a track with no landmark yet, at the cost of a late call.

A `NotInWorld` tick does not close an opponent's episode, for the reason #1212 gives for the surface baseline: a remote car blinks out on pit road. The plausibility check on the tick it returns catches one that came back somewhere else.

### 4. The confirm distance is 100 m

`PIT_APPROACH_CONFIRM_M = 100`, one constant in the shared episode module, the same for the player and opponents. It does two jobs, and the number is chosen against both:

- **It must outlast any clip.** A car on the racing line that strays into a pit entry's painted area is there for some tens of metres; a hundred metres along the lap inside the zone is a car in the pit-entry lane. The capture below checks it: the longest clip it shows must be at most half of D.
- **It must not cost the short approaches anything they still have.** On five of the eight measured tracks the pit-road line comes first (39–89 m), so D changes nothing there. On the long ones it gives most of the approach back: Silverstone confirms 77 m before the line, Bathurst about 340 m, Misano about 400 m.

If the capture shows a clip longer than 50 m, D becomes twice the longest clip measured, and the cost table below moves with it. A clip that reaches the pit-road line would make D unusable at that track and is the trigger for the per-track learning rejected below.

### 5. What it costs

The player's readback and the no-limiter entry reminder now start at the confirm tick instead of the zone edge:

| Approach (measured) | Confirmed at | Later than today by |
| --- | --- | --- |
| 39–89 m (Ledenon, Tsukuba, Zolder, Winton, Spa) | the pit-road line | the whole approach, roughly one to three seconds at the speeds a car brakes through a pit entry (an estimate, not measured) |
| 177 m (Silverstone) | 100 m in | 100 m, the same order |
| 443–502 m (Bathurst, Misano) | 100 m in | 100 m; 340–400 m of approach still ahead of the line |

The pit-road part of the run to the box is untouched, and that is where the readback has to fit before the pit-box count-in starts 120 m before the box (#600). Where the box is close enough to the line that the readback no longer fits, nothing new happens: #758 already made the count-in cut the readback and the readback resume from the cut once the count is done, landing as the car stops (its 30 s wait, #1681, covers it). That path exists today for the same short-pit-road stalls; the confirm makes it a little more common on short approaches and leaves the long approaches with lead to spare. The issue's requirement that the readback finish before the count-in therefore holds wherever the pit road leaves room for it, as it did before.

The no-limiter reminder, whose point is to land before the speed line, arrives at the line on the short-approach tracks. That is the real cost of this decision, accepted because the alternative is a false "Pit entry. Mind the limit." every lap at a clipped track; the session brief still carries the limit, and the no-limiter speeding line still guards the lane.

Opponent calls arrive at the pit-road line on most tracks — a second or three after today — which costs nothing a driver acts on. The stall backstop can be ten seconds or more late, and only for a car with a flag that never flips on a track whose pit road nobody has taught yet.

The side effects of a false `pitLane.approaching` go with it: a clip no longer cancels a pending exit readback or drops a waiting tire-wear report.

### 6. Where the code goes

- **One shared episode module**, `sim-events-iracing/src/diff/pit-approach-episode.ts`: the per-car episode state type and a pure step function that takes one car's tick (surface, previous surface, lap fraction, `SessionTime`, the pit-road edge, the landmark, the track length) and answers `open`, `confirmed` or `closed`, plus `PIT_APPROACH_CONFIRM_M` and the pit-road edge predicate decision 3 shares with `pit-lane-landmarks.ts`. The `pit-lap.ts` precedent: one rule, its readers each keeping their own state.
- **The player's signal moves out of `diffPitLane`** into a new `diff/pit-approach.ts` that emits `pitLane.approaching` and owns a new slice, `pitApproach`, taking the three approach fields from the flat pit-lane cluster (`approachExitingSuppressed`, `approachAlertFired`, `pitApproachCooldownUntil`) plus the episode. The slice rules forbid a module that imports `TranslatorState` from naming a slice type, so the slice and the flat cluster cannot share `diffPitLane`; the pit-lane facts it needs (`OnPitRoad`, the stall, the last surface, the track type) arrive as values. `PIT_LANE_EVENTS` loses `pitLane.approaching`, `PIT_APPROACH_EVENTS` gains it, and its `TICK_ORDER` row stays ahead of `diffPitReadback` and `diffTireWear`, which read it from `pending`. The pin in `state-slices.test.ts` shrinks by the three fields. The dirt-oval branch moves with it unchanged.
- **The opponent cluster becomes a slice**, `opponentPit`, since its diff changes in substance and the pin's reason for waiting (#1559's restructure) has passed; its entry in `LEGACY_FLAT_MEMBERS` goes. The replay wipe keeps what it keeps today (window, aggregate flag, cooldowns) and drops the per-car episodes with the surface baseline.
- **No new event, no new opt-in, no payload change.** The two events fire later and less often; every consumer stays as it is.
- **Docs in the same change:** the event-catalog JSDoc of both events, the headers of `pit-readback.ts`, `opponent-pit.ts` and `no-limiter.ts` (all three describe the zone edge as the trigger), the website's Pit Crew page (the opponent-pit trigger paragraph, which promises the call "earlier than waiting for it to be on pit road", and the no-limiter reminder's "a few seconds before the speed line"), a `race-engineer-callout-examples.md` entry, and a Bug Fixes changelog fragment.

## The capture that confirms it

One session at Oran Park recorded with `pnpm telemetry-watch` (lands in `local/`), a race or an online practice with other cars on track, in which the player drives several laps on the racing line through the last corner and then makes one real pit entry, ideally while other cars pit too. It answers three questions, each with a consequence already decided:

1. **The longest clip, in metres inside `AproachingPits`, for the player and for remote cars.** At most 50 m: D stands. Longer: D becomes twice it.
2. **Does any clipping car's `CarIdxLapDistPct` reach the learned `pitRoadStart` while it reads `AproachingPits`?** No: clause 3.1 stands. Yes: the landmark clause goes and opponents confirm on the accepted edge, the distance and the stall.
3. **Does any clipping car show a `CarIdxOnPitRoad` false → true on an `AproachingPits` tick?** No: clause 3.2 stands. Yes: that clause goes too.

The same session gives the real Oran Park approach length, and so the readback's cost there. Cut it into a fixture under `src/diff/__fixtures__/` (the tire-wear precedent) so the tests replay it.

## Alternatives rejected

- **Fire the player on the `OnPitRoad` edge everywhere, with no distance clause.** Safe, and the simplest rule, but it moves the readback 340–400 m later than it needs to be on the long approaches, the only tracks where today's early start buys anything. The distance clause gives that back for the cost of one constant.
- **A time dwell instead of a distance.** Time inside the zone depends on speed in the wrong direction: a car braking for the pit lane spends longer per metre than a car accelerating out of a corner, so a threshold that passes the first can pass a slow clip too, and a track's pit-entry speed changes what the number means.
- **Switch the rule on only at tracks where the zone overlaps the racing line**, from a hand-kept list. No source for the list, hundreds of configurations, stale on every track update — #1112 rejected hard-coded pit geometry for the same reasons.
- **Learn the overlap: record each clip's span, in the session or in the track store, and keep today's immediate call where none has been seen.** It can only learn from a clip, so the first car on the racing line at a clipped track is announced falsely before anything is known, which the issue's expected behaviour rules out. Learning from other cars' clips means a second writer into the player's state, and persisting it means a new record in a frozen format with a section version bump. It stays the route if the capture shows clips that reach the pit-road line, which D cannot handle.
- **Tell the entry apart by the learned `approachStart`.** A clip and a real entry cross the same boundary, and the clips teach `approachStart` themselves (see *Out of scope*).
- **Confirm opponents on `CarIdxOnPitRoad` being true.** It reads true on the racing surface.
- **Confirm opponents only at the stall.** Always true, but the call would come once the car has stopped; it is kept as the last resort only.
- **Speed or braking as the tell.** A car slowing for the pit lane and a car lifting through traffic look alike, and nothing measures the difference yet.

## Out of scope

- **`approachStart` learning at a clipped track.** Every clip is an `OnTrack → AproachingPits` edge on the way in, so at Oran Park the racing line will fill that landmark's window. Whether that is wrong depends on whether a clip and a real entry cross the zone at the same lap fraction, which the capture shows. Learning only from confirmed episodes would be a change to #1112's acceptance; if the capture shows it is needed it is proposed as its own issue.
- **Persisting anything about clips**, per track or shared.
- **Dirt ovals** (decision 2) and the opponent callout there, which stays silent as #622 decided.
- **The readback's own wording or length**, the count-in's thresholds, and #758's scheduling.
- **`pitLane.entered` / `pitLane.exited`**, the stall events and the pit-box count-in, which read `OnPitRoad` and the stall and never the approach zone.
- **Renaming either event.**

## Testing

Unit, in `sim-events-iracing`:

- **The episode module**: opens only on the existing open conditions; confirms on each clause; closes on `OnTrack`, on `OffTrack` and on an implausible jump; the distance is wrap-aware across start/finish; no track length turns the distance off; a `NotInWorld` tick holds an opponent episode and the plausibility check on its return.
- **`diffPitApproach` (player)**: a clip (`OnTrack → AproachingPits` for less than D → `OnTrack`) emits nothing and leaves the cooldown untouched, lap after lap; a short real entry emits on the `OnPitRoad` tick; a long one emits at D before the line; the first-tick seed in the zone, the garage start (#1201), the exit through the zone and the #650 cooldown behave as today; the dirt-oval branch is byte-for-byte today's tests.
- **`diffOpponentPit`**: a clip is silent; a real entry announces on the landmark when one is published and ignores a flag flip then; with no landmark it announces on the accepted edge and not on a flag that reads true throughout; a stuck flag with no landmark announces at the stall; a stall exit stays silent (#1212); the cooldown and the aggregation window start at the confirm tick; classification reads the order on the confirm tick.
- **Downstream**: a clip no longer cancels a pending exit readback or drops a waiting tire-wear report (`pit-readback`, `tire-wear` tests through `pending`); `tick-order.test.ts` with the moved row; `state-slices.test.ts` with both pins shrunk.
- **The Oran Park fixture**, once captured: replayed through both diffs, silent on every clip and announcing the real entries.

Scenario harness: two `telemetrySequence` shortcuts (the #1127 shape, mock SDK connected): one that drives the player through the approach zone and back onto the track (silent, the point of the button), and one that drives through it onto pit road (the readback plays). An opponent version patches a leader's `CarIdxTrackSurface` both ways. Each ends by restoring the surface.

Manual (Niklas): at Oran Park, laps on the racing line with no pit call, then a stop with the readback and the opponent calls when others pit; and one long-approach track (Bathurst or Misano) to hear the readback still start well before the line.

## To confirm with Niklas

Taken from the issue, old comments or uncommitted local files rather than from code or committed captures:

- That Oran Park's racing line puts cars in `AproachingPits` and returns them to `OnTrack` (or `OffTrack`) without `OnPitRoad` — the Discord report describes the calls heard, not the telemetry — and that remote cars' `CarIdxTrackSurface` shows the same clip as the player's `PlayerTrackSurface`.
- That the player's `OnPitRoad` is false on the racing surface in a race; measured only in one online practice at Spa.
- That `CarIdxOnPitRoad`'s false → true on an `AproachingPits` tick marks the pit-road line for remote cars in a race; the captures that show the flag misbehaving are practice and one caution, and none is a race.
- The approach lengths in decision 5, read from the learned track files on his machine, several from a single unpublished `pitRoadStart` sample; and the one-to-three-second figure, which is an estimate of approach speeds.
- That a car on a racing line cannot plausibly stay 100 m inside a pit-entry zone at any track he knows of; Oran Park is the only report.
