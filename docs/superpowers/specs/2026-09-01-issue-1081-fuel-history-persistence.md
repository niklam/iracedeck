# Persist validated fuel laps per car and track, and seed the buffer from them

> **Issue:** [#1081](https://github.com/niklam/iracedeck/issues/1081) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

**Amended 2026-11-22, before implementation:** the first version (2026-09-01) put the history in its own `Fuel\<carPath>_<trackName>.json` files, written by a new module in `deck-core`. Since then #1112 shipped `@iracedeck/track-store`, the per-track file every deck host shares, and built its envelope to hold more than one section. This version stores fuel as a second section of that file. It drops the filename transform and the collision rules the old layout needed, and records the TrackID measurement the old version asked for. The rejected layout is under *Alternatives considered*.

## Problem

Fuel consumption starts from nothing every session. The validated lap history built in #465 lives in memory on the translator and is wiped on a session change, so a driver who practised for an hour arrives at the race with zero samples and the consumption displays showing `--` until several green laps have run — exactly when the strategic question is being asked.

## What already exists, so the spec is not read as more work than it is

`sim-events-iracing/src/diff/fuel-laps.ts` (#465) is a working, tested engine, and three things Niklas asked for are already in it:

- **A 20-lap rolling buffer** — `FUEL_LAP_HISTORY_CAP = 20`. The requested window is the cap that already exists.
- **Validity gating** — `isValidForCalc: fuelUsed > 0 && !isOutLap && !isInLap && !wasTowed && !wasCaution`. Out-laps, in-laps, tows **and full-course caution laps** are already excluded.
- **A deferred session wipe** — a session change arms `pendingSessionWipe`, executed on the first live-in-car tick past pre-green, so a garage visit keeps the data.

And #1112 built the rest of the path this feature needs:

- **`@iracedeck/track-store`** — one file per track at `%LOCALAPPDATA%\iRaceDeck\Track Data\<sim>\track_<TrackID>.json`, shared by every deck host, written debounced and atomically, re-read and merged on every write so two plugin processes can share it, with corrupt, renamed-track, foreign-track and newer-build files handled. Its envelope (`version`, `sim`, `trackId`, `trackName`, `trackConfigName`, `trackLength`, `trackVersion`) carries every unknown key through a write, and `ParsedTrackFile` already allows a file "another feature wrote first" to have no `pitLane` section.
- **The seeding seam** — the translator does no file IO; `initSim` passes it `loadPitLaneLandmarks: (track) => trackData.store.load(track)`, and the translator seeds its learner at the first live tick of a track and again after a session change or a disconnect. Learned samples go out as `pitLane.landmarkLearned`, which the plugin's track-store phase hands to `recordSample`.
- **A Diagnostics row that opens the `Track Data` folder** (`open-track-data-folder`), which answers "easy to find" for anything stored there.

What is absent: any fuel persistence. The player's `CarPath` is read today only by Fuel Service's fuel step (`readPlayerCarPath`, #1314/#1483), and nothing reads `CarID`.

## Decision

### Storage: a `fuel` section in the track file

The fuel history is a second section of the track file, beside `pitLane`:

```json
{
  "version": 1,
  "sim": "iracing",
  "trackId": 324,
  "trackName": "tsukuba 2kfull",
  "trackConfigName": "",
  "trackLength": "2.03 km",
  "trackVersion": "…",
  "pitLane": { "…": "…" },
  "fuel": {
    "version": 1,
    "cars": {
      "67": {
        "carPath": "mx5 mx52016",
        "laps": [
          { "subSessionId": 0, "sessionNum": 0, "lap": 7, "endedAt": "2026-11-22T18:04:11.512Z", "sessionKind": "practice", "fuelUsed": 1.183, "lapTime": 62.41 }
        ]
      }
    }
  }
}
```

- **Keyed by track, then by `CarID`.** The track is already the file's identity; the car is the key inside the section. `carPath` is stored raw beside each car for a human reading the file and for re-keying, as the envelope stores the track's raw names.
- **Only valid laps are stored**, at most `FUEL_LAP_HISTORY_CAP` (20) per car, the newest by `endedAt`. Invalid laps carry the live tracker's lap sequence and mean nothing once the session is over.
- **Liters and seconds**, as the tracker computes them.
- **The section versions itself** (`FUEL_SECTION_VERSION`), as `pitLane` does, and the envelope's `version` does not move.

Why this is the right home, not merely the nearest one:

- **Same identity, same lifetime.** A fuel history is per car per track; the file is per track and already settles what a track is — per sim, per layout, with renamed and foreign files handled.
- **Same sharing problem, already solved.** The history must survive switching decks (R5), so two plugin processes can write it — exactly the case track-store's merge-on-write exists for.
- **Same seeding moments.** The translator seeds pit-lane landmarks at the first live tick of a track and after a session change or a disconnect; fuel seeds at the same moments, plus a car change.
- **Already findable.** The Diagnostics row opens the folder; the file is named by `TrackID` with the track's names inside.

### Track identity: `TrackID` is per layout — measured

The first version could not lean on `TrackID` and carried `TrackName` beside it, because nothing showed one id per layout. #1112 now keys on it, and the 102 snapshots in `local/telemetry-snapshot-*.json` (23 distinct tracks) settle it: no two `TrackName`s share an id, and one venue's layouts have distinct ids — Tsukuba `2kfull` 324, `2kshort` 326, `1kouter` 328; Lakeland oval 16, `lakeland dirt` 275. The store's renamed-track handling covers a name changing under one id.

### Merging fuel laps across processes

Track-store's merge is safe because folding is idempotent: re-folding a sample already on disk changes nothing. The fuel section keeps that property:

- **A lap is the same lap when its `subSessionId`, `sessionNum` and `lap` match and the two `endedAt` are under `FUEL_LAP_DUPLICATE_WINDOW_MS` (60 s) apart.** Two deck hosts running at once read the same sim and record the same lap; the sim-reported numbers are identical in both, while the wall-clock end differs by a tick. The window is what tells a repeat from an offline session's lap 7 a week later, where `subSessionId` is `0` both times. Same shape as `PIT_LANE_DUPLICATE_WINDOW_MS`.
- **Merging is a union, deduplicated by that rule, cut to the newest 20 per car.** Commutative and idempotent, so the store's write path and its settle check work unchanged.
- **The fold lives beside the model, not in the store**, as `pitLane`'s does in `track-data`: a sim-neutral `fuel` model module owns the section's shape, normaliser, newer-version check and merge. The store calls it and never reimplements it.

### Exclusions

Recorded laps are valid laps from **every session kind except qualifying**. On top of #465's gates:

- **Qualifying laps are never recorded** (R4). The car runs light and the figure is unrepresentative. Practice, test, warmup and race count.
- **Parade laps are never recorded**, by a positive term (R1).
- Caution laps remain excluded by `wasCaution`.

**Each lap stores its session kind anyway.** One field, and it is what makes a later "prefer race laps when both are present" change possible without discarding the history.

### Seeding

**At the first live tick of a car and track, and again after a session change, a car change or a disconnect, the translator loads that car's stored laps and puts them into the buffer.** Live laps then displace the oldest through `FUEL_LAP_HISTORY_CAP`, so the tracker needs pre-filling, not new displacement logic.

The deferred session wipe stays and runs **before** the seed. Since every valid non-qualifying lap was already handed to the store, wipe-then-seed keeps practice laps into the race and drops what should go (qualifying, invalid laps, partial segments).

**What the translator reads it through:** a `loadFuelLaps` option beside `loadPitLaneLandmarks`, wired in `initSim` to the store, and a `fuel.lapRecorded` bus event carrying the identity (sim, track, `CarID`, `CarPath`) and the lap, which the plugin's track-store phase hands to the store — the pit-lane path, mirrored. The bus event is a catalog addition and so a published contract; it needs an `event-names.ts` entry in the scenario harness.

## Named requirements

- **R1 — Parade laps are excluded by a positive term, not by side effect.** `isValidForCalc` gains a `!wasPreGreen` term, tracked as `wasCaution` is, using the shared `isPreGreen()` helper (a positive session-state test covering `ParadeLaps`, `Warmup`, `GetInCar`, `Invalid`). Today parade laps go unrecorded only because the deferred wipe returns early pre-green: an accident of the wipe logic that fails silently if the wipe is ever restructured, and already misses a parade lap in a session with no wipe pending.
- **R2 — A lap recorded by two deck hosts is stored once**, by the duplicate rule above.
- **R3 — One section never blocks the other.** A `fuel` section from a newer build is carried through untouched while `pitLane` keeps learning, and the reverse. A malformed `fuel` section makes the file corrupt (moved aside) exactly as a malformed `pitLane` does today. Generalising track-store's per-file `newerSection` outcome to per section is part of this work.
- **R4 — Qualifying laps are never persisted or counted.**
- **R5 — The store is shared across ecosystems.** Switching decks must not lose history. The track file already is.
- **R6 — The fuel section never leaves the machine.** It is personal driving data. The track file's `pitLane` section is planned as a later upload's payload, which must stay a projection of `pitLane` alone.

## Alternatives considered

**Separate files, `Fuel\<carPath>_<trackName>.json` (this spec's first version).** Readable filenames, one file per pair, deleting a file as the remedy for a bad average. Rejected now that track-store exists: it would have been a second copy of the shared-file write path (~1000 lines in `track-store.ts`: atomic replace, merge, settle check, corrupt and renamed asides, stale temp files), and it needed a frozen filename transform plus collision detection, because `<carPath>_<trackName>` is not injective. #750's reset is the remedy for a bad average now, not a file delete.

**A `fuel-store` package beside `track-store`, with the generic file mechanics extracted into a shared base.** Clean for each store alone, but it splits one track's facts across two folders, two identity checks and two seeding paths, for no gain the section does not give.

**A new module in `deck-core`** (also the first version). `deck-core` is the deck abstraction; persistence has gone to its own packages since (`settings`, `replay-store`, `track-store`).

## Trade-offs accepted

**A stored entry can outvote early live laps until displaced.** The direct consequence of seeding the buffer wholesale. The alternative considered was keeping the live tracker authoritative and using the store only while `samples === 0`, on the argument that a confident wrong number is worse than `--`. That was overruled: the prior is the same driver in the same car at the same track, about as representative as a prior gets, whereas `--` is certainly useless. The property remains real: after a setup change that alters consumption, the first laps read against old data until twenty laps have displaced it. #750's reset is the escape hatch.

**Track-store's name widens** from "the pit-lane landmark store" to "what iRaceDeck learns per track", and its write path from one section to several. Its `CLAUDE.md`, the Architecture page and the `track-data` model docs move with it.

**Removing one car's bad history is no longer a file delete.** Deleting the track file loses the pit-lane landmarks too. #750's reset is the per-car remedy, which is one more reason open question 2 matters.

## Out of scope

- **Uploading or sharing fuel data** (R6).
- **Weighting by session kind, track temperature, weather or setup.** The stored session kind keeps the first open; the rest are not recorded.
- **Building #750's reset or any UI to show where a figure came from.** Both are open questions below, and #750 is its own issue.
- **Rename detection for cars.** `CarID` is the key; `carPath` is informational. A car renamed under one id keeps its history, which is the wanted outcome.

## Open questions, deliberately not settled here

1. **Is the first green lap after a restart excluded?** Caution laps already are; the lap *after* a restart is not, and it burns differently. Needs Niklas.
2. **Does #750's Reset Fuel Consumption Data clear the stored laps?** It must, or the next seed undoes the reset. If yes, the mechanism is a per-car `clearedAt` time in the section, which the merge applies by dropping laps that ended before it, never a deletion: another process's next write would bring deleted laps back. Needs Niklas's confirmation, since it changes an unimplemented issue's scope.
3. **Should a seeded figure look different from a live one?** A driver cannot tell whether the number on the key comes from this session or three weeks ago. Whether that deserves surfacing at all is worth deciding rather than defaulting; nothing here builds it.

## What would be measured before implementation

- **How many valid laps a typical practice session yields**, since a 20-lap window only helps if it fills.

## Testing

- **The fuel model, by suite:** the section normaliser keeps unknown keys; the merge is commutative and idempotent; two copies of one lap under 60 s apart merge to one, while the same lap number from another offline session stays two; the newest 20 per car survive; a newer section version is reported, not read.
- **The store, by suite:** two stores on one folder (the existing `pid` and `TrackStoreIo` seams) each record a lap of one car and both survive; a newer `fuel` section is carried through while `pitLane` is written, and the reverse (R3); a file with only a `pitLane` section gains a `fuel` section and loses nothing.
- **The translator, by suite:** seeding at the first live tick, after a session change (after the deferred wipe, not before it), after a car change and after a disconnect; a qualifying lap and a parade lap are neither counted nor published (R1, R4); a seeded buffer gives `getFuelStats()` figures before the first live lap.
- **By hand, in the sim (Niklas):** run a practice of several green laps, leave, join a race session in the same car at the same track, and see the fuel readout before the first lap completes; repeat on another deck host and see the same figure; check that a qualifying session leaves the stored laps unchanged.

## Affected artifacts

- `sim-events-iracing`: `fuel-laps.ts` (the `!wasPreGreen` term, the qualifying exclusion, session-kind capture, the seeding entry point, publishing `fuel.lapRecorded`), the identity read (`CarID`, `CarPath`) and their tests.
- `event-bus`: the `fuel.lapRecorded` event in the catalog; `scenario-harness`: its `event-names.ts` entry.
- `track-data` (or a sim-neutral sibling model module): the fuel section's model — shape, normaliser, merge, version.
- `track-store`: the second section, per-section version handling (R3), `loadFuelLaps` / `recordFuelLap`, and its `CLAUDE.md`.
- `plugin-runtime`: `initSim`'s `loadFuelLaps` option and the track-store phase's subscription.
- The Architecture page (`docs/development/architecture.md`), since a new event crosses the bus and the store's scope widens.
- The website and a changelog fragment: fuel figures from the first lap are user-visible.
- #750: a note that its reset must clear the stored laps, once open question 2 is answered.
