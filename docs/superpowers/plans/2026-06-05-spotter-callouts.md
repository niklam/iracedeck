# Spotter Proximity Callouts (#651) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in "Spotter calls" voice family to the Race Engineer — spoken side-awareness ("car left", "two cars right", "three wide", "one car left", "clear", and a repeating "still there") driven off the existing `radar.changed` event, with road (left/right) vs oval (inside/outside) terminology and a side-by-side focus gate that holds back routine chatter while a car is alongside.

**Architecture:** A new imperative `spotter-engine.ts` (mirroring `radar-engine.ts`) owns a state machine over `RadarState`. Unlike radar (which plays directly on `AudioChannel.Radar`), the spotter schedules through the **#652 interpreter** via `engine.fire("pit-crew.spotter-call")`, where that single scenario plays a `{var:"spotterClip"}` step whose value the engine computes per transition. The engine acquires/releases an exclusive-focus floor (`WEIGHT.SAFETY`) on `AudioBus.Voice` while a car is alongside. **All clip selection is var-driven (no new pools)** so nothing depends on the audio manifest at load time.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces, Zod, the audio-scenarios interpreter (#652 weight/focus model), EJS Property Inspector templates.

---

## Decisions locked during brainstorming (do NOT re-litigate)

1. **One clip per transition.** Each callout is a single pre-recorded clip; the engine never sequences multiple clips into one callout. De-escalation/swap wording is baked into single combined clips.
2. **No `<break>` SSML** in any spotter clip text. (The flags group uses `<break>`; spotter must not.)
3. **Two PI opt-ins** (default `true`): `calloutEnabledSpotterCars` (every transition call — car/two cars/one car/three wide/clear/combined) and `calloutEnabledSpotterStillThere` (the ~4 s loop). Plus the master mode button `pitCrewSpotterEnabled` (default `false`).
4. **2→1 de-escalation announces** "One car left." (symmetric with the 1→2 "Two cars left." escalation).
5. **Combined de-escalation/swap clips** carry both cues in one clip and are gated by `calloutEnabledSpotterCars`.

## OPEN DECISIONS — resolve before/at execution (flagged for the user)

- **D1 — Radio framing.** The issue suggested wrapping each spotter call in the `@pit-crew.radio-open` / `@pit-crew.radio-close` walkie framing (like flags). Given the "terse, immediate, standalone" intent and that the Radar it coexists with is unframed, this plan defaults to **NO framing** (the `spotter-call` sequence is just `[{var:"spotterClip"}]`). Flip to framed by changing one sequence array if desired.
- **D2 — "Two cars" combined variants.** The four `clear-*-two-cars-*` clips cover rare both→two-X / two-X→two-Y transitions accurately. This plan **includes them** for correctness. To drop them (use singular "Car" on the remaining side for those rare cases), the engine's `combinedClip()` would ignore `remainingCount`.

---

## Clip catalog (25 clips/voice, path `voice/{voice}/spotter/<name>.mp3`)

| name | text | category |
|---|---|---|
| `car-left` | "Car left." | road level |
| `car-right` | "Car right." | road level |
| `two-cars-left` | "Two cars left." | road level |
| `two-cars-right` | "Two cars right." | road level |
| `one-car-left` | "One car left." | road level |
| `one-car-right` | "One car right." | road level |
| `car-inside` | "Car inside." | oval level |
| `car-outside` | "Car outside." | oval level |
| `two-cars-inside` | "Two cars inside." | oval level |
| `two-cars-outside` | "Two cars outside." | oval level |
| `one-car-inside` | "One car inside." | oval level |
| `one-car-outside` | "One car outside." | oval level |
| `three-wide` | "Three wide." | shared |
| `clear-right-car-left` | "Clear right. Car left." | road combined |
| `clear-left-car-right` | "Clear left. Car right." | road combined |
| `clear-right-two-cars-left` | "Clear right. Two cars left." | road combined |
| `clear-left-two-cars-right` | "Clear left. Two cars right." | road combined |
| `clear-outside-car-inside` | "Clear outside. Car inside." | oval combined |
| `clear-inside-car-outside` | "Clear inside. Car outside." | oval combined |
| `clear-outside-two-cars-inside` | "Clear outside. Two cars inside." | oval combined |
| `clear-inside-two-cars-outside` | "Clear inside. Two cars outside." | oval combined |
| `clear` | "Clear." | clear pool |
| `still-there` | "Still there." | still-there pool |
| `hold-your-line` | "Hold your line." | still-there pool |

