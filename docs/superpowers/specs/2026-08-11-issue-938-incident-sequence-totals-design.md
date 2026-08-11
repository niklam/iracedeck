# Issue #938 — Incident sequence totals: announce the running total, not the marginal delta

**Date:** 2026-08-11
**Issue:** [#938](https://github.com/niklam/iracedeck/issues/938)
**Branch:** `ir-938`

## Problem

iRacing scores a multi-stage incident (off-track → spin → wall) as ONE incident sequence that escalates to the worst outcome (1x → 2x, total 2x — not 1x + 2x). `PlayerCarMyIncidentCount` moves by the *marginal upgrade* at each step. The current burst coalescer in `packages/sim-events-iracing/src/diff/incidents.ts` has no notion of a sequence: when the escalation spans a burst-window boundary (quiet window 1500 ms / hard cap 3000 ms), the second burst's delta is only the marginal +1, and the Race Engineer announces "one penalty point" for a 2x incident.

Expected: every announcement speaks the sequence's **running total measured against the pre-incident baseline**, with intermediate calls trumped by later corrections (existing `family: "incident"` preemption).

## Approach: validate, then implement (two phases)

The fix's detection model binds incident sequences by the `PlayerIncidents` flags staying up — but the code header in `incidents.ts` records a conflicting observation ("byte set for ~one 16 ms frame; count changes with `playerIncidents == 0`"). Per the issue's *Validation before implementation* section, Phase 1 builds a committed full-rate capture tool and captures a deliberate multi-stage incident; Phase 2 implements the model the data supports.

## Phase 1 — `telemetry-watch` CLI

A new, focused CLI in `@iracedeck/iracing-sdk`, sibling to `telemetry-snapshot` (a separate command, not a flag on the snapshot CLI — the snapshot options don't compose with a continuous stream, and each command keeps one responsibility):

- `packages/iracing-sdk/src/cli/telemetry-watch.ts` — thin entry point.
- `packages/iracing-sdk/src/cli/watch-core.ts` — pure, unit-tested helpers: arg parsing, change detection, record building, summary formatting.
- `packages/iracing-sdk/src/cli/watch-core.test.ts` — tests for all pure helpers.
- Package script: `"telemetry-watch": "node dist/cli/telemetry-watch.js"`.

### Behavior

- `--vars=A,B,C` (required): telemetry variables to record. Unknown/missing names warn once on the first frame but keep watching (a var may appear later).
- Subscribes to **`SDKController`** (10 ms poll, `SessionTick`-deduped) — deliberately the exact cadence the plugin's translator sees, so captures validate what production code observes.
- `--mode=changes|all` (default `changes`): `changes` appends a record only when any requested var differs from the previous notified frame (strict equality for primitives; JSON comparison for arrays). Lossless for step-valued vars — durations are recoverable from `SessionTick`/`SessionTime`. `all` records every deduped frame.
- Output: JSONL to `--output=<file>`, or auto-timestamped file in `--output-dir=<dir>`, or stdout when neither is given. Status/summary always to stderr.
- Record shapes (one JSON object per line, `type` discriminated):
  - `{ "type": "meta", "startedAt": ISO, "vars": [...], "mode": "changes" }` — first line.
  - `{ "type": "tick", "ts": <wall-clock ms>, "sessionTick": n, "sessionTime": s, "values": { <var>: value, ... } }`
  - `{ "type": "connection", "ts": <ms>, "connected": boolean }` — on every connection edge.
- Runs until Ctrl+C: SIGINT unsubscribes, closes the file, prints a summary (record count, duration) to stderr, exits 0.
- No decoding/interpretation in the tool — it records raw values; analysis decodes afterwards. Generic and reusable for future sim-model validations.

### Capture protocol (Niklas drives)

Offline/AI test session, road course. Run:

```bash
pnpm --filter @iracedeck/iracing-sdk telemetry-watch --vars=PlayerIncidents,PlayerCarMyIncidentCount,PlayerTrackSurface,SessionFlags,IsOnTrack,OnPitRoad --output-dir=../../local
```

Drive, in order: (a) a lone off-track, then wait clean; (b) the reported sequence — off-track, gather the car for a couple of seconds, then a wall hit; (c) if possible, an escalation ending in AI-car contact; (d) one long sustained off-track. If possible, note when the on-screen incident indication appears/ends relative to each crash.

### Analysis questions (from the issue)

1. How long does the `PlayerIncidents` byte stay non-zero across a multi-stage sequence?
2. Do the `Ongoing` report values (`RepOffTrackOngoing` 0x03, `RepCollisionWithWorldOngoing` 0x06) appear?
3. What does the penalty byte (`PenZeroX`/`PenOneX`/`PenTwoX`/`PenFourX`) carry at each step — in particular, does it carry the sequence's *current value*?
4. Does the byte return to 0 only when the sim's on-screen incident indication ends?

## Phase 2 — detection model

Implemented as specified below **if the capture confirms flag-bounded sequences**; contingencies at the end.

### Sequence machine (in `diff/incidents.ts`)

- **Sequence opens** when `PlayerIncidents` goes non-zero. Snapshot `PlayerCarMyIncidentCount` at that moment as the pre-sequence baseline.
- **Fallback open:** a count increment with no observed flag-up opens a sequence with baseline = the pre-increment count (never miss an announcement because a flag edge was missed).
- **Cadence unchanged:** increments still coalesce under `INCIDENT_BURST_QUIET_MS` (1500 ms) and `INCIDENT_BURST_MAX_MS` (3000 ms).
- **Each flush emits the running total** `count − baseline` with the latest classified type (latest wins, as today — escalation runs light → heavy). A later escalation in the same sequence flushes again with the corrected, higher total; `family: "incident"` preemption trumps an in-flight callout, otherwise the correction plays next.
- **Baseline resets only when the flags go down** (sequence close) — never at a flush.

### Invariants and edge cases

- **Flush-before-reset:** the baseline a flush computes against is always the baseline of the sequence its increments belong to. A flags-down with a burst still pending defers the sequence reset until that burst flushes; a flags-down with nothing pending closes immediately.
- **Re-raise during a pending burst:** a new flag-up while the previous sequence's burst is still pending (flags dropped and re-raised inside the quiet window) flushes the old burst immediately (emitting the old sequence's total), then opens the fresh sequence — no cross-sequence contamination.
- **Fallback close:** a sequence opened via the fallback (no flag-up ever observed) closes when its burst flushes while the flags read down — degenerating to today's one-burst-one-sequence behavior if the flag model fails in practice.
- **Pit / off-track-world suppression:** entering pit lane / pit stall / leaving the world clears the sequence state along with the pending burst and type latch (existing behavior extended).
- **Unclassified increments** inside a sequence still count toward the total (it is `count − baseline`); if no increment in a sequence ever resolves a type, nothing is emitted (existing stay-silent rule).
- **Replay wipe:** sequence state re-seeds (NOT preserved across `wipeStateForReplay`), same policy as today's burst fields — by the time a driver is glancing at a replay, the incident flags are down.

### State (in `state.ts`, both `TranslatorState` and `createInitialState`)

New fields alongside the existing burst cluster (final names at implementation):

- `incidentSeqBaseline: number` — pre-sequence `PlayerCarMyIncidentCount`; `-1` = no open sequence.
- `incidentSeqFlagsWereUp: boolean` — whether this sequence was opened by an observed flag-up (drives the fallback close).
- `incidentSeqEmittedTotal: number` — total already emitted for this sequence; each flush emits `delta = total − emittedTotal` and advances it.

### Event payload

`incident.occurred` becomes `{ delta: number; total: number; type: IncidentType }`:

- `total` — the sequence's running total against the pre-sequence baseline. **This is what the engineer speaks.**
- `delta` — points added since the sequence's previous emission (the current field's per-flush semantics, kept for consumers that want the marginal change).

