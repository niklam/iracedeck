# Black Flag Queueable Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `BLACK`, `DISQUALIFY`, and `DQ_SCORING_INVALID` Race Engineer scenarios `queueable: true` so a penalty raised while the Voice bus is busy replays when the bus idles instead of being silently dropped (issue #923).

**Architecture:** One production file changes (`flag-alerts.ts` — three scenarios gain `queueable: true` plus rationale comments); the scheduler (`interpreter.ts`) is untouched. Tests extend the existing roster assertion and mirror the #671 yellow-cleared blocker-scenario pattern. Docs: audio-scenarios `CLAUDE.md` roster, a new `## 2.4.0` changelog section, and a #923 entry in the callout examples rule.

**Tech Stack:** TypeScript, Vitest, pnpm/turbo monorepo.

## Global Constraints

- Work in the worktree `C:/Users/Niklas/Projects/iRaceDeck/ir-923` (branch `ir-923`). The shell cwd resets between commands — always `cd /c/Users/Niklas/Projects/iRaceDeck/ir-923` first or use absolute paths.
- Spec: `docs/superpowers/specs/2026-08-05-black-flag-queueable-design.md`. Decisions locked with the user: all three scenarios queueable; **no speak-time `if:` gate**.
- No changes to `interpreter.ts`, event-bus, translator, plugins, manifests, PI templates, schemas, clips, or scenario-harness.
- Conventional commits; `pnpm build` (tsc) catches what `pnpm test` (esbuild) misses — run both before claiming green; use `set -o pipefail` when piping build output.
- Changelog is MDX — a bare `<` or `{` breaks the website build; verify with `pnpm --filter @iracedeck/website build`.
- Markdown: fenced code blocks need a language identifier; no hard line wraps inside paragraphs.

---

### Task 1: Make the three penalty-flag scenarios queueable (TDD)

**Files:**
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/flag-alerts.test.ts` (roster test ~line 310; new describe block after the #671 block ending ~line 764)
- Modify: `packages/audio-scenarios/src/catalog/pit-crew/flag-alerts.ts` (header comment ~line 42; `BLACK` ~line 200; `DISQUALIFY` ~line 255; `DQ_SCORING_INVALID` ~line 384)

**Interfaces:**
- Consumes: the interpreter's existing `queueable` scheduling (`queueOrDrop` → `setPending`, ties → newest) — no engine change.
- Produces: `BLACK`, `DISQUALIFY`, `DQ_SCORING_INVALID` scenario objects with `queueable: true`; Task 2's docs describe this state.

- [ ] **Step 1: Update the roster test and add the behavioral tests (failing first)**

In `flag-alerts.test.ts`, replace the queueable-roster test (the `it("furled, furled-cleared, yellow-cleared, white-last-lap and meatball are queueable …")` block at ~line 310) with:

```typescript
  it("furled, furled-cleared, yellow-cleared, white-last-lap, meatball and the penalty raises are queueable (defer behind a busy bus) — and they're the only flags that are", () => {
    const queueableIds = [
      "pit-crew.flag-furled",
      "pit-crew.flag-furled-cleared",
      "pit-crew.flag-yellow-cleared",
      // Issue #772: the last-lap crossing is one-shot and the translator
      // latch never re-fires, so a fire displaced by an equal-weight line
      // (spotter call) must replay at idle instead of being dropped.
      "pit-crew.flag-white-last-lap",
      // Issue #867: a spotter proximity call outranks the meatball line; the
      // one-shot raise must defer/stash and replay instead of being lost.
      "pit-crew.flag-meatball",
      // Issue #923: the penalty raises are one-shot edges that never re-fire
      // and the penalty is a sustained state — a fire that can't take the bus
      // must defer and replay at idle, never leave the driver untold.
      "pit-crew.flag-black",
      "pit-crew.flag-disqualify",
      "pit-crew.flag-dq-scoring-invalid",
    ];

    for (const id of queueableIds) {
      expect(findScenario(id).queueable).toBe(true);
    }

    for (const s of FLAG_ALERTS) {
      if (queueableIds.includes(s.id)) continue;

      expect(s.queueable).not.toBe(true);
    }
  });
