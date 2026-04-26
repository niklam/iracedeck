# Design: Voice scenarios for flag events

## Context

`@iracedeck/audio-scenarios/catalog/pit-crew/flag-alerts.ts` defines seven flag scenarios but they reference clip paths that never existed (`pit-crew/flags/IRD-flag-{color}-flag.mp3`) and are not registered in `registerPitCrew()`. The Race Engineer is silent on flag changes today even though `sim-events-iracing/diff/flags.ts` already publishes `flag.{color}.raised` (yellow / green / blue / black / red / white / checkered / debris / meatball) and `flag.yellow.cleared`, and the scenario harness already exposes one-click triggers for all eleven flag transitions.

Voice clips for both registered voices (`luca`, `titan`) are already generated under `voice/<voice>/flags/`: `black-01`, `blue-01` + `blue-02`, `checkered-{practise,qualifying,race}-01`, `debris-01`, `green-01`, `meatball-01`, `red-01`, `white-01`, `yellow-01`. The existing `yellow-01` text ("Yellow flag! Mind the slow cars!") reads as local-style; the issue calls out scope distinction (local vs full-course) as priority #2, so a full-yellow clip is missing. A yellow-cleared clip is also missing.

The issue lists meatball as priority #1 — drivers may not see the flag overlay and missing it costs a black-flag penalty — and it explicitly asks for `priority: "urgent"` + `preempt: true` so it interrupts in-flight engineer chatter.

## Changes

### 1. Audio asset config (`packages/audio-assets/generate.config.json`)

Under `groups.flags`:

- Rename existing `yellow-01` → `yellow-local-01` (keeps current text "Yellow flag! Mind the slow cars!"). Aligns with the `<color>-<qualifier>-NN` convention already used by checkered.
- Add `yellow-full-01` — text: `"Full course yellow! <break time="0.3s" /> Pace car deployed."`
- Add `yellow-cleared-01` — text: `"Yellow's cleared. <break time="0.3s" /> Back to green soon."`

Then run `pnpm --filter @iracedeck/audio-assets generate --group flags` to produce the three new MP3s per voice (~6 ElevenLabs calls), followed by `pnpm --filter @iracedeck/audio-assets generate:manifest` to refresh the runtime `manifest.json`.

### 2. Scenario catalog (`packages/audio-scenarios/src/catalog/pit-crew/flag-alerts.ts` — full rewrite)

Replace the existing file with eleven scenarios. All wrap `@pit-crew.radio-open` ... `@pit-crew.radio-close`, all `base: "voice/{voice}"`, all `channel: AudioChannel.Voice`, `bus: AudioBus.Voice`.

Family strategy:

- All non-meatball flag scenarios share `family: "flag"`. Per the DSL contract this means a new flag callout preempts the in-flight one regardless of priority — yellow → green race restart no longer plays both back-to-back; whichever flag fires last wins.
- Meatball is excluded from the family. We want it to preempt anything in flight (handled by `priority: "urgent"` + `preempt: true`), but we do NOT want a routine yellow to cancel a still-playing meatball — leaving it out of the `flag` family achieves both.

Scenario definitions:

| id | Trigger | Sequence body | Priority | Family |
|---|---|---|---|---|
| `pit-crew.flag-yellow-local` | `flag.yellow.raised` where `data.scope === "local"` | `flags/yellow-local-01.mp3` | normal | flag |
| `pit-crew.flag-yellow-full` | `flag.yellow.raised` where `data.scope === "full"` | `flags/yellow-full-01.mp3` | normal | flag |
| `pit-crew.flag-yellow-cleared` | `flag.yellow.cleared` | `flags/yellow-cleared-01.mp3` | normal | flag |
| `pit-crew.flag-green` | `flag.green.raised` | `flags/green-01.mp3` | normal | flag |
| `pit-crew.flag-blue` | `flag.blue.raised` | `pool: "flag-blue"` | normal | flag |
| `pit-crew.flag-white` | `flag.white.raised` | `flags/white-01.mp3` | normal | flag |
| `pit-crew.flag-red` | `flag.red.raised` | `flags/red-01.mp3` | normal | flag |
| `pit-crew.flag-black` | `flag.black.raised` | `flags/black-01.mp3` | normal | flag |
| `pit-crew.flag-checkered` | `flag.checkered.raised` | `if`-step on `getSessionType()` → `practise` / `qualifying` / `race` clip | normal | flag |
| `pit-crew.flag-debris` | `flag.debris.raised` | `flags/debris-01.mp3` | normal | flag |
| `pit-crew.flag-meatball` | `flag.meatball.raised` | `flags/meatball-01.mp3` | **urgent** + `preempt: true` | _(none)_ |

Blue uses a pool to randomize between `blue-01` and `blue-02`. Add an entry to the existing `POOLS` registry in `pit-crew/pools.ts`:

```typescript
"flag-blue": [
  "voice/{voice}/flags/blue-01.mp3",
  "voice/{voice}/flags/blue-02.mp3",
],
```

Pool clips include the full `voice/{voice}/...` path because pool resolution does NOT apply the calling scenario's `base` (pool clip paths are resolved verbatim except for `{voice}` substitution against the manifest). Register it from `index.ts` next to the `acknowledgment` line:

```typescript
engine.definePool("flag-blue", [...POOLS["flag-blue"]]);
```

