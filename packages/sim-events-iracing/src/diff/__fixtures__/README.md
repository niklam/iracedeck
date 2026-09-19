# Diff fixtures

`caution-restart-20260917.json` — 284 ticks cut from `local/telemetry-watch-20260917-191825-092.jsonl`
(issue #1127): an offline AI race at Homestead-Miami, a rolling double-file start, two full-course
cautions thrown with the Race Admin `!yellow` command, and two double-file restarts. Only the fields
`diff/caution.ts` reads are kept, deduplicated on those fields, car slots trimmed to the 20 cars at
their own indices (0–19) plus the pace car — index 64 in the raw telemetry — appended as slot 20.

`caution-road-20260918.json` — 143 ticks cut the same way from `local/telemetry-watch-20260918-185032-545.jsonl`
(issue #1127, the amended design): the first **road-course** caution anyone captured — an offline AI
race, two cautions, one restart, the second caution still waving when the capture ends. It is the
evidence for the two road rules: the waving caution never goes static on its own there (at 309.33 s
it drops straight to `Caution | OneLapToGreen` on one tick, so "Two to green" has no moment and stays
silent), and the pace car shows `AproachingPits` for about three seconds mid-caution and comes back
(152.23 → 155.37 s, 562.07 → 565.22 s — its route out through pit exit), while the real exit comes
after one to green (461.22 s, 5.7 s before the green). Two things this fixture does **not** carry: the
capture has no session YAML, so the tests that replay it supply `PaceCarIdx: 64` synthetically, as the
oval fixture's tests do; and it recorded no `LapDistPct` (player or per-car), so it **cannot** exercise
the one-to-green lap's checkpoint (`caution.lastLapCheckpoint`) — that rule is covered by the
synthetic ticks in `caution.test.ts` and by the harness's "Caution → restart" button, not by this
capture. It also has no `paceCar.deployed` after either throw: the pace car was already on track when
the caution came out (its surface reads on-track from the rolling start on), so the only deployed
edges are the returns from the two blips.

`caution-lineup-20260919.json` — ONE tick, cut from the snapshot `local/telemetry-snapshot-20260919-094304-382.json`
(issue #1127, the 2026-09-19 correction): a 20-car ARCA race at Homestead, at one to green under a
double-file restart, the moment the position call said **"P21"** while the display showed **P19**.
Same trimming (cars 0–19 at their indices, the pace car — index 64 — as slot 20), but the fields are
what the LINEUP and the RACE ORDER read rather than what `diff/caution.ts` reads: the pace arrays,
`CarIdxPaceFlags` (the first capture with it set — the player, index 0, carries `WavedAround`),
`CarIdxLapCompleted` / `CarIdxLapDistPct` for the canonical order, and the official
`CarIdxPosition` / `PlayerCarPosition` as the cross-check. It is the evidence for both halves of the
bug: the two lanes are UNEVEN — line 0 holds 11 cars (rows 1..11), line 1 holds 9 (rows 0..8) — so
the old `2R − 1` formula gave the player (line 0, row 11) position 21 where the combined order counts
20; and car #7 (index 7) is two laps down and lined up one row ahead of the player, so the lineup
says 20 while the race order, and the display, say 19 — which is why the position call speaks the
race position. Read by `caution-lineup.test.ts` (the lineup), its own `caution-lineup-20260919.test.ts`
(the shape and the race order) and `audio-scenarios`' `caution.test.ts` (what the bundled voice speaks
for it). The balanced 2026-09-17 fixture cannot tell the two formulas apart; this one can.

The captures themselves live in the gitignored `local/`, so these files are the committed evidence.
Regenerate one with the script in the #1127 plan only if the capture is available (the road cut uses
the same script with the road capture as its source and `sessionTime >= 60` as its window); otherwise
treat it as source. Prettier reformats these files on commit, so a regeneration will differ from the
committed copy in formatting (compact single-line vs. multi-line) even when the data is byte-identical
— that is expected and not a data change.
