> **Issue:** [#1112](https://github.com/niklam/iracedeck/issues/1112) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Learned pit-lane landmarks per track

## The problem

iRacing never tells a plugin where the pit lane _is_. It reports what state each car is in — approaching the pits, between the cones, in a stall, back on track — but not the positions at which those states change, and those positions are what a callout needs when it wants to say something _before_ the car gets there: how long until the pit-exit merge, how far to the speed-limit line. The track-data package bundles corner markers from Lovely Sim Racing, but no pit geometry.

The maintainer's request, made while designing the pit-exit traffic warning (#1113): learn those positions from the cars we watch, keep them, and make them better over time; first locally, later shared so a driver's first visit to a track is already seeded.

## What the sim gives us

Every car exposes `CarIdxTrackSurface` (`OnTrack` ↔ `AproachingPits` ↔ `InPitStall`) and `CarIdxOnPitRoad` ("between the cones"), alongside `CarIdxLapDistPct` and `CarIdxEstTime` — the reference-lap time to reach that position. The player's own `PlayerTrackSurface` / `OnPitRoad` are the same signals with no interpolation noise. Four edges, in driving order:

| Landmark        | Edge                                      |
| --------------- | ----------------------------------------- |
| `approachStart` | `OnTrack → AproachingPits` on the way in  |
| `pitRoadStart`  | `CarIdxOnPitRoad` off → on                |
| `pitRoadEnd`    | `CarIdxOnPitRoad` on → off                |
| `blendEnd`      | `AproachingPits → OnTrack` after pit road |

The fourth was the maintainer's "if we get it, gather it", and we do: after pit road a car sits in `AproachingPits` until the sim flips it to `OnTrack`, and `diffPitLane` already relies on exactly that edge — it keeps the approach callout suppressed while a car leaving pit road is in that state and re-arms only once it reads `OnTrack`. So all four come from fields the translator already samples.

Resolution is one tick at 60 Hz: about a metre at pit speed, several metres at track speed for the approach edge. That is why the store keeps a **median over many cars** rather than the last value seen.

## What ships

A per-track file of the four landmarks, learned from every accepted edge, persisted under `%LOCALAPPDATA%\iRaceDeck\Track Data\`, seeded into the translator at session start, and exposed to consumers through a translator accessor and a bus event. #1113 is the first consumer. Nothing user-facing beyond a Diagnostics row.

## Decisions

### 1. The landmark record

Each of the four is `{ pct, estTime, samples, updatedAt }`: the running median position and reference time, the count behind them, and when they last moved. Both `pct` and `estTime` are kept because consumers want different ones — a distance for "how far", a time for "who arrives when" — and deriving one from the other needs a speed profile the file does not have.

### 2. Sample acceptance

An edge is accepted only when:

- the car's **previous** state was a road state (on track, approaching, or on pit road) — a tow, a reset or a teleport-to-stall lands a car in `InPitStall` from nowhere and produces no accepted edge;
- the position moved a **plausible distance** since the previous tick — a jump is a teleport, not a drive;
- the car is **not the pace car**, which parks on pit road and blends at will.

A landmark is **published** to consumers once two or more samples agree within a tolerance; a lone sample is remembered but not trusted. Tolerance and minimum count are constants tuned on captures, not settings. The stricter alternative — player samples only, other cars merely confirming — was weighed and rejected for now: it learns a track only when the player pits, which on a busy server is the slow path, and the plausibility rules already reject the teleport cases that made other cars suspect.

### 3. The file

One JSON file per track, keyed by `TrackID`, carrying `TrackName`, `TrackConfigName` and `TrackLength` as they were when written — the #1081 re-keying rule: if the identity scheme ever changes, the raw names let a file be re-keyed instead of orphaned. An explicit `version` field, and an `origin` per landmark (`learned` today; `seeded` reserved). **The format is frozen**, because it is the upload payload of the later phase; changing it later means a migration on every driver's machine.

Shared across the three ecosystems, deliberately outside `Settings\<host>\`: a pit lane is a fact about a track, not about which deck is attached, and per-host copies would relearn on every switch. Written debounced and atomically; a malformed file is moved aside with a timestamped name, never overwritten — a corrupt file is still someone's learned data.

### 4. Ownership

As in #1081: the store lives in **deck-core** and the translator does no file IO. At session start the plugin seeds the translator with the track's landmarks; the translator's diff publishes accepted samples on the bus (`pitLane.landmarkLearned`), and the store folds them in and persists. Consumers read `getPitLaneLandmarks()` from the translator, not the file, so a landmark accepted mid-session is usable mid-session.

### 5. No landmark, no guess

A consumer that finds no published landmark for the current track stays silent and logs at debug. The alternative — an estimate from track length or a default pit-lane fraction — is a wrong number spoken with confidence, which is worse than silence for the one thing this store exists to make precise.

### 6. Track updates

When a file's stored `TrackLength` disagrees with the session's for the same `TrackID`, the track has been rebuilt. Proposed: samples reset, the previous values kept under `previous` for one session so a consumer can fall back while the new geometry is learned. Recorded as the open question in the issue.

## Later: a shared database

Out of scope here except for what it needs the file to be. The leaning, recorded so the format is designed for it: drivers who opt in upload accepted landmarks; a service aggregates per track; each release bundles a snapshot into `@iracedeck/track-data` the way the corner markers already ship, so seeding works offline and the local file refines on top. The `origin` field is the seam. Filed as its own issue when it is next.

## Alternatives rejected

**Hard-coding pit geometry per track.** Hundreds of configurations, no source, and stale on every track update.

**Player samples only.** Decision 2.

**Per-ecosystem storage.** Decision 3.

**Estimating a missing landmark.** Decision 5.

## Verification

Edge-detector tests: each of the four edges, the three rejection rules, wrap-around at the start/finish line. Aggregator tests: median convergence, the publish threshold, tolerance. Store tests in the #1081 shape: absent, malformed, unreadable, atomic write. Manual: a practice session on a busy server, confirming the file appears and the counts climb; a second session on the same track, confirming the seed.