---

## State machine (the heart of the engine)

`RadarState = "clear" | "left" | "right" | "both" | "two-left" | "two-right"`. Per-side car counts:
`clear{L:0,R:0} left{1,0} right{0,1} both{1,1} two-left{2,0} two-right{0,2}`.

`termFor(side, dir)` — maps a physical side to spoken term given `TrackDirection`:

| dir | left side | right side |
|---|---|---|
| `neutral`/unknown (road) | "left" | "right" |
| `left` (left-going oval) | "inside" | "outside" |
| `right` (right-going oval) | "outside" | "inside" |

`handleTransition(old, new, dir)` (called only when master on, not pit-road, not Lone Qualify, and `new !== old`):

```text
resetLoopTimer()

if new == "clear":
  if carsEnabled: fireClip(pickClearPool())     // "Clear." / "Clear! Clear!"
  releaseFocus()
  return

acquireFocusIfNeeded()

if new == "both":
  if carsEnabled: fireClip("voice/{voice}/spotter/three-wide.mp3")
  startLoop()
  return

// new is one-sided (left/right/two-left/two-right)
occupied = the side with count > 0
n        = count(new, occupied)          // 1 or 2
other    = the other side
if carsEnabled:
  if count(old, other) > 0:
    // other side just cleared while occupied keeps car(s) → combined clip
    fireClip(combinedClip(other, occupied, n, dir))
  else if count(old, occupied) == 0:
    fireClip(levelClip(occupied, n, dir))        // 0→1 car / 0→2 two-cars
  else if n > count(old, occupied):
    fireClip(levelClip(occupied, 2, dir))        // 1→2 two-cars
  else:
    fireClip(levelClip(occupied, 1, dir, /*oneCar*/true))  // 2→1 one-car
startLoop()
```

