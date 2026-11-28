# The player's fastest sectors: this session and all time, dry and wet

> **Issue:** [#1810](https://github.com/iracedeck/iracedeck/issues/1810) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Measured at `4a0683682`.

## The problem

The issue's Goal settles the product: after each sector the engineer says when the player has just beaten a best, which best (this session, all time dry, all time wet) and by how much; all-time bests are kept per driver, car, track configuration and conditions, shared across deck hosts; wet is `TrackWetness` 4–7; one setting per session kind, Practice and Test on, Qualifying and Race off (Niklas, 2026-11-28).

What exists: the sector starts (`extractSectorStarts`, `packages/iracing-sdk/src/sector-utils.ts`, #1573) and a sector timer (`packages/sim-events-iracing/src/diff/sector-times.ts`, #1572) that measures every car's sector times by interpolating each crossing between two ticks. The timer is fed by `stepCarProgress` (`diff/car-progress.ts`), whose gate opens only when `sessionType === "Race"` (`translator.ts:3654`), past the green, with a canonical order. So outside a race nothing measures a sector, and nothing keeps a time past the session. This spec settles how the player's sectors are measured in every session kind, what counts, where the sim-neutral model lives, what is stored and where, the event, the calls and their order.

The design was reviewed by the `architect` agent before commit; its nine findings are folded in (the model's home, the scope classifier, the timer's output, the order at the line, the layout merge and the identity homes).

## Decisions

### 1. One sector timer for every session kind: the progress step gains a scope

`stepCarProgress`'s `isRaceSession` argument becomes `scope: "field" | "player" | null`, and the tick and the slice carry it:

- `"field"` when `sessionType === "Race"`, exactly today's classifier and today's behaviour: every car, the canonical order, past the green.
- `"player"` in every other live session that has a `SessionClass` (practice, qualifying, test, and the race-class sessions that are not `"Race"`: heats and warmups). Only the player's entry is read and appended, through the same `readCarProgress`, line correction and `appendProgressSample`; every other index reads `null`. The gate is the field gate without the canonical order.
- `null` with no `SessionClass` or in a replay: refused as today.

The step stays the one place that states when progress is read (`car-progress.ts:4-10`), so the consumers refuse other scopes themselves rather than the translator deciding for them: `diffGaps` and `liveGapBetween` (`translator.ts:2089-2102`) answer nothing unless the tick or slice is `"field"`, so `getLiveGapBetween` stays the race gap it is documented as. The docs of the step, `getLiveGapBetween` and `getCarSectorTimes` are updated to say which scope they read, and `sim-events-iracing/CLAUDE.md` records that in `"player"` scope the step is still among the canonical order's skipped consumers (a tick whose order threw skips it).

`diffSectorTimes` runs on both scopes. One timer, one continuity rule (`previousSessionTime`, `SECTOR_MAX_TICK_SPAN_S`, `traceReset`) and one interpolation then measure the player's sectors everywhere, which is what #1572 rejected a second timer for.

Whether the player is the one driving is not a gate condition: it is decided per tick by the bests step (decision 3), in every scope, so a team-mate's stint in a race is timed for the comparison as today and never filed as the user's record.

### 2. A sector is clean on its own, and the timer hands its closed sectors on

The timer records a lap's `clean` flag (#1572 decision 4). A best needs the same verdict per sector, because a lap with an off in sector three still has a good sector one. `SectorLap` and the lap in progress gain `sectorClean: boolean[]` beside `sectorTimes`, set as the lap's flag is: `stepCar` marks the lap in progress with the tick's flag before handling the crossings, and a sector opened on a tick starts at that tick's verdict (`sector-times.ts:208, 243`), so both crossing ticks count. A sector is clean when every tick of it read the car `OnTrack`, no full-course caution was out, and its time is positive. The opening-lap rule (`lap.lap > 1`) is race semantics: in `"field"` scope the opening lap's sector one is unclean and its later sectors are judged by their own ticks; in `"player"` scope it does not apply. A lap's `clean` stays exactly today's (every sector clean, and not the opening lap), so the sector comparison decides nothing differently.

Today the timer records a lap only when the whole lap closes (`recordLap`, `sector-times.ts:239-241`) and returns `void`. It now returns the player's sectors closed this tick, `{ lap, sector, time, clean }[]` (`null` when it threw), captured in `handleOrderSteps` as `classNeighbors` is (`translator.ts:4419-4450`) and handed on as a value. No diff reads another family's slice (`sim-events-iracing/CLAUDE.md`, *What a diff receives*).

### 3. The model is sim-neutral, in its own package; the translator keeps iRacing's half

The #1112 split, exactly: iRacing's reads stay in the translator, and everything a second sim would reuse is a pure, sim-neutral model.

**`@iracedeck/personal-bests`**, a new package in `SIM_NEUTRAL_PACKAGES`, depending only on `@iracedeck/event-bus` (types) and `@iracedeck/track-data` (the shared back-off below). It holds:

- the record types, the loader type `PersonalBestsLoader` and the sentinel `PERSONAL_BESTS_UNAVAILABLE`;
- `roundBestTime` (once, to the thousandth) and `beats` (at least 0.001 s lower), so "improved by point zero zero zero" cannot be said;
- `classifyConditions` over the bus's own `TrackWetness`: `"wet"` when every reading was 4–7 (`LightlyWet` to `ExtremelyWet`), `"dry"` when every reading was 1–3 (`Dry` to `VeryLightlyWet`, dry by Niklas's threshold), `"mixed"` otherwise, `Unknown` included;
- the tracker: per sector, the session best in any conditions ("fastest this session" is what the line says, so a dry best stands after the rain), and the all-time best per `dry` / `wet`, seeded from the loader; a sector layout change clears the session bests; no all-time verdict until the loader has answered (records or none), so an unread file never makes every sector a "first time";
- the load back-off, as one helper extracted from `track-data`'s `pit-lane-learner.ts` into `track-data`, which the learner and this tracker both import, not a copy.

**`diff/sector-bests.ts`** in `sim-events-iracing` holds iRacing's half, in its own slice: for the sector in progress, the player's incident count when it opened (`PlayerCarMyIncidentCount`), the wetness readings, and whether the player was in the car (`liveOnTrack`) on every tick. When the timer hands it a closed sector (decision 2), the sector is a **candidate** when the timer marked it clean, the incident count has not risen and the player drove all of it. The incident rule is the player's alone: the timer's rule is one for every car because #1572 compares cars, while a best compares the player only with the player. The candidate goes to the model's tracker, which answers whether it beat a session or all-time best.

### 4. The event: `sectorBest.set`, facts only

A new catalog entry in `packages/event-bus/src/event-catalog.ts`, published from live telemetry only:

```typescript
/** Payload of `sectorBest.set` (issue #1810). */
export type SectorBestSet = {
  /** The sector, 1-based ("sector two" is 2). */
  sector: number;
  sectorCount: number;
  /** The player's lap the sector belongs to, as `lap.completed` numbers it. */
  lap: number;
  /** The sector time, seconds, rounded to the thousandth. */
  time: number;
  conditions: "dry" | "wet" | "mixed";
  /** Set when this is a new session best; `previous` null = the session's first time for the sector. */
  session: { previous: number | null } | null;
  /**
   * Set when this is a new all-time best in `conditions` (never for "mixed"), and only once the loader
   * has answered for the combination; `previous` null = the combination's first time for the sector.
   */
  allTime: { previous: number | null } | null;
  /** What the store keys the record by. */
  combo: PersonalBestCombo;
  /** The sector layout the time was measured on: `extractSectorStarts`' output. */
  sectorStarts: readonly number[];
};
```

Published when `session` or `allTime` is set. One event feeds both the call and the store: sectors have no precedence to join, unlike laps (#1811).

**Identity.** `PersonalBestCombo` is `{ sim, driverId, carId, carName, track: TrackIdentity }`. `PitLaneTrackIdentity` is renamed `TrackIdentity` in the catalog, with `PitLaneTrackIdentity` kept as an alias, since a track's identity is no longer the pit lane's alone. The combination is resolved in `sim-events-iracing` beside `resolvePitLaneTrackIdentity`: `driverId` from the player's `DriverInfo.Drivers[].UserID` through one reader shared with the replay recorder (`diff/replay-laps.ts:97-105`, `replay-incidents.ts:120` read it today), `carId` from its `CarID` (not read today) and `carName` from `CarScreenName`, as strings.

**The last sector waits for its lap.** The timer closes a lap's last sector at the interpolated crossing, but `lap.completed` fires when `LapLastLapTime` changes, a tick or more later (0.4–0.9 s for a refused lap), and then waits for the standings up to `LAP_RESULTS_SYNC_MAX_WAIT_MS` = 3000 ms (`laps.ts:156`). So the step holds the player's last-sector `sectorBest.set` until that lap's `lap.completed` is out and publishes it in the same flush right after it and after that lap's `fastestLap.set`, or on the lap diff's own expiry if the lap is never published; its `TICK_ORDER` row is after `diffLaps` and `diffFastestLap`. Every other sector is published on the tick it closes.

### 5. The store: files only, on #1741's primitives

`@iracedeck/personal-best-store`, sim-neutral, depending on `personal-bests` (types), `settings`, `logger` and #1741's shared persisted-file primitives. Right to be its own package rather than a section of track-store's file: a driver's times are personal and keyed by driver and car, while the pit-lane section is a track fact meant for a later upload. One folder serves every deck host, for track-store's reason (`track-store/CLAUDE.md`, *One folder for every deck host*): a best is a fact about a driver, a car and a track.

- **Where.** `%LOCALAPPDATA%\iRaceDeck\Personal Bests\<sim>\driver_<driverId>\track_<trackId>_car_<carId>.json`, `IRACEDECK_PERSONAL_BESTS_DIR` replacing the root. One file per combination, so a driver who wants a record gone deletes one visible file. The sim folder rule is `isTrackDataSim`, moved from `track-store/src/track-file.ts:101` to `track-data` and imported by both stores.
- **Envelope.** `version`, `sim`, `driverId`, `carId`, `carName`, the track identity's fields, the sections; every unknown key carried through every write. A file whose ids disagree is another combination's: no data, never written. A renamed car or track configuration under the same ids is the same combination: names rewritten, records kept.
- **The sectors section.** `{ starts: number[], dry: (Rec | null)[], wet: (Rec | null)[] }`, `Rec = { time, recordedAt }`; `previousSectors` holds the last layout before a change, one level. When the session's `sectorStarts` differ from `starts` (a start more than `1e-6` apart, or another count), `load` answers no sector records, and a write of the new layout moves `sectors` to `previousSectors`. **A pending record merges only into the section whose `starts` it matches** (`sectors` or `previousSectors`) and is otherwise dropped, and no write demotes the current layout except one carrying a layout neither section holds. So a stale debounced flush of the old layout cannot move the new one aside: within a layout the minimum (the earlier `recordedAt` on a tie) is idempotent and commutative, and across layouts no write reorders them.
- **The file discipline** is #1741's: atomic temp and rename, the corrupt aside, the identical-aside check, the stale-temp sweep, `WRITE_RETRY_DELAYS_MS`. This package writes none of it. #1741 (3.11.0) must merge first; the board carries that order.
- **API.** `load(combo)`: synchronous, never throws, read once per combination, answers the records, `null`, or `PERSONAL_BESTS_UNAVAILABLE` for a file that exists but cannot be read. `recordSector(event)`: folds a `sectorBest.set` with `allTime` set into memory, debounced write (track-store's 2 s, capped at 10 s). `flushSync()` on exit.

### 6. Wiring: seeded at session start, recorded from the bus

The #1112 shape: `plugin-runtime` gains a `personal-best-store` phase that initializes the store and subscribes `recordSector` to `sectorBest.set` events with `allTime` set; the translator takes a `loadPersonalBests: PersonalBestsLoader` option (`phases/sim.ts`, beside `loadPitLaneLandmarks`), typed from `personal-bests`, never from the store, and calls it when the combination is first known in a session, then on the shared back-off while it answers `PERSONAL_BESTS_UNAVAILABLE`. The translator does no file IO and gains no edge to a file package. Consumers read the translator, never the store.

### 7. The calls: one line per sector, the strongest that holds

One contract family, `catalog/pit-crew/sector-best.ts`, on `sectorBest.set`, picks at most one line:

1. `allTime` with a `previous`, `conditions` `"wet"`: the all-time wet line;
2. `allTime` with a `previous`, `conditions` `"dry"`: the all-time line;
3. otherwise `session` with a `previous`: the session line;
4. otherwise nothing: a first time is recorded silently.

Each line carries the improvement, `previous − time`. **Gates:** the session-kind setting for the event's `SessionClass` (decision 8), read live; no full-course caution; the race not finished. `maxQueueWaitMs: 6000`: a sector call not started within six seconds describes a part of the track the driver has left.

**Order: publication order decides an idle bus, `queueBehind` a busy one** (the #1211 pair). Mid-lap, #1573's "Sector three." is published at the lead point, before the line, and this event at the line, so the sector start is said first and this line follows; the corner names queue as they do today (#1676). At the start/finish line this event is published after the lap's `lap.completed` and `fastestLap.set` (decision 4), so the lap-time calls (#555, #1163, #1571) take the bus first and this line queues behind them with no trigger delay, ahead of #1572's comparison, which waits its 500 ms.

### 8. Settings: one per session kind, Practice and Test on

A new family, `families/sector-best-sessions.ts`, in the shape of `fuel-countdown-sessions` (#1702), with its `SessionClass` mapping (Race covers heats and warmups): `calloutEnabledSectorBestPractice` (on), `calloutEnabledSectorBestTest` (on), `calloutEnabledSectorBestQualifying` (off), `calloutEnabledSectorBestRace` (off). These keys are a persisted contract; their defaults are Niklas's product decision, an exception to new Race Engineer functionality defaulting on. The settings decide speaking only: records are kept in every session kind with a `SessionClass`.

### 9. The wording, both voices: draft, for Niklas's approval before any clip is generated

The sector number sits inside the sentence, so each line is one take per sector number, one to ten (`sector-number`'s bound, #1573 decision 7), not a splice of #1573's phrase-final "Sector two." The improvement is read in the compact lap-time form to the thousandth (`lap-time-readout.ts`): "point one four two" from `lap-time-thousandths`, and from a second up the whole seconds from `lap-time-second` before it. An improvement of a minute or more drops the delta sentence, never the line.

Default voice (Niklas's wording):

- "That was your fastest sector two in this session." + "Improved by point one four two."
- "That was your all-time fastest sector two here." + "It was point one four two faster than your previous best."
- "That was your all-time fastest wet sector two here." + the same.

Short Calls voice:

- "Best sector two." + "Up point one four two."
- "All-time best, sector two." + "Up point one four two."
- "All-time wet best, sector two." + "Up point one four two."

The lead-ins ("Improved by", "It was", "faster than your previous best.", "Up") are generated with #1688's conditioning (previous request ids, the following text), so the splice reads as one sentence.

### 10. Artifacts beyond the code

- `sim-events-iracing`: the step's scope on the tick and slice, the scope refusals in `diffGaps` and `liveGapBetween`, `sectorClean` and the timer's returned closes, `diff/sector-bests.ts` and its slice, its `TICK_ORDER` row, the combination resolver and the shared `UserID` reader, the `loadPersonalBests` option; `CLAUDE.md`.
- `event-bus`: `sectorBest.set`, `SectorBestSet`, `PersonalBestCombo`, `TrackIdentity` (alias kept).
- `track-data`: `isTrackDataSim` and the back-off helper moved in; `track-store` and the pit-lane learner import them.
- The two new packages with their `CLAUDE.md` files; `plugin-runtime`'s phase and seeding.
- `audio-scenarios`, `callout-settings`, both voice packs (clips, scripts, catalog, a `version` bump each), the scenario harness (event name; a Sectors shortcut per line, a first time that is silent, and a Race-session press, silent at default settings).
- Website: the Race Engineer page's sector paragraph (what is said, the four settings, where records are kept and that deleting the file forgets them), the pack reference, a `Features` changelog fragment.
- The Architecture page (two new packages, the model/store split and the flow: translator → bus → store, store → translator at session start), the root `CLAUDE.md` package list, `race-engineer-callout-examples.md`.

## Approaches weighed and rejected

- **The bests model inside the translator.** Records, rounding, the conditions classifier and the load back-off are not iRacing; a second sim would rewrite them. #1112 kept only iRacing's half in the translator, and this follows it.
- **A player-only sector timer of its own.** Two definitions of a sector time: the drift #1572 rejected a tick timer for.
- **Widening the field gate to every session kind.** The gaps and every trace consumer would run in practice, where the canonical order means something else (`race-positions.md`).
- **Gating the player scope on being in the car.** It would leave the field scope timing a team-mate's stint as the user's; the rule belongs where the record is decided, in every scope.
- **A trigger delay to order the last sector after the lap.** `lap.completed` can trail the crossing by up to three seconds, so no fixed delay holds; publication order does.
- **Keeping the records in track-store's file.** Personal data in an uploadable track file, and a landmark rebuild as a risk to the times.
- **Splitting session bests by conditions.** "Fastest this session" would be false after a dry best set earlier in the session.
- **iRacing's lap validity for a sector.** A lap verdict, settled after the sector call; and #1582 showed the `LapDelta*_OK` flags cannot be trusted.
- **Speaking a first-time record.** Every sector of a first visit's first flying lap would be called with nothing beaten.

## Out of scope

- The all-time best lap: #1811, on this store and model.
- Viewing or resetting records from a key or the settings window; deleting the file is the reset for now.
- Tyre compounds, setups, fuel load and iRacing track updates: a record survives them, keyed only by driver, car, track configuration and conditions.
- Other cars' bests, and the sector comparison's race-only scope (#1572).
- A second sim's translator half: the model, store and event are sim-neutral; `trackId: number` stays iRacing-shaped until #714.

## Testing

- `car-progress.test.ts`: `"player"` scope reads only the player, through the same validation and line correction (one fixture through both scopes gives the player identical progress and resets); opens without a canonical order; a heat race or warmup is `"player"`; `"field"` is exactly `sessionType === "Race"` and its existing tests pass unchanged.
- `gaps.test.ts` and `liveGapBetween`'s tests: nothing answered in `"player"` scope, with the player's trace present (the positive control that the refusal, not an empty slice, decides it).
- `sector-times.test.ts`: `sectorClean` per sector, each unclean cause in one sector leaving the others clean, with clean twins; the opening-lap rule in `"field"` only; a lap's `clean` unchanged on the existing fixtures; the returned closes on each tick, `null` on a throw.
- `sector-bests.test.ts`: a candidate refused on an incident, an unclean sector and a tick out of the car (a team-mate's stint in a race), each with its twin; the held last sector published after `lap.completed` and `fastestLap.set` of its lap, and on the lap diff's expiry; nothing on a replay.
- `personal-bests` tests: `classifyConditions` at the 3/4 boundary both ways and with `Unknown`; the 0.001 s rule; session best in any conditions, all-time per conditions; no all-time verdict before the loader answers; first times with `previous: null`; a layout change clearing the session bests; the back-off helper, and the pit-lane learner's tests passing unchanged on it.
- The store's tests on #1741's harness: the path, foreign and renamed files, the minimum merge between two processes in both orders, a layout change, a stale old-layout flush after it (merged into `previousSectors`, never demoting `sectors`), corrupt and unreadable files, the flush.
- `sector-best.test.ts` (catalog): the line for every combination of `session`, `allTime`, `previous` and `conditions`; each session-kind setting silencing only its kind; the delta at 0.142, 1.5 and 61 s; at the line, on an idle bus, the lap-time line then this one, with the twin where this event is published first; a call older than 6 s dropped.
- `callout-settings` registry rows for the four keys and their defaults.
- **Manual check in iRacing:** offline practice at a known track: no call on the out-lap; from the second flying lap a session line after each improved sector, after "Sector three." where both are due, and after the lap line at the start/finish; the store file appears; a new session with the same car and track gives the all-time line when a record falls; qualifying is silent at default settings and speaks with its setting on; a wet session gives the wet line and writes the wet slots only.
