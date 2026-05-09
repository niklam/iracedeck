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
├── radar-engine.ts           # Imperative tick-loop engine — NOT a scenario; consumes radar.changed
├── …
└── *.test.ts
```

One file per family. Each family file:
- Exports `<FAMILY>_ALERTS: readonly Scenario[]`.
- Exports `<FAMILY>_SCENARIO_IDS: readonly string[]` and `<FAMILY>_POOL_NAMES: readonly string[]` for tests.
- Uses a small constructor function (e.g. `flagScenario(id, body)`) to build scenarios with consistent `family:` / `priority:` / `bus:` defaults.

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
- `family:` — shared identifier for same-family preemption. Two fires with the same family supersede the earlier one.
- `priority:` — `low` / `normal` / `urgent`. Cross-family preemption: `urgent` cancels in-flight `normal` (meatball-cancels-yellow); `normal` cancels in-flight `low` (pit-status cancels in-flight readback).
- `preempt: true` — combined with `urgent` for safety-critical lines that should cut anything in flight.
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
