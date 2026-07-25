# Corner-Name Callouts in Practice and Test Sessions — Design

**Issue:** #888
**Date:** 2026-07-25
**Status:** Approved (pending spec review)

## Summary

Spoken corner-name callouts in practice-like sessions: as the player approaches a named corner, the Race Engineer announces it ("Eau Rouge", "Turn five") with a speed-scaled lead time so the call lands before the corner. Corner data comes from Lovely Sim Racing's [lovely-track-data](https://github.com/Lovely-Sim-Racing/lovely-track-data) dataset (CC BY-NC-SA 4.0, used under an explicit grant from Constantinos Demetriadis, 2026-07-19). **Attribution to Lovely Sim Racing and Racing Circuits is a grant condition and a release blocker.**

## Decisions made during brainstorming

| Question | Decision |
|---|---|
| Scope | One worktree (`ir-888`), two sequential PRs: data layer first, then mechanism + audio |
| Wording | Bare name only — "Eau Rouge", "Turn five". No prefix, no prefix setting |
| TTS text | Numbers spelled out ("Turn five", never "T5"/"Turn 5") |
| Data delivery | Bundled snapshot only — no runtime fetch. Refresh via repo script per release |
| Lead time | Global setting, **default 1.0 s** (long leads confuse consecutive-corner sequences), clamped 0–5 s |
| Data layer home | New `@iracedeck/track-data` package |
| Clip generation | ElevenLabs pre-generation of the full name set (~439 clips, `default` voice), approved by Niklas including cost |
| Opt-in default | ON (`calloutEnabledCornerNames`), per the standing rule for new Race Engineer functionality |

## Dataset facts (verified against the live repo)

- The issue text assumed numeric `WeekendInfo.TrackID` is the lookup key. **Reality: the dataset keys iRacing tracks by the sim's internal `TrackName` string** (`bathurst`, `algarve gp`, `watkinsglen 2021 fullcourse`). `TrackName` is the join key; the numeric `${TrackID}|${SessionNum}` pattern is still used for cache invalidation.
- 131 iRacing track files; **68 tracks** have named turns with usable positions; **439 unique corner names** after normalization; 439 unique slugs (no collisions). Pruned snapshot ≈ 31 KB.
- Turn schema variants handled at refresh time: `start`/`end` (common), `marker`-only (apex — used as position fallback), one `naem` typo, unnamed turns (dropped), `T5`-style names (normalized to `Turn 5`), non-ASCII names (`180°`, `Hasseröder`).
- One slug-format outlier in the dataset (`cota-gp` with a hyphen where iRacing uses a space) — covered by normalized matching (lowercase, hyphens ≡ spaces).

## PR 1 — Data layer: `@iracedeck/track-data`

New package, zero runtime dependencies, synchronous API, plain tsc build.

```text
packages/track-data/
├── package.json                     # @iracedeck/track-data
├── scripts/refresh-corner-data.mjs  # download LSR tarball → prune/normalize → rewrite snapshot
└── src/
    ├── index.ts                     # public exports
    ├── corner-data.ts               # resolver + normalization
    ├── corners.iracing.json         # committed pruned snapshot (~31 KB)
    ├── attribution.ts               # CORNER_DATA_ATTRIBUTION constants
    └── *.test.ts
```

**Snapshot format** — `{ "<lsr trackId>": [{ "start": 0.046, "name": "Hell Corner" }, …] }`, sorted by `start`, names pre-normalized (whitespace collapsed, `T<n>` → `Turn <n>`, `naem` fixed, `marker` fallback applied). Only named turns with a position survive pruning.

**Public API:**

- `resolveCornerMarkers(trackName: string): CornerMarker[] | null` — normalized matching against `WeekendInfo.TrackName`. `CornerMarker = { startPct: number; name: string; slug: string }`, sorted by `startPct`.
- `slugifyCornerName(name: string): string` — the single slug algorithm (lowercase, non-alphanumeric runs → `-`, trimmed). Shared by resolver and clip tooling.
- `listCornerNames(): { name: string; slug: string }[]` — unique names across the snapshot, for voice-config authoring.
- `CORNER_DATA_ATTRIBUTION` — source name/URL, license, Racing Circuits pass-through credit.

