# Diff fixtures

`caution-restart-20260917.json` — 266 ticks cut from `local/telemetry-watch-20260917-191825-092.jsonl`
(issue #1127): an offline AI race at Homestead-Miami, a rolling double-file start, two full-course
cautions thrown with the Race Admin `!yellow` command, and two double-file restarts. Only the fields
`diff/caution.ts` reads are kept, deduplicated on those fields, car slots trimmed to 21 (20 cars plus
the pace car at index 64 → index 20 is the pace car in this fixture's arrays).

The capture itself lives in the gitignored `local/`, so this file is the committed evidence. Regenerate
it with the script in the #1127 plan only if the capture is available; otherwise treat it as source.