Consumers updated:

- `packages/event-bus/src/event-catalog.ts` — payload shape + docs.
- `packages/audio-scenarios/src/catalog/pit-crew/incidents.ts` — the `where:` stash carries `total` instead of `delta` (same #922 stash discipline: write after the type check only); header comment rewritten to describe sequence totals. `points-1…4` clips cover every reachable total; an out-of-range or missing total degrades to no count per #835.
- `packages/scenario-harness/src/event-names.ts` — payload template gains `total`.

### Contingencies (decided by the capture)

- **Penalty byte carries the sequence value** (e.g. `RepCollisionWithWorld | PenTwoX`): use it to corroborate the count arithmetic (log a mismatch at debug); replacing the arithmetic outright is only on the table if the capture shows the byte is *more* reliable than the count.
- **`Ongoing` values appear:** map `RepOffTrackOngoing` → `"off-track"` and `RepCollisionWithWorldOngoing` → `"collision-world"` in `classifyIncident` instead of suppressing.
- **Flag-duration model disproved** (byte genuinely transient): the flags cannot bound sequences; fall back to a time-window sequence boundary sized from the observed inter-report spacing. **This variant goes back to Niklas for approval before implementation.**
- **Final type latest-vs-worst:** keep latest (current behavior) unless the capture shows a sequence whose last report is *less* severe than an earlier one.

## Testing

- `watch-core.test.ts` — arg parsing, change detection, record building, summary.
- New diff-level tests in `packages/sim-events-iracing/src/diff/incidents.test.ts` (or a sibling file) driving `diffIncidents` with explicit `now` values (the `diff/pit-lane.test.ts` pattern), covering at minimum:
  - the reported escalation-across-flush case: off-track (flush, total 1) → wall inside the same flag-up (flush, **total 2**, type `collision-world`);
  - flag-up/flag-down sequence boundaries (second flag-up = fresh baseline);
  - fallback open on a count increment with no flag-up;
  - flags-down with a pending burst (flush-before-reset);
  - re-raise during a pending burst (old total flushed, fresh sequence);
  - pit-lane suppression clearing sequence state;
  - existing `classifyIncident` cases unchanged (plus `Ongoing` mapping if the contingency lands).
- Audio-scenarios tests: the stash reads `total`; zero/missing total skips the count clause.

## Affected artifacts (beyond code)

- **Changelog** (`packages/website/src/content/docs/changelog.mdx`): Bug Fixes line under the in-development version.
- **Website Race Engineer docs**: the incident-callout description states that an escalating incident announces the incident's full value as scored by iRacing, with later escalations correcting earlier calls.
- **Rules** (`.claude/rules/race-engineer-callout-examples.md`): correct the #922 entry's "delta is the episode total" claim, **remove the entry's accidental duplicate** (it appears twice), and add a #938 entry once the pattern is proven.
- **`incidents.ts` header comment**: rewritten to describe the validated flag/sequence model (replacing the conflicting observation).

## Sequencing

1. Spec committed (this document).
2. Implementation plan (writing-plans skill).
3. Build the watch tool: TDD, `pnpm build`, lint, tests.
4. **Stop — hand the capture command to Niklas.** He drives the capture session.
5. Analyze the capture; lock the detection model (checkpoint with Niklas if it deviates from this spec).
6. Implement Phase 2: TDD, full build/lint/test, changelog + website + rules updates.
7. Niklas manually tests in iRacing.
8. With Niklas's go-ahead: `code-review xhigh --fix`, then PR (squash-merge target `master`, title `fix(audio): announce incident sequence totals, not marginal deltas (#938)`).

## Success criteria

- The reported scenario (off-track, ~2 s, wall hit) announces **two** penalty points on the wall-hit callout.
- A single-burst incident announces exactly what it does today (no regression).
- An escalation to car contact announces 4 with the collision-car line trumping the earlier call.
- All tests pass; `pnpm build` clean; changelog, website docs, and rules updated in the same PR.