**PR 1 is not user-facing** — no changelog entry. PR title: `feat(track-data): corner marker data layer for corner-name callouts (#888)`; body references #888 without a closing keyword.

## PR 2 — Callout mechanism + audio

PR title: `feat(race-engineer): corner-name callouts in Practice and Test sessions (#888)`; body carries `Closes #888`.

### Bus event (`@iracedeck/event-bus`)

`cornerName.approaching` with payload `{ name: string; slug: string }` — the catalog's first open-vocabulary payload. The slug rides in the payload so the audio layer never imports `@iracedeck/track-data`. Scenario-harness `event-names.ts` template entry is mandatory (compile-time completeness check).

### Translator (`@iracedeck/sim-events-iracing`)

New dependency on `@iracedeck/track-data`.

**State** (`state.ts`, type + `createInitialState` in sync):

- `cornerMarkersKey: string | null`, `cornerMarkers: CornerMarker[] | null` — resolved-marker cache on the `${TrackID}|${SessionNum}` invalidation pattern, resolved from `WeekendInfo.TrackName`.
- `cornerLeadPrevPct: number | null` — previous tick's lead point.
- `cornerSpoken: Set<number>` — marker indices spoken this lap.

**Diff** — new `diff/corner-name.ts`, wired into `handleTick` post-replay-guard:

