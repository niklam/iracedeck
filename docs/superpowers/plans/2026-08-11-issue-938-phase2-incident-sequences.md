# Issue #938 Phase 2 — Incident type-value announcements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Race Engineer announces an incident's value as iRacing scores it — `V(type, discipline)` from the Sporting Code §3.5.1 tables — instead of the burst's marginal count delta, so an escalating crash announces its full value no matter how many announcement windows it spans.

**Architecture:** Niklas's type-value model: in iRacing's model a sequence's total IS its worst outcome's value, so the spoken number is the table value of the burst's latest classified type, discipline-resolved (pavement/dirt) per tick. The existing burst machinery stays; two capture-driven fixes land with it (untyped increments extend the burst; a late report byte retypes it). `incident.occurred` gains `points` (spoken); `delta` keeps its raw-count semantics.

**Tech Stack:** TypeScript ESM, Vitest (diff-level tests call `diffIncidents` directly with explicit `now` — the `pit-lane.test.ts` pattern).

**Spec:** `docs/superpowers/specs/2026-08-11-issue-938-incident-sequence-totals-design.md` ("Capture findings" + "Phase 2 — detection model (final, simplified)").

## Global Constraints

- Worktree `C:/Users/Niklas/Projects/iRaceDeck/ir-938`, branch `ir-938`. Shell cwd resets between commands — absolute paths / `git -C` / `pnpm --dir` always.
- The spoken number comes from the discipline-resolved Sporting Code table via the classified type — never from count deltas, never from road-only constants baked in clips (#922).
- Tests required for all new code; run from the worktree root: `pnpm --dir <wt> exec vitest run <path>`.
- `pnpm lint:fix` + `pnpm format:fix` + full `pnpm build` (pipefail, check exit code) before each commit.
- Commits: A (track-type helper), B (model + payload + audio + tests), C (docs). Each commit leaves the workspace green.
- STOP after Task 6 — Niklas manually tests in iRacing before any push/PR.

---

### Task 1: `isDirtTrack` in `track-type.ts` (TDD) — Commit A

**Files:**
- Modify: `packages/sim-events-iracing/src/track-type.ts`
- Test: `packages/sim-events-iracing/src/track-type.test.ts` (create if absent; extend if present)

**Interfaces:**
- Produces: `isDirtTrack(sessionInfo: Record<string, unknown> | null): boolean` — true when `WeekendInfo.TrackType` contains "dirt" (case-insensitive); false for null/missing/non-string.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("isDirtTrack", () => {
  it.each([
    ["dirt oval", true],
    ["Dirt Road", true],
    ["road course", false],
    ["short oval", false],
  ])("classifies TrackType %s as dirt=%s", (trackType, expected) => {
    expect(isDirtTrack({ WeekendInfo: { TrackType: trackType } })).toBe(expected);
  });

  it("treats null / missing session info as pavement", () => {
    expect(isDirtTrack(null)).toBe(false);
    expect(isDirtTrack({})).toBe(false);
    expect(isDirtTrack({ WeekendInfo: { TrackType: 7 } })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --dir "C:/Users/Niklas/Projects/iRaceDeck/ir-938" exec vitest run packages/sim-events-iracing/src/track-type.test.ts`

- [ ] **Step 3: Implement** (in `track-type.ts`, after `resolveTrackType`):

```typescript
/**
 * Whether the session runs on a dirt surface (`WeekendInfo.TrackType`
 * contains "dirt"). Drives the discipline-dependent `collision-car`
 * incident value (Sporting Code §3.5.1: heavy car contact scores 2x on
 * dirt, 4x on pavement — issue #938). Null/missing/unrecognized session
 * info reads as pavement.
 */
export function isDirtTrack(sessionInfo: Record<string, unknown> | null): boolean {
  if (!sessionInfo) return false;

  const weekendInfo = sessionInfo.WeekendInfo as Record<string, unknown> | undefined;
  const raw = weekendInfo?.TrackType;

  return typeof raw === "string" && raw.toLowerCase().includes("dirt");
}
```

- [ ] **Step 4: Run to verify pass**, then commit:

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-938" add packages/sim-events-iracing/src/track-type.ts packages/sim-events-iracing/src/track-type.test.ts
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-938" commit -m "feat(sim-events): add isDirtTrack discipline resolver (#938)"
```

---

### Task 2: Type-value announcements in `diff/incidents.ts` + payload (TDD)

**Files:**
- Modify: `packages/sim-events-iracing/src/diff/incidents.ts`
- Modify: `packages/sim-events-iracing/src/state.ts` (comment updates only — no field changes)
- Modify: `packages/sim-events-iracing/src/translator.ts:1662` (pass the collision-car value)
- Modify: `packages/event-bus/src/event-catalog.ts` (payload + docs)
- Modify: `packages/scenario-harness/src/event-names.ts` (payload template)
- Test: `packages/sim-events-iracing/src/diff/incidents.test.ts`

**Interfaces:**
- Produces:
  - `incident.occurred` payload `{ delta: number; points: number; type: IncidentType }`.
  - Exported `@internal` from `incidents.ts`: `INCIDENT_LATE_TYPE_MS = 200`, `COLLISION_CAR_VALUE_PAVEMENT = 4`, `COLLISION_CAR_VALUE_DIRT = 2`, `resolveCollisionCarValue(sessionInfo): number`, `incidentTypeValue(type: IncidentType, collisionCarValue: number): number`.
  - `diffIncidents(state, telemetry, now, emit, collisionCarValue = COLLISION_CAR_VALUE_PAVEMENT)`.

- [ ] **Step 1: Write the failing diff-level tests** — append to `incidents.test.ts` (imports merge with the existing ones):

```typescript
import { IncidentFlags, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import { createInitialState } from "../state.js";
import type { PendingEvent } from "./types.js";
import {
  classifyIncident,
  COLLISION_CAR_VALUE_DIRT,
  COLLISION_CAR_VALUE_PAVEMENT,
  diffIncidents,
  INCIDENT_BURST_QUIET_MS,
  INCIDENT_LATE_TYPE_MS,
  incidentTypeValue,
  resolveCollisionCarValue,
} from "./incidents.js";

function tick(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    IsOnTrack: true,
    OnPitRoad: false,
    PlayerTrackSurface: TrkLoc.OnTrack,
    PlayerTrackSurfaceMaterial: 0,
    PlayerCarMyIncidentCount: 0,
    PlayerIncidents: 0,
    ...overrides,
  } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

function occurred(events: PendingEvent[]): Array<{ delta: number; points: number; type: string }> {
  return events.filter((e) => e.event === "incident.occurred").map((e) => e.data as never);
}

describe("incidentTypeValue / resolveCollisionCarValue", () => {
  it("maps the Sporting Code §3.5.1 values", () => {
    expect(incidentTypeValue("off-track", COLLISION_CAR_VALUE_PAVEMENT)).toBe(1);
    expect(incidentTypeValue("out-of-control", COLLISION_CAR_VALUE_PAVEMENT)).toBe(2);
    expect(incidentTypeValue("contact-world", COLLISION_CAR_VALUE_PAVEMENT)).toBe(0);
    expect(incidentTypeValue("collision-world", COLLISION_CAR_VALUE_PAVEMENT)).toBe(2);
    expect(incidentTypeValue("contact-car", COLLISION_CAR_VALUE_PAVEMENT)).toBe(0);
    expect(incidentTypeValue("collision-car", COLLISION_CAR_VALUE_PAVEMENT)).toBe(4);
    expect(incidentTypeValue("collision-car", COLLISION_CAR_VALUE_DIRT)).toBe(2);
  });

  it("resolves collision-car by discipline, defaulting to pavement", () => {
    expect(resolveCollisionCarValue({ WeekendInfo: { TrackType: "dirt oval" } })).toBe(2);
    expect(resolveCollisionCarValue({ WeekendInfo: { TrackType: "road course" } })).toBe(4);
    expect(resolveCollisionCarValue(null)).toBe(4);
  });
});

describe("diffIncidents — type-value announcements (issue #938)", () => {
  function seed(state: ReturnType<typeof createInitialState>, emit: (e: PendingEvent) => void): void {
    diffIncidents(state, tick(), 1_000, emit);
  }

  it("replays capture sequence B: a slow escalation announces the collision's full value", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    // Off-track: byte one frame, count lags ~2 frames.
    diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepOffTrack | IncidentFlags.PenOneX }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033 + INCIDENT_BURST_QUIET_MS, emit);
    expect(occurred(events)).toEqual([{ delta: 1, points: 1, type: "off-track" }]);

    // Collision with a car 4.1 s later — a new burst, but the spoken value is
    // the TYPE's value (4x), never the marginal +3 the count moved by.
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepCollisionWithCar }), 6_100, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 4 }), 6_133, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 4 }), 6_133 + INCIDENT_BURST_QUIET_MS, emit);

    expect(occurred(events)).toEqual([
      { delta: 1, points: 1, type: "off-track" },
      { delta: 3, points: 4, type: "collision-car" },
    ]);
  });

  it("replays capture sequence C: an untyped increment is kept and a late byte retypes the burst", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepOffTrack }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033, emit);
    // Second increment lands with NO byte; its report byte follows 2 frames later.
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 2 }), 3_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 2, PlayerIncidents: IncidentFlags.RepOutOfControl }), 3_033, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 2 }), 3_033 + INCIDENT_BURST_QUIET_MS, emit);

    expect(occurred(events)).toEqual([{ delta: 2, points: 2, type: "out-of-control" }]);
  });

  it("does not retype the burst from a byte beyond the late-type window", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepOffTrack }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033, emit);
    // An unrelated classified byte 500 ms later (no count movement) must not
    // repaint the pending off-track burst.
    diffIncidents(
      state,
      tick({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepContactWithCar }),
      2_033 + INCIDENT_LATE_TYPE_MS + 300,
      emit,
    );
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 4_500, emit);

    expect(occurred(events)).toEqual([{ delta: 1, points: 1, type: "off-track" }]);
  });

  it("announces the discipline-resolved collision-car value", () => {
    const run = (collisionCarValue: number): Array<{ delta: number; points: number; type: string }> => {
      const state = createInitialState();
      const { events, emit } = collect();
      diffIncidents(state, tick(), 1_000, emit, collisionCarValue);
      diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepCollisionWithCar }), 2_000, emit, collisionCarValue);
      diffIncidents(state, tick({ PlayerCarMyIncidentCount: 2 }), 2_033, emit, collisionCarValue);
      diffIncidents(state, tick({ PlayerCarMyIncidentCount: 2 }), 2_033 + INCIDENT_BURST_QUIET_MS, emit, collisionCarValue);

      return occurred(events);
    };

    expect(run(COLLISION_CAR_VALUE_DIRT)).toEqual([{ delta: 2, points: 2, type: "collision-car" }]);
    expect(run(COLLISION_CAR_VALUE_PAVEMENT)).toEqual([{ delta: 2, points: 4, type: "collision-car" }]);
  });

  it("announces points 0 for a contact type so audio skips the count clause", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepContactWithCar }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033 + INCIDENT_BURST_QUIET_MS, emit);

    expect(occurred(events)).toEqual([{ delta: 1, points: 0, type: "contact-car" }]);
  });

  it("keeps an untyped-only burst silent", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_000 + INCIDENT_BURST_QUIET_MS, emit);

    expect(occurred(events)).toEqual([]);
  });

  it("announces two separated off-tracks independently", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepOffTrack }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033 + INCIDENT_BURST_QUIET_MS, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepOffTrack }), 7_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 2 }), 7_033, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 2 }), 7_033 + INCIDENT_BURST_QUIET_MS, emit);

    expect(occurred(events)).toEqual([
      { delta: 1, points: 1, type: "off-track" },
      { delta: 1, points: 1, type: "off-track" },
    ]);
  });

  it("clears the pending burst on pit-lane entry", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepOffTrack }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1, OnPitRoad: true }), 2_100, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 6_000, emit);

    expect(occurred(events)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify the new describes fail** (`incidentTypeValue` etc. unresolved).

- [ ] **Step 3: Implement in `incidents.ts`.**

Header comment: replace the burst/latch story's disproven parts with the validated model — the report byte is transient (~1 frame) and can trail its count increment by ~2 frames (capture `local/telemetry-watch-20260811-125031-041.jsonl`); the `Ongoing` values were confirmed never emitted; the penalty byte is unreliable (inconsistent/absent) and must not be used; the spoken number is the discipline-resolved Sporting Code §3.5.1 type value (a sequence escalates to its worst outcome per §3.5.2, so the worst type's value IS the sequence's total — issue #938); the count delta stays the trigger; cadence unchanged.

New constants + helpers (after `classifyIncident`; `isDirtTrack` imported from `../track-type.js`):

```typescript
/**
 * A classified report byte arriving this soon after a count increment (with
 * no increment of its own) retypes the pending burst. The capture for #938
 * showed the byte trailing its count increment by ~2 frames (~33 ms); without
 * adoption the increment would announce with a stale type or not at all.
 *
 * @internal Exported for testing.
 */
export const INCIDENT_LATE_TYPE_MS = 200;

/**
 * Sporting Code §3.5.1 heavy-car-contact values per discipline (#938). The
 * only value that differs between the pavement and dirt tables.
 *
 * @internal Exported for testing.
 */
export const COLLISION_CAR_VALUE_PAVEMENT = 4;
/** @internal Exported for testing. */
export const COLLISION_CAR_VALUE_DIRT = 2;

/**
 * Resolve the discipline-dependent `collision-car` value from session info.
 * Unknown/missing session info reads as pavement.
 *
 * @internal Exported for testing.
 */
export function resolveCollisionCarValue(sessionInfo: Record<string, unknown> | null): number {
  return isDirtTrack(sessionInfo) ? COLLISION_CAR_VALUE_DIRT : COLLISION_CAR_VALUE_PAVEMENT;
}

/**
 * The incident points a type carries (Sporting Code §3.5.1). An iRacing
 * incident SEQUENCE escalates to its worst outcome (§3.5.2), so the latest
 * classified type's value IS the sequence's scored total — this is the
 * number the Race Engineer speaks (#938). Never derived from count deltas.
 *
 * @internal Exported for testing.
 */
export function incidentTypeValue(type: IncidentType, collisionCarValue: number): number {
  switch (type) {
    case "off-track":
      return 1;
    case "out-of-control":
      return 2;
    case "contact-world":
      return 0;
    case "collision-world":
      return 2;
    case "contact-car":
      return 0;
    case "collision-car":
      return collisionCarValue;
  }
}
```

`flushIncidentBurst` gains the value parameter and emits the new payload (the guard drops `delta > 0`'s companion `type !== null` requirement? NO — keep both guards; an untyped burst stays silent):

```typescript
function flushIncidentBurst(state: TranslatorState, emit: EmitFn, collisionCarValue: number): void {
  if (state.incidentBurstType !== null && state.incidentBurstDelta > 0) {
    emit({
      event: "incident.occurred",
      data: {
        delta: state.incidentBurstDelta,
        points: incidentTypeValue(state.incidentBurstType, collisionCarValue),
        type: state.incidentBurstType,
      },
    });
  }

  clearIncidentBurst(state);
}
```

`diffIncidents` signature: `(state, telemetry, now, emit, collisionCarValue: number = COLLISION_CAR_VALUE_PAVEMENT)`. Two behavioral changes in the delta block, one new else-branch:

1. **Untyped increments extend the burst** — replace the `if (resolvedType !== null) { …start/extend… }` gate so the burst starts/extends for EVERY positive delta; only the type assignment stays conditional:

```typescript
    if (state.incidentBurstFirstAt === 0) {
      state.incidentBurstFirstAt = now;
    }

    if (resolvedType !== null) {
      // Most-recent type wins — escalation runs light → heavy.
      state.incidentBurstType = resolvedType;
    }

    state.incidentBurstDelta += delta;
    state.incidentBurstLatestAt = now;
```

(The old comment about only starting typed bursts — and `flushIncidentBurst`'s "should be impossible" note — must be updated: an untyped burst is now normal and flushes silently.)

2. **Late-byte retype** — new `else if` branch after the `if (delta > 0)` block:

```typescript
  } else if (
    currentType !== null &&
    state.incidentBurstFirstAt > 0 &&
    now - state.incidentBurstLatestAt <= INCIDENT_LATE_TYPE_MS
  ) {
    // The report byte can land 1–2 frames AFTER its count increment
    // (capture sequence C, #938). Adopt it into the pending burst and
    // consume the latch — it belongs to the increment we just recorded,
    // not to some future count change.
    state.incidentBurstType = currentType;
    state.pendingIncidentType = null;
    state.pendingIncidentTypeAt = 0;
  }
```

3. Both flush call sites pass `collisionCarValue`.

- [ ] **Step 4: Update the catalog** — `event-catalog.ts`:

```typescript
  /**
   * Player incident announcement (issue #530; value model #938). `points` is
   * the incident's value as iRacing scores it — the Sporting Code §3.5.1
   * table value of the classified type, discipline-resolved (heavy car
   * contact: 4x pavement / 2x dirt). An iRacing incident sequence escalates
   * to its worst outcome (§3.5.2), so this IS the sequence's total, and it
   * is the number audio speaks; `0` (contact types) means no count is
   * spoken. `delta` carries the raw count movement the emission coalesced
   * (informational). `type` is the latest classified {@link IncidentType};
   * translators must omit emission when the incident type is unknown —
   * every fire MUST set `type`.
   */
  "incident.occurred": SimEvent<"incident.occurred", { delta: number; points: number; type: IncidentType }>;
```

- [ ] **Step 5: Harness template** — `event-names.ts`: `data: { delta: 1, points: 1, type: "off-track" }`, description noting `points` is the spoken Sporting Code value (#938).

- [ ] **Step 6: Translator** — `translator.ts:1662`:

```typescript
  diffIncidents(self.state, telemetry, now, emit, resolveCollisionCarValue(sessionInfo));
```

(import `resolveCollisionCarValue` from `./diff/incidents.js`; `sessionInfo` is already in scope).

- [ ] **Step 7: `state.ts` comments** — update the burst cluster comment: bursts may be untyped (flushed silently), the late-type window retypes them, and the emitted number is the type's Sporting Code value, not the delta.

- [ ] **Step 8: Run the diff tests to verify pass** — `pnpm --dir <wt> exec vitest run packages/sim-events-iracing/src/diff/incidents.test.ts`.

---

### Task 3: Audio stash speaks `points`

**Files:**
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/incidents.ts`
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/register-pit-crew.test.ts`

- [ ] **Step 1: Update the audio tests first** — every `incident.occurred` publish gains `points` (the old `delta` value where the fixture meant a whole incident: `{ delta: 4, points: 4, type: "collision-car" }`, the dirt case `{ delta: 2, points: 2, type: "collision-car" }`, off-track `{ delta: 1, points: 1, type: "off-track" }`); rename the `_resetLastIncidentDelta` import to `_resetLastIncidentPoints`; add one #938 case: publish `{ delta: 3, points: 4, type: "collision-car" }` and assert the count clause resolves `pool:incidents/points-4` (mirror the existing points-assertion shape).
- [ ] **Step 2: Run to verify the new expectations fail.**
- [ ] **Step 3: Update `incidents.ts`** — rename the stash `lastIncidentDelta` → `lastIncidentPoints` and `_resetLastIncidentDelta` → `_resetLastIncidentPoints`; the `where:` write becomes:

```typescript
        lastIncidentPoints = Number.isInteger(data.points) && data.points > 0 ? data.points : null;
```

The `incident.points` resolver reads `lastIncidentPoints`. Rewrite the header's "Penalty wording (issue #922)" paragraph: the payload's `points` is the incident's value as iRacing scores it (Sporting Code table value of the classified type, discipline-resolved by the translator — #938); the count is still never baked into clip wording, dirt car contact announces two points, and an escalating crash announces its full value with the correction trumping an in-flight earlier call (`family: "incident"`). Drop the claim that a coalesced emission's delta is the episode total.
- [ ] **Step 4: Run** — `pnpm --dir <wt> exec vitest run packages/audio-scenarios/src/catalog/pit-crew/register-pit-crew.test.ts`.

---

### Task 4: Adapt the translator integration tests — Commit B

**Files:**
- Modify: `packages/sim-events-iracing/src/translator.test.ts` (the `incidents and off-track` describe, ~line 1492)

- [ ] **Step 1: Update the expectations.**
  - Single-increment test: assert `data` equals `{ delta: 1, points: 1, type: "off-track" }`.
  - The multi-step coalesce test drives counts 0→1→3→7 (+1, +2, +4) — synthetic deltas from the pre-capture additive model. Rewrite with real escalation arithmetic: counts 0→1 (`RepOffTrack`) →2 (`RepOutOfControl`) →4 (`RepCollisionWithCar`) inside one quiet window; assert ONE emission `{ delta: 4, points: 4, type: "collision-car" }`.
  - The separate-emissions test: both emissions carry `points: 1`.
  - The `RepOffTrackOngoing` test (~line 1606): under the untyped-extends change the increment now accumulates but the burst has no type — still NO emission. Expectation unchanged; re-run to confirm.
- [ ] **Step 2: Run the full sim-events suite** — `pnpm --dir <wt> exec vitest run packages/sim-events-iracing`. Grep `incident.occurred` across `packages/` for any other fixtures to update.
- [ ] **Step 3: Full verification and commit B:**

```bash
pnpm --dir "C:/Users/Niklas/Projects/iRaceDeck/ir-938" lint:fix
pnpm --dir "C:/Users/Niklas/Projects/iRaceDeck/ir-938" format:fix
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-938" && set -o pipefail && pnpm build 2>&1 | tail -5
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-938" && set -o pipefail && pnpm test 2>&1 | tail -15
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-938" add -A packages/
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-938" commit -m "fix(audio): announce the incident's scored value, not the marginal count delta (#938)"
```

---

### Task 5: Docs (changelog, website, rules, spec) — Commit C

**Files:**
- Modify: `packages/website/src/content/docs/changelog.mdx`
- Modify: `packages/website/src/content/docs/docs/actions/audio-voice/pit-crew.md`
- Modify: `.claude/rules/race-engineer-callout-examples.md`

- [ ] **Step 1: Changelog** — the 2.4.0 (Unreleased) **Bug Fixes** section already carries the #922 line ("The Race Engineer's contact and collision callouts now announce the penalty point count iRacing actually awarded…"). Per the one-change-one-line rule, EDIT that line (no second line) so it covers #938: the count now comes from the Sporting Code value of the detected incident type with dirt weights resolved live, and a crash that escalates after the first callout (an off-track that ends in the wall seconds later) announces its full value, correcting the earlier call.
- [ ] **Step 2: Website** — `pit-crew.md` has no incident-callout section. Add `## Incident callouts` after `## Damage Heads-Up`: the six lines (off-track "watch the curbs" nudge, out-of-control composure line, light/heavy wall contact, light/heavy car contact); contact/collision lines end with the penalty count iRacing actually scores — the value of the incident's worst outcome, with dirt racing's different car-contact weight announced correctly; an escalating crash (off-track → spin → wall) announces each stage as it lands, a worse outcome correcting the earlier call (cutting it off if it's still playing); light contacts carry no count. Check the "Race Engineer Callouts (per-subject opt-in/out)" section lists the incident toggles accurately. Verify with `pnpm --dir <wt> --filter @iracedeck/website build`.
- [ ] **Step 3: Rules** — `race-engineer-callout-examples.md`: the #922 entry appears TWICE — delete one; in the survivor, replace "a multi-step crash coalesces into one emission whose delta is the points the episode scored in total" with the corrected statement (the payload's `points` field — the discipline-resolved type value — is what's spoken; `delta` is the raw count movement). Append a #938 entry: validate a sim model with a full-rate capture before building on it (the `telemetry-watch` CLI, one-frame report bytes, count-before-byte ordering), prefer the sim's own authoritative value table (discipline-resolved) over reconstructing values from deltas, and note the two capture-driven burst fixes (untyped increments extend; late byte retypes).
- [ ] **Step 4: Commit C:**

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-938" add packages/website/src/content/docs .claude/rules/race-engineer-callout-examples.md
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-938" commit -m "docs: describe incident value announcements on website, changelog, and rules (#938)"
```

---

### Task 6: Final verification, then STOP for manual testing

- [ ] Full `pnpm build` + `pnpm test` (pipefail, check exit codes) — green.
- [ ] `git -C <wt> status` clean; `git log --oneline` shows commits A/B/C on `ir-938`.
- [ ] **STOP.** Hand Niklas the manual test protocol (repeat the capture's incident set live with the plugin running; expect: lone off-track → "watch the curbs", no number; off-track → wall/car collision seconds later → collision line with the full scored value — "four points" for a pavement car collision — correcting the earlier call; dirt session car contact → "two points"). No push, no PR until he confirms.

## Self-review notes

- Spec coverage: type-value model → Task 2; discipline resolution → Tasks 1–2; capture fixes (untyped extends, late-byte retype) → Task 2 with dedicated tests; payload + harness → Task 2; audio → Task 3; synthetic-test rewrite → Task 4; changelog/website/rules → Task 5. No state field changes; replay wipe untouched.
- Names consistent across tasks: `points` payload field, `lastIncidentPoints` stash, `INCIDENT_LATE_TYPE_MS`, `COLLISION_CAR_VALUE_*`, `resolveCollisionCarValue`, `incidentTypeValue`.
