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

`contact-world` (light object touch) is not in the table — value 0. The ONLY discipline difference is `collision-car`, resolved at runtime from the session's track type (`WeekendInfo.TrackType` contains "dirt" → 2, else 4; unknown → pavement 4). In the shipped model these values ARE the spoken number (`points = V(type, discipline)`, see Phase 2 below) — resolved live at emission time, never baked into clip wording (#922) and never reconstructed from count deltas.

## Phase 2 — detection model (final, simplified — Niklas's type-value model)

**Key insight (Niklas):** in iRacing's model an incident sequence's total IS the value of its worst outcome. With the discipline resolved (pavement/dirt) and the type classified, the spoken number is simply `V(type, discipline)` from the authoritative table — no baselines, no sequence windows, no count arithmetic. The count delta remains the *trigger* (a 0x byte with no count movement stays silent, as today) but never the *spoken number*.

### Changes in `diff/incidents.ts` (the existing burst machinery stays)

- **New helpers:** `resolveCollisionCarValue(sessionInfo)` (via `isDirtTrack`; pavement 4 / dirt 2, unknown → pavement) and `incidentTypeValue(type, collisionCarValue)` (the §3.5.1 table). The value resolves per tick in the translator and is passed as a `diffIncidents` parameter.
- **Untyped increments extend the burst** (capture fix 1): a count delta with no resolvable type still accumulates into `incidentBurstDelta` and updates the pacing — today it is silently dropped, which lost capture C's spin entirely.
- **Late-byte retype** (capture fix 2): a classified byte arriving within `INCIDENT_LATE_TYPE_MS` (**200 ms**) of the burst's last increment (with no count delta of its own) retypes the pending burst (worst-severity wins, ties → latest — a lesser byte never downgrades an already-typed burst, #938 review) and consumes the latch — the capture showed the byte trailing its increment by ~2 frames.
- **Flush emits `{ delta, points, type }`**: `delta` = the burst's raw accumulated count delta (today's semantics, informational), `points` = `incidentTypeValue(burstType, collisionCarValue)` — **the spoken value**, `type` = the worst-severity classified type (ties → latest). An untyped burst stays silent (unchanged).
- **Escalation across bursts needs no linkage**: each burst independently announces its own type's value — a wall hit 4 s after the off-track announces 2x (or a car collision 4x) no matter how many announcement windows the crash spanned. The correction trumps an in-flight earlier call via `family: "incident"` preemption (audio, unchanged).
- **Cadence unchanged** (`INCIDENT_BURST_QUIET_MS` 1500 / `INCIDENT_BURST_MAX_MS` 3000): intermediate calls with corrections (Niklas approved over a single delayed call).
- **No state changes**: the existing burst cluster is untouched (comment updates only). Pit/off-world clearing and the replay-wipe policy stay as they are.

### Accepted degradations (documented, not handled)

- A missed report byte (no type within 200 ms) leaves the burst with its earlier or no type — same class of behavior as today; at 100 Hz polling the byte is reliably observed.
- Content whose scoring deviates from the two Sporting Code tables (future disciplines) announces the table value; §3.5.7 reserves iRacing's right to add systems — revisit then.
- Contact types always announce `points: 0` (both tables list light contact as 0x, so the count clause skips). If content ever awards a point on a contact report byte, the intro plays with no number — accepted (#938 review); the pre-#938 delta model would have spoken the awarded count in that hypothetical.
- A lighter incident coalescing into the same announcement window AFTER a heavier one goes unannounced (worst-severity type wins, so the heavy incident keeps its type and value — #938 review); the reverse, light → heavy, is the normal escalation and announces the worst outcome.

### Event payload

`incident.occurred` becomes `{ delta: number; points: number; type: IncidentType }`:

- `points` — `V(type, discipline)`: the incident's value as iRacing scores it. **This is what the engineer speaks.** `0` (contact types) means the count clause skips.
- `delta` — the burst's raw accumulated count delta (unchanged semantics, informational).

Consumers updated:

- `packages/event-bus/src/event-catalog.ts` — payload shape + docs.
- `packages/audio-scenarios/src/catalog/pit-crew/incidents.ts` — the `where:` stash carries `points` instead of `delta` (same #922 stash discipline: write after the type check only); header comment rewritten. `points-1/2/4` clips cover every reachable value; zero/missing degrades to no count per #835.
- `packages/scenario-harness/src/event-names.ts` — payload template gains `points`.

### Contingencies — RESOLVED by the capture + Sporting Code

- Penalty byte: unreliable (inconsistent/absent) — not used.
- `Ongoing` values: never emitted — remain suppressed in `classifyIncident`.
- Flag-duration model: disproved — replaced by the arithmetic-classified sequence model above (approved by Niklas: tight open window per the support article's "followed very quickly" + the Sporting Code value tables).
- Final type: worst-severity classified wins, ties → latest (escalation runs light → heavy, so the worst is normally also the latest; the severity guard keeps a lighter coalesced follow-up from downgrading — #938 review).

## Testing

- `watch-core.test.ts` — arg parsing, change detection, record building, summary.
- New diff-level tests in `packages/sim-events-iracing/src/diff/incidents.test.ts` driving `diffIncidents` with explicit `now` values (the `diff/pit-lane.test.ts` pattern), covering at minimum:
  - the capture's sequence B replayed: off-track +1 (flush → points 1), collision-car +3 at +4.1 s (flush → **points 4**, `collision-car`) — the reported bug;
  - the capture's sequence C replayed: off-track +1, then an untyped +1 whose `out-of-control` byte arrives 2 frames later (single flush → points 2, `out-of-control`) — the dropped-increment/late-type bug;
  - a late byte beyond the 200 ms window does NOT retype the burst;
  - dirt vs pavement: the same collision-car burst announces points 2 with the dirt value and points 4 with the pavement value;
  - a contact type (value 0) announces `points: 0` (audio skips the count clause);
  - an untyped-only burst stays silent;
  - two off-tracks separated by more than the quiet window → two independent points-1 announcements;
  - pit-lane entry clears the pending burst (existing behavior, re-pinned);
  - `incidentTypeValue` / `resolveCollisionCarValue` unit cases;
  - existing `classifyIncident` cases unchanged.
- Audio-scenarios tests: the stash reads `points`; a zero/missing value skips the count clause.

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