1. **Gates (diff-side, #655 precedent — keeps the event harness-firable):** `classifySessionType(...) === "practice"` (covers Practice + Offline Testing), `IsOnTrack === true`, markers resolved, `trackLengthMeters` known, `LapDistPct` valid. Silent when any input is missing — never guess.
2. **Lead point:** `leadPct = clamp(Speed × leadSeconds / trackLengthMeters, 0, 0.2)`; `leadPoint = (LapDistPct + leadPct) mod 1`. `Speed` is m/s, so units line up with track length in meters.
3. **Crossing detection:** signed forward delta between previous and current lead point folded into (−0.5, 0.5]:
   - delta ≤ 0 (reversing / stationary jitter): update prev, no fire.
   - delta > `CORNER_TELEPORT_THRESHOLD` (0.05 lap, #603 scale): discontinuity (tow, reset-to-pits) → re-anchor, clear spoken set, no fire. A reset starts a fresh pass — corners announce again on the new run.
   - otherwise: fire markers whose `startPct` lies in the circular interval `(prev, current]`. Multiple crossed in one tick → **speak only the one nearest the current lead point**, mark all crossed as spoken (no stale burst — #480/#838).
4. **Dedup / lap reset:** per-marker-index spoken set; cleared when the lead-point interval crosses S/F (0.0). Once per marker per lap; reverse-then-forward cannot double-fire.
5. **Pit road:** while `OnPitRoad === true`, crossings are still tracked (prev advances, crossed markers marked spoken) but nothing is announced — no corner chatter in the pit lane, and no burst at pit exit for markers the pit lane slid past.
6. **First valid tick** seeds `cornerLeadPrevPct` silently — no entry burst.

**Lead-seconds injection** — `SimEventsIracingOptions` gains `getCornerCalloutLeadSeconds?: () => number` (live-read closure from plugins) plus an exported `sanitizeCornerCalloutLeadSeconds` clamp (0–5 s, default 1.0, malformed → default) — the #838 `fuelCalloutMarginLaps` pattern; sim-events-iracing stays deck-core-free.

### Audio assets (`@iracedeck/audio-assets`)

- New `corner-names` group in `configs/default.voice.json`: ~439 entries, `name: "<slug>-01"`, `text` = spoken form with numbers spelled out (`turn-5-01` → `"Turn five."`). Override map for oddballs (`180°` → `"One eighty."`; `Hasseröder` keeps the umlaut).
- A small authoring script generates the group JSON from `listCornerNames()` (entries are not hand-typed); the merged config is committed.
- Generation: `generate:dry-run --group corner-names` (must list only the new entries) → `generate --group corner-names` → `generate:manifest`. Approved paid run, `default` voice only. Estimated asset bump ~3–6 MB.

### Audio scenario (`@iracedeck/audio-scenarios`)

- `pit-crew.corner-name-approaching`, `family: "corner-name"` — a consecutive-corner fire preempts the in-flight one wholesale (the 1 s-lead / corner-sequence concern).
- Sequence: `[{ var: "cornerNameClip" }]` — bare name, **no radio open/close frame** (pit-box count-in precedent).
- Scheduling: `weight` omitted (`WEIGHT.NORMAL`), `interrupt: false`, **`queueable: false`** — a corner name that missed its moment drops, never replays late.
- Snapshot-driven builder shape (#558, lap-time precedent): `buildCornerNameScenario(getSnapshot)` + `registerCornerNameVars(engine, getSnapshot)`; each plugin subscribes to `cornerName.approaching`, caches the latest `{ name, slug }`, passes the closure to `registerPitCrew`. Var resolver returns `poolRef("corner-names", slug)`; a missing clip aborts the whole callout silently (#835) — graceful degradation when the dataset grows between releases.
- Family wiring in `index.ts`: `CornerNameCalloutId = "corner-names"`, `CORNER_NAME_CALLOUT_SETTING_KEYS`, `SCENARIO_ID_TO_CORNER_NAME_ID`, `getCornerNameCalloutEnabled` param on `registerPitCrew` (before the master), scenarios wrapped `wrapWithMaster(wrapCalloutScenario(…))`.

### Settings + PI

- `GlobalSettingsSchema` (deck-core): `calloutEnabledCornerNames` (canonical boolean pattern, default `true`) and `cornerCalloutLeadSeconds` (coerced number, default 1, `.catch` on malformed).
- `pit-crew.ejs`, Race Engineer Callouts accordion — new "Corner Names" item: opt-in checkbox, "Lead time (seconds)" range (0–5, step 0.5, default 1, global), and the attribution line as `ird-supporting-text`: corner data by **Lovely Sim Racing** (lovely-track-data), corner names by **Racing Circuits**, CC BY-NC-SA 4.0, with links (external-link handler opens the default browser).
- Plugin closures in **all three** plugins (stream-deck, mirabox, ulanzi): the opt-in live-read closure + the `getCornerCalloutLeadSeconds` option + the `cornerName.approaching` snapshot subscription.

### Scenario harness

- `event-names.ts` template for `cornerName.approaching`.
- Shortcut button(s) under a "Corner Names" category with a sample payload (e.g. Eau Rouge, Turn five).

### Tests

- **PR 1:** resolver matching (exact / hyphen-space / unknown → null), slug stability, snapshot-shape validation (positions in [0,1), names non-empty, sorted), prune/normalize pure functions.
- **PR 2:** diff — seeding, forward crossing fires, speed scaling, multi-cross picks nearest, teleport re-anchor, reverse no-fire, lap-wrap set reset, practice-only gate, silence on unknown track / missing track length / not-in-car. Scenario — registration, opt-in gating, var → poolRef resolution. Fixture updates: both `simhub-service.test.ts` literals, every positional `registerPitCrew(...)` test.

### Docs / website / skills (PR 2)

- Changelog (`changelog.mdx`): one Features line under the in-development version, including the credit.
- Website Race Engineer / Pit Crew action docs: corner callouts section, session scope, attribution.
- `iracedeck-actions` skill: feature listing update.
- `.claude/rules/race-engineer-callout-examples.md`: new reference entry for the pattern (open-vocabulary clip set + bundled dataset).
- `README.md` / architecture page: new package in the package list + dependency graph.

## Error handling summary

| Failure | Behavior |
|---|---|
| Track not in dataset | `resolveCornerMarkers` → null → diff silent |
| Track length unknown | Diff silent (no guessing) |
| Corner name has no clip (dataset grew) | #835 abort — whole callout skipped silently |
| Malformed lead-seconds setting | Sanitize clamp → default 1.0 s |
| Tow / reset-to-pits | Teleport re-anchor; fresh pass announces again |
| Replay viewing | Post-replay-guard diff — silent |

## Manual test plan

1. Scenario harness: fire `cornerName.approaching` shortcuts → hear bare-name clips.
2. iRacing practice session at a covered track (e.g. Bathurst, Spa): calls land ~1 s before each named corner; consecutive corners preempt cleanly; reset-to-pits re-announces on the next run; opt-in toggle silences live; lead-time slider changes timing.
3. Race/qualifying session: no corner callouts.

Nothing is pushed until manual testing passes (standing rule).
