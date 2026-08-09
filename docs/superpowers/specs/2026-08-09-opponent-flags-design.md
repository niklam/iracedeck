# Opponent Penalty Flags + Leader White — Design (issue #936)

Date: 2026-08-09
Issue: #936 — Race Engineer: announce other drivers' flags — nearby penalty flags (furled / black / meatball / DQ) + the leader's white flag
Branch: `ir-936`

## Summary

Two strands, one PR:

1. **Opponent penalty flags** — announce penalty flags shown to other drivers near us, read from `CarIdxSessionFlags` (per-car `irsdk_Flags` bitfield, typed but previously consumed nowhere). Two trigger edges: a qualifying car's flag **rises**, or a car with an already-active flag **enters our window**. A new pit-crew family (`opponent-flag`) with per-flag opt-ins.
2. **Leader's white flag** — announce when the overall leader starts their final lap ("The leader is about to start their final lap."), detected from lap counting (not the per-car White bit), riding the existing `calloutEnabledFlagWhite` opt-in as a third stage of the white family.

Step 0 telemetry validation is done for the core premise (opponents' Black bits populate — `0x50000` on two flagged AI opponents while the player read `0x40000`); the remaining confirmations (Furled/Repair/Disqualify population, sim-earned penalties, human fields, far-away culling) are non-blocking and fold in opportunistically.

## Decisions made during brainstorming

- **Reusability (explicit requirement):** the per-car flag data must be consumable beyond this callout. No concrete second consumer yet — keep the seam clean per the #933 gaps precedent (pure helpers in `iracing-sdk`, stateful store in the translator, a `getLive*()` accessor), no speculative plumbing.
- **Architecture:** layered flag store (chosen over event-only and bus-published state sync). **Store = truth, qualifier = policy**: the store holds raw decoded per-car penalty flags with no debounce; announcement policy (debounce, episodes, cooldowns, aggregation) stays private to the diff.
- **One PR, both strands** — one worktree, one review cycle, one changelog line; #936 closes on merge.
- **Track-gap estimate:** forward `CarIdxLapDistPct` delta folded around the lap × `trackLengthMeters` (the #574 cache) ÷ player speed with a ~10 m/s floor. Not `CarIdxEstTime` (unverified semantics around pit lane/lap boundaries), and explicitly not the #933 crossing-time traces (per the issue — opposite accuracy/coverage trade-off). Coarse is fine: it's a window boundary, never spoken.
- **Window hysteresis:** in at ≤ 10 s, out at > 12 s; range-entry re-arms only after leaving.
- **Weights (plan-review refinement, approved):** weight by **relation**, not by trigger — `track-ahead` scenarios at `WEIGHT.SAFETY` (the approaching-an-impaired-car safety case IS the track-ahead relation), `ahead`/`behind`/aggregate at `WEIGHT.NORMAL`. All `queueable: true`, `interrupt: false`, **family-less** (the #622/#923 rationale: lines describe different cars and sustained states — queue, never chop, never drop).
- **Scenario split (plan-review refinement, approved):** one scenario per flag × relation (12) plus one aggregate — 13 scenarios. Both diff triggers ride the same scenario: the wording ("has a meatball") is true for raise and range-entry alike, so per-trigger scenarios would double the clip count for nothing, and per-relation scenarios keep every line individually harness-firable (the #622 shape). The `trigger` field stays in the event payload for the harness/future consumers; audio ignores it.
- **Aggregate opt-in mapping:** the aggregate scenario maps to the `black` callout id (the #622 shape, where `others` rides `nearby`) — the wording is penalty-generic and black is the central penalty subject.
- **Leader white:** lap-count detection only; the per-car White bit is not consulted at all (unconfirmed per Step 0 — if a future capture proves it populates, that's a follow-up simplification).
- **"Behind" relation stays standings-P+1 only** (the issue's current scope); track-behind is out of scope.
- **No "cleared / penalty served" callouts** (possible follow-up).

## Canonical types (`@iracedeck/event-bus`)

New enum, exported as a **value** (the `RadarState` / `PitServiceKind` convention):

```typescript
export enum OpponentPenaltyFlag {
  Furled = "furled",
  Black = "black",
  Repair = "repair", // the meatball — canonical name follows the sim bit
  Disqualify = "disqualify",
}
```

Two new `SimEventMap` entries:

```typescript
"opponentFlag.flagged": SimEvent<"opponentFlag.flagged", {
  /** Who the car is relative to the player. "others" is the aggregate tail. */
  relation: "ahead" | "behind" | "track-ahead" | "others";
  /** Absent for "others". */
  carIdx?: number;
  flag?: OpponentPenaltyFlag;
  /** What crossed: the flag bit rose, or an already-flagged car entered the window. Absent for "others". */
  trigger?: "raised" | "entered-range";
  /** Effective position at emit time (class position in multi-class, the #622 shape). Absent for "others". */
  position?: number;
  /** Coarse forward track gap in seconds — present for "track-ahead" only. */
  gapSeconds?: number;
  isMultiClass?: boolean;
}>;

"flag.white-leader.raised": SimEvent<"flag.white-leader.raised", EmptySimEventPayload>;
```

## Pure layer (`@iracedeck/iracing-sdk`)

- New `penalty-flag-utils.ts`: `decodePenaltyFlags(bits: number | undefined): CarPenaltyFlags` returning `{ furled, black, repair, disqualify }` booleans over the `Flags` masks, plus `PENALTY_FLAG_MASK`. iracing-sdk speaks **sim bits**; the translator maps to the canonical event-bus enum (iracing-sdk does not import event-bus — same layering as `gap-utils`).
- `gap-utils.ts` gains the coarse forward-gap estimate (pure): folded forward `LapDistPct` delta × track length ÷ floored player speed. Returns `null` when track length is unknown — the track-ahead window is then simply unavailable (standings relations unaffected); don't punish missing data.

## Translator (`@iracedeck/sim-events-iracing`)

### Flag-state store + accessor (truth)

New `diff/opponent-flags.ts`, called from `handleTick` beside `diffOpponentPit` (after `calculateFrozenRacePositions`, consuming the same frozen order per `race-positions.md`). Every tick it decodes each car's penalty bits into per-car state sized from the **actual array length** (never 64 — the Step 0 capture had length 72 with the pace car at index 64).

New accessor in `translator.ts`:

```typescript
/** Cars currently showing any penalty flag. Null before the first store tick. */
export function getLiveOpponentFlags(): LiveOpponentFlags | null;
// LiveOpponentFlags = { cars: Array<{ carIdx: number; flags: OpponentPenaltyFlag[] }> }
```

The accessor reflects raw current truth (post-decode, pre-policy) and is the reusable seam. Added to the `race-positions.md`-style consumer discipline: future consumers read this, never re-derive from `CarIdxSessionFlags` themselves.

### Callout qualifier (policy)

- **Raise trigger:** a penalty bit rises on a qualifying car (edge vs the per-car previous-tick bit baseline). The **furled raise is debounced 1 s per car** (the #669 shape: pending-timestamp array, re-check the bit is still up when the window elapses, drop silently on flicker).
- **Range-entry trigger:** a car with an active flag transitions from outside to inside the qualification window (per-car membership boolean with the 10 s/12 s hysteresis; standings-window membership has no hysteresis — position deltas are discrete).
- **Qualification window** (any of): 1–3 class positions ahead, same class, same lap; directly behind (class P+1), same class, same lap; ahead on track within the gap window, any class/lap status. Standings relations from the frozen order via `classPositionFromOrder` (#588 class space); same-lap via the lap-progress score form (`|scoreP − scoreC| < 1.0`). A car matching both standings-ahead and track-ahead reports the standings relation.
- **Dedup:** once per car per flag episode, shared by both triggers — a per-car announced-bitmask keyed on the sim `Flags` bits; a flag's own bit dropping ends that flag's episode. The furled→black escalation transition (iRacing clears `Furled` and sets `Black` in one tick, #846) announces only the black raise; the simultaneous furled falling edge must not be treated as anything (no cleared callouts exist) and must clear any pending furled debounce.
- **Per-(car, flag) cooldown:** 30 s (`OPPONENT_FLAG_CAR_COOLDOWN_MS`), keyed per flag rather than per car (plan-review refinement, approved) — a per-car cooldown would suppress "Disqualified" for 30 s after the black-flag line on the same car; escalations must announce immediately.
- **Burst aggregation:** the #622 rolling-window shape with its own constants — 12 s window, threshold 3, `opponentFlagAggregateAnnounced` episode flag gating collapse (not the live count), quiet-window reset. Individual lines below threshold; the entry reaching threshold emits one `relation: "others"`.
- **Gating in the diff** (the #622 gate set): race session, not replay-only (#604), not pre-green (#647), not post-race, `playerCarIdx >= 0`; pace car excluded via the existing `resolvePaceCarIdx`. Baselines and the store advance every tick even when gated — a gated transition is absorbed, never replayed.

### State (`state.ts` — type AND `createInitialState` in sync)

`opponentFlagsInitialized`, `opponentFlagLastBits: number[]` (baseline), the store array, `opponentFlagFurledPendingAt: number[]` (0-sentinel), `opponentFlagAnnouncedMask: number[]`, `opponentFlagCarCooldownUntil: number[]`, `opponentFlagInWindow: boolean[]`, `opponentFlagRecentEntries: number[]`, `opponentFlagAggregateAnnounced: boolean`, plus the leader-white fields below.

`wipeStateForReplay`: episode/aggregation/cooldown/window state **preserved** (the #622 preserved-cluster precedent — an incident-replay glance must not reset mid-episode); the bit baseline re-seeds.

### Leader white (`diff/leader-white.ts`)

Separate small diff module (different subject, different state; SRP):

- **Lap-limited races:** leader-relative `SessionLapsRemainEx` (#880-validated frame of reference) falling to 1.
- **Timed races:** the leader's first scored crossing (leader's `CarIdxLapCompleted` increment) after `SessionTimeRemain` expiry — the #880 white-lap model. Dual-limit races: whichever edge lands first wins the latch.
- Leader = **overall** P1 from the frozen canonical order (their final lap ends the race for everyone in multi-class).
- **Latch:** once per race; re-armed by a green rising edge (overtime / same-SessionNum admin restart — the #880 sticky-latch lesson) and by the per-session reset.
- **Suppression:** skip when the player is the leader; skip when the player's own `SessionFlags.White` is already up at detection time (the #772 heads-up owns that moment — never both back to back).
- **Gates:** race session only, not replay-only, not pre-green.
- Emits `flag.white-leader.raised`.

## Audio scenarios (`@iracedeck/audio-scenarios`)

New `catalog/pit-crew/opponent-flags.ts`:

- **13 scenarios:** `pit-crew.opponent-flag-<flag>-<relation>` for furled/black/meatball/disqualify × ahead/behind/track-ahead (12), plus `pit-crew.opponent-flag-others`. Scenario ids use the spoken subject names (`meatball`, not `repair`). All family-less, `queueable: true`, `interrupt: false`; weight by relation — track-ahead at `WEIGHT.SAFETY`, ahead/behind/aggregate at `WEIGHT.NORMAL`. Both diff triggers ride the same scenarios (audio ignores `trigger`).
- **Sequences** compose a relation part and a flag part (exact clip inventory settled at the wording dry-run): relation intros for ahead/behind/track-ahead (position-bearing variants splice the existing `position-number` group, the #622 three-part shape with `previous_request_ids` prosody continuity), flag phrases per flag per trigger (raise wording ≈ "P5 ahead picked up a meatball — expect them to slow."; range-entry wording ≈ "The car ahead has a meatball — careful, they may be slow.").
- **Speak-time position:** the `where:` predicate writes a pending stash **after every gate** (opt-in wrappers included) carrying `carIdx` + emit-time fallbacks; the var resolver prefers a live `getLiveCarPosition(carIdx)` read in the payload's `isMultiClass` projection (the #622/#922/#933 rules — the stash's `carIdx` lets the resolver drop the number when the live car no longer matches).
- **Family wiring** (`index.ts`): `OpponentFlagCalloutId = "furled" | "black" | "meatball" | "disqualify"`, `OPPONENT_FLAG_CALLOUT_SETTING_KEYS`, `SCENARIO_ID_TO_OPPONENT_FLAG_ID` (aggregate → `black`), `getOpponentFlagCalloutEnabled` param added **before** the master param, scenarios wrapped `wrapWithMaster(wrapCalloutScenario(...))`.
- **Leader white** added to the white family in `flag-alerts.ts`: `pit-crew.flag-white-leader` on `flag.white-leader.raised`, `family: "flag"`, `queueable: true`, `WEIGHT.SAFETY` (the flag-family band), mapping to `FlagCalloutId "white"` in `SCENARIO_ID_TO_FLAG_ID` — no schema/PI/plugin change for this strand.

## Voice lines (`@iracedeck/audio-assets`)

- New `opponent-flags` group in `configs/default.voice.json`; new `flags/white-leader-01` entry in the flags group.
- **Checkpoint:** scoped dry-run (`generate:dry-run --group ...`) showing every wording for approval before any generation; `.env.local` copied from the master checkout; clips + `generate.manifest.json` + `manifest.json` committed.

## Opt-ins (`@iracedeck/deck-core`) + PI + plugins

- Four Zod fields in `GlobalSettingsSchema` — `calloutEnabledOpponentFlagFurled/Black/Meatball/Disqualify` — standard string/boolean coercion, `default(true)` (new Race Engineer functionality defaults ON).
- `pit-crew.ejs`: an "Opponent Flags" `sdpi-item` using the auto-balancing 2-column grid pattern.
- All three plugin `plugin.ts` files (byte-identical): live-read closure over `OPPONENT_FLAG_CALLOUT_SETTING_KEYS`.

## Scenario harness

- `event-names.ts` entries for `opponentFlag.flagged` and `flag.white-leader.raised` (compile-time completeness check).
- Shortcut buttons: one per flag per trigger (8), aggregate, leader white — category `Opponent Flags` (leader white under the existing flags category).

## Testing

- **Pure utils:** decode masks; folded-gap math (wrap-around, speed floor, unknown track length → null).
- **Opponent-flags diff** (explicit `now`, the `pit-lane.test.ts` pattern): first-tick seeding; single raise per flag; furled debounce (flicker silent, sustained fires, escalation mid-debounce cancels pending); escalation announces black only and doesn't re-open the furled episode; range-entry with hysteresis (enter fires once, hover at boundary doesn't re-fire, leave-and-re-enter re-fires); episode latch shared across triggers; per-car cooldown; aggregation (threshold collapse, episode flag holds through pruning, quiet-window reset, leader-independence not applicable here); every gate (non-race, replay-only, pre-green, post-race, unresolved player); pace-car + player exclusion; arrays longer than 64 with the pace car at index 64 (the Step 0 capture's exact shape); `wipeStateForReplay` preservation; store/accessor truth (flag visible pre-debounce via accessor while the callout debounces).
- **Leader-white diff:** lap-limited edge; timed-race crossing-after-expiry; dual-limit; green re-arm; both suppressions; gates.
- **Scenarios:** mirror `opponent-pit.test.ts` — where: routing per relation/trigger, stash write-after-gates, live-position resolver fallback, opt-in wrapping, aggregate mapping.
- **Fixtures:** `simhub-service.test.ts` both literals; every positional `registerPitCrew(...)` caller (`grep -rl`).
- Full `pnpm build` (tsc catches what vitest won't) + `pnpm test` + `pnpm lint:fix` + `pnpm format:fix`; no watcher is running, so all builds are manual.

## Error handling

- Missing `CarIdxSessionFlags` → diff no-ops that tick (store keeps last truth; accessor unchanged).
- Unknown track length or stationary player → track-ahead window unavailable; standings relations unaffected.
- Missing lap-progress data for a car → that car doesn't qualify (never misread a lapped car as same-lap, the #622 rule).
- Missing live position at speak time → emit-time payload fallback; mismatched stash `carIdx` → drop the spoken number, not the line.

## Documentation

- Changelog (`changelog.mdx`) — one line under the in-development version.
- Website Race Engineer callout docs.
- `race-engineer-callout-examples.md` — new entry naming the patterns (flag-state store + truth/policy split), added with the PR number.
- `race-positions.md` consumer list (the diff consumes the frozen order; `getLiveOpponentFlags` documented as the flag-data seam).

## Out of scope

- Flag-cleared / penalty-served callouts.
- Track-behind window membership.
- Consulting the per-car White bit for leader detection.
- Any second consumer of `getLiveOpponentFlags()` (Session Info mode, template variables) — the seam exists; consumers are follow-ups.

## Open items

- Final wordings — settled at the scoped dry-run checkpoint before generation.
- Remaining Step 0 confirmations (Furled/Repair/DQ population for opponents, sim-earned penalties, human fields, far-away culling) — non-blocking; fold findings into #936 as they arrive. Furled degrades cleanly if the bit never populates for opponents: the callout simply never fires.
