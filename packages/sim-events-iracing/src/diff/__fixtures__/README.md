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
silent), and the pace car's `AproachingPits` means two opposite things there: that start was a
standing start, so the pace car never ran on the road — it waited **parked**, which iRacing reports as
`OnTrack` (its surface reads `OnTrack` from the first record and its `CarIdxLapCompleted` stays −1
throughout), and its three seconds of `AproachingPits` mid-caution (152.23 → 155.37 s, 562.07 →
565.22 s) is it rolling **out** through pit exit onto the circuit — the deployment, not a departure
that returns — while the real exit comes after one to green (461.22 s, 5.7 s before the green). Two things this fixture does **not** carry: the
capture has no session YAML, so the tests that replay it supply `PaceCarIdx: 64` synthetically, as the
oval fixture's tests do; and it recorded no `LapDistPct` (player or per-car), so it **cannot** exercise
the one-to-green lap's checkpoint (`caution.lastLapCheckpoint`) — that rule is covered by the
synthetic ticks in `caution.test.ts` and by the harness's "Caution → restart" button, not by this
capture. It also has no `paceCar.deployed` on either throw's own tick: a waiting pace car already reads
`OnTrack` (see above), so the only deployed edges are the two deployments themselves — the return to
`OnTrack` at 155.37 s and 565.22 s as it completes its roll out through pit exit — plus a third at
494.18 s, under green, when it parks again after the real exit.

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

`tire-wear-stops-20260919.json` — 33 ticks, the whole of `local/telemetry-watch-20260919-193233-855.jsonl` (issue #1108): a session with two pit stops the driver drove into, the first with four tires (and fast repair) queued, the second with nothing queued. Only the fields the pit-lane, readback and tire-wear diffs read are kept — `IsOnTrack`, `OnPitRoad`, `PlayerCarInPitStall`, `PlayerTrackSurface`, `PitSvFlags` and the twelve `<corner>wear<L|M|R>` readings — deduplicated on those fields. It is the evidence for three facts the diff rests on: the readings refresh exactly once per stop, on the tick the car arrives in its box (447.25 s and 597.75 s, between the surface turning `InPitStall` and `PlayerCarInPitStall` going true), and then hold unchanged through service, departure and the whole next stint; after stop 1's four-tire change they still show the set that came **off** through departure (469.13 s) and pit exit (475.55 s), so reading them at departure gives the stint just driven; and both fronts wear lowest on the inside — the sim's R on the left front and its L on the right front — which is what fixes the mirrored L/M/R → outside/middle/inside mapping. The capture records a tick only on a change and ends right at stop 2's pit exit, so the tests that replay it hold each record until the next one and past the end; the session starts on the circuit (`IsOnTrack` with surface −1, then `OnTrack`), so it has no garage start in the stall — that case is covered by the synthetic ticks in `tire-wear.test.ts`. Read by `tire-wear.test.ts`, `translator.test.ts` and its own `tire-wear-stops-20260919.test.ts`. Cut with a one-off node script over the capture: every `tick` record, `t` = `sessionTime` rounded to 0.01 s, deduplicated on the kept fields.

`replay-laps-crossings-20260917.json` — 60 ticks cut from `local/telemetry-watch-20260917-191825-092.jsonl` (issue #1203), the same offline AI race at Homestead as the caution fixture, from the first record (107.38 s, every counter −1) to the pace car's own first crossing (333.38 s): only `CarIdxLapCompleted` is kept, deduplicated on it, with the same slot trimming (cars 0–19 at their indices, the pace car — raw index 64 — as slot 20). It is the shape the replay lap record diffs over: the first S/F crossing of all 20 cars as −1 → 0 (203.70 → 206.55 s, car 17 first, car 13 last), then two full crossings of the field (0 → 1 from 239.5 s, 1 → 2 from 278.5 s) — three crossings per car and no tow, reset or drop anywhere in the window — with the pace car parked at −1 through both and crossing once at the very end, which the diff must skip. Two things it does **not** carry, because no capture does: `CarIdxLastLapTime` (so the lap-time wait is covered by the synthetic ticks in `replay-laps.test.ts` only) and `ReplayFrameNumEnd` (the tests that replay it derive a frame from `t`, since the live frame counter advances 60 per second, and assert the events' order and lap numbers rather than the frame values). Read by `translator.test.ts` and its own `replay-laps-crossings-20260917.test.ts`. Cut with a one-off Python script over the capture: every `tick` record up to 334 s, `t` = `sessionTime` rounded to 0.01 s, deduplicated on the kept field.

The captures themselves live in the gitignored `local/`, so these files are the committed evidence.
Regenerate one with the script in the #1127 plan only if the capture is available (the road cut uses
the same script with the road capture as its source and `sessionTime >= 60` as its window); otherwise
treat it as source. Prettier reformats these files on commit, so a regeneration will differ from the
committed copy in formatting (compact single-line vs. multi-line) even when the data is byte-identical
— that is expected and not a data change.
