# @iracedeck/audio-scenarios

The Race Engineer's voice catalog: scenarios that subscribe to bus events and
play voice clips through `@iracedeck/audio-service`.

See `.claude/rules/race-engineer-callouts.md` for the end-to-end "how to add
a callout" walkthrough that threads this package together with the bus,
translator, audio-assets, deck-core, plugins, and scenario-harness. The notes
below cover the audio-scenarios-only mechanics.

## Catalog layout

```text
src/catalog/pit-crew/
├── index.ts                  # Family wiring: id types, setting-key maps, scenario-id maps, registerPitCrew()
├── pools.ts                  # Every pool name → ordered list of clip paths
├── radio-frame.ts            # Shared @pit-crew.radio-open / @pit-crew.radio-close include scenarios
├── flag-alerts.ts            # Family: flag (issue #467)
├── damage-alerts.ts          # Family: damage (issue #489)
├── pit-status.ts             # Family: pit-status (issue #479)
├── readback.ts               # Family: pit-readback (issues #476 / #481) — compositional scenarios
├── toggle-confirmations.ts   # Family: pit-action (issue #468) — fuel/tires/compound/windshield/fast-repair
├── track-conditions.ts       # Family: track-conditions (issue #526)
├── session-start.ts          # Family: session-start (issue #542) — dynamic clip composition
├── lap-time.ts               # Family: lap-time (issue #555) — dynamic clip composition
├── radar-engine.ts           # Imperative tick-loop engine — NOT a scenario; plays directly on AudioChannel.Radar; consumes radar.changed
├── spotter-engine.ts         # Imperative state-machine engine (issue #651) — NOT a scenario file, but SCHEDULES THROUGH THE INTERPRETER; consumes radar.changed. Gated by the Race Engineer master (pitCrewRaceEngineerEnabled) + two opt-ins — no standalone toggle, no Stream Deck mode/button
├── …
└── *.test.ts
```

One file per family. Each family file:
- Exports `<FAMILY>_ALERTS: readonly Scenario[]`.
- Exports `<FAMILY>_SCENARIO_IDS: readonly string[]` and `<FAMILY>_POOL_NAMES: readonly string[]` for tests.
- Uses a small constructor function (e.g. `flagScenario(id, body)`) to build scenarios with consistent `family:` / `weight:` / `bus:` defaults.

