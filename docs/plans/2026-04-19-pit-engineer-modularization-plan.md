# Pit Engineer modularization plan

> **2026-04-22 update (#413):** Superseded and kept only for historical context. The feature was renamed Pit Engineer → **Pit Crew** and split into the Race Engineer (voice) and Radar (directional ticks) sub-features with an action-level Mode selector. The Stage 7 thin-shell refactor (#401 / #410 / #412) already did most of the modularization this doc anticipated — audio / event / scenario logic now lives in `@iracedeck/audio-service`, `@iracedeck/event-bus`, and `@iracedeck/audio-scenarios`. The action itself (`packages/iracing-actions/src/actions/pit-crew/pit-crew.ts`) is a thin Stream Deck shell. References below to "pit-engineer", "pit-engineer.ts", and "spotter" describe the pre-rename state.

**Status:** Historical (refactor shipped via the audio architecture design + #410 + #412 + #413).
**Date:** 2026-04-19.
**Branch when started:** `refactor/pit-engineer-modularization`.

Split the monolithic `packages/actions/src/actions/pit-engineer.ts` (3,400+ LOC, 40+ module globals, 15+ sub-features) into a coordinator + per-feature modules with shared infrastructure.

---

## 1. Problem

`pit-engineer.ts` has become the single largest file in the codebase and grows linearly with every sub-feature. Concretely:

- **3,400+ lines** in one file, single `PitEngineer` class with ~15 sub-features co-located.
- **~40 module-level `let` globals** shared across all handlers.
- **~12 pool `*Index` rotation variables** — same three-line pattern repeated.
- **Tick loop** is a single method with one `if (globalSettings.X) handleX()` per feature — 10+ gates deep.
- **Reset paths** (`resetTelemetryState`, `resetAllAudioState`) are manually maintained; forgetting to add to them is a silent bug (has happened).
- **Tests** mock `@iracedeck/deck-core` wholesale and call `@internal` exports; refactors cascade across many test blocks.
- **Cross-feature coupling via module scope** — any handler can read or write any global, no static protection.

Adding a new sub-feature currently costs ~100-150 LOC in this file, scattered across schema, state, pool, handler, tick-loop wiring, and reset hooks.

---

## 2. Goals

1. Every sub-feature becomes a self-contained unit: own state (private), own settings slice, own reset, own audio I/O.
2. Adding a new feature = adding a new file + one line in a coordinator list. No cross-cutting edits.
3. Tests target feature classes directly, injecting fake infrastructure. No deck-core wholesale mocking.
4. `pit-engineer.ts` (now the coordinator) drops below ~300 LOC.
5. State resets happen automatically — the coordinator walks feature list and calls `onReset()`. Features can't forget.
6. Zero behavior change at any intermediate stage. Every commit is installable and playable.
7. Mirabox and Stream Deck builds remain identical.

---

## 3. Non-goals

- No rewrite of the audio service (`deck-core/audio-service.ts`) — already clean after the bus refactor.
- No change to the platform adapter, icon template system, or PI EJS.
- No TypeScript project structure changes (still `@iracedeck/actions` workspace package).
- No Zod schema changes — only redistribution across files.
- No new features during the refactor. Feature work pauses on this branch.

---

## 4. Target directory structure

```text
packages/actions/src/actions/
├── pit-engineer.ts                  # kept as re-export shim for backward import compat
└── pit-engineer/
    ├── index.ts                     # PitEngineer class (coordinator, ≤300 LOC)
    ├── settings.ts                  # Zod schema, exported types
    │
    ├── core/
    │   ├── sub-feature.ts           # SubFeature interface + BaseSubFeature abstract
    │   ├── feature-init-context.ts  # dependency bag passed to features at construction
    │   ├── tick-context.ts          # per-tick read-only snapshot
    │   ├── pool-rotator.ts          # generic rotator (replaces 12+ *Index vars)
    │   ├── audio-director.ts        # wraps getAudio() + radio flow dispatch
    │   ├── radio-flow.ts            # state machine, was inline in pit-engineer.ts
    │   └── session-gate.ts          # isRace / isLoneQualify / getSessionType helpers
    │
    ├── audio/
    │   ├── pools.ts                 # re-exports all pool barrels for convenience
    │   ├── ack-pool.ts              # acknowledgments + greetings
    │   ├── connector-pool.ts        # "and", "also", "plus" sentence connectors
    │   ├── welcome-pool.ts          # welcome clips + driver-name variants
    │   ├── tip-pool.ts              # racing tips + bucketing
    │   ├── overtake-pool.ts
    │   ├── flag-pool.ts
    │   ├── fuel-pool.ts
    │   ├── incident-pool.ts         # grass / gravel / generic / limits
    │   ├── pit-approach-pool.ts
    │   ├── pit-departure-pool.ts
    │   ├── pit-exit-pool.ts
    │   ├── pit-limiter-pool.ts      # no-limiter / dropped / speeding
    │   └── reminder-pool.ts         # service reminders
    │
    ├── features/
    │   ├── pit-approach.ts
    │   ├── pit-departure.ts
    │   ├── pit-exit.ts
    │   ├── pit-limiter-warning.ts
    │   ├── incident-alert.ts
    │   ├── spotter.ts
    │   ├── overtake.ts
    │   ├── racing-tip.ts
    │   ├── flag-alerts.ts
    │   ├── fuel-warnings.ts
    │   ├── service-reminders.ts
    │   ├── toggle-audio.ts
    │   └── welcome-message.ts
    │
    ├── icons/
    │   └── generate-pit-engineer-svg.ts
    │
    └── __tests__/
        ├── core/
        │   ├── pool-rotator.test.ts
        │   ├── audio-director.test.ts
        │   ├── radio-flow.test.ts
        │   └── session-gate.test.ts
        ├── features/
        │   ├── pit-limiter-warning.test.ts
        │   ├── incident-alert.test.ts
        │   ├── spotter.test.ts
        │   └── ...
        └── pit-engineer.test.ts     # coordinator-level wiring tests only
```

The outer `pit-engineer.ts` stays as a re-export so existing imports (`plugin.ts` on both adapters) keep working with no plugin-side churn.

---

## 5. Core abstractions

### 5.1 `SubFeature` interface

```typescript
export interface SubFeature {
  /** Stable identifier for logging + feature lookup. */
  readonly name: string;

  /** Update the feature's enabled flag and any settings-derived state. */
  onSettingsChange(settings: PitEngineerSettings, globalSettings: GlobalSettings): void;

  /** Per-telemetry-tick hook (4 Hz). Short-circuit if disabled. */
  onTick(ctx: TickContext): void;

  /**
   * Reset all feature-local state. Called on:
   * - Session change
   * - Plugin restart
   * - Feature toggled off then on
   * - SDK disconnect / reconnect
   */
  onReset(): void;

  /** Called when feature transitions to disabled (settings off, offline). */
  onSuspend(): void;

  /** Called when feature transitions to enabled. Default no-op. */
  onResume(): void;

  /** Called on plugin shutdown. Cleanup timers / callbacks. Default onReset(). */
  destroy(): void;
}
```

### 5.2 `BaseSubFeature` abstract class

Handles the default enabled-flag plumbing so features only override what they need:

```typescript
export abstract class BaseSubFeature<TSettings = PitEngineerSettings> implements SubFeature {
  protected readonly logger: ILogger;
  protected readonly director: AudioDirector;
  protected readonly session: SessionGate;
  protected enabled = false;

  constructor(init: FeatureInitContext) {
    this.logger = init.logger.withScope(this.name);
    this.director = init.director;
    this.session = init.session;
  }

  abstract readonly name: string;

  /** Features implement this to decide whether they're live. */
  protected abstract isEnabled(settings: PitEngineerSettings, globalSettings: GlobalSettings): boolean;

  /** Features implement this to do per-tick work; only called when enabled. */
  protected abstract onTickEnabled(ctx: TickContext): void;

  /** Features implement this to wipe state. */
  abstract onReset(): void;

  onSettingsChange(settings: PitEngineerSettings, globalSettings: GlobalSettings): void {
    const wasEnabled = this.enabled;
    this.enabled = this.isEnabled(settings, globalSettings);

    if (wasEnabled && !this.enabled) this.onSuspend();
    if (!wasEnabled && this.enabled) this.onResume();
  }

  onTick(ctx: TickContext): void {
    if (!this.enabled) return;
    this.onTickEnabled(ctx);
  }

  onSuspend(): void {
    this.onReset();
  }

  onResume(): void {
    // default no-op
  }

  destroy(): void {
    this.onReset();
  }
}
```

### 5.3 `TickContext` — per-tick snapshot

```typescript
export interface TickContext {
  telemetry: TelemetryData | null;
  onPitRoad: boolean;
  sessionType: string;            // "Race" | "Lone Qualify" | etc.
  isOnTrack: boolean;
  playerCarIdx: number;
  trackLengthMeters: number;
  now: number;                    // Date.now() — cached per tick
}
```

Built once per telemetry tick in the coordinator; passed to every feature. Features read; never mutate.

### 5.4 `FeatureInitContext` — dependency bag

```typescript
export interface FeatureInitContext {
  logger: ILogger;
  director: AudioDirector;
  session: SessionGate;
  requestIconRefresh: () => void;   // for features that drive icon state
}
```

Injected at construction. Gives features access to shared infrastructure without reaching out to module globals.

### 5.5 `PoolRotator<T>`

Replaces every `let *Index = 0` + `pool[idx]; idx = (idx+1) % pool.length;` pattern:

```typescript
export class PoolRotator<T> {
  private idx = 0;

  constructor(private readonly items: readonly T[]) {}

  next(): T | null {
    if (this.items.length === 0) return null;
    const item = this.items[this.idx]!;
    this.idx = (this.idx + 1) % this.items.length;
    return item;
  }

  reset(): void {
    this.idx = 0;
  }

  get size(): number {
    return this.items.length;
  }

  /** 60/40-style weighted pick between two pools, preserving each pool's rotation. */
  static weightedPick<T>(primary: PoolRotator<T>, secondary: PoolRotator<T>, pSecondary: number): T | null {
    return Math.random() < pSecondary ? secondary.next() : primary.next();
  }
}
```

### 5.6 `AudioDirector`

Thin façade over `getAudio()` + the radio flow state machine. Features never import `getAudio` directly:

```typescript
export interface AudioDirector {
  /** Plays a single engineer voice message. Returns true if the flow actually started. */
  speak(file: string): boolean;

  /** Chains multiple messages with connectors. Returns true if started. */
  speakSequence(files: string[], opts?: { includeAck?: boolean; connectors?: readonly string[] }): boolean;

  /** Priority-tier message that interrupts and locks out lower priorities. */
  speakPriority(file: string): void;

  /** Non-voice channel playback (spotter ticks, cues). */
  playCue(channel: AudioChannel, file: string, loop?: boolean): void;

  stopCue(channel: AudioChannel): void;

  /** Cancel whatever's playing on the voice flow. */
  cancelRadioFlow(): void;

  /** Current state of the radio flow — used for cooldown-from-clip-end patterns. */
  readonly flowState: RadioFlowState;

  readonly isBusy: boolean;
}
```

All the current top-level functions (`playRadioMessage`, `playEngineerSoundSimple`, `playPriorityMessage`, `playWelcomeMessage`, `cancelRadioFlow`, `playTickClose`, etc.) become private methods on `AudioDirectorImpl`. `radioFlowState` and `globalPriorityActive` become private fields.

### 5.7 `SessionGate`

Encapsulates session-info lookup. Builds the `sessionType` field of `TickContext` once per tick; features query it via typed helpers:

```typescript
export interface SessionGate {
  readonly sessionType: string;
  readonly isRace: boolean;
  readonly isLoneQualify: boolean;
  readonly isOpenQualify: boolean;
  readonly isPractice: boolean;
  readonly trackLengthMeters: number;
  readonly pitSpeedLimitMps: number;
}
```

Recomputed once per tick in the coordinator; cached until the next tick. Features never re-parse session YAML.

---

## 6. The coordinator (`pit-engineer/index.ts`)

```typescript
export class PitEngineer extends ConnectionStateAwareAction<PitEngineerSettings> {
  private readonly features: SubFeature[] = [];
  private director!: AudioDirectorImpl;
  private session!: SessionGateImpl;
  private lastTelemetry: TelemetryData | null = null;

  override async onConnected(): Promise<void> {
    await super.onConnected();

    this.director = new AudioDirectorImpl(getAudio(), this.logger.withScope("AudioDirector"));
    this.session = new SessionGateImpl(this.sdkController);

    const init: FeatureInitContext = {
      logger: this.logger,
      director: this.director,
      session: this.session,
      requestIconRefresh: () => this.updateAllVisibleIcons(),
    };

    this.features.push(
      new WelcomeMessageFeature(init),
      new PitApproachFeature(init),
      new PitDepartureFeature(init),
      new PitExitFeature(init),
      new PitLimiterWarningFeature(init),
      new OvertakeFeature(init),
      new RacingTipFeature(init),
      new FlagAlertsFeature(init),
      new IncidentAlertFeature(init),
      new FuelWarningsFeature(init),
      new ServiceRemindersFeature(init),
      new ToggleAudioFeature(init),
      new SpotterFeature(init),
    );

    this.startTickLoop();
  }

  protected override onTelemetryTick(telemetry: TelemetryData | null): void {
    this.lastTelemetry = telemetry;
    this.session.refresh(telemetry);

    const ctx: TickContext = {
      telemetry,
      onPitRoad: telemetry?.OnPitRoad ?? false,
      sessionType: this.session.sessionType,
      isOnTrack: telemetry?.IsOnTrack ?? false,
      playerCarIdx: this.session.playerCarIdx,
      trackLengthMeters: this.session.trackLengthMeters,
      now: Date.now(),
    };

    for (const feature of this.features) {
      feature.onTick(ctx);
    }
  }

  protected override onSettingsUpdated(settings: PitEngineerSettings, globalSettings: GlobalSettings): void {
    for (const feature of this.features) {
      feature.onSettingsChange(settings, globalSettings);
    }
  }

  protected override onSessionChanged(): void {
    this.director.cancelRadioFlow();
    for (const feature of this.features) feature.onReset();
  }

  override async onWillDisappear(): Promise<void> {
    for (const feature of this.features) feature.destroy();
    await super.onWillDisappear();
  }
}
```

Feature ordering matters only when one feature's audio could race another's. The current tick order is preserved. Document any implicit cross-feature ordering in the feature's JSDoc.

---

## 7. Migration stages

Each stage is independently shippable. After each stage: pnpm build both plugins, in-game smoke test, commit.

### Stage 0 — Infrastructure (no feature migrated)

Create everything in `pit-engineer/core/` and `pit-engineer/audio/`. Do not touch the main file. Ship alongside the existing implementation.

- `sub-feature.ts`, `base-sub-feature.ts`
- `feature-init-context.ts`, `tick-context.ts`
- `pool-rotator.ts` + tests
- `audio-director.ts` + tests (initially a thin pass-through, not yet used)
- `session-gate.ts` + tests
- Move all pool constants into `audio/*-pool.ts` files but keep them exported as before. `pit-engineer.ts` re-imports them; no behavior change.

**Deliverable:** new utilities and their tests. `pit-engineer.ts` imports the pools from the new location but still has all handlers inline. All existing tests pass.

**Estimate:** 3-4 hours.

### Stage 1 — First migration: Pit Limiter Warning

Smallest non-trivial feature. Validates the pattern end-to-end.

- Create `features/pit-limiter-warning.ts`
- Move: `pitNoLimiterIndex`, `pitLimiterDroppedIndex`, `pitSpeedingIndex` → `PoolRotator` instances inside the feature.
- Move `handlePitLimiterWarning` method body → `onTickEnabled`.
- Remove feature-specific globals from main file.
- Remove handler method from `PitEngineer` class.
- Coordinator list gets `new PitLimiterWarningFeature(init)`.
- Port the feature's tests from `pit-engineer.test.ts` to `__tests__/features/pit-limiter-warning.test.ts` using direct instantiation.

**Deliverable:** 1 feature fully migrated. Old-style and new-style code coexist.

**Estimate:** 2 hours.

**Review gate:** in-game test — press accelerator on pit road without limiter, verify "no limiter" callout fires. Stop in pit box, verify speeding callout still fires. If either broken, revert this stage only; infrastructure stays.

### Stage 2 — Independent features (individually commitable)

Order by simplest first:

1. **Spotter** — already cleanly boundaried; has its own channel + tick loop.
2. **Overtake detection** — contained pool + cooldown + simple state machine.
3. **Flag alerts** — telemetry-only, no radio flow complication.
4. **Incident Alert** — uses radio flow; good test of AudioDirector integration.

Each one commits separately. In-game smoke test between commits. Roll back individually if needed.

**Estimate:** 6-8 hours total (2 hours each, 4 features, some overlap).

### Stage 3 — Radio-heavy features

These are the biggest and share radio-flow conventions heavily. Do them together so `AudioDirector`'s interface stabilizes:

1. **Welcome Message** — validates priority + greeting chain + name injection.
2. **Racing Tips** — bucketed pools (START_ONLY / anytime / MID_RACE_ONLY).
3. **Fuel Warnings** — the biggest sub-feature (~400 LOC), most complex state machine. Do last in this stage.
4. **Service Reminders** — deferred reminder timer, priority-flow-aware.

`AudioDirector` will likely need tweaks after Welcome Message — lock it down before doing Fuel.

**Estimate:** 6-8 hours.

### Stage 4 — Remaining features

1. **Pit Approach / Departure / Exit** — three similar features; refactor in one pass and share a helper for pit-lane state detection.
2. **Toggle Audio Confirmations** — fairly isolated; reads pit service flags + DRS/P2P etc.
3. **Engine Startup Animation** — icon-side work; moves to `icons/animation.ts`.

**Estimate:** 3-4 hours.

### Stage 5 — Cleanup

- Delete `resetTelemetryState`, `resetAllAudioState` — replaced by coordinator's `for (f of features) f.onReset()`.
- Remove any remaining module-level `let` globals. Anything left is a bug — it means a feature is leaking state.
- `pit-engineer.ts` becomes a re-export shim pointing at `pit-engineer/index.ts`.
- Update `plugin.ts` imports in both adapters if the import path changed. (It shouldn't — keep the shim.)
- Update tests: `pit-engineer.test.ts` now only tests coordinator wiring. Feature-specific tests live under `__tests__/features/`.
- Verify: `grep "^let global" packages/actions/src/actions/pit-engineer/` returns nothing.

**Deliverable:** coordinator ≤ 300 LOC; zero module-level mutable state in the package.

**Estimate:** 2 hours.

### Total: 20-26 hours across 6 stages.

---

## 8. Test migration strategy

### Old pattern

```typescript
vi.mock("@iracedeck/deck-core", () => ({ CommonSettings: {...}, ConnectionStateAwareAction: class {...}, ... }));
import { pickTip, GLOBAL_KEY_NAME } from "./pit-engineer.js";

it("picks tips", () => {
  expect(pickTip(false)).toMatch(/tips\//);
});
```

Heavy mock, pure-function entry points.

### New pattern

```typescript
import { IncidentAlertFeature } from "./incident-alert.js";
import { FakeAudioDirector, FakeSessionGate } from "../__testing__/fakes.js";

describe("IncidentAlertFeature", () => {
  let director: FakeAudioDirector;
  let feature: IncidentAlertFeature;

  beforeEach(() => {
    director = new FakeAudioDirector();
    feature = new IncidentAlertFeature({
      logger: silentLogger,
      director,
      session: new FakeSessionGate({ sessionType: "Race" }),
      requestIconRefresh: () => {},
    });
    feature.onSettingsChange({ incidentAlert: true, ... } as PitEngineerSettings, {});
  });

  it("fires sustained off-track warning after 2s on grass", () => {
    // Drive 2 seconds of ticks with PlayerTrackSurface=OffTrack, material=Grass1
    for (let t = 0; t <= 2000; t += 250) {
      feature.onTick({ telemetry: { PlayerTrackSurface: TrkLoc.OffTrack, ... }, now: t, ... });
    }
    expect(director.spoken).toHaveLength(1);
    expect(director.spoken[0]).toMatch(/incidents\/IRD-incident-(grass|generic)/);
  });
});
```

Direct instantiation. No deck-core mocking. Fakes implement `AudioDirector` and `SessionGate` with recorder arrays for assertions.

### Test fakes

Create `packages/actions/src/actions/pit-engineer/__testing__/fakes.ts`:

```typescript
export class FakeAudioDirector implements AudioDirector {
  spoken: string[] = [];
  sequences: string[][] = [];
  priorityMessages: string[] = [];
  cues: { channel: AudioChannel; file: string }[] = [];

  speak(file: string): boolean { this.spoken.push(file); return true; }
  speakSequence(files: string[]): boolean { this.sequences.push(files); return true; }
  speakPriority(file: string): void { this.priorityMessages.push(file); }
  playCue(channel: AudioChannel, file: string): void { this.cues.push({ channel, file }); }
  // ...
  readonly flowState: RadioFlowState = "idle";
  readonly isBusy = false;
}
```

Feature-level tests become obvious. Reviewers can read them without knowing the internals.

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Cross-feature hidden coupling via module globals | Before each migration, `grep` the globals the feature uses. If any other handler touches the same global, that's an explicit cross-feature contract — move it to `TickContext` or a shared `AudioDirector` method. Document the contract in JSDoc. |
| Radio-flow race conditions when multiple features want to speak | `AudioDirector` serializes access. `speak()` returns false if priority is locked. Features read `director.isBusy` before firing. The cooldown-from-clip-end pattern (already in incident alert) becomes a `BaseSubFeature` helper. |
| Regression between stages | Each stage ships separately. Commit, build both plugins, in-game smoke test. If regression, revert that one stage only. No big-bang merge. |
| Tests become out of sync mid-refactor | Port tests in the same stage as the feature migration. No "migrate feature in Stage 1, migrate test in Stage 2" splits. |
| Feature ordering becomes implicit | Explicit array in coordinator with comments where order matters (e.g. spotter after toggle audio). No hidden dependencies. |
| Stream Deck and Mirabox diverge | Both import from `@iracedeck/actions` workspace. No divergence possible — they build the same source. Verify after every stage by packaging both. |
| Breaking plugin.ts imports | Keep `pit-engineer.ts` as a re-export shim pointing to `pit-engineer/index.ts`. External imports (`PIT_ENGINEER_UUID`, `PitEngineer` class) unchanged. |
| Bigger PR than reviewers can handle | Each stage = separate PR. Six PRs total, each reviewable standalone. |
| Perf regression from increased indirection | Micro-benchmark the tick loop before and after Stage 2. Fourteen feature method calls + context object vs 14 inline handlers is noise at 4 Hz. If it ever matters, cache the context object, don't re-allocate per tick. |

---

## 10. Triggers — when to actually start

Do not do this refactor on a whim. Start only when one of these fires:

- **File hits 5,000 LOC.** Currently ~3,400. Runway = ~1,500 LOC or roughly 3-5 more sub-features at current pace.
- **Three cumulative sub-feature additions since the last plan review.** Indicates velocity that will outgrow the current structure.
- **A cross-feature bug caught in the wild** (e.g. one feature's state leaks into another's behavior via module scope). Post-mortem naming "module global X was mutated by Y instead of Z" = trigger.
- **A collaborator is coming in** to work on Pit Engineer. The current structure requires whole-file context to contribute safely.
- **A new sub-feature requires > 300 LOC** and would push us past 4,000. At that point, the cost of the refactor is lower than the cost of adding to the monolith.

Until one of those fires, keep adding features the current way. This plan waits on disk.

---

## 11. Reversion safety

If any stage regresses gameplay and we can't fix forward, revert that stage's commit. The earlier stages stay. Infrastructure (Stage 0) never needs reverting — it adds files and changes nothing else.

Worst case: revert every stage down to Stage 0, ship with new infrastructure unused but available for a second attempt later.

---

## 12. Open questions

Left for the time we actually start:

1. **Should Welcome Message + Engine Startup Animation share a feature, or stay separate?** They fire once near session start and both touch icon state. Currently independent.
2. **Should `PitApproach` / `Departure` / `Exit` collapse into one `PitLaneTransitions` feature?** They share state detection and pool patterns. Probably yes; decide when migrating Stage 4.
3. **Does `AudioDirector` need a priority queue for overlapping reminders?** Currently first-write-wins on `globalPriorityActive`. A future Phase-2 feature (hard-contact alert) might want to preempt a lower-priority message. Defer until needed.
4. **Where does the Spotter tick-loop timer live?** Currently a module-level `globalSpotterTickTimer`. On migration: a private field on `SpotterFeature`. Self-evident.
5. **Should `TickContext` include `ctx.delta` (time since last tick)?** Some features compute this locally. If more than 2 do, hoist to context. Otherwise leave in features.

---

## 13. What happens after

Once migration is complete:

- New features take ~30 LOC in their own file + 1 line in the coordinator array. No other file edits.
- Feature authors don't need to know anything outside their file + `core/`.
- External contributors can write a feature without reading the coordinator.
- The audio / session / rotator infrastructure is reusable for any future action (e.g. if another action wants engineer-style voice output).
- Tests are first-class: a feature without tests fails review because it can be instantiated directly and must be.

---

## 14. Acceptance criteria (to be checked when done)

- [ ] `pit-engineer/index.ts` ≤ 300 LOC
- [ ] Zero `let global*` in `packages/actions/src/actions/pit-engineer/`
- [ ] Every feature has its own test file with ≥ 80% coverage of its public surface
- [ ] `pnpm build` succeeds in both plugins
- [ ] Full in-game smoke test passes: welcome flow, tip, overtake, flag, incident alert (brief + sustained), spotter, fuel warning, service reminder, pit limiter, pit approach/departure/exit, toggle audio, engine startup
- [ ] Mirabox and Stream Deck packaged builds byte-identical in the actions bundle (same source)
- [ ] All existing tests still pass (including ones unrelated to Pit Engineer)
- [ ] `pit-engineer.ts` is a one-line re-export shim
- [ ] No change to the Property Inspector EJS, icons, or audio files
- [ ] Documentation: add `pit-engineer/CLAUDE.md` summarizing the module structure and SubFeature contract

---

## 15. Document maintenance

When the refactor actually starts, copy this file to `2026-XX-XX-pit-engineer-modularization-design.md` (the retrospective "what we actually did") and delete this one. Until then, keep it current — if the feature count or architecture changes materially, update § 10 triggers and § 4 directory structure.
