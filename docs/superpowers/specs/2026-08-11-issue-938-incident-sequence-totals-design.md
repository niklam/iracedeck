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

## Capture findings (2026-08-11, validated — supersedes the flag-duration model)

Capture: `local/telemetry-watch-20260811-125031-041.jsonl` (offline AI session, deliberate incidents). Decoded:

| SessionTime | `PlayerIncidents` | Count | Meaning |
|---|---|---|---|
| 188.9 | `RepOffTrack \| Pen1x` | 0 → 1 | A: lone off-track (1x) |
| 204.4 | `RepOffTrack \| Pen2x` | 1 → 2 (+1) | B opens: off-track |
| 208.5 | `RepCollisionWithCar`, pen absent | 2 → 5 (**+3**) | B upgrades: heavy car contact — marginal 4−1, sequence total 4 |
| 238.75 | `RepOffTrack`, pen absent | 5 → 6 (+1) | C opens: off-track |
| 239.78 | `RepOutOfControl`, pen absent | 6 → 7 (+1) | C upgrades: spin — total 2. **Count moved ~2 frames BEFORE the byte** |

1. **The flag-duration model is disproved.** Every report byte was visible for exactly one frame (~16 ms), even mid-sequence. The in-code observation was correct; flags cannot bound sequences.
2. **`Ongoing` report values never appeared**, including across repeated off-track excursions. `classifyIncident` keeps suppressing them.
3. **The penalty byte is unreliable**: present with inconsistent values on two of five reports, absent on three. Never use it for announcements.
4. **Ordering is not guaranteed**: the count increment can precede its report byte (C's upgrade). Today's code silently DROPS an increment it cannot type — C's spin was never counted or spoken (a second, previously unreported bug this fix removes).
5. **The count arithmetic is exact**: every count move equals *(new worst outcome − sequence value so far)*, confirming the upgrade model (Sporting Code §3.5.2: "In the event of multiple concurrent incidents (ie: 2x that causes a 4x), only the most serious is counted (ie: 4x).").

### Authoritative incident values (Sporting Code §3.5.1)

| Incident type | `IncidentType` | Pavement | Dirt |
|---|---|---|---|
| Light contact with another driver | `contact-car` | 0x | 0x |
| Wheels off the racing surface | `off-track` | 1x | 1x |
| Loss of control | `out-of-control` | 2x | 2x |
| Contact with other object | `collision-world` | 2x | 2x |
| Heavy contact with another driver | `collision-car` | **4x** | **2x** |

`contact-world` (light object touch) is not in the table — value 0. The ONLY discipline difference is `collision-car`, resolved at runtime from the session's track category (`WeekendInfo` category contains "Dirt" → 2, else 4; unknown → pavement 4). These values are used ONLY to classify new-vs-upgrade — the spoken number is always the count arithmetic, never a type constant (#922).

## Phase 2 — detection model (final)

### Sequence machine (in `diff/incidents.ts`)

Let **P** = the open sequence's running total (`count − baseline`), **D** = an increment's delta, **V(T)** = the classified type's value from the table above.

- **Open sequence:** a sequence stays open for `INCIDENT_SEQUENCE_OPEN_MS` (**6000 ms**) after its last increment (Niklas: the sim merges only quick follow-ups; observed real upgrade gap 4.1 s).
- **Classification of an increment while a sequence is open:**
  - `P + D == V(T)` → **upgrade**: same sequence, total becomes `P + D`.
  - `D == V(T)` → **new**: flush the old sequence's pending announcement immediately (its total, its type), then open fresh with baseline = `count − D`.
  - neither, or `T` unresolved → **continue conservatively**: same sequence, total `P + D` (the total is the points the driver actually gained; bounded by the 6 s window).
- **Arithmetic reopen:** when no sequence is open but the previous one closed within `INCIDENT_SEQUENCE_REOPEN_MAX_MS` (**30 000 ms**) and `P_prev + D == V(T)` with `D < V(T)` — the sim itself has declared an upgrade (a marginal smaller than the type's own value is impossible otherwise) — reopen: total `P_prev + D`, emitted-total `P_prev`, so the flush announces the corrected total. This is what keeps a slow gather-then-crash correct despite the tight open window.
- **Value cap:** a sequence whose total has reached the discipline's maximum value cannot upgrade — any further increment (typed or not) starts a new sequence.
- **Late type adoption:** a classified byte arriving within `INCIDENT_LATE_TYPE_MS` (**200 ms**) after an untyped or lesser-typed increment (the C ordering) is adopted into the pending sequence/burst: the classification re-runs with the now-known type — an "upgrade" verdict keeps the accumulated total, a "new" verdict splits (flush old, re-baseline). The pending burst cannot have flushed yet (quiet window 1500 ms > 200 ms).
- **Announcement cadence unchanged:** increments coalesce under `INCIDENT_BURST_QUIET_MS` (1500 ms) / `INCIDENT_BURST_MAX_MS` (3000 ms). Each flush emits `{ delta: total − emittedTotal, total, type: latest }` and advances the emitted total. A later flush in the same sequence announces the corrected, higher total; `family: "incident"` preemption trumps an in-flight callout.
- **Untyped sequences stay silent** at flush (no resolvable type ever) — but do NOT advance the emitted total, so a type arriving with a later increment in the same sequence announces the full total.
- **Pit / off-world suppression:** entering pit lane / pit stall / leaving the world clears all sequence state including the reopen memory (existing behavior extended).
- **Replay wipe:** all sequence state re-seeds (NOT preserved across `wipeStateForReplay`), same policy as today's burst fields.

### State (in `state.ts`, both `TranslatorState` and `createInitialState`)

The burst cluster (`incidentBurstType`/`incidentBurstDelta`) is replaced by the sequence cluster; burst timing fields remain for cadence:

- `incidentSeqBaseline: number` — count at sequence open; `-1` = no open sequence.
- `incidentSeqEmittedTotal: number` — total already announced for this sequence.
- `incidentSeqLatestType: IncidentType | null` — latest classified type.
- `incidentSeqLastIncrementAt: number` — for the open window; `0` = none.
- `incidentSeqLastIncrementDelta: number` — for late-type re-classification.
- `incidentSeqClosedTotal: number` / `incidentSeqClosedAt: number` — reopen memory (`0` = none).
- `incidentCollisionCarValue: number` + a session cache key — the discipline-resolved `collision-car` value (the `trackLengthKey` pattern).
- `incidentBurstFirstAt` / `incidentBurstLatestAt` — kept (announcement pacing only).

### Event payload

`incident.occurred` becomes `{ delta: number; total: number; type: IncidentType }`:

- `total` — the sequence's running total against the pre-sequence baseline. **This is what the engineer speaks.**
- `delta` — points added since the sequence's previous emission (the current field's per-flush semantics, kept for consumers that want the marginal change).

Consumers updated:

- `packages/event-bus/src/event-catalog.ts` — payload shape + docs.
- `packages/audio-scenarios/src/catalog/pit-crew/incidents.ts` — the `where:` stash carries `total` instead of `delta` (same #922 stash discipline: write after the type check only); header comment rewritten to describe sequence totals. `points-1…4` clips cover every reachable total; an out-of-range or missing total degrades to no count per #835.
- `packages/scenario-harness/src/event-names.ts` — payload template gains `total`.

### Contingencies — RESOLVED by the capture + Sporting Code

- Penalty byte: unreliable (inconsistent/absent) — not used.
- `Ongoing` values: never emitted — remain suppressed in `classifyIncident`.
- Flag-duration model: disproved — replaced by the arithmetic-classified sequence model above (approved by Niklas: tight open window per the support article's "followed very quickly" + the Sporting Code value tables).
- Final type: latest classified wins (the capture showed escalation runs light → heavy).

## Testing

- `watch-core.test.ts` — arg parsing, change detection, record building, summary.
- New diff-level tests in `packages/sim-events-iracing/src/diff/incidents.test.ts` (or a sibling file) driving `diffIncidents` with explicit `now` values (the `diff/pit-lane.test.ts` pattern), covering at minimum:
  - the capture's sequence B replayed: off-track +1 (flush → total 1), collision-car +3 at +4.1 s (flush → **total 4**, `collision-car`) — the reported bug;
  - the capture's sequence C replayed: off-track +1, then +1 with the byte arriving 2 frames AFTER the count (flush → total 2, `out-of-control`) — the late-type/dropped-increment bug;
  - `D == V(T)` starts a new sequence even inside the open window (two off-tracks 5 s apart → two total-1 announcements);
  - arithmetic reopen: off-track, >6 s quiet, collision-car +3 → corrected total 4;
  - reopen window expiry: same but past 30 s → new sequence, total 3 (accepted degradation);
  - dirt discipline: `collision-car` D=2 with a Dirt category resolves as a NEW 2x sequence, not an upgrade;
  - value cap: a sequence at the discipline max never upgrades;
  - conservative continuation for an unknown-arithmetic increment inside the window;
  - untyped-only sequence stays silent; a later typed increment announces the full total;
  - pit-lane suppression clears all sequence state including reopen memory;
  - existing `classifyIncident` cases unchanged.
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
