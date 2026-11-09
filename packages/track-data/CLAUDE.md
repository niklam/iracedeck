# @iracedeck/track-data

Two kinds of track data, kept apart. Zero runtime dependencies, and no IO: nothing here reads a file or the clock.

- **Corner markers** — bundled from Lovely Sim Racing, keyed by `WeekendInfo.TrackName` (`corner-data.ts`, `corners.iracing.ts`, `normalize.ts`).
- **Pit-lane landmarks** — the pure model of the four pit-lane positions learned from live telemetry (`pit-lane-landmarks.ts`, #1112). Learned values are not Lovely data and carry none of its licence terms.

## License

The corner data is CC BY-NC-SA 4.0 and used with permission (#888). Attribution is a condition of that grant: the credits in `CORNER_DATA_ATTRIBUTION` (`src/attribution.ts`, whose comment lists the grant's terms) are never removed from the Property Inspector or the website docs. The grant covers the corner markers only; never mix learned landmarks into the Lovely snapshot or its attribution.

## Refreshing the data

`src/corners.iracing.ts` is generated. Refresh it with `node packages/track-data/scripts/refresh-corner-data.mjs` after building the package.

A corner the refresh adds then needs a hand-authored `corner-names` entry and clip in every published voice, the same entry in each; `packages/audio-assets/src/corner-names.test.ts` fails until it has one (#1336).

## Pit-lane landmarks

`approachStart`, `pitRoadStart`, `pitRoadEnd`, `blendEnd` (`PIT_LANE_LANDMARK_NAMES`, driving order). The translator (`sim-events-iracing`) turns each accepted edge into a `PitLaneLandmarkSample`; `@iracedeck/track-store` persists the section; both fold with this module so they agree. Design: `docs/superpowers/specs/2026-09-04-issue-1112-pit-lane-landmarks.md` and its 2026-11-09 amendments.

- **`foldSample(record, sample, now, trackLengthM?)`** is the only way a sample enters a record. It rejects a malformed sample and a duplicate (same `key`, `at` under `PIT_LANE_DUPLICATE_WINDOW_MS` apart), keeps a window of the last `PIT_LANE_WINDOW_CAP` samples ordered by `at`, recomputes `pct` as the circular median of the window and `estTimeByClass` per car class from the samples on the median's side of the S/F line (`CarIdxEstTime` restarts there), and drops `previous` once the landmark publishes again. It never mutates its input.
- **Published** means at least `PIT_LANE_MIN_AGREEING_SAMPLES` window samples within `PIT_LANE_TOLERANCE_M` of the median (`PIT_LANE_TOLERANCE_PCT` when the track length is unknown). `resolvePublishedLandmark` is the consumer view: current values when published, else the pre-rebuild `previous`, else `null` — never an estimate.
- **A changed `WeekendInfo.TrackLength` is a rebuild** (`applyTrackLength`): published values move to `previous`, window and count reset.
- **Every lap fraction is wrap-aware.** Use `pitLaneSignedDeltaPct`, `pitLaneMidpointPct` and `pitLaneCircularMedianPct`; a plain subtraction or sort is wrong for a pit exit straddling S/F.
- **The section format is frozen** — it is the upload payload of the later shared database. Every function keeps keys it does not know, at every level; a new field is added beside the old ones, never in place of one. `normalizePitLaneSection` reads a section from JSON (malformed samples and unusable records dropped) and returns `null` for a wrong shape or a newer version; check `isNewerPitLaneSection` first, since a newer file must be neither rewritten nor moved aside as corrupt.
- **The constants are reasoned defaults, to be tuned on captures**, not settings.
