# Diff fixtures

`caution-restart-20260917.json` — 284 ticks cut from `local/telemetry-watch-20260917-191825-092.jsonl`
(issue #1127): an offline AI race at Homestead-Miami, a rolling double-file start, two full-course
cautions thrown with the Race Admin `!yellow` command, and two double-file restarts. Only the fields
`diff/caution.ts` reads are kept, deduplicated on those fields, car slots trimmed to the 20 cars at
their own indices (0–19) plus the pace car — index 64 in the raw telemetry — appended as slot 20.

The capture itself lives in the gitignored `local/`, so this file is the committed evidence. Regenerate
it with the script in the #1127 plan only if the capture is available; otherwise treat it as source.
Prettier reformats this file on commit, so a regeneration will differ from the committed copy in
formatting (compact single-line vs. multi-line) even when the data is byte-identical — that is expected
and not a data change.