> **Snapshot-driven variation (issue #558).** A family whose lone scenario reads a runtime resolver in its `where:` predicate or conditional `if` steps cannot build that scenario at module-load time. Such a family exports a `buildXxxScenario(getSnapshot)` builder (plus a `registerXxxVars(engine, getSnapshot)` that registers its `engine.defineVar` clip resolvers) **instead of** a static `<FAMILY>_ALERTS` array — the lone scenario is materialized at wiring time inside `registerPitCrew()`. It still exports `<FAMILY>_SCENARIO_IDS: readonly string[]` and `<FAMILY>_POOL_NAMES: readonly string[]` (the latter `[]` when the readout is composed from `engine.defineVar` resolvers / static `clipPath` steps rather than pools), and still uses the small constructor helper for the shared `family:` / `weight:` / `bus:` defaults. Reference files: `session-start.ts` and `lap-time.ts`.

## Pools

Defined once in `pools.ts` as `Record<string, readonly string[]>`. Scenarios
reference them by name — `"pool:<name>"` in a sequence step, or `{ pool: "<name>" }`
in a step object.

- Single-element pools resolve deterministically.
- Multi-element pools **rotate** with a per-pool no-repeat tracker, shared
  across every scenario that draws from the pool. So a callout family that
  reuses a pool (e.g., the acknowledgment pool used by every pit-action
  confirmation) gets a coherent rotation across the whole family.
- Voice substitution: `{voice}` in a path is replaced at playback time with
  the active Race Engineer voice setting. Always use `voice/{voice}/…` paths.

## Scenarios

A `Scenario` (see `src/dsl.ts`) binds:
- `id` — `pit-crew.<family>-<subject>`.
- `when: { event, where? }` — bus event filter. The `where:` predicate runs at event arrival; return `false` to skip.
- `family:` — shared identifier for same-family preemption. A newer same-family fire replaces the in-flight family-mate wholesale, **regardless of weight** (it is NOT stashed for replay).
- `weight?:` — higher weight wins a busy bus. Named bands are exported from `dsl.ts` as `WEIGHT`: `TRANSIENT = 5`, `CHATTER = 10`, `NORMAL = 50` (the default when `weight` is omitted), `SAFETY = 70`, `CRITICAL = 100`. Any integer is allowed — scheduling importance is a tunable number, not a fixed enum.
- `interrupt?:` (default `false`) — when a fire wins a busy bus over an in-flight LOWER-weight fire, `true` cuts that line mid-sentence immediately; `false` waits for the current line to finish, then plays. Equal/lower-weight fires never cut.
- `queueable?:` (default `false`) — when a fire can't take the bus right now (equal/lower weight, or below a focus floor), `true` defers it for replay when the bus next idles; `false` drops it. The single per-bus pending slot holds the **highest-weight waiting fire** (ties → newest). The deferred fire replays **unconditionally** — its `where:` is NOT re-evaluated, because some `where:` predicates commit a side effect as their last gate (e.g. the position readout claims a shared cooldown); freshness comes from the var resolvers reading live state at speak time, not from re-gating.
- `focusOwner?:` — marks a scenario as belonging to an exclusive-focus owner (see the focus floor below).
- **Exclusive focus.** `IScenarioEngine.acquireFocus(bus, ownerId, floorWeight)` / `releaseFocus(bus, ownerId)` raise a per-bus weight floor. While a floor is held, only fires with `weight` at or above the floor — or the owner's own fires (`focusOwner === ownerId`) — play; everything else defers (if `queueable`) or drops. Set the floor to the band you want to admit (e.g. `WEIGHT.SAFETY` to let safety flags through while holding back routine chatter). Releasing the floor drains any deferred fire.
- `sequence:` — ordered steps. The full sequence is `[@pit-crew.radio-open, …body…, @pit-crew.radio-close]` for everything that should sound like radio chatter; the radio frame is itself an include scenario.

## Live gating

Every voice scenario is wrapped at registration time, outside-in:

1. **Master gate** (`pitCrewRaceEngineerEnabled`) — outermost; one boolean for the whole subsystem.
2. **Per-callout opt-in** (`callout<Polarity><Family><Subject>`) — middle; one boolean per subject.
3. (Family-specific) **engine-internal gate** — innermost; e.g. `getPitActionsAllowed()` cooldown for pit-action confirmations.

All gates are **read live** on every event arrival. A toggle mid-session takes
effect on the next event without re-registering scenarios; an in-flight clip
is never cut by a gate flipping. The gate functions are passed into
`registerPitCrew()` as closures over `getGlobalSettings()`.

## Imperative engines (radar-engine, spotter-engine)

Two files in `src/catalog/pit-crew/` are **imperative engines**, not scenario families: they own a module-level state machine driven by `radar.changed` rather than exporting a `*_ALERTS` scenario array. They differ in how they reach the speaker:

- **`radar-engine.ts`** plays clips **directly** on `AudioChannel.Radar` via `@iracedeck/audio-service` — it never touches the interpreter.
- **`spotter-engine.ts`** (issue #651) **schedules through the interpreter**. Instead of playing directly, each transition computes a clip path into a module variable and fires a single var-driven scenario: `getScenarioEngine().fire("pit-crew.spotter-call")`, where the scenario's lone step is `{ var: "spotterClip" }` (registered via `getScenarioEngine().defineVar("spotterClip", () => pendingSpotterClip)`). **All clip selection is var-driven — no new pools.** Because nothing is enumerated in a pool, the scenario has no dependency on the audio manifest at load time (build/test stay green before the clips are generated). The two engine-owned no-repeat arrays (clear pool, still-there pool) live as module consts inside the engine, *not* in `pools.ts`, for the same reason.

The whole engine is gated by the **Race Engineer master** (`pitCrewRaceEngineerEnabled`, the existing "Race Engineer" toggle button) plus **two per-callout opt-ins** read live on every event/tick: `calloutEnabledSpotterCars` (transition calls) and `calloutEnabledSpotterStillThere` (the ~4 s reminder loop), both default ON. The spotter has **no `pitCrewSpotterEnabled` toggle and no Stream Deck mode/button** — it's a Race Engineer voice callout family like flags / position / lap-time. When the master is off, or when **both** opt-ins are off, the engine stays inactive: it acquires no focus floor and fires nothing.

The spotter engine also owns an **exclusive-focus floor**. While any car is alongside it holds `getScenarioEngine().acquireFocus(AudioBus.Voice, "spotter", WEIGHT.SAFETY)` and releases it (`releaseFocus(AudioBus.Voice, "spotter")`) the instant the state returns to clear (or on force-clear: master off / both opt-ins off / pit road / Lone Qualify). The floor admits only fires at `WEIGHT.SAFETY` or above — so safety flag callouts still break through while routine chatter is held back — plus the spotter's own fires (matched by `focusOwner: "spotter"` on the `pit-crew.spotter-call` scenario, so a spotter call plays even while its own floor is held). See the #652 weighted-scheduling entry in `.claude/rules/race-engineer-callout-examples.md` for the focus model.

Both engines reuse the existing `radar.changed` bus event (no new event, no translator diff). Road vs oval terminology in the spotter is resolved per fire from `resolveTrackDirection` / `getTrackDirection` (`@iracedeck/sim-events-iracing`): road courses speak left/right, ovals inside/outside.

## Adding a new family

This is the consumer-side checklist; see the rule
(`.claude/rules/race-engineer-callouts.md`) for the full cross-package flow.

1. New file under `src/catalog/pit-crew/<family>.ts` — scenarios, pool names, scenario-id list.
2. Add the pool entries to `pools.ts`.
3. In `index.ts`:
   - Add `<Family>CalloutId` (type union of subject ids).
   - Add `<FAMILY>_CALLOUT_SETTING_KEYS: Record<<Family>CalloutId, string>` — exported so plugins can read it.
   - Add `SCENARIO_ID_TO_<FAMILY>_ID: Record<string, <Family>CalloutId>` — covers every scenario id in the family.
   - Add `get<Family>CalloutEnabled` parameter to `registerPitCrew` (default `() => true`) — placed **before** the master-gate parameter so the master stays last among per-callout opt-ins. Inserting between existing parameters shifts master-gate's index, so test fixtures that call `registerPitCrew` positionally need `undefined` inserted at the new slot (`register-pit-crew.test.ts`).
   - Wrap the family's scenarios with `wrapWithMaster(wrapCalloutScenario(...))` in the registration loop.

## Conventions

- **Scenario id:** `pit-crew.<family>-<subject>`. The translator does NOT see this id; it's the audio-side convention. The compile-time completeness check in `<FAMILY>_SCENARIO_IDS` catches typos.
- **Pool name:** `<family>-<subject>`. Mirrors the scenario naming so a grep on the family prefix finds both halves.
- **Family identifier (`family:` field):** matches the file/scenario prefix without the `pit-crew.` namespace. So `flag-yellow-local` has `family: "flag"`, `track-conditions-worsening-mostly-dry` has `family: "track-conditions"`.

## Testing

Each family file has a sibling `<family>.test.ts`. The cross-cutting wiring
test is `register-pit-crew.test.ts` — it stands up the engine with a real bus
and asserts that every gate (master, per-callout, engine-internal) actually
suppresses dispatch. When you add a closure parameter to `registerPitCrew`,
update the positional call there or every existing test fails.
