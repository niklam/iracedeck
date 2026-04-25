# Audio architecture design

> **2026-04-22 update (#413):** This document predates the Pit Engineer → **Pit Crew** rebrand and the "Spotter" → **Radar** rename. References below to "pit-engineer" / "spotter" refer to the older names of what now ship as Pit Crew / Race Engineer (voice) and Radar (directional ticks). The architectural layers and scenario-DSL design described here are unchanged by the rename; only labels move. Active sections (§10 testing, §12 release cadence, §13 GA scope) have been updated; historical refactor narrative (§1–§9, §11) keeps the original terminology so it stays consistent with the commits that implemented each stage.

**Status:** Proposed. Work lands on `feature/pit-crew` (branch renamed from `feature/pit-engineer` alongside #413): each stage branches off that feature branch and merges back into it. `feature/pit-crew` → `master` is one final PR containing both the Pit Crew action and this architecture, closing #375 and #376 together.
**Date:** 2026-04-19.
**Issue:** #376. Ships together with #375 (Pit Crew).

---

## 1. Context

`feature/pit-engineer` ships the Pit Engineer action with the miniaudio-backed audio engine bolted onto `@iracedeck/iracing-native`, 174 MP3 clips flat-listed in `@iracedeck/audio-assets`, and all triggering logic (telemetry interpretation + pool rotation + cooldown/priority + sequencing) packed into a 3.5k-LOC `pit-engineer.ts`. That gets the feature out the door but fuses three concerns that should live in different layers:

1. **The audio engine** (miniaudio + channels + device management) has nothing to do with the iRacing SDK. It's in `iracing-native` only because that's where we already had a compiled C++ addon.
2. **The audio scenarios** (when to play what, which pool, which cooldown, which channel) are sim-agnostic concepts — pit approach, flag raised, tire change — but today they're tangled with iRacing-specific telemetry reads.
3. **The iRacing translator** (telemetry → "pit approach just happened") is buried inside the action.

Other racing sims (AC, rFactor, BeamNG, ACC) have the same events. The goal is to make the audio side of the engineer repeatable across sims without rewriting the scenario library each time. Scope for v1: reusable scenarios, iRacing-only telemetry source. Second-sim support is out of scope but shouldn't be painful to add later.

This design also fixes a secondary problem: the branch's own modularization plan (`docs/plans/2026-04-19-pit-engineer-modularization-plan.md`) splits `pit-engineer.ts` into a coordinator + per-feature modules but keeps everything iRacing-specific. That's not enough.

---

## 2. Goals

1. `@iracedeck/iracing-native` goes back to being pure iRacing SDK + keyboard + window focus. Zero audio code.
2. Audio engine is its own package; the native addon compiles without SDK or keyboard code.
3. Scenarios are sim-agnostic data — a future sim adapter can drive the same scenarios by publishing the same semantic events.
4. Scenarios are expressive enough for real content: `["{{name}}", "pause:1000", "wtf.mp3"]`, random pools, conditional branching, composition (one scenario includes another).
5. Events are semantic and typed — a canonical catalog in the bus, not stringly-typed free-for-all.
6. The `PitEngineer` action shrinks to: button toggle, PI, volume/device/driver-name settings, icon — no telemetry reads.
7. Every scenario is unit-testable without mocking `@iracedeck/deck-core` wholesale.
8. Zero behavior change visible to end users (sub-features, volumes, PI, etc. all work identically).

---

## 3. Non-goals

- Support for a second sim. The design accommodates it; implementing another adapter is a separate issue.
- Replacing the audio engine's native bindings with `audio-speaker` or any other npm library. `audio-speaker` was considered (see #376 alternatives) and the native miniaudio path is kept for v1. Revisit if maintenance burden warrants.
- Splitting the spotter into its own Stream Deck action. Scenario clips are structured to make that easy later, but the spotter stays part of Pit Engineer for now.
- Cross-sim *command* parity (broadcast messages, keyboard shortcuts to iRacing). Commands stay in `iracing-sdk`.

---

## 4. Package architecture

Six packages, clearly layered:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ @iracedeck/iracing-actions                                               │
│   • PitEngineer action (thin): button, PI, settings, icon                │
│   • Subscribes to scenarios from @iracedeck/audio-scenarios              │
└──────────────────────────────────────────────────────────────────────────┘
                              │ imports
                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ @iracedeck/audio-scenarios                                               │
│   • Scenario catalog (data)                                              │
│   • DSL interpreter (pools, vars, conditionals, include, cooldown)       │
│   • Subscribes to event bus, drives audio-service                        │
│   • Ships pit-engineer scenarios in a submodule                          │
└──────────────────────────────────────────────────────────────────────────┘
        │ imports bus                      │ imports                        │ imports
        ▼                                  ▼                                ▼
┌────────────────────────┐    ┌────────────────────────┐   ┌────────────────────────┐
│ @iracedeck/event-bus   │    │ @iracedeck/audio-      │   │ @iracedeck/audio-      │
│   • Typed pub/sub      │    │ service                │   │ assets                 │
│   • Event catalog      │    │   • AudioBus + mixing  │   │   • MP3s               │
│   • Lifecycle          │    │   • Sequencer          │   │   • Reorganized        │
│   • Zero sim knowledge │    │   • Device mgmt        │   │                        │
└────────────────────────┘    └────────────────────────┘   └────────────────────────┘
        ▲                              │ imports
        │ publishes                    ▼
┌──────────────────────────────────────┐    ┌────────────────────────┐
│ @iracedeck/sim-events-iracing        │    │ @iracedeck/audio-      │
│   • Subscribes to sdkController      │    │ native                 │
│   • Diffs telemetry                  │    │   • miniaudio.h        │
│   • Publishes semantic events        │    │   • C++ bindings       │
│   • ONLY package importing iracing-  │    │   • Mock for macOS/    │
│     sdk                              │    │     Linux              │
│   • Parallel to future sim-events-ac │    │   • Zero SDK knowledge │
└──────────────────────────────────────┘    └────────────────────────┘
```

### 4.1 `@iracedeck/event-bus`

- Typed pub/sub. One singleton per plugin instance.
- Ships a canonical event catalog (see §6) as a discriminated union. Scenarios get payload-type safety.
- `publish(event)`, `subscribe(eventName, handler)`, `unsubscribe(eventName, handler)`.
- No retention — consumers that need "last value" query a separate state cache (future; not needed for v1).
- No sim knowledge, no audio knowledge. Pure infrastructure.

### 4.2 `@iracedeck/sim-events-iracing`

- Subscribes to `sdkController` ticks (already provided by `deck-core`).
- Keeps per-tick previous-state for diffing (pit road transitions, toggle changes, flag changes, spotter state, material sampling, incident counter).
- On each tick, emits any events that fired.
- Every event carries `telemetry: TelemetryData` (the current tick's snapshot) plus event-specific `data`.
- The **only** package that imports `@iracedeck/iracing-sdk`.
- Mirrored by future `sim-events-ac`, `sim-events-rfactor`, etc. Each emits the same event catalog.

### 4.3 `@iracedeck/audio-native`

- New node-gyp package. Moves `miniaudio.h`, the audio section of `addon.cc`, and the audio TS wrapper out of `iracing-native`.
- Cross-platform: Windows builds the native addon, macOS/Linux use the mock (same pattern as `iracing-native`).
- Exports: `AudioChannel` enum, `IAudioNative` interface (init/destroy/play/stop/volume/isPlaying/setEndCallback/stopAll/seekRandom/getDevices/setDevice).
- Zero knowledge of buses, scenarios, iRacing, or anything above.
- `binding.gyp` keeps `ole32.lib` + the warning suppressions (4244/4267/4996) that today live in `iracing-native/binding.gyp` — those were all miniaudio artifacts.

### 4.4 `@iracedeck/audio-service`

- Pure TS over `@iracedeck/audio-native`.
- Singleton service (`initializeAudio(native, logger)` + `getAudio()` — same pattern as today's `deck-core/audio-service`).
- Owns the `AudioBus` enum (Voice / Background / Alerts) and the channel-to-bus mapping + mix ratios currently baked into `deck-core/audio-service.ts`.
- Owns the **sequencer primitive**: `playSequence(steps: string[], channel, bus, opts)` plays step 1, waits for `setChannelEndCallback`, plays step 2, etc. Cancellable. This is what `pit-engineer.ts`'s `playRadioMessage` / `startVoiceMessages` does by hand today.
- **Does not** understand scenarios, pools, variables, or conditionals. Those live in `audio-scenarios`.

### 4.5 `@iracedeck/audio-assets`

- Reorganized from today's flat layout (see §5).
- Just MP3s + a `package.json`. No code.
- Copied into each plugin's `sdPlugin/assets/audio/` by the existing `copyAudioAssetsPlugin()` in the plugins' rollup configs.

### 4.6 `@iracedeck/audio-scenarios`

- The DSL interpreter (see §7) and the scenario catalog.
- Ships pit-engineer scenarios as one submodule (`@iracedeck/audio-scenarios/pit-engineer`).
- Consumers: register scenarios, register pools, register variables, enable/disable scenarios.
- Depends on: `event-bus`, `audio-service`, `audio-assets`. Knows nothing about iRacing.

---

## 5. audio-assets layout

> **2026-04-25 update (#441):** The original plan envisioned a `pit-engineer/` (later `pit-crew/`) consumer namespace alongside generic `sfx/`. That layout shipped with the feature and was then dropped in #441 §1: TTS-generated voice content moved under `voice/<voice>/` with the radio-engineer ffmpeg filter applied at build time, and `sfx/` stays as the only sibling. Scenarios reference voice content via a templated `base: "voice/{voice}"` so the active Race Engineer voice setting (§9) is substituted at playback time.

```text
packages/audio-assets/
  voice/                         TTS-generated engineer voices, one folder per voice key.
    luca/
      acknowledgment/            ack pool ("Okay.", "Got it.", "Roger that.", …)
      flags/                     flag callouts (engineer calls out flags)
      names/                     driver-name slot fills
      numbers/                   1–100 for fuel/lap call-outs
      openers/                   spoken greetings ("alright", "hi", "right", "so")
      pit-actions/               pit-service callouts (fuel-on, tires-on-fronts, at-the-next-stop, …)
      pit-limiter/               pit-limiter warnings + reminders
      units/                     unit suffixes ("seconds", "litres", "kilograms", …)
      welcome/                   multi-clip welcome flow openers
    titan/
      …                          (parallel structure)
  sfx/                           Generic sound effects — shared across voices.
    IRD-tick-open.mp3            walkie-talkie PTT tick (radio-frame open)
    IRD-tick-close.mp3           walkie-talkie PTT tick (radio-frame close)
    IRD-ambient-pit.mp3          pit-lane ambient loop under voice transmissions
    radar/                       directional radar pings
  generate.config.json           ElevenLabs TTS generator config (voices, groups, prosody anchors)
  generate.manifest.json         Per-entry hash cache (skip re-generation if inputs unchanged)
  manifest.json                  Built manifest consumed by audio-scenarios validation
  package.json
```

Root has two kinds of entries: voice content under `voice/<voice>/` (radio-engineer filter applied at build time) and generic SFX under `sfx/` (passed through as-is). A future "flag marshal" action or "UI sound" feature can add its own top-level namespace, but voice clips for any consumer live under `voice/`.

Scenarios reference clips by path relative to the package root. Paths are prefixed by an optional `base:` on the scenario; leading `/` escapes the base for cross-namespace references; and the `{voice}` token in either the base or a clip path is replaced at playback time with the active Race Engineer voice key:

```ts
{
  base: "voice/{voice}",
  sequence: [
    "@pit-crew.radio-open",         // include the radio-frame opener (sfx tick + ambient start)
    "pool:acknowledgment",          // pool entries are full paths, no base applied
    "pit-actions/tires-on.mp3",     // → voice/<voice>/pit-actions/tires-on.mp3
    "/sfx/IRD-tick-open.mp3",       // → sfx/IRD-tick-open.mp3 (leading "/" escapes the base)
  ],
}
```

---

## 6. Event catalog

Two flavors. Both are published by `sim-events-iracing` on tick ticks, after diffing against previous state.

### 6.1 Transition events — fire once on change

```text
pitLane.approaching            car in approach zone, not on pit road, not exiting
pitLane.entered                crossed onto pit road
pitLane.exited                 crossed off pit road
pitStall.entered               car in stall
pitStall.departed              car left stall while still on pit road

flag.yellow.raised             payload: { scope: "local" | "full" }
flag.yellow.cleared
flag.blue.raised
flag.green.raised
flag.checkered.raised
flag.black.raised
flag.white.raised
flag.red.raised

tireService.changed            payload: { added: string[]; removed: string[]; current: string[] }
                               (debounced 500 ms; suppressed while in pit stall — see §6.3)
pitService.toggled             payload: { service: "fuel" | "windshield" | "fastRepair"; on: boolean }
                               (debounced 300 ms; suppressed while in pit stall — see §6.3)
carControl.drsToggled          payload: { on: boolean }
carControl.p2pToggled          payload: { on: boolean }
carControl.limiterToggled      payload: { on: boolean }
limiter.dropped                limiter was on in pit lane, now off
limiter.missing                on pit road above limited speed, no limiter
limiter.speeding               over pit speed with limiter

incident.occurred              incident counter bumped
offTrack.started
offTrack.ended

overtake.completed             payload: { carIdx: number; sustained: number /* ms */ }

driver.firstOnTrack            first time in car this session (welcome trigger)
session.changed                payload: { from: SessionType; to: SessionType }
engine.startup                 one-shot when RPM jumps from 0
```

### 6.2 Value-change events — emit new state when derived value changes

```text
spotter.changed                payload: { from: SpotterState; to: SpotterState }
fuel.lapsRemaining.crossed     payload: { threshold: number; laps: number }
                               // Translator emits once per descending threshold crossing.
                               // Thresholds are sim-agnostic numeric values; scenarios
                               // filter on `threshold` in their `where` predicate to
                               // react to specific tiers (e.g., 5, 3, 1 laps remaining).
```

### 6.3 Pit-service debouncing + in-stall suppression

The translator coalesces noisy pit-service signals so consumers see a clean stream of user-intent transitions:

- **Per-bit debounce.** Each pit-service bit (fuel / windshield / fast-repair) tracks its own last-observed flip and emits only after the bit has been stable for `PIT_SERVICE_DEBOUNCE_MS` (300 ms). Tire bits use the same scheme but with `TIRE_DEBOUNCE_MS` (500 ms — longer because iRacing's "Lefts" / "Rights" / "Fronts" / "Rears" buttons emit multi-tick clear-then-set transitions that need to ride out before the final state is meaningful). Effects:
  - Rapid taps that revert within the window stay silent (final state matches baseline → no emit).
  - Multi-tap intent oscillations coalesce to a single emit reflecting the settled state.
  - The `tireService.changed` payload carries `current: string[]` (the post-change tire set) so consumers can decide on the resulting state rather than reconstructing it from the deltas.
- **In-stall suppression.** While `PlayerCarInPitStall` is true, the translator continuously syncs its baselines to the current state without emitting. iRacing flips the tire/service bits one-by-one as the crew completes each task during the stop — those aren't user intent and the engineer should stay silent during the actual service. On stall exit the baseline already reflects the post-service state so no spurious "tires off → tires on" cascade fires.
- **Car-control toggles stay immediate.** DRS, P2P, and the pit limiter aren't pit-service bits — they're wheel-button activations / sensor-driven, so they bypass the debounce entirely and fire on the first observed change.

### 6.4 Event envelope

Every event carries the current-tick telemetry snapshot so conditionals in scenarios can peek anywhere without a separate state cache:

```ts
type SimEvent<T extends string, D> = {
  event: T;
  timestamp: number;
  telemetry: TelemetryData;   // full snapshot at fire time (reference, not copy)
  data: D;                    // event-specific payload
};

type SimEventMap = {
  "pitLane.approaching":  SimEvent<"pitLane.approaching", {}>;
  "pitLane.entered":      SimEvent<"pitLane.entered", {}>;
  "flag.yellow.raised":   SimEvent<"flag.yellow.raised", { scope: "local" | "full" }>;
  "spotter.changed":      SimEvent<"spotter.changed", { from: SpotterState; to: SpotterState }>;
  // ... rest
};
```

Dotted names keep hierarchy (`flag.yellow.raised` vs `flag.yellow.cleared`). Translator maps iRacing flag bits + scope + clear-detection to each name — that logic is already in `pit-engineer.ts`'s `handleFlags`; the design moves it, doesn't reinvent it.

---

## 7. Scenario DSL

A scenario is data:

```ts
type Scenario = {
  id: string;                          // "pit-engineer.welcome"
  when?: { event: keyof SimEventMap; where?: (e: SimEvent) => boolean };  // absent = fires only via engineer.fire(id)
  channel: AudioChannel;               // Voice | Spotter | SFX | Ambient
  bus: AudioBus;                       // Voice | Background | Alerts
  priority?: "low" | "normal" | "high" | "urgent";   // default: normal
  cooldown?: number;                   // ms debounce (absent = no debounce)
  preempt?: boolean;                   // urgent: stop current voice clip on fire
  family?: string;                     // scenarios sharing a family preempt each other regardless of priority
  base?: string;                       // path prefix for sequence entries; supports {voice} substitution
  sequence: Step[];
};

type Step =
  | string                             // shorthand (see below)
  | { clip: string }                   // literal file
  | { var: string }                    // context variable
  | { pool: string; noRepeat?: boolean }
  | { connector: true }                // sugar for { pool: "connector" }
  | { pause: number }                  // ms
  | { include: string }                // splice another scenario's sequence
  | { if: (ctx: ScenarioContext) => boolean; then: Step[]; else?: Step[] };
```

**String shorthand:**

| Shorthand | Object form |
|---|---|
| `"foo/bar.mp3"` | `{ clip: "foo/bar.mp3" }` |
| `"/foo/bar.mp3"` | `{ clip: "/foo/bar.mp3" }` (base-escaped) |
| `"{{name}}"` | `{ var: "name" }` |
| `"pool:greeting"` | `{ pool: "greeting" }` |
| `"pause:500"` | `{ pause: 500 }` |
| `"@other-scenario"` | `{ include: "other-scenario" }` |

**Syntax-only example** (no `when` — triggered imperatively via `engineer.fire(id)`, e.g., from a PI "Test" button):

```ts
{
  id: "pit-engineer.wtf",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-engineer",
  sequence: ["{{name}}", "pause:1000", "extras/wtf.mp3"],
}
```

Scenarios without `when` are not auto-subscribed to the event bus; they only play when explicitly fired. This is how the existing PI "Test" button wires up today.

**Event-driven example with `where` filter** (fuel warning at the 3-lap threshold only):

```ts
{
  id: "pit-engineer.fuel-3laps",
  when: {
    event: "fuel.lapsRemaining.crossed",
    where: (e) => e.data.threshold === 3,
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-engineer",
  sequence: ["@pit-engineer.radio-open", "pool:fuel-low-3laps", "@pit-engineer.radio-close"],
}
```

**Welcome flow from the branch, translated:**

```ts
{
  id: "pit-engineer.welcome",
  when: { event: "driver.firstOnTrack" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-engineer",
  sequence: [
    "/sfx/IRD-tick-open.mp3",     // leading "/" → absolute, escapes the pit-engineer base
    "pool:greeting",              // random pick, no-repeat
    { connector: true },
    "{{name}}",
    { connector: true },
    "pool:welcome-tip",
    "/sfx/IRD-tick-close.mp3",
  ],
}
```

**Auto-fuel branching — one scenario, not two:**

```ts
{
  id: "pit-engineer.service-reminder",
  when: { event: "pitLane.entered" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "pit-engineer",
  sequence: [
    "@pit-engineer.radio-open",
    {
      if: (ctx) => ctx.telemetry.dpFuelAutoFillActive === true,
      then: ["pool:reminder-autofuel"],
      else: ["pool:reminder-fuel"],
    },
    "pool:reminder-tires",
    "@pit-engineer.radio-close",
  ],
}
```

**Radio-frame composition (defined once, reused everywhere):**

```ts
{ id: "pit-engineer.radio-open",  sequence: ["/sfx/IRD-tick-open.mp3",  "pool:acknowledgment"] }
{ id: "pit-engineer.radio-close", sequence: ["/sfx/IRD-tick-close.mp3"] }
```

**Priority / preempt** — pit speeding cuts off tips mid-sentence:

```ts
{ id: "limiter.speeding", priority: "urgent", preempt: true, ... }
```

### 7.1 Pools

Defined once, referenced by name. Shared no-repeat rotation across scenarios that use the same pool.

```ts
engineer.definePool("greeting", [
  "pit-engineer/greeting/welcome.mp3",
  "pit-engineer/greeting/good-to-have-you.mp3",
]);

engineer.definePool("connector", [
  "pit-engineer/connector/and.mp3",
  "pit-engineer/connector/also.mp3",
  "pit-engineer/connector/plus.mp3",
]);
```

### 7.2 Variables

Variables are registered by the consumer so they can be dynamic. The pit-engineer action wires `{{name}}`:

```ts
engineer.defineVar("name", () => {
  const settings = getActionSettings();
  return `pit-engineer/names/${settings.driverName}.mp3`;
});
```

### 7.3 Scenario context (passed to conditionals)

```ts
type ScenarioContext = {
  event: SimEvent;                     // the triggering event
  telemetry: TelemetryData;            // event.telemetry, for convenience
  data: unknown;                       // event.data, typed per event
  now: number;                         // timestamp
  vars: Record<string, string>;        // resolved variable values
};
```

---

## 8. Data flow

**Plugin startup (order matters, each depends on previous):**

```text
1. initPluginConfig(config)
2. eventBus.initialize(logger)
3. initializeAudio(audioNative, logger)   ← uses @iracedeck/audio-native
4. getAudio().init()
5. publish _audioDeviceList / apply audioOutputDevice from global settings
6. initializeSimEventsIracing(eventBus, sdkController, logger)
7. initializeAudioScenarios(eventBus, audioService, assets, logger)
8. Register scenario catalogs (pit-engineer, future others)
9. Register iracing-actions (PitEngineer, etc.) on the adapter
10. initGlobalSettings(adapter, logger)
11. ... rest of today's init (SimHub, BindingDispatcher, AppMonitor)
12. adapter.connect()
```

**Runtime — one telemetry tick:**

1. `sdkController` delivers `TelemetryData` to `sim-events-iracing`.
2. Translator diffs against last tick; detects "entered approach zone, not exiting".
3. `eventBus.publish({ event: "pitLane.approaching", telemetry, data: {} })`.
4. `audio-scenarios` handler receives the event, looks up scenarios with `when.event === "pitLane.approaching"`, filters by `where` predicate.
5. Per matched scenario: check cooldown, priority vs. currently-playing scenario, optional preempt, optional family preempt.
   - **Default (non-urgent scenario fires while another non-urgent is playing):** the new scenario is dropped, not queued. Voice lanes are single-stream — queuing would stale-play callouts seconds after their triggering event.
   - **Urgent + preempt:** stops the current clip mid-sentence and plays the urgent scenario.
   - **Urgent without preempt:** same as non-urgent default — dropped if something is playing.
   - **Same family:** the new scenario stops the current clip mid-sentence and plays itself, regardless of priority. Used for scenario groups where a new event invalidates the in-flight callout (e.g., all tire-set scenarios share `family: "tire-service"`, so switching from "fronts" to "rears" mid-playback cancels the fronts callout and starts the rears one). Cross-family scenarios still respect the priority/preempt rules above.
6. Resolve `sequence` step-by-step:
   - literal → path (applying `base` unless leading `/`)
   - var → call registered resolver
   - pool → pick random, no-repeat (shared state across scenarios using same pool)
   - conditional → evaluate `if`, take `then` or `else` branch
   - include → inline the other scenario's resolved sequence
   - pause → schedule delay
7. Call `audioService.playSequence(resolvedPaths, channel, bus, { onComplete })`.
8. `audioService` plays step 1 on the channel, awaits `setChannelEndCallback`, plays step 2, etc. Respects bus volume.

**PI enable/disable** a sub-feature:

- PI toggles `pitApproachEnabled`.
- Action calls `scenarios.setEnabled("pit-engineer.pit-approach", false)`.
- Scenario layer unsubscribes that scenario's trigger from the bus.
- Any in-flight sequence for that scenario is cancelled.

**Disconnect from iRacing:**

- `sdkController` reports disconnect.
- `sim-events-iracing` stops diffing (no tick → no events).
- `audio-scenarios` optionally subscribes to a `session.disconnected` event the translator also emits; on receipt, cancels any in-flight sequences and resets pool rotation state.

---

## 9. Error handling

- **Audio failures are non-fatal.** Missing MP3, dropped device, native-engine hiccup: log and skip. Plugin never crashes on audio.
- **Load-time validation.** On scenario catalog load, scan every scenario: check clip files exist (via `audio-assets` manifest), pools referenced are defined, events referenced exist in the catalog, vars are registered. Broken scenarios log and skip. The rest keep working.
  - The manifest is auto-generated at `audio-assets` build time by a new `scripts/generate-audio-manifest.mjs` (mirrors the existing `scripts/generate-icon-defaults.mjs` pattern). Output: a JSON list of clip paths committed under `packages/audio-assets/manifest.json`. A freshness test verifies the manifest matches the file tree, same way icon previews are checked today.
- **Runtime per-fire try/catch.** Interpreter wraps each fire so one broken scenario never blocks another. Logged at error level with scenario id + event name.
- **Sequencer resilience.** If `setChannelEndCallback` fires with an error, or if a step's clip resolves to a missing path at runtime, the sequencer logs and advances to the next step rather than stalling.
- **Non-Windows dev.** Existing native mock handles everything as no-op success. No behavioral divergence for scenario logic — it still resolves and "plays" (no sound), letting the DSL be tested end-to-end on macOS/Linux.

---

## 10. Testing

- **`@iracedeck/event-bus`** — pure TS, typed payloads. Trivial tests for publish/subscribe/unsubscribe; type-level tests that the event catalog is discriminated correctly.
- **`@iracedeck/sim-events-iracing`** — feed canned `TelemetryData` snapshots via a fake `sdkController`. The `iracing-native` mock already ships realistic snapshots (Spa practice, 3 drivers). Assert the event stream for each input sequence. Tests live in this package, independent from the audio side.
- **`@iracedeck/audio-native`** — no tests (it's the boundary). The mock is what other packages test against.
- **`@iracedeck/audio-service`** — inject a fake native, assert channel/bus routing and sequencer behavior. Mirror the existing `deck-core/audio-service.test.ts`.
- **`@iracedeck/audio-scenarios` — interpreter unit tests.** Property tests on the DSL:
  - String shorthand → object equivalence
  - Pool rotation no-repeat across multiple draws and across scenarios sharing a pool
  - Variable resolution (including variables that depend on settings)
  - Conditional branching given synthetic `ScenarioContext`
  - Include composition (including cycle detection)
  - Cooldown enforcement, priority ordering, preemption of in-flight
- **`@iracedeck/audio-scenarios` — catalog tests.** Each scenario catalog gets its own test file that feeds canned events and asserts the resolved clip sequence. `audio-service` is faked — no real audio plays. **This is the big win:** scenario behavior is testable without mocking `@iracedeck/deck-core` wholesale (the approach `pit-crew.test.ts` is forced into for the Stream Deck surface).
- **`PitCrew` action** — Tests verify per mode: (a) Race Engineer toggle flips `raceEngineerEnabled` in global settings without touching the Radar gate; (b) Radar toggle flips `radarEnabled` synchronously via `setRadarEnabled` (so the tick loop stops/starts immediately) and writes to global settings; (c) Radar Volume up/down steps `radarVolume` by 5, clamps at 5/100, and writes to `AudioBus.Alerts`; (d) the Test button invokes `playRadarTest`; (e) independent-gate regression: Race Engineer off + Radar on still ticks, and vice versa. Voice-scenario assertions (welcome/pit-lane/flag/etc.) come back with their follow-up PRs (#410).
- **Plugin wiring** — smoke test that startup order produces a ready event bus + working audio-service + scenarios subscribed to the bus.

---

## 11. Build and packaging

- **`@iracedeck/audio-native`** is a new node-gyp package. Mirrors `iracing-native`'s cross-platform `scripts/build.mjs`:
  - Windows: `node-gyp rebuild` + `tsc`
  - macOS/Linux: `tsc` only (mock active at module load)
- `binding.gyp` moves the miniaudio-relevant bits out of `iracing-native`:
  - Linked libs: `ole32.lib` only (drop `winmm.lib` addition that went with the audio section)
  - Disabled warnings: 4244, 4267, 4996 (miniaudio-only artifacts)
- `iracing-native/binding.gyp` returns to pre-pit-engineer state (`user32.lib`, `kernel32.lib`). `winmm.lib` was never needed — it was added in the pit-engineer commit and can be removed.
- **`@iracedeck/audio-service`, `@iracedeck/audio-scenarios`, `@iracedeck/event-bus`, `@iracedeck/sim-events-iracing`** — all pure TS, `tsc` build. Turbo handles topological order.
- **`@iracedeck/audio-assets`** — no build step, just MP3s.
- **Plugin rollup configs** — `copyAudioAssetsPlugin()` stays, just reads the reorganized `audio-assets/` layout.
- **Plugin emitted `package.json`** — `@iracedeck/audio-native` goes in `optionalDependencies` (same pattern as `keysender`). `keysender` was never in `iracing-native` so nothing else changes on that front.

---

## 12. Migration and rollout

The extraction happens on branches off `feature/pit-engineer`, not on `master`. Each stage is its own PR into `feature/pit-engineer`. The whole refactored feature — Pit Engineer action + architecture — lands on `master` as a single final merge, closing both #375 and #376. Stages are ordered so each commit leaves `feature/pit-engineer` installable and playable; because `master` never sees an intermediate state, no compatibility shims are required — consumers update in the same commit that moves the code.

### Stage 1 — Extract `@iracedeck/audio-native`

- Move `miniaudio.h` and the audio section of `addon.cc` / `mock-impl.ts` / `index.ts` from `iracing-native` to new `packages/audio-native/`.
- `binding.gyp` split: iRacing-native gets the no-audio baseline; audio-native gets `ole32.lib` + warning disables.
- Update both plugins' `plugin.ts`: instantiate a separate `new AudioNative()` alongside `new IRacingNative()` and pass its audio callbacks to `initializeAudio(...)`. No re-export shims in `iracing-native`.
- No behavior change. Commit: `refactor(audio): extract audio-native from iracing-native (#376)`.

### Stage 2 — Extract `@iracedeck/audio-service`

- Move today's `deck-core/audio-service.ts` into the new package.
- Depend on `@iracedeck/audio-native` directly.
- Update all consumers (`pit-engineer.ts`, both plugins' `plugin.ts`) to import from the new package in the same commit. `deck-core` does not re-export.
- Commit: `refactor(audio): extract audio-service package (#376)`.

### Stage 3 — Add `@iracedeck/event-bus`

- New package, pure TS.
- Empty event catalog at this point — no consumers yet.
- Commit: `feat(events): add event-bus package (#376)`.

### Stage 4 — Add `@iracedeck/sim-events-iracing` and migrate pit-engineer handlers

This stage does two related things; split into two commits inside the same PR for reviewability:

- **4a.** Add the package with the translator skeleton + event catalog. No consumers yet; telemetry-diffing logic copied over from `pit-engineer.ts` into the new package but not deleted from the action. Commit: `feat(events): add sim-events-iracing translator (#376)`.
- **4b.** Migrate `pit-engineer.ts` handlers to subscribe to the event bus instead of reading telemetry directly. Delete the duplicated diffing logic from the action in the same commit it becomes unreachable. Commit: `refactor(pit-engineer): consume semantic events from sim-events-iracing (#376)`.

### Stage 5 — Reorganize `audio-assets`

- Git-move files into `pit-engineer/` subfolder. Rename targets: `radio-openers/` → `pit-engineer/greeting/`, `fuel-warnings/` → `pit-engineer/fuel/`, others preserve their names under `pit-engineer/`.
- **Pre-check:** `grep -r "radio-openers\|fuel-warnings" packages/` before moving. Hits outside `pit-engineer.ts` (EJS templates, test fixtures, other actions) must be updated in the same commit.
- No new package; just file reorg.
- Commit: `refactor(audio-assets): reorganize into pit-engineer/ namespace (#376)`.

### Stage 6 — Add `@iracedeck/audio-scenarios`

- New package. DSL interpreter + catalog.
- Port pit-engineer scenarios one at a time (pit approach, pit exit, service reminder, flag alerts, etc.).
- After each port: delete the corresponding handler from `pit-engineer.ts`, confirm tests pass.
- Commit per scenario group: `refactor(pit-engineer): port pit-lane scenarios to audio-scenarios (#376)`, etc.

### Stage 7 — Shrink `PitEngineer` action ✅

- After all scenarios are ported, `pit-engineer.ts` becomes: button, PI, settings, icon. Target: under 400 LOC. **Landed at 380 LOC (#401).**
- All module-level `let` globals deleted (their roles are now owned by scenarios / sim-events-iracing / audio-service).
- Commit: `refactor(pit-engineer): shrink action to thin shell over audio-scenarios (#401)`.
- Master on/off stored as a plugin-global setting (`pitEngineerEnabled`) so the flag persists across restarts and is readable by every action instance without module state.
- The spotter tick loop — the one imperative piece the DSL cannot yet express (see §15) — moved to `packages/audio-scenarios/src/catalog/pit-engineer/spotter-engine.ts`. Registered alongside `registerPitEngineer(bus)` and exposed via `setSpotterEnabled` / `playSpotterTest` / `subscribeSpotterVisualState` so the action stays stateless.

Each stage is a single logical commit; each lands as its own PR into `feature/pit-engineer`. Tests run and pass at every stage. Stage 6 may split into multiple per-scenario-group commits inside a single PR.

---

## 13. Release cadence is out of scope

This plan governs **architecture**, not **feature release cadence**. The two axes are orthogonal.

- **Every stage preserves user-visible behavior on `feature/pit-crew`** (branch renamed from `feature/pit-engineer` in #413). A scenario that plays on the branch today plays the same way after stage 6 ports it to the DSL — same trigger, same clips, same default PI toggle state. Stage-6 ports are refactors, not new-scenario introductions.
- **First GA release scope (updated #410 + #413).** The Pit Crew action ships as a multi-mode Stream Deck action with three modes: Race Engineer (voice toggle), Radar (directional tick toggle), and Radar Volume Up/Down. **Radar is the only feature that produces audio on day 1** — voice-engineer scenarios (welcome, pit-lane callouts, flag alerts, incident alerts, overtake + racing tips, toggle confirmations, pit-limiter warnings, fuel warnings) are not registered with the scenario engine; the Race Engineer toggle flips a global flag that those scenarios will read when they return in follow-up PRs. Race Engineer and Radar have independent on/off globals (`raceEngineerEnabled`, `radarEnabled`) so silencing the voice engineer doesn't kill the proximity alerts. Both ship default-on.
- **Follow-up tracking.** Voice-engineer features return one at a time in dedicated PRs after individual validation. Race Engineer Volume Up/Down modes land alongside the first voice-scenario PR (adding them now would be dead UI). Issues get filed when the work is scheduled — no placeholder issues today.

---

## 14. Critical files

### New packages (each gets its own folder under `packages/`)

- `packages/audio-native/` (node-gyp, C++, mock)
- `packages/audio-service/` (TS)
- `packages/event-bus/` (TS)
- `packages/sim-events-iracing/` (TS)
- `packages/audio-scenarios/` (TS)

### Modified packages

- `packages/iracing-native/` — drop audio section from `addon.cc`, `index.ts`, `mock-impl.ts`; drop `miniaudio.h`; revert `binding.gyp` audio libs
- `packages/deck-core/` — remove `audio-service.ts` (now in its own package). All consumers updated in stage 2; no re-export shim, since `master` only sees the final post-refactor state.
- `packages/audio-assets/` — reorganize into `pit-engineer/` + top-level generics
- `packages/iracing-actions/src/actions/pit-engineer/pit-engineer.ts` — shrinks to ~400 LOC
- `packages/iracing-actions/src/actions/pit-engineer/pit-engineer.test.ts` — rewrites to test the thin action directly; scenario tests move to `audio-scenarios`
- `packages/iracing-plugin-stream-deck/src/plugin.ts` and `packages/iracing-plugin-mirabox/src/plugin.ts` — add init for event-bus, sim-events-iracing, audio-scenarios; same pattern in both
- Both plugins' `rollup.config.mjs` — no changes (the existing `copyAudioAssetsPlugin()` continues to work)
- `.claude/rules/plugin-structure.md` — update the init-order doc block
- `.claude/rules/platform-feature-flags.md` — no changes expected

### Existing utilities and patterns to reuse

- Cross-platform native build script pattern: `packages/iracing-native/scripts/build.mjs` — template for `audio-native`
- Singleton + `initializeX(...)` + `getX()` pattern: `deck-core/audio-service.ts` today — template for the new `audio-service`
- Global-settings pub/sub pattern (`onGlobalSettingsChange`) — reference implementation for the event bus shape
- Per-action settings mocking pattern: `packages/iracing-actions/src/actions/splits-delta-cycle/splits-delta-cycle.test.ts` — template for the shrunken `PitEngineer` tests

---

## 15. Verification

Per-stage:

```bash
pnpm install
pnpm --filter <stage-package> test
pnpm build
```

End-to-end (after all stages):

```bash
pnpm install
pnpm lint
pnpm test            # pit-crew.test.ts covers the multi-mode surface; scenario tests live in audio-scenarios
pnpm build           # both plugins
pnpm --filter @iracedeck/iracing-plugin-stream-deck pack:plugin
pnpm --filter @iracedeck/iracing-plugin-mirabox pack:plugin
```

Runtime smoke test on Windows (initial GA scope — Radar audible only, per §13 / #410 / #413):

1. Start Stream Deck (or VSD Craft) with four Pit Crew buttons bound, one per mode: Race Engineer, Radar, Radar Volume Up, Radar Volume Down.
2. Open the PI on each — confirm the Mode dropdown with three entries (Race Engineer, Radar, Radar Volume), the Direction dropdown (visible only when Mode = Radar Volume), a global Radar Volume slider + Test, a global Output Device dropdown, and the standard title/color/border/graphic + common settings. No old Pit Engineer / Spotter fields.
3. Press the Race Engineer button — `raceEngineerEnabled` flips in global settings; status bar flips green ↔ red across every Pit Crew instance showing the Race Engineer mode. With voice scenarios unregistered per #410, no audio plays — the only observable effect is the icon state.
4. Press the Radar button — `radarEnabled` flips; `setRadarEnabled` is called synchronously so the directional tick loop stops/starts immediately in a live session.
5. Confirm **no** voice audio plays on welcome (first-on-track), flag raises, pit-lane transitions, stall departure, pit exit, service reminders, incidents, overtakes, racing tips, toggle confirmations, pit-limiter states, or fuel-threshold crossings. Those scenarios are still not registered with the scenario engine; their catalogs return with their follow-up PRs.
6. Press Radar Volume Up / Down — `radarVolume` increments/decrements by 5 on `AudioBus.Alerts`; clamps at 5/100; key icon reflects the new percentage.
7. Press the Radar Test button in any PI — confirm the left → right → both preview plays on `AudioChannel.Radar`.
8. Swap Output Device — confirm the preview plays on the selected device. Voice (engineer) and Background buses are not driven today; any follow-up PR re-introducing a voice feature re-wires them.
9. Independent-gate check: set Race Engineer off + Radar on → ticks still play. Set Race Engineer on + Radar off → silence.

Voice-scenario smoke tests (welcome, pit-lane, flag alerts, etc.) return alongside the follow-up PRs that re-register each scenario; they are deferred for the initial GA signoff.

Runtime on macOS (mock path):

1. `pnpm test` passes.
2. The `audio-scenarios` catalog tests pass without any native addon (the DSL interpreter is TS-only).
3. Plugin boot doesn't crash; `initializeAudio` logs that it's running in mock mode; no audio output but no errors.

---

## 16. Open questions

- **Second-sim translator naming.** Today: `@iracedeck/sim-events-iracing`. For AC, would we use `sim-events-ac` or `sim-events-assetto-corsa`? The branch picks short names (`iracing-*`), so keep short for consistency. Not blocking.
- **Pool scope.** Shared no-repeat rotation across all scenarios that use the same pool, or per-scenario rotation? Default to shared (that's how the branch behaves implicitly — there's one `lastAckIndex`). Revisit if it causes surprises.
- **Variable function signatures.** Today vars resolve to `string` paths. Could later return sequences (`Step[]`) to allow "variable expansion" that isn't a single clip. YAGNI for v1.
- **Catalog packaging.** Ship scenarios as compiled TS or as JSON data? TS is easier (conditionals are functions), JSON is more portable. v1: TS. Revisit if we ever want user-editable scenarios.