Checkered uses nested `if` steps on `getSessionType()` (imported from `@iracedeck/sim-events-iracing` — already a workspace dep of `@iracedeck/audio-scenarios`). The DSL's `if` step takes one predicate with `then` / optional `else`, so a three-way branch nests:

```typescript
sequence: toggleSequence([
  {
    if: () => getSessionType() === "Practice",
    then: ["flags/checkered-practise-01.mp3"],
    else: [
      {
        if: () => getSessionType().includes("Qualify"),
        then: ["flags/checkered-qualifying-01.mp3"],
        else: ["flags/checkered-race-01.mp3"],
      },
    ],
  },
]),
```

Branching rules:

- `"Practice"` → `flags/checkered-practise-01.mp3`
- contains `"Qualify"` (matches both `"Open Qualify"` and `"Lone Qualify"`) → `flags/checkered-qualifying-01.mp3`
- everything else (default — `"Race"`, empty string, unknown) → `flags/checkered-race-01.mp3`

The `getSessionType()` calls are inside predicate closures so they resolve at fire time, not module-load time. Two calls per fire is acceptable (zero-cost lookup of an in-memory snapshot).

Export `FLAG_ALERTS: readonly Scenario[]` from `flag-alerts.ts`. The blue pool lives in `pools.ts`, not `flag-alerts.ts`, so all pool definitions stay in one place.

### 3. Registration (`packages/audio-scenarios/src/catalog/pit-crew/index.ts`)

Import `FLAG_ALERTS`. Add the pool registration next to `acknowledgment`, then a loop over `FLAG_ALERTS` after the tire compound loop:

```typescript
engine.definePool("flag-blue", [...POOLS["flag-blue"]]);

// ... existing scenario loops ...

for (const s of FLAG_ALERTS) engine.defineScenario(s);
```

Update the file-header docstring so the "stay on disk" list no longer mentions flag alerts and the "Other voice scenarios" paragraph trims accordingly.

### 4. Tests (`packages/audio-scenarios/src/catalog/pit-crew/flag-alerts.test.ts` — new)

Mirror the structure of `toggle-confirmations.test.ts`. Cases:

- `FLAG_ALERTS` length matches the table above (11 scenarios).
- Each scenario has the expected `id`, `when.event`, `priority`, and `family` (or absence of family for meatball).
- Yellow `where` predicates select correctly on `data.scope === "local"` vs `"full"`.
- Meatball scenario has `priority: "urgent"` and `preempt: true`.
- All non-meatball flag scenarios have `family: "flag"`.
- Checkered `if`-step picks the right clip for `"Race"`, `"Practice"`, `"Open Qualify"`, `"Lone Qualify"`, and unknown session types. Mock `getSessionType` via `vi.mock("@iracedeck/sim-events-iracing", ...)`.
- Blue scenario references the pool `flag-blue`. Add a parallel test in `pools.test.ts` (or extend an existing pool sanity test) that `POOLS["flag-blue"]` contains both clip paths.

### 5. Plugin docs

- `docs/plugins/core/actions/pit-crew.md` (or equivalent action doc) — list flag voice coverage in the Pit Crew action page, noting per-flag clips, scope-aware yellow, and meatball as the only urgent preempting callout.
- Website action docs (`apps/website/...` if applicable) — same.

Skill files (`iracedeck-actions`) describe actions, not scenarios, and don't need updates.

## Out of scope

- `flag.debris.cleared` and `flag.meatball.cleared` event-bus events — explicitly deferred per brainstorm. Today's scenarios are raised-only, matching the existing single-edge pattern for non-yellow flags.
- Sector-aware yellow flag callouts (`"yellow, sector 3"`) — needs sector resolution work first.
- Pace-car / safety-car-specific announcements — not flag events.
- Visual flag-state updates on key icons — separate from the audio path.
- Adding new variants to existing single-clip flags (red, white, etc.) — current single clips are sufficient; variant pools can land later as new audio is recorded.
- Migrating the still-pending toggle scenarios (`PENDING_TOGGLE_SCENARIOS`: windshield / fastRepair / drs / p2p) — separate issue.

## Verification

- `pnpm --filter @iracedeck/audio-scenarios test` — unit tests pass.
- `pnpm --filter @iracedeck/audio-assets generate --group flags --dry-run` shows only the three new/renamed entries.
- After live generation: `voice/luca/flags/` and `voice/titan/flags/` each contain `yellow-local-01.mp3`, `yellow-full-01.mp3`, `yellow-cleared-01.mp3`; `yellow-01.mp3` is absent.
- Scenario harness (`pnpm --filter @iracedeck/scenario-harness dev`):
  - All 11 flag buttons fire the engineer voice and use the radio frame.
  - Click "Yellow (local)" then "Yellow (full)": full-yellow preempts the local clip mid-message (family preemption).
  - Click "Yellow (local)", then immediately click "Meatball" while the line is still playing: meatball preempts mid-message (urgent + preempt).
  - Click "Meatball", then immediately click "Yellow (local)": yellow does NOT cancel meatball; meatball plays out (no shared family).
  - Click "Checkered" with the harness's session type set to Practice / Qualifying / Race in turn — each plays the matching variant.
  - Click "Yellow (local)" → "Yellow Cleared" → "Green" in quick succession: family preemption keeps only the most recent callout audible.
