# Opponent-Pit Callouts — Design (issue #622)

Date: 2026-08-06
Issue: #622 — Race Engineer: announce when other drivers are pitting
Branch: `ir-622`

## Summary

A new Race Engineer callout family that announces when other drivers enter the pits: the race leader plus same-lap competitors within ±2 effective positions of the player. The trigger is a car's `CarIdxTrackSurface` transitioning into `TrkLoc.AproachingPits` (the same enum the player's own `pitLane.approaching` uses), never `CarIdxOnPitRoad` (documented unreliable in `diff/race-finish.ts`). An incident-burst-style 12 s aggregation window in the translator collapses caution pit trains ("…other cars pitting as well") so the feature stays usable on ovals.

## Decisions made during brainstorming

- **Sessions:** races only; the diff gates on `isRaceSession && !replayOnlySession && !isPreGreen(telemetry)` (the `diffPitsOpen` precedent for the first two, #647's `isPreGreen` for the third). No caution gating — cautions are the prime use case.
- **Multi-class:** class space throughout. The ±2 window, "same lap", and "the leader" are interpreted against the player's class (effective positions, the #588/#599 precedent). Only same-class cars qualify in multi-class.
- **Aggregation window:** 12 s (middle of the issue's 10–15 s range).
- **Dirt ovals:** no fallback trigger. Opponents there typically teleport to the stall and never pass through the approach state (#634); the callout stays silent on dirt ovals. Follow-up if anyone asks.
- **P{n} wording:** three-part splice — new intro clip "The car in" + existing `position-number` clip ("P4.") + new tail clip "is pitting", generated with `previous_request_ids` for prosody continuity. Direct neighbours use "The car ahead is pitting." / "The car behind is pitting."

## Bus event (`@iracedeck/event-bus`)

One new entry in `SimEventMap` (naming shape of `pitBox.countdown` / `cornerName.approaching`):

```typescript
"opponentPit.entered": SimEvent<"opponentPit.entered", {
  /** Who the car is relative to the player. "others" is the aggregate tail. */
  relation: "leader" | "ahead" | "behind" | "nearby" | "others";
  /** Absent for "others". */
  carIdx?: number;
  /** Effective position at emit time (class position in multi-class). Absent for "others". */
  position?: number;
  isMultiClass?: boolean;
}>;
```

One event, five relations, five scenarios branching in `where:` — keeps every variant firable from the scenario harness with an explicit payload. The relation union is a plain string union (the `RadarState` style), exported as a type only (no runtime enum needed).

## Translator (`@iracedeck/sim-events-iracing`)

New `diff/opponent-pit.ts`, called in `handleTick` immediately after `calculateFrozenRacePositions` (the `diffOvertakes` slot, ~line 1458) so it consumes the canonical frozen order on the same tick, per `race-positions.md`. Signature follows the house shape: `diffOpponentPit(state, telemetry, playerCarIdx, paceCarIdx, isRaceSession, replayOnlySession, isMultiClass, frozenPositions, now, emit)` (exact parameter set finalized in the plan).

**Detection.** Per-car previous-tick baseline `opponentPitLastSurface: number[]` (seeded silently on the first eligible tick via `opponentPitInitialized`); a car triggers when its surface transitions into `TrkLoc.AproachingPits` from any other value. Skips the player, the pace car, and cars not in world (`lc >= 0 && dp >= 0 && ts !== NotInWorld`, the `race-finish.ts` in-world test).

**Qualification.** Effective positions come from the frozen order: overall rank from `frozenPositions[carIdx]`, class rank via `classPositionFromOrder(frozenPositions, CarIdxClass, carIdx)` when multi-class.

- Leader: effective P1 (class P1 in multi-class, and same class as the player). Always qualifies — no same-lap or window check.
- Nearby: same class as the player (multi-class), effective-position delta in {−2, −1, +1, +2}, and "same lap": lap-progress score difference `|scoreP − scoreC| < 1.0` where score = `CarIdxLapCompleted + CarIdxLapDistPct` (raw `CarIdxLap` equality misbehaves around S/F crossings; the score form is what the position machinery already uses).
- Everyone else: ignored.

**Relation mapping.** delta −1 → `ahead`, +1 → `behind`, ±2 → `nearby` (spoken with the position number). Leader wins over any delta (a leader entering while the player is P2 announces as the leader, not "the car ahead").

**Per-car re-entry cooldown.** 30 s per carIdx (`opponentPitCarCooldownUntil: number[]`, the #650 `<x>CooldownUntil` pattern per car) so a car crawling across the approach-zone boundary can't re-announce.

**Aggregation (the oval safety valve).** The incident-burst pattern in translator state: `opponentPitRecentEntries: number[]` (timestamps of qualifying entries, leader included), pruned to the last 12 s (`OPPONENT_PIT_AGGREGATE_WINDOW_MS = 12_000`) on every tick, plus `opponentPitAggregateAnnounced: boolean`. Entries 1–2 in a window emit individually; entry 3 emits one `relation: "others"` aggregate (once per episode); entries 4+ are silent. The episode resets (timestamps cleared, flag lowered) after 12 s with no qualifying entry. **The leader always emits individually** even mid-aggregation (leader-first, per the issue) — leader entries still count toward the window total.

**State.** All new fields go on `TranslatorState` AND `createInitialState()` (kept in sync); nothing needs preserving across replay wipes (`wipeStateForReplay` resets it wholesale, which is correct — baselines reseed on the next live tick).

**New export.** `getLiveCarPosition(carIdx): LivePosition | null` — the per-car sibling of the player-only `getLivePosition()`, built on the same `calculateFrozenRacePositions` order (overall rank + `classPositionFromOrder` class rank + `isMultiClass`). Consumed by the plugins' speak-time snapshot resolver; added to `race-positions.md`'s consumer list.

## Audio assets (`@iracedeck/audio-assets`)

New `opponent-pit` group in `configs/default.voice.json` (dry-run wordings reviewed by Niklas before any generation; ElevenLabs is paid):

| Base | Line (canonical variant) | Notes |
|---|---|---|
| `leader` | "The leader is pitting." | 3–5 variants |
| `ahead` | "The car ahead is pitting." | 3–5 variants |
| `behind` | "The car behind is pitting." | 3–5 variants |
| `car-in` | "The car in" | intro for the ±2 splice; `next_request_ids` → a `position-number` clip |
| `is-pitting` | "is pitting." | tail for the ±2 splice; `previous_request_ids` → a `position-number` clip |
| `others` | "And it seems there are other cars pitting as well." | the aggregate tail; 2–3 variants |

The ±2 line plays as `opponent-pit/car-in` + `position-number/{n}` (existing pool, no new number clips) + `opponent-pit/is-pitting`. Generation: `generate:dry-run --group opponent-pit` → review → `generate --group opponent-pit` → `generate:manifest`; clips + both manifests committed.

## Audio scenarios (`@iracedeck/audio-scenarios`)

New `catalog/pit-crew/opponent-pit.ts`. Five scenarios, **two families**:

- `pit-crew.opponent-pit-leader` — `family: "opponent-pit-leader"`, `where: relation === "leader"`.
- `pit-crew.opponent-pit-ahead` / `-behind` / `-nearby` / `-others` — `family: "opponent-pit"`, `where:` on their relation.

The leader family is separate so a caution pit train (leader + aggregate emitted in the same flush) plays as the issue's desired sequence — "The leader is pitting." then "And it seems there are other cars pitting as well." — instead of the aggregate preempting the leader line mid-sentence (family preemption replaces an in-flight family-mate regardless of weight). Within the `opponent-pit` family, preemption deliberately lets a newer entry supersede a stale in-flight one.

Scheduling on all five: `weight: 65` (the pit-window value — above chatter, below flags), `interrupt: false`, `queueable: true`. Sequences wrap in the standard radio frame (`@pit-crew.radio-open` / `@pit-crew.radio-close`).

The `-nearby` scenario's number resolves **at speak time**: `registerOpponentPitVars(engine, getSnapshot)` defines `opponentPit.number` returning `poolRef("position-number", String(n))` from the snapshot. The scenarios themselves are a **static `OPPONENT_PIT_ALERTS` array** (their `where:` predicates read only the event payload; only the var closes over the resolver, so the pit-window static shape + a vars-registration function is the right split — the corner-name builder shape isn't needed). The snapshot already carries the live-with-payload-fallback position (composed in the plugin resolver); a null snapshot aborts the callout (#835).

Pools: `POOL_REGISTRY` entries for `opponent-pit-leader`, `opponent-pit-ahead`, `opponent-pit-behind`, `opponent-pit-others`, `opponent-pit-car-in`, and `opponent-pit-is-pitting` (the splice intro/tail are ordinary pools so future variants are clip-file additions). The nearby sequence is `radio-open` + `pool:opponent-pit-car-in` + `{ var: "opponentPit.number" }` + `pool:opponent-pit-is-pitting` + `radio-close`.

Family wiring in `index.ts`: `OpponentPitCalloutId = "leader" | "nearby"`; `OPPONENT_PIT_CALLOUT_SETTING_KEYS = { leader: "calloutEnabledOpponentPitLeader", nearby: "calloutEnabledOpponentPitNearby" }`; `SCENARIO_ID_TO_OPPONENT_PIT_ID` maps the leader scenario → `leader` and the other four → `nearby`; scenarios wrapped `wrapWithMaster(wrapCalloutScenario(...))`. New `registerPitCrew` parameters at positions **41** (`getOpponentPitCalloutEnabled`) and **42** (`getOpponentPitSnapshot`), pushing the two master gates to 43/44.

## Settings + PI (`@iracedeck/deck-core`, `@iracedeck/iracing-actions`)

- Two Zod fields in `GlobalSettingsSchema` next to `calloutEnabledPitOpenClosed`: `calloutEnabledOpponentPitLeader` / `calloutEnabledOpponentPitNearby`, the standard `z.union([z.boolean(), z.string()]).transform(...).default(true)` coercion.
- `pit-crew.ejs`: new "Opponent Pits" grid item after "Pit Window" in the Race Engineer Callouts accordion — the array-driven 2-column pattern, two checkboxes ("Leader pitting", "Nearby competitor pitting"), `default="true"`.

## Plugins (all three)

`iracing-plugin-stream-deck`, `iracing-plugin-mirabox`, **and `iracing-plugin-ulanzi`** (the callout rule's "BOTH plugins" is stale — Ulanzi has its own byte-identical `registerPitCrew` call site; the rule gets fixed in this PR). Each adds, before the two master-gate closures:

- the live-read opt-in closure `(id: OpponentPitCalloutId) => getGlobalSettings()[OPPONENT_PIT_CALLOUT_SETTING_KEYS[id]] !== false`;
- a snapshot resolver: an `opponentPit.entered` subscription caches the latest payload, and the resolver returns `{ position }` from `getLiveCarPosition(carIdx)` with payload-position fallback.

## Scenario harness

New "Opponent Pit" category in `scenario-shortcuts.ts`: leader, ahead, behind, nearby (explicit position, e.g. P4), and aggregate buttons publishing `opponentPit.entered` directly. New `event-names.ts` template (compile-enforced). The harness `main.ts` `registerPitCrew` call currently ends at arg 40, so the two new params default — it gains its own snapshot resolver (cached last payload) so the nearby button speaks a number.

## Tests

- `diff/opponent-pit.test.ts`: first-tick seeding; single transition per relation (leader/ahead/behind/±2); same-lap score filter; class filter in multi-class; player/pace-car/not-in-world skips; per-car cooldown; aggregation (3rd entry → others, 4th silent, episode reset after quiet, leader individual mid-aggregation); race-only/replay-only/pre-green gating; explicit `now` threading (the `pit-lane.test.ts` pattern).
- Scenario tests: registration + where-branching + opt-in mapping in `register-pit-crew.test.ts`; a dedicated `opponent-pit.test.ts` for the speak-time number resolution and fallback.
- Positional-arg updates in exactly three files: `rolling-start.test.ts`, `start-lights.test.ts`, `register-pit-crew.test.ts` (masters shift to 43/44).
- `simhub-service.test.ts`: both object literals gain the two new keys.
- Translator export test for `getLiveCarPosition`.

## Docs / website / skills / rules

- Website `pit-crew.md`: behaviour section + per-subject opt-in entry ("Under **Opponent Pits**, two callouts…").
- `changelog.mdx`: one `**Features**` line under `## 2.4.0`.
- Internal `docs/plugins/core/actions/pit-crew.md` voice-coverage section.
- `.claude/skills/iracedeck-actions/SKILL.md` Pit Crew row (callout-family enumeration).
- `.claude/rules/race-positions.md` consumer list (+`getLiveCarPosition`).
- `.claude/rules/race-engineer-callouts.md` step 8: "BOTH plugins" → all three (Ulanzi).
- `.claude/rules/race-engineer-callout-examples.md`: new #622 entry (per-car array diff + burst aggregation + two-family preemption split + per-car live position at speak time).

## Error handling summary

- Missing/short telemetry arrays → car skipped that tick, no crash (optional chaining like `race-finish.ts`).
- Unresolvable player/pace carIdx → diff returns without emitting.
- Frozen-order rank 0 (unclassified car) → car doesn't qualify.
- Speak-time live position null → payload fallback → abort only when both missing (#835: whole-callout abort, never a fragment).
- Replay scrubs/session changes → state wiped and reseeded silently; no announcements from stale baselines.

## Manual test plan

1. Harness: all five shortcut buttons play the right lines; nearby speaks the number; mid-session PI toggles silence future fires without cutting in-flight audio; master gate off silences everything.
2. iRacing (road race, AI works): drive near AI cars pitting — verify leader/ahead/behind/±2 lines and the position number; confirm nothing announced for cars 3+ positions away or lapped cars.
3. iRacing oval with caution pit train: verify entries 1–2 individual, then one aggregate, then silence; leader announced individually.
4. Validate the risk item: `AproachingPits` is actually reported for remote cars (netcode LOD) — if distant cars never report it, only the pit-train case matters and the window still catches them near the player.
