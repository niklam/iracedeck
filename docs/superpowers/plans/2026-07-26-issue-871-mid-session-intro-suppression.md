# Issue #871 — Mid-Session Intro-Brief Suppression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Race Engineer replaying the session/race intro brief when the plugin connects mid-session with the car already on track (issue #871).

**Architecture:** The translator's fresh-connect synthesis (`session.changed { from: -1 }`) stays untouched. The two intro scenarios' `where:` predicates learn to reject the self-identifying synthetic event when the session is already underway: session-start rejects when `isLiveOnTrack(e.telemetry)`, race-start rejects when `SessionState === Racing || isPostRace(e.telemetry)`. Approved spec: `docs/superpowers/specs/2026-07-26-issue-871-mid-session-intro-suppression-design.md`.

> **Amended post-review:** the session-start gate now reads `e.telemetry.IsOnTrack === true` directly rather than `isLiveOnTrack` — its `IsReplayPlaying` conjunct would let a connect tick with the in-session replay view open evade the gate (see the amended spec). The snapshots below predate the amendment.

**Tech Stack:** TypeScript monorepo (pnpm + turbo), Vitest, scenario-engine test harness in `@iracedeck/audio-scenarios`.

## Global Constraints

- Worktree: `C:/Users/Niklas/Projects/iRaceDeck/ir-871`, branch `ir-871`. All commands run from that root.
- Genuine session transitions (`from >= 0`) must be untouched; missing telemetry / missing `SessionState` must brief (don't punish missing data).
- No new opt-in, no schema/PI/plugin/bus/translator changes.
- `pnpm build` (tsc) is the type gate — vitest alone is not sufficient.
- Every commit message ends with the trailer `Claude-Session: https://claude.ai/code/session_01DHJUsyTWcCk8yBPpy1PjS4`.
- SessionState values (from `@iracedeck/iracing-native` `defines.ts`, re-exported by `@iracedeck/iracing-sdk`): Invalid=0, GetInCar=1, Warmup=2, ParadeLaps=3, Racing=4, Checkered=5, CoolDown=6.

---

### Task 1: session-start `where:` suppression

**Files:**
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/session-start.ts` (imports, `sessionStartScenario`'s `where:`, header comment lines 14–16)
- Test: `packages/audio-scenarios/src/catalog/pit-crew/session-start.test.ts`

**Interfaces:**
- Consumes: `isLiveOnTrack(t)`, `type TelemetryData` from `@iracedeck/iracing-sdk` (existing exports).
- Produces: no new exports — behavior change only.

- [ ] **Step 1: Extend the mock bus to carry telemetry, and write the failing tests**

In `session-start.test.ts`, change `createMockBus`'s signature and `publishEvent` (lines 36 and 60–67) to accept optional telemetry:

```typescript
function createMockBus(): IEventBus & {
  publishEvent: (name: SimEventName, data: Record<string, unknown>, telemetry?: unknown) => void;
} {
```

```typescript
    publishEvent(name: SimEventName, data: Record<string, unknown>, telemetry?: unknown) {
      this.publish({
        event: name,
        timestamp: Date.now(),
        telemetry: (telemetry ?? null) as unknown,
        data: data as never,
      } as SimEventOf<SimEventName>);
    },
```

Append a new describe block at the end of the outer `describe("session-start scenario", ...)` block (after the `setup-warning clause` describe, before its closing `});`):

```typescript
  // Issue #871: the translator's fresh-connect synthesis marks itself with
  // `from: -1`. Connecting mid-practice/mid-qualifying with the car already
  // on track must not replay the brief; connecting in the garage (the #668
  // case) and genuine transitions (`from >= 0`) still brief.
  describe("mid-session fresh-connect suppression (issue #871)", () => {
    it("suppresses the brief on a synthetic fresh connect with the car on track", () => {
      currentSnapshot = snap();
      bus.publishEvent("session.changed", { from: -1, to: 0 }, { IsOnTrack: true, IsReplayPlaying: false });
      flush(audio);

      expect(voicePaths()).toEqual([]);
    });

    it("still briefs on a synthetic fresh connect in the garage", () => {
      currentSnapshot = snap();
      bus.publishEvent("session.changed", { from: -1, to: 0 }, { IsOnTrack: false, IsReplayPlaying: false });
      flush(audio);

      expect(hasClip("/session-start/session-qualifying.mp3")).toBe(true);
    });

    it("still briefs on a genuine session transition with the car on track", () => {
      currentSnapshot = snap();
      bus.publishEvent("session.changed", { from: 0, to: 1 }, { IsOnTrack: true, IsReplayPlaying: false });
      flush(audio);

      expect(hasClip("/session-start/session-qualifying.mp3")).toBe(true);
    });

    it("briefs on a synthetic fresh connect with no telemetry attached (don't punish missing data)", () => {
      currentSnapshot = snap();
      bus.publishEvent("session.changed", { from: -1, to: 0 });
      flush(audio);

      expect(hasClip("/session-start/session-qualifying.mp3")).toBe(true);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/audio-scenarios/src/catalog/pit-crew/session-start.test.ts`
Expected: the "suppresses the brief on a synthetic fresh connect with the car on track" test FAILS (brief plays); the other three new tests pass (current behavior already briefs).

- [ ] **Step 3: Implement the suppression**

In `session-start.ts`, add to the imports (the file currently imports nothing from `@iracedeck/iracing-sdk`):

```typescript
import { isLiveOnTrack, type TelemetryData } from "@iracedeck/iracing-sdk";
```

In `sessionStartScenario` (line ~175), change `where: () => {` to `where: (e) => {` and insert before the final `return true;`:

```typescript
        // Issue #871: the translator's fresh-connect synthesis marks itself
        // with `from: -1`. Replaying the intro brief to a driver already
        // lapping (plugin restart mid-practice / mid-qualifying) is noise —
        // reject the synthetic event when the driver is live on track. The
        // envelope telemetry is the synthesis-tick state, i.e. "was the
        // driver already driving at connect". Connecting in the garage (the
        // #668 case) and genuine transitions (`from >= 0`) still brief, and
        // missing telemetry briefs too (don't punish missing data — also
        // keeps the harness composer firable without driving telemetry).
        const from = (e.data as { from?: number }).from;

        if (from === -1 && isLiveOnTrack(e.telemetry as TelemetryData | null)) return false;
```

Update the header comment (lines 14–16) to read:

```text
 *   - Fresh-connect synthetic event: when the plugin connects mid-session, the
 *     translator emits a synthetic `session.changed { from: -1, to: N }` —
 *     connecting mid-practice or mid-qualifying triggers the brief, UNLESS the
 *     driver is already live on track (issue #871): a plugin restart while
 *     lapping must not replay the intro, so the `where:` rejects the synthetic
 *     marker when `isLiveOnTrack(e.telemetry)` is true.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/audio-scenarios/src/catalog/pit-crew/session-start.test.ts`
Expected: PASS (all tests, including the pre-existing ones — the mock-bus `telemetry: null` default keeps them briefing).

- [ ] **Step 5: Commit**

```bash
git add packages/audio-scenarios/src/catalog/pit-crew/session-start.ts packages/audio-scenarios/src/catalog/pit-crew/session-start.test.ts
git commit -m "fix(race-engineer): suppress session-start brief on mid-session fresh connect (#871)"
```

---

### Task 2: race-start `where:` suppression

**Files:**
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/race-start.ts` (imports, `where:` in `buildRaceStartScenario`, header `where:` paragraph lines 48–52)
- Test: `packages/audio-scenarios/src/catalog/pit-crew/race-start.test.ts`

**Interfaces:**
- Consumes: `isPostRace(t)`, `SessionState`, `type TelemetryData` from `@iracedeck/iracing-sdk` (existing exports).
- Produces: no new exports — behavior change only.

- [ ] **Step 1: Extend the mock bus and write the failing tests**

In `race-start.test.ts`, apply the same `createMockBus` / `publishEvent` change as Task 1 Step 1 (lines 38 and 62–69):

```typescript
function createMockBus(): IEventBus & {
  publishEvent: (name: SimEventName, data: Record<string, unknown>, telemetry?: unknown) => void;
} {
```

```typescript
    publishEvent(name: SimEventName, data: Record<string, unknown>, telemetry?: unknown) {
      this.publish({
        event: name,
        timestamp: Date.now(),
        telemetry: (telemetry ?? null) as unknown,
        data: data as never,
      } as SimEventOf<SimEventName>);
    },
```

Add to the imports:

```typescript
import { SessionState } from "@iracedeck/iracing-sdk";
```

Append a new describe block inside the outer scenario describe (next to the existing firing-condition tests):

```typescript
  // Issue #871: the translator's fresh-connect synthesis marks itself with
  // `from: -1`. A fresh connect into a race already underway (post-green or
  // post-race) must not replay the grid brief; a pre-green grid restart still
  // briefs (starting position + conditions are still actionable), and genuine
  // transitions (`from >= 0`) are untouched. Defense-in-depth: the translator
  // already latches silently on a race + Racing connect, but the scenario owns
  // its own firing conditions for harness-fired events.
  describe("mid-session fresh-connect suppression (issue #871)", () => {
    it("suppresses the brief on a synthetic fresh connect with the race underway (Racing)", () => {
      currentSnapshot = snap();
      bus.publishEvent("session.changed", { from: -1, to: 1 }, { SessionState: SessionState.Racing });
      flush(audio);

      expect(voicePaths()).toEqual([]);
    });

    it("suppresses the brief on a synthetic fresh connect after the race (Checkered)", () => {
      currentSnapshot = snap();
      bus.publishEvent("session.changed", { from: -1, to: 1 }, { SessionState: SessionState.Checkered });
      flush(audio);

      expect(voicePaths()).toEqual([]);
    });

    it("still briefs on a synthetic fresh connect on the pre-green grid (Warmup)", () => {
      currentSnapshot = snap();
      bus.publishEvent("session.changed", { from: -1, to: 1 }, { SessionState: SessionState.Warmup });
      flush(audio);

      expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
    });

    it("still briefs on a genuine session transition when the state reads Racing", () => {
      currentSnapshot = snap();
      bus.publishEvent("session.changed", { from: 0, to: 1 }, { SessionState: SessionState.Racing });
      flush(audio);

      expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
    });

    it("briefs on a synthetic fresh connect with no telemetry attached (don't punish missing data)", () => {
      currentSnapshot = snap();
      bus.publishEvent("session.changed", { from: -1, to: 1 });
      flush(audio);

      expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
    });
  });
```

NOTE: `snap()` in this file returns a `RaceStartSnapshot`; check the local helper name at the insertion point — the file's fire helper is `fire(snapshot)`, but these tests publish manually to control the payload/telemetry, so they set `currentSnapshot` directly (same shape as the existing delay tests at lines 325–336).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/audio-scenarios/src/catalog/pit-crew/race-start.test.ts`
Expected: the two "suppresses" tests FAIL (brief plays); the other three pass.

- [ ] **Step 3: Implement the suppression**

In `race-start.ts`, extend the `@iracedeck/iracing-sdk` import (the file has none today — add it next to the `@iracedeck/event-bus` import):

```typescript
import { isPostRace, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
```

In `buildRaceStartScenario`'s `where:` (line ~272), insert after the `snapshot === null` rejection and before the "passed" log:

```typescript
        // Issue #871: the translator's fresh-connect synthesis marks itself
        // with `from: -1`. A fresh connect into a race already underway —
        // post-green (Racing) or post-race (Checkered/CoolDown) — must not
        // replay the grid brief; a restart on the pre-green grid still briefs
        // (starting position + conditions are still actionable). Explicit
        // positive state set (the #647 house style), so a missing/Invalid
        // SessionState briefs rather than suppresses. Defense-in-depth: the
        // translator already latches silently on race + Racing, but the
        // scenario owns its firing conditions for harness-fired events.
        const from = (e.data as { from?: number }).from;
        const telemetry = e.telemetry as TelemetryData | null;

        if (from === -1 && (telemetry?.SessionState === SessionState.Racing || isPostRace(telemetry))) {
          logger?.info(
            `race-start where: rejected — fresh connect into a race already underway (SessionState=${telemetry?.SessionState})`,
          );

          return false;
        }
```

Change the `where: () => {` signature to `where: (e) => {`.

Update the header `where:` paragraph (lines 48–52) to:

```text
 * `where:` is `classifySessionType(getSessionType()) === "race" &&
 * getSnapshot() !== null`, plus the issue #871 fresh-connect gate: a synthetic
 * `session.changed { from: -1 }` (plugin connect mid-session) is rejected when
 * the race is already underway (`SessionState === Racing` or post-race) — a
 * pre-green grid restart still briefs. The first arm gates the scenario open
 * only for race transitions (practice/qualifying are owned by session-start);
 * the snapshot arm short-circuits when telemetry / wetness aren't yet
 * available so the scenario skips entirely rather than speaking a partial
 * readout.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/audio-scenarios/src/catalog/pit-crew/race-start.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/audio-scenarios/src/catalog/pit-crew/race-start.ts packages/audio-scenarios/src/catalog/pit-crew/race-start.test.ts
git commit -m "fix(race-engineer): suppress race-start brief on fresh connect into a running race (#871)"
```

---

### Task 3: scenario-harness reproducibility

**Files:**
- Modify: `packages/scenario-harness/presets/telemetry/hot-lap.json` (add `SessionState: 4`)
- Modify: `packages/scenario-harness/presets/telemetry/on-grid.json` (add `SessionState: 2`)
- Modify: `packages/scenario-harness/src/scenario-shortcuts.ts` (two fresh-connect race-start shortcuts)
- Modify: `packages/scenario-harness/ui/index.html` (session-start composer: fresh-connect fire button + hint)
- Modify: `packages/scenario-harness/ui/app.js` (wire the new button)
- Modify: `packages/scenario-harness/CLAUDE.md` (one sentence on the fresh-connect button)

**Interfaces:**
- Consumes: the `where:` gates from Tasks 1–2 read `e.telemetry`; the harness `/api/bus/publish` already attaches `ctx.controller.getState().telemetry` to every published event, so applying a telemetry preset before clicking drives the gate.
- Produces: QA workflow — apply preset, then click the fresh-connect button/shortcut.

- [ ] **Step 1: Add `SessionState` to the two presets**

`hot-lap.json` — add after `"PlayerTrackSurface": 3,`:

```json
  "SessionState": 4,
```

`on-grid.json` — add after `"PlayerTrackSurface": 3,`:

```json
  "SessionState": 2,
```

(4 = Racing, 2 = Warmup. JSON has no comments; values documented in the shortcut descriptions below.)

- [ ] **Step 2: Add the two race-start fresh-connect shortcuts**

In `scenario-shortcuts.ts`, directly after the last `raceStart(...)` entry in the `SCENARIO_SHORTCUTS` array, add (uses the `TrackWetness` import already present):

```typescript
  // Fresh-connect variants (issue #871). The translator's mid-session connect
  // synthesis marks itself with `from: -1`; the race-start `where:` rejects it
  // when the race is already underway (SessionState Racing / post-race) and
  // still briefs on the pre-green grid. The gate reads the event envelope's
  // telemetry, which `/api/bus/publish` fills from the live mock state — so
  // apply the named telemetry preset BEFORE clicking.
  {
    id: "race-start-fresh-connect-grid",
    category: "Race Start",
    label: "Fresh connect — pre-green grid (briefs)",
    description:
      "Synthetic fresh-connect session.changed (from: -1) while the race hasn't gone green. Apply the on-grid telemetry preset first (SessionState: Warmup) — the grid brief still plays (issue #871).",
    event: "session.changed",
    data: { from: -1, to: 1 },
    raceStartSnapshot: {
      driverName: "niklas",
      trackTemp: 28,
      airTemp: 20,
      tempUnit: "celsius",
      wetness: TrackWetness.Dry,
      playerCarPosition: 3,
    },
  },
  {
    id: "race-start-fresh-connect-mid-race",
    category: "Race Start",
    label: "Fresh connect — mid-race (suppressed)",
    description:
      "Synthetic fresh-connect session.changed (from: -1) with the race underway. Apply the hot-lap telemetry preset first (SessionState: Racing) — no brief plays (issue #871).",
    event: "session.changed",
    data: { from: -1, to: 1 },
    raceStartSnapshot: {
      driverName: "niklas",
      trackTemp: 28,
      airTemp: 20,
      tempUnit: "celsius",
      wetness: TrackWetness.Dry,
      playerCarPosition: 3,
    },
  },
```

- [ ] **Step 3: Add the session-start composer fresh-connect button**

`ui/index.html` — replace the composer's actions block (line ~251):

```html
            <div class="actions">
              <button id="session-start-fire" class="primary" type="button">Fire Session Start</button>
              <button id="session-start-fire-connect" type="button">Fire as Fresh Connect</button>
            </div>
```

And extend the composer hint (line ~189–194) by appending one sentence inside the `<p class="hint">`:

```html
              “Fire as Fresh Connect” publishes the mid-session connect shape
              (<code>from: -1</code>, issue #871): apply the <code>hot-lap</code> telemetry preset
              first to hear it suppressed, or <code>in-garage</code> to hear it still brief.
```

`ui/app.js` — in `wireSessionStartComposer()`, add a second listener after the existing one:

```javascript
  // Issue #871: the fresh-connect variant publishes the translator's
  // mid-session connect shape (from: -1). The session-start where: rejects it
  // when the live mock telemetry says the driver is on track (apply the
  // hot-lap preset first), and still briefs from the garage (in-garage).
  $("session-start-fire-connect").addEventListener("click", async () => {
    try {
      await post("/api/session-start/snapshot", readSessionStartSnapshot());
      await post("/api/bus/publish", { event: "session.changed", data: { from: -1, to: 0 } });
    } catch (e) {
      alert(`Session start fresh-connect fire failed: ${e.message}`);
    }
  });
```

- [ ] **Step 4: Update the harness CLAUDE.md**

In `packages/scenario-harness/CLAUDE.md`, "Snapshot endpoints vs telemetry patch" section, append one sentence to the paragraph:

```text
The session-start composer has a second fire button, "Fire as Fresh Connect", publishing `session.changed { from: -1, to: 0 }` (the translator's mid-session connect shape) so the #871 on-track suppression is reproducible — apply a telemetry preset (`hot-lap` vs `in-garage`) before firing; the race-start equivalents are the two "Fresh connect" shortcuts.
```

- [ ] **Step 5: Build the harness package to catch type errors**

Run: `pnpm exec tsc --noEmit -p packages/scenario-harness`
Expected: clean (the shortcut objects must satisfy `ScenarioShortcut`).

- [ ] **Step 6: Commit**

```bash
git add packages/scenario-harness
git commit -m "improve(scenario-harness): fresh-connect repro shortcuts, presets, and composer button (#871)"
```

---

### Task 4: docs — changelog + callout-examples entry

**Files:**
- Modify: `packages/website/src/content/docs/changelog.mdx` (2.3.0 → Bug Fixes)
- Modify: `.claude/rules/race-engineer-callout-examples.md` (new #871 entry)

- [ ] **Step 1: Changelog entry**

Under `## 2.3.0` → `**Bug Fixes**`, append:

```markdown
- The Race Engineer no longer replays the session or race intro brief when the plugin reconnects mid-session (for example after a deck-software auto-update): connecting with the car already on track in practice or qualifying, or into a race that's already underway, stays silent. Connecting in the garage, or reconnecting on the pre-green race grid, still gets the brief.
```

- [ ] **Step 2: Callout-examples entry**

Append to `.claude/rules/race-engineer-callout-examples.md` (end of the list):

```markdown
- **Mid-session fresh-connect suppression on the intro briefs — gate the synthetic marker at the scenario, keep the synthesis intact** — issue #871 (refines #668/#568). The translator's fresh-connect synthesis (`session.changed { from: -1, to: N }`) deliberately fires during green for practice/qualifying (#668 — those sessions sit in `SessionState.Racing` their whole duration, and connecting in the garage mid-practice wants the brief), but nothing checked whether the driver was already driving — so a plugin restart (deck-host auto-update, crash recovery) mid-practice replayed the whole session brief to a driver already lapping. Fix at the SCENARIO layer, not the synthesis: the synthetic event is self-identifying (`from === -1`), so the `where:` predicates reject it — session-start when `isLiveOnTrack(e.telemetry)` (on-track state is the only meaningful "already underway" signal in practice/qualifying), race-start when `SessionState === Racing || isPostRace(e.telemetry)` (post-green; a pre-green grid restart still briefs — starting position + conditions are still actionable). Genuine transitions (`from >= 0`) are untouched, missing telemetry briefs (don't punish missing data), and the envelope telemetry is the synthesis-tick state — semantically "what was true at connect" (the #480 `e.telemetry` gate shape, which also keeps the events harness-firable: the harness attaches its live mock telemetry to every published event). The race-start gate is DEFENSE-IN-DEPTH — the translator already latches silently on a race + `Racing` connect (#568's "too late to brief") — but the scenario owning its own firing conditions covers harness-fired events and survives future synthesis changes. No new opt-in (#572 firing-condition-fix precedent). Reach for this pattern when a deliberately-synthesized event serves several consumers but one consumer's reaction is wrong in a sub-case the synthesis can't see: keep the synthesis intact, make the synthetic event self-identifying, and gate the one consumer's `where:` on the marker plus the disqualifying live state.
```

- [ ] **Step 3: Verify the website builds**

Run: `pnpm --filter @iracedeck/website build`
Expected: build succeeds (MDX is valid).

- [ ] **Step 4: Commit**

```bash
git add packages/website/src/content/docs/changelog.mdx .claude/rules/race-engineer-callout-examples.md
git commit -m "docs(race-engineer): changelog + callout-examples entry for mid-session intro suppression (#871)"
```

---

### Task 5: full verification

- [ ] **Step 1: Full build (tsc gate)**

Run from the worktree root with pipefail: `set -o pipefail && pnpm build 2>&1 | tail -5`
Expected: all tasks successful.

- [ ] **Step 2: Full test run**

Run: `set -o pipefail && pnpm test 2>&1 | tail -6`
Expected: all test files pass (baseline was 235 files / 7210 tests; new counts higher).

- [ ] **Step 3: Lint + format**

Run: `pnpm lint:fix && pnpm format:fix`
Expected: no remaining errors. If files were modified, re-run Step 1–2, then commit:

```bash
git add -A
git commit -m "chore: lint/format fixes (#871)"
```

(Skip the commit if nothing changed.)

- [ ] **Step 4: Report ready for manual testing**

Do NOT push or open a PR. Manual iRacing/harness testing comes first (project rule), then `code-review xhigh --fix`, then the PR — each on explicit approval.
