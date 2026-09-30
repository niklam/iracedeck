# Issue #1285: gap trend calls read the lap-over-lap gap, not the within-lap rate

> **Issue:** [#1285](https://github.com/niklam/iracedeck/issues/1285) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

The issue's race record shows the "car ahead is pulling away" call five times in seven laps, while the real start/finish gap moved by only about 1.1 s all race and shrank for the last three laps. Two mechanisms in `packages/sim-events-iracing/src/diff/gaps.ts` combine to produce it.

- **The breakaway reads a within-lap rate.** `processRelevance` decides both the closing threat and the breakaway from `gapRateEma*`, the display-trend EMA (`GAP_TREND_EMA_ALPHA` 0.15 over checkpoints 0.02 lap apart, so its memory is about 0.13 lap). That is the rate across the last sector or two. A car ahead that is faster down a straight reads as "opening hard" whatever the lap-over-lap gap does. The re-arm (`gap <= GAP_BREAKAWAY_REARM_GAP_S && ema < GAP_BREAKAWAY_MIN_RATE_S_PER_LAP`) reads the same EMA. The gap never exceeded 5 s, so the episode re-armed at the first sector where that local rate dipped under 0.5 and could fire again on the next lap.
- **The ETA regime folds an underestimate into the trough.** The consistency gate should have stopped every one of these calls, because each needs the gap 1.5 s above its trough since the previous call. The only reading in the diff that can sit that far below the true gap is the ETA regime: `leaderRate < chaserRate × GAP_ETA_LEADER_SLOW_FACTOR` (0.5) over a 3 s window. At Red Bull Ring the car ahead brakes from ~280 to ~80 km/h into T1 and T3 while the player is still flat on the straight 3–5 s behind, so the ratio drops below 0.5. The reading then becomes `separation ÷ chaser rate`. For a car 4 s behind, that is about 2 s. `foldSideExtremes` folds it into the trough. When the regime ends, the EMA restarts from its first sample, which is taken while the leader accelerates out of the hairpin and the player brakes into it. That sample reads as a strong opening, so the rate bar and the consistency gate both pass on the next crossing-time reading.

The crossing-time gap itself is correct through a braking zone. It is the time since the car ahead passed the player's current position, which is exactly the gap a braking leader should show. The ETA regime exists for a leader that has stopped, when the crossing-time reading freezes (#933 follow-up). It was never meant for a leader that is braking for a corner.

## Decisions

### 1. Trend calls use a lap-scale rate: the gap now against the gap at the same spot one lap earlier

Each side keeps a lap history of its checkpoint readings: `{ progress, gapSeconds }` at the existing `GAP_CHECKPOINT_STEP` cadence of player progress, pruned to a little over one lap. At each checkpoint the diff looks up the gap at `progress − 1`, interpolated between the two history samples that bracket it. The lookup counts only when those two samples are contiguous, no more than `GAP_TREND_MAX_STEP_LAPS` apart. `gapSeconds − gapThen` is the lap-over-lap change in seconds per lap. It compares the gap at the same point on the track, so the within-lap profile cancels out: a car faster down the straight and slower through the hairpins produces the same profile on both laps.

The lap rate is the mean of the most recent lap-over-lap changes, `GAP_LAP_RATE_WINDOW_SAMPLES` = 10 (0.2 lap). It reads `null` until the window holds `GAP_LAP_RATE_MIN_SAMPLES` = 5. A single change beyond `GAP_TREND_MAX_RATE_S_PER_LAP` is skipped as a glitch, the same guard the EMA uses.

`processRelevance` uses the lap rate for the closing projection, the breakaway bar and both re-arms. A `null` lap rate means no trend call. `gap.trendChanged.ratePerLap` carries the lap rate, so `lapsToContact` is the gap divided by a lap-scale closing rate. The payload's shape does not change and the audio side is untouched.

The display trend keeps its fast EMA. Session Info's Gaps colour is a live view, and a sector-scale rate is what it should show. Only the callouts move to the lap scale.

**Consequence (confirmed by Niklas, 2026-09-30):** a pair needs one lap of same-spot history before any closing or pulling-away call. That means no trend calls on lap 1 (lap 2 as well, see "Lap 1 is never recorded" below), and none for a lap after a neighbour change, a pit visit or any other break in the history. The threshold call ("right with us" / "we've caught the car ahead") is unaffected and still works from the first stable reading. The website stops promising a lap-1 breakaway call. A fallback that kept lap-1 breakaways with a within-lap rate and a stricter bar was rejected, because it would re-admit the sector-profile false call this issue is about.

**What breaks the lap history.** The history is cleared, so the next lap is silent, on: a neighbour identity change (`resetSideState`), the player's backwards jump, a due checkpoint the side cannot sample (either car suppressed, `lapDelta !== 0`, a null gap, a neighbour with no live progress), any tick in the ETA regime, and every tick while a full-course caution is out. For the caution, `diffGaps` takes the translator's caution phase as a trailing boolean (`state.cautionPhase !== "none"`, which `diffCaution` sets earlier in the same tick), and it never re-derives the phase from `SessionFlags`. Each of these is a discontinuity in what the gap measures, and a lap-later comparison across it would be a comparison between two different stories. Without the caution clear, the first green lap would be measured against the pace lap at the same spot, and the field stringing out after the restart would read as a whole lap of "pulling away". A plain sampling gap does not clear the history, because the bracket-contiguity check already refuses a lookup across it. A refused lookup does clear the lap-rate window, so the rate cannot keep serving changes from before the gap.

**Lap 1 is never recorded (Niklas, 2026-09-30, after the review).** History samples are taken only once `LapCompleted >= 1`. A pair queued through a first-lap corner at low speed has an inflated time gap there (the same distance at a lower speed is more seconds), so lap 2 at racing speed would read as a lap-scale "closing" against it. The first trend call can therefore come on lap 3.

**A threshold call fired on an ETA reading clears the extremes** (to `null`, so the next crossing-time reading reseeds them) instead of resetting them to the ETA value. Otherwise the leak decision 3 closes in `foldSideExtremes` would reopen through the threshold path.

### 2. The breakaway re-arms only when the opening is over at lap scale

The breakaway latch re-arms when the gap is back under `GAP_BREAKAWAY_REARM_GAP_S` **and** the lap rate is below `GAP_BREAKAWAY_REARM_RATE_S_PER_LAP` = 0.25 s/lap. That is half the announce bar, the same hysteresis the closing threat's recede test uses (`< GAP_CLOSING_MIN_RATE_S_PER_LAP / 2`). A `null` lap rate never re-arms. The latch holds through a break in the history rather than flipping on missing data.

In the issue's race this means one "pulling away" call at most for laps 9–13, and only if the lap rate reached 0.5, which it did not (~0.3 s/lap). The latch then re-arms when the gap starts shrinking from lap 13.

### 3. The ETA regime is for a stopped or crawling leader only, and its readings stay out of the extremes

The regime needs, in addition to the existing relative test, the leader's recent rate × track length below `GAP_ETA_LEADER_CRAWL_MPS` = 8 m/s (about 29 km/h) over the same 3 s `GAP_RATE_WINDOW_S`. A 3 s average through a braking zone includes the braking and the exit, so it should stay above the apex speed of even a slow hairpin. The validation capture below checks that. A wrecked, stopped or limping car falls below it. `diffGaps` takes the track length the translator already resolves each tick (`resolveTrackLengthMeters`) as a new trailing parameter. With no track length the regime never engages. That is the safe direction for this bug: a stopped leader then shows the frozen crossing-time gap, which is the pre-#933-follow-up behaviour, rather than a false reading.

The side records whether this tick's reading is an ETA reading (a per-side boolean in `TranslatorState`, not a new field on the public `GapNeighborState`). `foldSideExtremes` does not fold an ETA reading into the since-announcement extremes. It hands the extremes as they stand to the processors, so the threshold episode's lap-1 test still has them. The threshold call itself keeps using ETA readings, because a pursuer closing on a stopped player is exactly what "right with us" is for. The relevance path already sees no rate in the ETA regime, since the regime resets the trend chain and now also clears the lap history.

The 8 m/s value is decided here, not deferred. The capture that validates it is the issue's first task, run during the manual test: `pnpm telemetry-watch` recording `CarIdxLapDistPct`, `CarIdxLapCompleted`, `SessionTime` and `CarIdxTrackSurface` while following a car 3–5 s back through Red Bull Ring's T1 and T3. Replaying it through `diffGaps` on `origin/master` should show the regime engaging in the braking zones, which confirms cause 2. On the branch it should never engage. The leader's minimum 3 s average in the capture sets how much margin the constant has.

## Artifacts beyond the code

- `packages/sim-events-iracing/src/state.ts`: the new per-side fields (lap history, lap-rate window, ETA flag), in both the type and `createInitialState()`, with the doc comments on the display EMA narrowed to "display only".
- `packages/sim-events-iracing/src/diff/gaps.ts`: the module and `maybeEmitCalloutEvents` doc comments, which describe the relevance model as reading the smoothed rate.
- `packages/website/src/content/docs/docs/actions/audio-voice/pit-crew.md`, *Gap callouts*: trend calls read the lap-over-lap change at the same spot on track and start once a lap of history exists. The "on lap one" promise goes. The re-arm sentence names the rate condition as well as the 5 s gap.
- `packages/website/src/content/docs/docs/actions/display-session/session-info.md`, *Gaps*: the stopped-car sentence says the estimate is for a car that is stopped or crawling, not one braking for a corner.
- `packages/website/src/content/docs/changelog.mdx`: a `**Bug Fixes**` line under the in-development version.
- `.claude/rules/race-engineer-callout-examples.md`: the #933 entry's ETA sentence ("whenever the leader runs below half the chaser's pace") gains the crawl bar, plus a new #1285 entry for the reusable lesson: an announcement about a lap-scale trend must be decided on a lap-scale rate, and a within-lap rate compares one sector's profile, not the battle.
- `audio-scenarios` `gaps.ts`: no change. The payload shape is unchanged, and the contract `description` ("closing fast enough to reach it within eight laps, or opening into a breakaway") stays true, so `pnpm generate:pack-reference` is not needed.

## Out of scope

- The display trend on Session Info's Gaps mode. It keeps the fast EMA by design.
- The threshold callout, the cooldown, the stability guard and the consistency gate's rule itself. Only what feeds the extremes changes.
- Any change to the crossing-time gap model or to `gap-utils.ts`.
- A committed fixture cut from the validation capture. The regression test is synthetic, below. A capture-cut fixture can follow once the capture exists.
- Trend calls on lap 1 (see decision 1).

## Testing

In `packages/sim-events-iracing/src/diff/gaps.test.ts`, a synthetic two-car track drives `diffGaps` tick by tick, with each car's position integrated from a speed profile over lap distance:

- **The regression (issue's shape):** the car ahead is faster down two straights and brakes harder into two hairpins, and its lap time equals or is slower than the player's. The gap is 3–5 s, flat or shrinking lap over lap. Over eight laps: no `gap.trendChanged` with `side: "ahead", direction: "opening"`. Positive control: the same fixture fires at least one such call on `origin/master`'s `gaps.ts`, checked once by hand and recorded in the PR body.
- **A genuine breakaway:** the same profile with the car ahead 0.7 s/lap quicker, starting 2 s ahead. It produces exactly one "opening" call, on lap 2 or later, with `ratePerLap` near 0.7.
- **No lap-1 trend call:** a genuine breakaway from the start is silent until the pair has one lap of history.
- **Re-arm:** after an announced breakaway, a gap that stops growing but stays under 5 s re-arms only when the lap rate falls below 0.25. A later genuine breakaway announces again.
- **The ETA regime:** the braking profile never engages it (the gap never drops below the crossing-time value). A leader that stops on track does engage it with a track length. With no track length it does not. An ETA reading is not folded into the extremes: a stopped-then-restarted leader cannot open a consistency-gate pass.
- **Closing:** a car behind closing at 0.6 s/lap from 6 s is announced on the lap scale, and a within-lap closing burst on a lap-over-lap flat gap is not.
- The existing closing, breakaway and ETA tests are updated to the lap-scale model. Tests that drove the relevance path within one lap now need a lap of history first.

Manual: the validation capture above, plus a race or an AI session running 3–5 s behind a car at a track with heavy braking zones. The engineer should not call "pulling away" while the gap holds, and should call it once when the car ahead genuinely escapes.