- `levelClip(side, count, dir, oneCar=false)` → `car-<term>` (count 1, not oneCar) | `two-cars-<term>` (count 2) | `one-car-<term>` (oneCar). `<term> = termFor(side, dir)`.
- `combinedClip(clearedSide, remainingSide, remainingCount, dir)` → `clear-<termCleared>-{car|two-cars}-<termRemaining>` where the count word is `car` (1) or `two-cars` (2). Maps to the combined-clip names above.
- `fireClip(path)`: `pendingSpotterClip = path; getScenarioEngine().fire("pit-crew.spotter-call")`.
- `pickClearPool()` / loop `pickStillTherePool()`: engine-owned arrays + `lastIndex` no-repeat (don't use interpreter pools — that would create a manifest dependency).
- `startLoop()`: `setTimeout(tick, SPOTTER_STILL_THERE_INTERVAL_MS)`; `tick` re-checks master + StillThere opt-in live, fires a still-there pick, reschedules. `resetLoopTimer()` clears it.
- Focus: `acquireFocusIfNeeded()` → if not already held, `getScenarioEngine().acquireFocus(AudioBus.Voice, SPOTTER_FOCUS_OWNER, WEIGHT.SAFETY)`. `releaseFocus()` → `getScenarioEngine().releaseFocus(AudioBus.Voice, SPOTTER_FOCUS_OWNER)`. Tied to master+state only (not the opt-ins).
- `forceClear()` (master off / pit-road / Lone Qualify): `resetLoopTimer(); releaseFocus();` set internal state `clear`, no clip.

`SPOTTER_FOCUS_OWNER = "spotter"`; the `pit-crew.spotter-call` scenario sets `focusOwner: "spotter"`, `weight: WEIGHT.SAFETY`, `family: "spotter"`, `interrupt: true`, `queueable: false`, `channel: AudioChannel.Voice`, `bus: AudioBus.Voice`, `sequence: [{ var: "spotterClip" }]` (D1: unframed).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `packages/sim-events-iracing/src/track-type.ts` | add `TrackDirection` enum + `resolveTrackDirection()` | Modify |
| `packages/sim-events-iracing/src/track-type.test.ts` | tests for resolver | Create/Modify |
| `packages/sim-events-iracing/src/translator.ts` | add `getTrackDirection()` getter (reads latest session info) | Modify |
| `packages/sim-events-iracing/src/index.ts` | export `resolveTrackDirection`, `TrackDirection`, `getTrackDirection` | Modify |
| `packages/deck-core/src/global-settings.ts` | add 3 schema fields | Modify |
| `packages/audio-scenarios/src/catalog/pit-crew/spotter-engine.ts` | the state machine, focus, loop, var+scenario, `registerSpotterEngine`, `setSpotterEnabled`/`isSpotterEnabled` | Create |
| `packages/audio-scenarios/src/catalog/pit-crew/spotter-engine.test.ts` | engine unit tests | Create |
| `packages/audio-scenarios/src/catalog/pit-crew/index.ts` | `SpotterCalloutId`, `SPOTTER_CALLOUT_SETTING_KEYS`, register params + `registerSpotterEngine` call + re-exports | Modify |
| `packages/audio-scenarios/src/catalog/pit-crew/register-pit-crew.test.ts` | new trailing args | Modify |
| `packages/iracing-actions/src/actions/pit-crew/pit-crew.ts` | `spotter` mode, `toggleSpotter`, presentation, key handling | Modify |
| `packages/iracing-actions/src/actions/pit-crew/pit-crew.test.ts` | spotter mode tests | Modify |
| `packages/iracing-actions/src/actions/pit-crew/pit-crew.ejs` | spotter mode option + Spotter accordion (2 checkboxes) | Modify |
| `packages/iracing-plugin-stream-deck/src/plugin.ts` | spotter closures + `registerPitCrew` trailing args | Modify |
| `packages/iracing-plugin-mirabox/src/plugin.ts` | same | Modify |
| both plugins' `manifest.json` | tooltip mention (optional) | Modify |
| `packages/audio-assets/configs/*.voice.json` | `spotter` group text in EVERY voice config | Modify |
| `packages/website/src/content/docs/docs/actions/audio-voice/pit-crew.md` | Spotter section | Modify |
| `docs/plugins/core/actions/pit-crew.md` | Spotter docs | Modify |
| `packages/audio-scenarios/CLAUDE.md` | second imperative engine + focus gate | Modify |
| `.claude/rules/race-engineer-callout-examples.md` | #651 entry | Modify |
| `iracedeck-actions` skill data | spotter mode/callouts if enumerated | Modify |

`radar.changed` is reused — **no new bus event, no translator diff, no scenario-harness shortcut** (the existing Radar shortcuts in `scenario-shortcuts.ts` already emit `radar.changed`, which drives the spotter too; note this in the harness comment only if helpful).

---

## Task 1 — `resolveTrackDirection` in sim-events-iracing

**Files:**
- Modify: `packages/sim-events-iracing/src/track-type.ts`
- Test: `packages/sim-events-iracing/src/track-type.test.ts`
- Modify: `packages/sim-events-iracing/src/index.ts`

- [ ] **Step 1: Write failing tests** in `track-type.test.ts`:
  - `resolveTrackDirection(null)` → `TrackDirection.Neutral`
  - `{ WeekendInfo: { TrackDirection: "neutral" } }` → `Neutral`
  - `"left"` → `Left`; `"right"` → `Right`; mixed case/whitespace (`" Left "`) → `Left`
  - missing `TrackDirection` / non-string → `Neutral`
  - unknown string (`"clockwise"`) → `Neutral`

- [ ] **Step 2:** Run `pnpm --filter @iracedeck/sim-events-iracing test track-type` — expect FAIL.

- [ ] **Step 3: Implement** (append to `track-type.ts`, mirroring `resolveTrackType`):

```typescript
/** Track rotation direction. Unknown/neutral tracks (road courses) map to `Neutral`. */
export enum TrackDirection {
  Neutral = "neutral",
  Left = "left",
  Right = "right",
}

/**
 * Resolve `WeekendInfo.TrackDirection` to a {@link TrackDirection}. Drives the
 * spotter's road (left/right) vs oval (inside/outside) terminology (issue #651):
 * a left-going oval makes the left side "inside"; a right-going oval reverses it;
 * neutral/unknown stays left/right.
 *
 * @internal Exported for testing.
 */
export function resolveTrackDirection(sessionInfo: Record<string, unknown> | null): TrackDirection {
  if (!sessionInfo) return TrackDirection.Neutral;

  const weekendInfo = sessionInfo.WeekendInfo as Record<string, unknown> | undefined;
  const raw = weekendInfo?.TrackDirection;

  if (typeof raw !== "string") return TrackDirection.Neutral;

  switch (raw.trim().toLowerCase()) {
    case "left":
      return TrackDirection.Left;
    case "right":
      return TrackDirection.Right;
    default:
      return TrackDirection.Neutral;
  }
}
```

  NOTE: verify the real `WeekendInfo.TrackDirection` values in iRacing mock/session data (the exploration found `"neutral"`/`"left"`/`"right"`). Adjust the `case` labels if the SDK uses different strings.

- [ ] **Step 4:** Run the test — expect PASS.

- [ ] **Step 5: Add `getTrackDirection()` getter** in `translator.ts`. Find how `getSessionType()` reads the cached session info (it parses `WeekendInfo`); add a sibling that returns `resolveTrackDirection(<cached session info>)`. If the translator already holds parsed session info, reuse it; otherwise mirror `getSessionType`'s source exactly. Export it.

- [ ] **Step 6: Export** from `index.ts`: `resolveTrackDirection`, `TrackDirection`, `getTrackDirection`.

- [ ] **Step 7:** Run `pnpm --filter @iracedeck/sim-events-iracing build` and `… test` — expect PASS.

- [ ] **Step 8: Commit** `feat(sim-events-iracing): resolveTrackDirection + getTrackDirection getter (#651)`.

---

## Task 2 — Global settings schema (deck-core)

**Files:** Modify `packages/deck-core/src/global-settings.ts` (+ its test if one asserts field defaults).

- [ ] **Step 1:** Add three fields to `GlobalSettingsSchema`, next to `pitCrewRadarEnabled`:

```typescript
// Spotter calls master toggle (issue #651). Opt-in (default off), mirrors radar.
pitCrewSpotterEnabled: z
  .union([z.boolean(), z.string()])
  .transform((val) => val === true || val === "true")
  .default(false),
// Spotter per-callout opt-ins (issue #651). "Cars" gates every transition
// call (car/two cars/one car/three wide/clear/combined); "StillThere" gates
// the ~4 s repeating reminder while a car is alongside.
calloutEnabledSpotterCars: z
  .union([z.boolean(), z.string()])
  .transform((val) => val === true || val === "true")
  .default(true),
calloutEnabledSpotterStillThere: z
  .union([z.boolean(), z.string()])
  .transform((val) => val === true || val === "true")
  .default(true),
```

- [ ] **Step 2:** If a test enumerates defaults, add assertions: `pitCrewSpotterEnabled` → `false`, the two callout fields → `true`.

- [ ] **Step 3:** Run `pnpm --filter @iracedeck/deck-core build && pnpm --filter @iracedeck/deck-core test` — expect PASS.

- [ ] **Step 4: Commit** `feat(deck-core): spotter global settings fields (#651)`.

---

## Task 3 — `spotter-engine.ts` (state machine + focus + loop) — TDD

**Files:**
- Create: `packages/audio-scenarios/src/catalog/pit-crew/spotter-engine.ts`
- Create: `packages/audio-scenarios/src/catalog/pit-crew/spotter-engine.test.ts`

Mirror `radar-engine.ts` structure (module-level state, `register…`, `set…Enabled`, `_reset…` for tests). Key differences: routes through `getScenarioEngine().fire(...)` + focus, owns the var + scenario, and reads `getTrackDirection`.

**Public surface:**
```typescript
export const SPOTTER_FOCUS_OWNER = "spotter";
export const SPOTTER_STILL_THERE_INTERVAL_MS = 4000;
export const SPOTTER_CALL_SCENARIO_ID = "pit-crew.spotter-call";

export type SpotterDeps = {
  getMasterEnabled: () => boolean;             // pitCrewSpotterEnabled
  getCarsEnabled: () => boolean;               // calloutEnabledSpotterCars
  getStillThereEnabled: () => boolean;         // calloutEnabledSpotterStillThere
  getTrackDirection: () => TrackDirection;     // road vs oval terminology
  logger?: ILogger;
};

export function registerSpotterEngine(bus: IEventBus, deps: SpotterDeps): void;
export function setSpotterEnabled(next: boolean): void;   // mode-button synchronous flip (mirror setRadarEnabled)
export function isSpotterEnabled(): boolean;
export function _resetSpotterEngine(): void;              // @internal test isolation
```

`registerSpotterEngine` must, on first call: `getScenarioEngine().defineVar("spotterClip", () => pendingSpotterClip)` then `getScenarioEngine().defineScenario({ id: SPOTTER_CALL_SCENARIO_ID, channel: AudioChannel.Voice, bus: AudioBus.Voice, weight: WEIGHT.SAFETY, interrupt: true, queueable: false, family: "spotter", focusOwner: SPOTTER_FOCUS_OWNER, sequence: [{ var: "spotterClip" }] })`, then `bus.subscribe("radar.changed", handleRadarChanged)`. Idempotent on the same bus (mirror radar-engine's bus-instance guard).

`handleRadarChanged`: guard `enabled` flag; `getMasterEnabled()` → else `forceClear()`; `getSessionType() === "Lone Qualify"` → `forceClear()`; `isOnPitRoad()` (read `getLatestTelemetry().OnPitRoad`) → `forceClear()`; if `to === state` return; else `handleTransition(state, to, getTrackDirection())`; set `state = to`. **Before implementing the pit-road/Lone-Qualify guards, read `packages/sim-events-iracing/src/diff/radar.ts`** to confirm whether `radar.changed` is already pre-suppressed to `clear` on pit road / lone-qualify. If it is, keep the guards as harmless defense-in-depth (mirror radar-engine); if not, they are required.

Implement `handleTransition`, `termFor`, `levelClip`, `combinedClip`, `fireClip`, `pickClearPool`, `pickStillTherePool`, `startLoop`/`resetLoopTimer`, `acquireFocusIfNeeded`/`releaseFocus`/`forceClear` exactly per the **State machine** section above. Clip path tables and the two pools live as module consts (paths include `{voice}`; the interpreter substitutes voice on the var value).

- [ ] **Step 1: Write failing tests.** Set up a real engine via `initializeAudioScenarios(bus, fakeAudio, fakeManifest, logger)` with a fake `IAudioService` recording `playOnChannel(channel, path)` calls and immediately invoking the stored `onChannelComplete` callback so sequences advance synchronously; OR mock `getScenarioEngine()` to capture `fire`/`acquireFocus`/`releaseFocus`. Prefer the real-engine + fake-audio approach so the var→clip path is asserted end-to-end. Use a fake `IEventBus`. Use `vi.useFakeTimers()` for the loop. Cover:
  - **Arrivals (road, dir Neutral):** `clear→left` plays `…/spotter/car-left.mp3`; `clear→right` → `car-right`; `clear→two-left` → `two-cars-left`; `clear→two-right` → `two-cars-right`; `clear→both` → `three-wide`.
  - **Escalation/de-escalation:** `left→two-left` → `two-cars-left`; `two-left→left` → `one-car-left`; mirror right.
  - **Combined (de-escalation/swap):** `both→left` → `clear-right-car-left`; `both→right` → `clear-left-car-right`; `right→left` (swap) → `clear-right-car-left`; `left→right` → `clear-left-car-right`; `both→two-left` → `clear-right-two-cars-left`; `two-right→two-left` → `clear-right-two-cars-left`.
  - **Final clear:** any non-clear `→clear` plays a clip from the clear pool (`clear`) and calls `releaseFocus(AudioBus.Voice, "spotter")`.
  - **Oval mapping:** with `getTrackDirection` → `Left`: `clear→left` → `car-inside`; `clear→right` → `car-outside`; `both→left` → `clear-outside-car-inside`. With `Right`: `clear→left` → `car-outside`; `both→left` → `clear-inside-car-outside`.
  - **Focus gate acquisition:** first non-clear transition calls `acquireFocus(AudioBus.Voice, "spotter", WEIGHT.SAFETY)`; subsequent non-clear transitions do NOT re-acquire (still held); `→clear` releases.
  - **Sustained loop:** after a non-clear transition, advancing fake timers by `SPOTTER_STILL_THERE_INTERVAL_MS` fires a still-there pick; advancing again fires again (no-repeat across the two variants); a new transition resets the timer; `→clear` and master-off stop it.
  - **Opt-in gating (live):** `getCarsEnabled` → false suppresses the transition clip but the focus gate + loop still operate; `getStillThereEnabled` → false stops loop fires; flipping either mid-sequence takes effect on the next event/tick.
  - **Master + suppression:** `getMasterEnabled` → false (or pit-road / Lone Qualify) → `forceClear`: releases focus, stops loop, fires nothing.
  - **Scenario identity:** the fired scenario is `pit-crew.spotter-call` with `focusOwner:"spotter"`, `weight: WEIGHT.SAFETY` (assert via the defined scenario or via focus-bypass behavior — a spotter fire plays even while its own floor is held).
  - **Voice substitution:** the recorded play path has `{voice}` replaced (init the engine with `getActiveVoice` returning a voice key and assert the resolved path).
- [ ] **Step 2:** Run `pnpm --filter @iracedeck/audio-scenarios test spotter-engine` — expect FAIL.
- [ ] **Step 3: Implement** `spotter-engine.ts` per the State machine section.
- [ ] **Step 4:** Run the test — expect PASS.
- [ ] **Step 5:** `pnpm --filter @iracedeck/audio-scenarios build` — expect PASS.
- [ ] **Step 6: Commit** `feat(audio-scenarios): spotter engine state machine + focus gate (#651)`.

---

## Task 4 — Wire spotter into `registerPitCrew` (index.ts)

**Files:** Modify `packages/audio-scenarios/src/catalog/pit-crew/index.ts`; Modify `register-pit-crew.test.ts`.

- [ ] **Step 1:** Add the canonical id↔key map + re-exports near the other families:

```typescript
/** Stable id for each spotter PI opt-in (issue #651). */
export type SpotterCalloutId = "cars" | "still-there";

/** Canonical map from {@link SpotterCalloutId} to its global-settings key. */
export const SPOTTER_CALLOUT_SETTING_KEYS: Record<SpotterCalloutId, string> = {
  cars: "calloutEnabledSpotterCars",
  "still-there": "calloutEnabledSpotterStillThere",
};
```
  Re-export from index: `registerSpotterEngine`, `setSpotterEnabled`, `isSpotterEnabled`, `SpotterCalloutId`, `SPOTTER_CALLOUT_SETTING_KEYS`, `SPOTTER_STILL_THERE_INTERVAL_MS`.

- [ ] **Step 2:** Add trailing parameters to `registerPitCrew` (after `getRadarMasterEnabled`), with doc comments mirroring the others:

```typescript
  getSpotterMasterEnabled: () => boolean = () => true,                       // pitCrewSpotterEnabled
  getSpotterCalloutEnabled: (id: SpotterCalloutId) => boolean = () => true,  // cars / still-there opt-ins
  getSpotterTrackDirection: () => TrackDirection = () => TrackDirection.Neutral,
```
  Import `TrackDirection` from `@iracedeck/sim-events-iracing`.

- [ ] **Step 3:** Inside `registerPitCrew`, after `registerRadarEngine(bus, getRadarMasterEnabled);` add:

```typescript
  registerSpotterEngine(bus, {
    getMasterEnabled: getSpotterMasterEnabled,
    getCarsEnabled: () => getSpotterCalloutEnabled("cars"),
    getStillThereEnabled: () => getSpotterCalloutEnabled("still-there"),
    getTrackDirection: getSpotterTrackDirection,
    logger,
  });
```
  (Place the `import { registerSpotterEngine } from "./spotter-engine.js";` with the other imports. The var+scenario are defined inside `registerSpotterEngine`, which runs after `getScenarioEngine()` is available — guaranteed since `registerPitCrew` runs post-`initializeAudioScenarios`.)

- [ ] **Step 4:** Update `register-pit-crew.test.ts` — append the three new trailing args to the `registerPitCrew(...)` call (use `undefined` unless a test asserts spotter behavior; if so, pass closures + a `getSpotterTrackDirection`). Confirm existing assertions still hold.

- [ ] **Step 5:** `pnpm --filter @iracedeck/audio-scenarios build && pnpm --filter @iracedeck/audio-scenarios test` — expect PASS.

- [ ] **Step 6: Commit** `feat(audio-scenarios): register spotter engine in pit-crew (#651)`.

---

## Task 5 — Pit Crew action: spotter mode + toggle

**Files:** Modify `pit-crew.ts`; Modify `pit-crew.test.ts`.

Mirror the Radar mode exactly (reference: `pit-crew.ts` Settings enum line ~90, `modePresentation` ~308–331, `toggleRadar` ~745–753, `onKeyDown` switch ~585–603). Import `isSpotterEnabled`, `setSpotterEnabled` from `@iracedeck/audio-scenarios`.

- [ ] **Step 1:** Add `"spotter"` to the `mode` enum.
- [ ] **Step 2:** Add a `case "spotter"` to `modePresentation`:
```typescript
    case "spotter":
      return { defaultTitle: "SPOTTER", stateIndicator: isSpotterEnabled() ? "on" : "off" };
```
- [ ] **Step 3:** Add `toggleSpotter` (mirror `toggleRadar`):
```typescript
  private toggleSpotter(): void {
    const next = !isSpotterEnabled();
    this.logger.info(`Spotter ${next ? "enabled" : "disabled"}`);
    setSpotterEnabled(next);
    updateGlobalSettings({ pitCrewSpotterEnabled: next });
  }
```
- [ ] **Step 4:** Add `case "spotter": this.toggleSpotter(); break;` to `onKeyDown`.
- [ ] **Step 5:** Tests: spotter mode renders title "SPOTTER" + on/off indicator from `isSpotterEnabled`; pressing in spotter mode flips `setSpotterEnabled` + `updateGlobalSettings({ pitCrewSpotterEnabled })`. Mock `@iracedeck/audio-scenarios` spotter exports.
- [ ] **Step 6:** `pnpm --filter @iracedeck/iracing-actions build && … test pit-crew` — expect PASS.
- [ ] **Step 7: Commit** `feat(actions): Spotter toggle mode on Pit Crew (#651)`.

---

## Task 6 — Property Inspector (pit-crew.ejs)

**Files:** Modify `pit-crew.ejs`.

- [ ] **Step 1:** Add `<option value="spotter">Spotter</option>` to the Mode `<sdpi-select>` (after `radar`).
- [ ] **Step 2:** Add a Spotter accordion group (mirror the Flags 2-column grid block) with the two opt-ins:
```javascript
var spotterCallouts = [
  { setting: "calloutEnabledSpotterCars",       label: "Announce cars around you" },
  { setting: "calloutEnabledSpotterStillThere", label: "Repeat reminder while alongside" },
];
```
  Render as `<sdpi-checkbox … global default="true">` rows inside the 2-column `grid-template-rows: repeat(Math.ceil(items.length/2), auto); grid-auto-flow: column;` div, under an `<sdpi-item label="Spotter">`, within the "Race Engineer Callouts" accordion (or a sibling consistent with how Radar/other families are grouped). Use `default="true"` (NOT `default="false"`).
- [ ] **Step 3:** The mode-conditional-visibility script already handles the `direction-item` for `radar-volume`; no spotter-specific sub-settings are conditional, so no script change is required (verify the spotter option doesn't disturb the `radar-volume` option-sync logic).
- [ ] **Step 4:** Build the plugin(s) so the EJS compiles (covered in Task 8's build), then visually confirm `ui/pit-crew.html` contains the spotter option + checkboxes.
- [ ] **Step 5: Commit** `feat(actions): Spotter PI mode option + opt-ins (#651)`.

---

## Task 7 — Plugin wiring (both plugins)

**Files:** Modify `packages/iracing-plugin-stream-deck/src/plugin.ts` and `packages/iracing-plugin-mirabox/src/plugin.ts` (identical edits); optional tooltip in both `manifest.json`.

- [ ] **Step 1:** Import `SPOTTER_CALLOUT_SETTING_KEYS`, `SpotterCalloutId` from `@iracedeck/audio-scenarios` and `resolveTrackDirection`/`getTrackDirection` from `@iracedeck/sim-events-iracing` (use the `getTrackDirection()` getter directly if it reads live session info; otherwise compose `() => resolveTrackDirection(<live session info getter>)`).
- [ ] **Step 2:** Append three args to BOTH `registerPitCrew(...)` calls (after the radar master gate), matching the new parameter order:
```typescript
  // Spotter master gate (issue #651)
  () => (getGlobalSettings() as Record<string, unknown>).pitCrewSpotterEnabled === true,
  // Spotter per-callout opt-ins (issue #651)
  (id: SpotterCalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[SPOTTER_CALLOUT_SETTING_KEYS[id]] !== false,
  // Spotter road/oval terminology (issue #651)
  () => getTrackDirection(),
```
- [ ] **Step 3:** (Optional) update the Pit Crew `manifest.json` tooltip to mention Spotter.
- [ ] **Step 4:** `pnpm --filter @iracedeck/iracing-plugin-stream-deck build` and `… mirabox build` — expect PASS (this compiles the EJS from Task 6 too).
- [ ] **Step 5: Commit** `feat(plugins): wire spotter master + opt-ins + track direction (#651)`.

---

## Task 8 — Audio assets config (text only; NO generation)

**Files:** Modify every `packages/audio-assets/configs/*.voice.json`.

The voice-parity test requires identical group/entry keys across all voice configs. Add the `spotter` group (25 entries from the Clip catalog) to EVERY `*.voice.json`, same `name`s and `text` (text may be tuned per voice persona, but keep names identical). **No `<break>` tags.** Optional `seed` per entry.

- [ ] **Step 1:** Add the `spotter` group block to `default.voice.json` with the 25 entries (names + texts from the catalog table).
- [ ] **Step 2:** Mirror the same 25 `name`s into every other `configs/*.voice.json`.
- [ ] **Step 3:** Run the voice-parity test: `pnpm --filter @iracedeck/audio-assets test` — expect PASS (keys match across voices).
- [ ] **Step 4: Commit** `feat(audio-assets): spotter clip group config (text) (#651)`.

> The actual `.mp3` generation + `manifest.json` regen is the **HANDOFF** below — do NOT run it here.

---

## Task 9 — Docs, skill, CLAUDE.md, callout-examples

**Files:** website `pit-crew.md`; `docs/plugins/core/actions/pit-crew.md`; `packages/audio-scenarios/CLAUDE.md`; `.claude/rules/race-engineer-callout-examples.md`; `iracedeck-actions` skill data.

- [ ] **Step 1:** Website `pit-crew.md` — add a "Spotter calls" mode section mirroring the Radar section (what the button toggles, `pitCrewSpotterEnabled`, road vs oval, relation to Radar, the two opt-ins). Follow `website-action-docs.md`.
- [ ] **Step 2:** `docs/plugins/core/actions/pit-crew.md` — document the Spotter toggle + the calls alongside Radar (per `action-documentation.md`).
- [ ] **Step 3:** `packages/audio-scenarios/CLAUDE.md` — document the second imperative engine (`spotter-engine.ts`), that it schedules through the interpreter (var-driven, no pools) and owns the focus floor.
- [ ] **Step 4:** `.claude/rules/race-engineer-callout-examples.md` — add a #651 entry: the pattern it establishes (interpreter-scheduled imperative engine + exclusive-focus floor + one-clip-per-transition state machine reusing an existing event) and the reusable lesson.
- [ ] **Step 5:** Update the `iracedeck-actions` skill if it enumerates pit-crew modes/callouts (add Spotter mode + the two opt-ins). Action COUNT is unchanged (new mode, not new action) — do not bump action counts.
- [ ] **Step 6:** Markdown: every fenced block has a language; no hard-wraps inside paragraphs.
- [ ] **Step 7: Commit** `docs(spotter): document Spotter calls across docs/skills/rules (#651)`.

---

## Task 10 — Full verification (no audio yet)

- [ ] **Step 1:** From repo root: `pnpm install` then `pnpm build` — expect PASS across all packages.
- [ ] **Step 2:** `pnpm test` — expect PASS (engine + resolver + settings + action tests; spotter scenarios are var-driven so no manifest dependency).
- [ ] **Step 3:** `pnpm lint:fix` and `pnpm format:fix` — fix ALL issues (including any pre-existing ones surfaced).
- [ ] **Step 4:** Confirm `git status` clean except intended changes. Commit any lint/format fixups.

---

## HANDOFF — audio generation (USER runs; paid, ElevenLabs)

After Tasks 1–10 are green, the user runs (Claude must NOT run these — paid/external):

```bash
pnpm --filter @iracedeck/audio-assets generate --group spotter
pnpm --filter @iracedeck/audio-assets generate:manifest
```

Then commit the new `voice/<voice>/spotter/*.mp3` files + regenerated `manifest.json`. After that:

- [ ] Re-run `pnpm build && pnpm test` — the manifest freshness test passes and the spotter clips resolve at runtime.
- [ ] **USER manual test in iRacing** (per project rule: no push/PR before manual sim test). Verify road vs oval terminology, the focus gate (chatter held, safety flags break through), the still-there loop, and clear.
- [ ] Only when the user asks: open the PR with the repo template, title `feat(audio-scenarios): Race Engineer spotter proximity callouts (#651)`.

---

## Self-review notes

- **Spec coverage:** resolveTrackDirection ✔ (T1) · radar.changed reuse ✔ (T3) · one-clip-per-transition incl. combined/one-car ✔ (T3 catalog+machine) · oval mapping ✔ (T1/T3) · focus gate ✔ (T3) · still-there loop ✔ (T3) · master + 2 opt-ins ✔ (T2/T4/T6/T7) · mode button ✔ (T5) · plugins ✔ (T7) · PI ✔ (T6) · audio config ✔ (T8) · docs/skills/rules ✔ (T9) · tests ✔ (T3 enumerated). No new bus event/translator diff/harness shortcut (radar.changed reused) — intentional.
- **Manifest decoupling:** var-driven clip selection means no `definePool`/`validateScenario` dependency on not-yet-generated clips; build/test stay green pre-audio.
- **Naming consistency:** `pit-crew.spotter-call`, `spotterClip` var, `SPOTTER_FOCUS_OWNER="spotter"`, family `"spotter"`, keys `calloutEnabledSpotterCars` / `calloutEnabledSpotterStillThere` / `pitCrewSpotterEnabled`, ids `cars`/`still-there` — used identically across T2/T3/T4/T6/T7.
