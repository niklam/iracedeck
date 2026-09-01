# Persist validated fuel laps per car and track, and seed the buffer from them

> **Issue:** [#1081](https://github.com/niklam/iracedeck/issues/1081) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

Fuel consumption starts from nothing every session. The validated lap history built in #465 lives in memory on the translator and is wiped on a session change, so a driver who practised for an hour arrives at the race with zero samples and the consumption displays showing `--` until several green laps have run — exactly when the strategic question is being asked.

## What already exists, so the spec is not read as more work than it is

`sim-events-iracing/src/diff/fuel-laps.ts` (#465) is a working, tested engine, and three things Niklas asked for are already in it:

- **A 20-lap rolling buffer** — `FUEL_LAP_HISTORY_CAP = 20`. The requested window is the cap that already exists.
- **Validity gating** — `isValidForCalc: fuelUsed > 0 && !isOutLap && !enteredPits && !wasTowed && !wasCaution`. Out-laps, in-laps, tows **and full-course caution laps** are already excluded. The caution term is not in #465's plan; the implementation went beyond it.
- **A deferred session wipe** — a session change arms `pendingSessionWipe`, executed on the first live-in-car tick past pre-green, so a garage visit keeps the data.

What is absent: any persistence, and any car/track keying. Nothing in the repo reads `CarID`, `CarPath` or writes a fuel figure to disk.

## Decision

### Storage

One file per car+track pair at `%LOCALAPPDATA%\iRaceDeck\Fuel\<carPath>_<trackName>.json`.

**Shared across ecosystems, not under `Settings\<Stream Deck|Mirabox|Ulanzi>\`.** That split exists because settings are host state; fuel history is a fact about a car, a track and a driver. Storing it per-ecosystem would mean plugging in a different deck silently loses the history — the exact "start from nothing" this feature exists to end.

**One file per pair rather than one shared map.** Discoverability is the requirement: a human opening the folder sees what is there, and fixes a bad average by deleting one visible file. That also makes pruning a delete and needs no new UI. The cost — more files, more IO — is real and accepted; the dataset is ~1.2 KB per pair (20 laps of three numbers), so the scale never justifies a shared blob or a database.

### Identity, and the ordering that matters

**`CarID` and `TrackID` are the identity; the filename is an index.** Each file stores both numeric ids plus the raw `CarPath` and `TrackName` as they were when written. The filename is a convenience for a human browsing the folder; the file's contents are the truth, and they are what makes a future re-key possible if a name or a slug rule ever changes.

`WeekendInfo.TrackName` is the layout-bearing part: it distinguishes `barcelona gp` from `barcelona historic`, which `TrackID` is not established to do — `TrackID` is read in production today only as a cache-invalidation key (`state.ts:88`, `:520`), which requires it to change when the track changes and proves nothing about per-layout uniqueness. So `TrackName` carries the layout and `TrackID` sits alongside it, not instead of it.

**Interpretation stated so it is visible rather than assumed:** the requirement was written `Fuel\<car id>_<track_id>.json` with the stated priority "something that's easy to find". Read literally those pull in opposite directions — numeric ids are not easy to find. This spec reads it as readable names in the filename with numeric ids inside the file. If numeric filenames were actually wanted, this is the line to object to.

### The filename transform, frozen

1. Lowercase.
2. Runs of whitespace → a single `_`.
3. Allow-list `[a-z0-9_-]`; map anything else to `_`.
4. Trim leading and trailing `_` and `-`.
5. Reject an empty result rather than writing a file.

**The rule is frozen, not its aesthetics.** If the transform ever changes, every existing file orphans and every user silently starts from nothing — the failure this feature exists to prevent. The stored raw identifiers are the recovery path if it must ever change.

Two things this is designed against, both measured rather than assumed:

- **The character census.** `track-data`'s 60 real `TrackName` values contain only lowercase letters, digits, space and one hyphen; spaces→underscore is injective across all 60 with no case-insensitive collisions. That sample is the tracks with corner data, not every track, so the **allow-list** — not the census — is what makes the rule total.
- **`CarPath` is measured too, across 35 real samples** (34 extracted from `local/telemetry-snapshot-*.json`, plus `fordmustanggt3` from the capture taken during #1067): **lowercase letters, digits and spaces only** — no underscores, no punctuation, no uppercase. Longest 28 chars (`stockcars chevycamarozl12022`). The same shape as `TrackName`, from an independent sample.

Step 3 is deliberately lighter than `slugifyCornerName`, which strips to `[a-z0-9-]` and would differ for 59 of the 60 track values. That helper is the right shape for corner slugs and the wrong transform here; this one is written and named for this purpose.

### Collisions are detected, not prevented

The separator is a character the transform produces, so distinct pairs can map to one filename: car `ford_mustang` + track `gt3 lemans` and car `ford` + track `mustang gt3 lemans` both yield `ford_mustang_gt3_lemans.json`. This needs a `CarPath` containing an underscore, which **does not occur in any of the 35 samples measured** — so the hazard is unobserved rather than merely hypothetical. The check stays anyway: it costs one comparison against values the file already stores, and the cost of being wrong is two cars' datasets silently merged.

**A write that finds an existing file whose stored `CarID`/`TrackID` differ from the ones being written has detected a collision and must refuse rather than overwrite.** Silently merging two cars' datasets is worse than failing to persist one. A rarer separator narrows the odds without closing them, so detection is the mechanism and the separator is not load-bearing.

### Exclusions

Recorded laps are valid **practice and race** laps. On top of #465's existing gates:

- **Qualifying laps are never recorded.** The car runs light and the figure is unrepresentative.
- **Parade laps are never recorded**, and this becomes explicit rather than incidental — see the requirement below.
- Caution laps remain excluded by the existing `wasCaution` term.

**Store the session type on each lap anyway.** It costs one field and is what makes a later "prefer race laps when both are present" change possible without discarding the history. Rejecting qualifying at write time does not require it; keeping the option does.

### Seeding

**Read the stored laps at session start and seed the live buffer with them.** Live laps then displace the oldest, which is what `FUEL_LAP_HISTORY_CAP` already does — so the tracker needs pre-filling, not new displacement logic, and after seeding there is no stored-versus-live boundary to maintain.

## Named requirements

- **R1 — Parade laps are excluded by a positive term, not by side effect.** `isValidForCalc` gains a `!wasPreGreen` term, tracked as `wasCaution` is, using the shared `isPreGreen()` helper (`telemetry-features.ts:83` — a positive session-state test covering `ParadeLaps`, `Warmup`, `GetInCar`, `Invalid`). Today parade laps go unrecorded only because the deferred wipe returns early pre-green: an accident of the wipe logic, with no term in `isValidForCalc`, that fails silently if the wipe is ever restructured and already misses a parade lap in a session with no wipe pending.
- **R2 — A collision never merges two datasets.** A write whose stored identifiers disagree with the file's refuses.
- **R3 — The filename transform is frozen.** Changing it orphans every file; a change requires a migration keyed on the stored raw identifiers.
- **R4 — Qualifying laps are never persisted or counted.**
- **R5 — The store is shared across ecosystems.** Switching decks must not lose history.

## Trade-offs accepted

**A stored entry can outvote early live laps until displaced.** This is the direct consequence of seeding the buffer wholesale, and it was weighed rather than overlooked: the alternative considered was keeping the live tracker authoritative and using the file only while `samples === 0`, on the argument that a confident wrong number is worse than `--`. That was overruled, reasonably — the prior here is the same driver in the same car at the same track, which is about as representative as a prior gets, whereas the `--` alternative is certainly useless. The property remains real: after a setup change that alters consumption, the first laps read against three-week-old data until twenty laps have displaced it. #750's reset is the escape hatch.

**More files and more IO than a shared map**, accepted for discoverability, which is what makes the delete-a-file remedy possible.

## Open questions, deliberately not settled here

- **Is the first green lap after a restart excluded?** Caution laps already are; the lap *after* a restart is not, and it burns differently. Needs Niklas.
- **Does #750's Reset Fuel Consumption Data clear the persisted file?** It must, or a reset is undone by the next seed — and that argument is stronger now that seeding is wholesale. Recorded here as a note against #750, needing his confirmation, since it changes an unimplemented issue's scope.
- **Should a seeded number be distinguishable from a live one?** With the buffer seeded from disk, a driver cannot tell whether the figure on their key comes from this session or three weeks ago. Whether that deserves any surfacing at all is worth deciding rather than defaulting; nothing here builds it.

## What would be measured before implementation

- **Whether `TrackID` is unique per layout**, which would let it carry identity rather than merely sit alongside `TrackName`.
- **How many valid laps a typical practice session yields**, since a 20-lap window only helps if it fills.

## Affected artifacts

- `sim-events-iracing`: `fuel-laps.ts` (the `!wasPreGreen` term, the qualifying exclusion, session-type capture, a seeding entry point) and its tests.
- A new store module owning the `Fuel\` directory, its transform and collision detection. **In `deck-core`, not the translator** — the translator does no file IO, and putting `fs` into `sim-events-iracing` would invert the dependency direction that keeps it sim-focused.
- The snapshot/session parsing, to surface `CarID`, `CarPath`, `TrackID` — none of which any code reads today.
- `.claude/rules/` guidance for the new store, and the website if any of it becomes user-visible.
- A note against #750.
