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

The captures themselves live in the gitignored `local/`, so these files are the committed evidence.
Regenerate one with the script in the #1127 plan only if the capture is available (the road cut uses
the same script with the road capture as its source and `sessionTime >= 60` as its window); otherwise
treat it as source. Prettier reformats these files on commit, so a regeneration will differ from the
committed copy in formatting (compact single-line vs. multi-line) even when the data is byte-identical
— that is expected and not a data change.