```

Then add a new describe block directly after the `FLAG_ALERTS yellow-cleared delivery + waving debounce (issue #671)` describe (after its closing `});` at ~line 764):

```typescript
// Issue #923 — a directly-issued black flag (pit-lane speeding, a race-admin
// `!black`, escalation after an ignored meatball) landing while an equal- or
// higher-weight line held the Voice bus was silently dropped, and the raise
// is a one-shot edge that never re-fires — the driver was never told about
// the penalty. The penalty scenarios are queueable so the fire defers and
// replays when the bus idles; a black→DQ escalation while queued resolves
// structurally (the queueable DQ fire replaces the pending black — equal
// weight, ties → newest in the single pending slot).
describe("FLAG_ALERTS penalty-flag delivery (issue #923)", () => {
  // A stand-in for a spotter call / pit chatter: same Voice bus, same SAFETY
  // weight, NOT in the flag family — so a penalty fire can't take the bus and
  // can't family-preempt. Pre-#923 it was dropped here.
  function defineBlocker(): void {
    engine.defineScenario({
      id: "test.blocker",
      when: { event: "incident.occurred" },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "voice/{voice}",
      weight: WEIGHT.SAFETY,
      sequence: ["flags/red-01.mp3"],
    });
  }

  it.each([
    { event: "flag.black.raised" as const, clip: "voice/luca/flags/black-01.mp3" },
    { event: "flag.disqualify.raised" as const, clip: "voice/luca/flags/disqualify-01.mp3" },
    { event: "flag.dq-scoring-invalid.raised" as const, clip: "voice/luca/flags/dq-scoring-invalid-01.mp3" },
  ])("$event defers behind an equal-weight non-flag line and replays at idle (queueable)", ({ event, clip }) => {
    defineBlocker();

    bus.publishEvent("incident.occurred", { delta: 1, type: "off-track" });
    // Don't flush — the blocker holds the Voice bus.
    bus.publishEvent(event, {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual(["voice/luca/flags/red-01.mp3", clip]);
  });

  it("a disqualify raised while the black line waits replaces it — only the DQ line plays (escalation)", () => {
    defineBlocker();

    bus.publishEvent("incident.occurred", { delta: 1, type: "off-track" });
    // Don't flush — the blocker holds the Voice bus; the black fire defers.
    bus.publishEvent("flag.black.raised", {});
    // The penalty escalates while the black line waits: the queueable DQ fire
    // takes the single pending slot (equal weight, ties → newest), so the
    // driver hears the escalated line, never the stale black-flag one.
    bus.publishEvent("flag.disqualify.raised", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual(["voice/luca/flags/red-01.mp3", "voice/luca/flags/disqualify-01.mp3"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /c/Users/Niklas/Projects/iRaceDeck/ir-923 && pnpm exec vitest run packages/audio-scenarios/src/catalog/pit-crew/flag-alerts.test.ts`

Expected: FAIL — the roster test asserts `queueable === true` for the three new ids (currently undefined), and the four new behavioral tests see only the blocker clip (penalty fire dropped).

- [ ] **Step 3: Implement — `queueable: true` on the three scenarios**

In `flag-alerts.ts`:

**(a)** Extend the file-header doc comment: after the `**Yellow-cleared delivery + waving debounce (issue #671).**` paragraph (ends ~line 41, before the closing `*/`), add:

```typescript
 *
 * **Penalty-flag delivery (issue #923).** The penalty raises — `BLACK`,
 * `DISQUALIFY`, `DQ_SCORING_INVALID` — are `queueable`: each is a one-shot
 * edge that never re-fires, and a raise landing while an equal- or
 * higher-weight line held the Voice bus (another flag, a spotter call, a
 * CRITICAL line) was silently dropped — a penalty the driver was never told
 * about. The penalty is a sustained state (serving requires a pit visit), so
 * a replay a few seconds late is always still correct and no speak-time gate
 * is needed (the #867 meatball reasoning); a black→DQ escalation while
 * queued resolves structurally — the queueable DQ fire replaces the pending
 * black in the single pending slot (equal weight, ties → newest).
```

**(b)** Replace the `BLACK` declaration (~line 200) with:

```typescript
// `queueable: true` (issue #923): a directly-issued black flag — pit-lane
// speeding, a race-admin `!black`, escalation after an ignored meatball —
// arrives with no furled warning phase, and the raise is a one-shot edge that
// never re-fires. Without queueable, a raise landing while an equal-weight
// line (another flag, pit-approach, the spotter info line) or a higher-weight
// line (meatball, a proximity call) held the Voice bus was dropped and the
// driver never told about the penalty. Serving takes a pit visit (≥ 30 s),
// far beyond the seconds a queued fire waits, so a replay at idle is always
// still correct — no speak-time gate (the #867 meatball precedent); a
// black→DQ escalation while queued is covered structurally (the queueable
// DISQUALIFY fire replaces the pending black — equal weight, ties → newest).
const BLACK: Scenario = {
  ...flagScenario("black", ["pool:flag-black"]),
  queueable: true,
  when: { event: "flag.black.raised" },
};
```

**(c)** Replace the `DISQUALIFY` declaration (~line 255, keeping its existing #480 comment block and appending to it):

```typescript
// Driver-black splits (issue #480). `Disqualify` is split out of the generic
// `black` callout — "Disqualified. Pull off." carries different urgency than a
// routine black flag. `Furled` and `DqScoringInvalid` are new bits the engineer
// previously ignored. All share `family: "flag"` + `WEIGHT.SAFETY` like the
// other flags. `queueable: true` (issue #923): the same one-shot loss paths as
// BLACK above — and a DQ is even more must-hear.
const DISQUALIFY: Scenario = {
  ...flagScenario("disqualify", ["pool:flag-disqualify"]),
  queueable: true,
  when: { event: "flag.disqualify.raised" },
};
```

**(d)** Replace the `DQ_SCORING_INVALID` declaration (~line 384):

```typescript
// `queueable: true` (issue #923) — the same one-shot penalty edge as BLACK /
// DISQUALIFY above, with the same loss paths and sustained-state reasoning.
const DQ_SCORING_INVALID: Scenario = {
  ...flagScenario("dq-scoring-invalid", ["pool:flag-dq-scoring-invalid"]),
  queueable: true,
  when: { event: "flag.dq-scoring-invalid.raised" },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /c/Users/Niklas/Projects/iRaceDeck/ir-923 && pnpm exec vitest run packages/audio-scenarios/src/catalog/pit-crew/flag-alerts.test.ts`

Expected: PASS (all tests in the file, including the untouched ones).

Also run the cross-cutting wiring test to confirm nothing else asserts these flags:

Run: `cd /c/Users/Niklas/Projects/iRaceDeck/ir-923 && pnpm exec vitest run packages/audio-scenarios/src/catalog/pit-crew/register-pit-crew.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-923
git add packages/audio-scenarios/src/catalog/pit-crew/flag-alerts.ts packages/audio-scenarios/src/catalog/pit-crew/flag-alerts.test.ts
git commit -m "fix(audio): make black/DQ penalty-flag scenarios queueable (#923)"
```

---

### Task 2: Documentation — CLAUDE.md roster, changelog, examples rule

**Files:**
- Modify: `packages/audio-scenarios/CLAUDE.md` (the flag-family pointer list, ~line 43)
- Modify: `packages/website/src/content/docs/changelog.mdx` (new `## 2.4.0` section above `## 2.3.0` at ~line 12)
- Modify: `.claude/rules/race-engineer-callout-examples.md` (append one entry at the end of the bullet list)

**Interfaces:**
- Consumes: Task 1's shipped behavior (the queueable trio).
- Produces: docs consistent with the code; nothing downstream.

- [ ] **Step 1: Update the audio-scenarios CLAUDE.md roster**

In `packages/audio-scenarios/CLAUDE.md`, directly after the `**Yellow-cleared delivery + waving debounce**` bullet (~line 43), add a sibling bullet:

```markdown
- **Penalty-flag delivery** — `BLACK`, `DISQUALIFY`, and `DQ_SCORING_INVALID` are `queueable: true` (#923): the penalty raises are one-shot edges that never re-fire, so a fire that can't take the bus (equal/higher-weight line in flight) defers and replays at idle instead of leaving the driver untold. No speak-time gate — the penalty is sustained on the seconds timescale a queued fire waits (the #867 meatball reasoning), and a black→DQ escalation while queued resolves via the pending-slot tie replacement. See the #923 entry in the examples rule.
```

- [ ] **Step 2: Add the changelog section**

In `packages/website/src/content/docs/changelog.mdx`, insert directly above the `## 2.3.0` line:

```markdown
## 2.4.0

_Unreleased_

**Bug Fixes**

- The Race Engineer no longer misses a directly-issued black flag (a pit-lane speeding penalty, a race-admin black flag, or a disqualification) that lands while another callout is playing — the penalty line now waits its turn and plays as soon as the current line finishes.

```

(Keep a blank line before `## 2.3.0`.)

- [ ] **Step 3: Append the examples-rule entry**

In `.claude/rules/race-engineer-callout-examples.md`, append this bullet at the end of the entry list:

```markdown
- **Penalty-flag queueable delivery — one-shot penalty raises must survive a busy bus, and structure can replace a speak-time gate** — issue #923 (extends #671/#867). `BLACK`, `DISQUALIFY`, and `DQ_SCORING_INVALID` sat at `WEIGHT.SAFETY` with the default `queueable: false`, so a directly-issued black flag (pit-lane speeding, race-admin `!black`, meatball escalation — no furled warning phase) landing while an equal- or higher-weight line held the Voice bus went through `queueOrDrop` and was dropped with only a debug log; the raise is a plain rising edge that never re-fires, so the driver was never told about the penalty (the clearest case: a spotter proximity call playing when the flag lands). Fix: `queueable: true` on all three — the same class as #671 (yellow-cleared) and #867 (meatball/gantry): the penalty is a sustained state, so a replay a few seconds late is always still correct. The deliberate NON-fix: no speak-time `if:` gate (the FURLED #669 pattern), decided against because queue latency is bounded by one in-flight clip (seconds) while serving a black flag takes a pit visit (≥ 30 s), and the issue's named staleness case — black escalated to DQ while queued — is covered STRUCTURALLY: the now-queueable DISQUALIFY fire arrives at equal weight and replaces the pending black in the single pending slot (`setPending` ties → newest), so the driver hears "Disqualified. Pull off." instead of the stale black line (test-covered). The FURLED gates exist because that warning is genuinely withdrawable in normal play; a penalty is not, on this timescale. Known residual (accepted, same as #867): the single pending slot means a different equal-weight queueable fire (e.g. yellow-cleared) arriving while the black line waits still displaces it. Reach for this pattern when a one-shot raise announces a sustained state: `queueable: true` is the whole fix, and before adding a speak-time validity gate, check whether the scheduler's pending-slot replacement already delivers the fresher line for every realistic staleness path.
```

- [ ] **Step 4: Verify the website build (MDX)**

Run: `cd /c/Users/Niklas/Projects/iRaceDeck/ir-923 && set -o pipefail && pnpm --filter @iracedeck/website build 2>&1 | tail -5`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-923
git add packages/audio-scenarios/CLAUDE.md packages/website/src/content/docs/changelog.mdx .claude/rules/race-engineer-callout-examples.md
git commit -m "docs(audio): document queueable penalty flags + changelog (#923)"
```

---

### Task 3: Full verification gate

**Files:** none new — repo-wide checks in the worktree.

- [ ] **Step 1: Full build, test, lint, format**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-923
set -o pipefail
pnpm build 2>&1 | tail -5
pnpm test 2>&1 | tail -8
pnpm lint:fix 2>&1 | tail -5
pnpm format:fix 2>&1 | tail -5
```

Expected: build exit 0; all tests pass (baseline was 7422 across 239 files, now +4); lint/format clean or auto-fixed.

- [ ] **Step 2: Commit any lint/format fallout (only if files changed)**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-923
git status --porcelain
# if non-empty:
git add -A && git commit -m "style: lint/format fixes (#923)"
```

- [ ] **Step 3: Report ready for manual testing**

Stop here. The user manually tests via the scenario harness (`pnpm --filter @iracedeck/scenario-harness dev`, UI at `127.0.0.1:5750`): fire a spotter call or meatball, then `flag.black.raised` while it plays — the black-flag line must play when the bus idles; repeat for disqualify / dq-scoring-invalid. No push or PR before the user confirms manual testing (established workflow rule).
