> **Issue:** [#466](https://github.com/niklam/iracedeck/issues/466) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: telemetry readout on a key press

## The problem

A VR driver cannot glance at the deck. The fuel figures Session Info shows since #465 (last lap, average over N laps) and the temperatures the session-start brief speaks once are all out of reach mid-stint unless someone reads them out. projektdotnet42 asked on Discord for exactly that: map a button, have the Race Engineer say the number.

The issue was filed before the callout-script split (#1064), pack-bound voices (#1144) and the #1187 temperature rework, and its plan — a code-side `number-speech.ts` composing "one hundred" + "and" + "twenty five" from separate clips, framing clips played by the action — no longer fits the engine. This spec replaces that plan; the issue's what and why stand.

## What ships

A fifth Pit Crew mode, **Telemetry Readout**. Each key picks one readout; pressing it has the Race Engineer speak the value in the driver's display units:

> "Fuel used last lap, two point four liters."
>
> "Average fuel over the last five laps, two point four liters."
>
> "Track temperature is forty one degrees."
>
> "Air temperature is twenty three degrees."
>
> "No clean lap on the books yet." (a fuel readout before any valid lap)

Temperatures do not name the unit, matching the session-start brief since #1187 — but a pack can add it, the same way it can there.

## Decisions

### 1. The key press reaches the callouts as a bus event

The action publishes a new catalog entry:

```typescript
"telemetryReadout.requested": SimEvent<
  "telemetryReadout.requested",
  {
    kind: "fuel-last-lap" | "fuel-average" | "track-temp" | "air-temp";
    value: number | null;
    unit: "liters" | "gallons" | "celsius" | "fahrenheit";
    laps: number | null;
  }
>;
```

`value` is already in the driver's display unit and `unit` names it, so the payload is sim-agnostic and every contract reads the same shape whatever sim produced it. `laps` is set only for `fuel-average`.

This is the **first event the deck layer publishes** rather than the translator; the catalog entry's doc comment says so. It was chosen over an imperative `engine.fire(id)` with a stashed request (the spotter pattern) for two reasons: the scenario harness auditions callouts by publishing bus events, so a bus event is testable there with arbitrary values (a 119.9-gallon edge, a partial average) at no new plumbing; and the value travels in the envelope instead of in hidden module state beside the engine.

The value is captured at press time, not re-read at fire time (the readback's #481 rule). A readout answers "what is it now" at the moment the driver asked; a queue delay of a few seconds does not make it stale, and reading at press time keeps the audio layer free of any sim dependency.

### 2. The action computes the value

`packages/iracing-actions/src/actions/pit-crew/pit-crew.ts` gains the `telemetry-readout` mode and two settings:

- `readoutKind` — `fuel-last-lap` (default) · `fuel-average` · `track-temp` · `air-temp`.
- `fuelLapWindow` — 1–20, default 5, shown only for `fuel-average`. It is the same schema Session Info's fuel average uses, extracted so the two cannot drift.

On key down, with telemetry present:

- **Fuel last lap / average** — `getFuelStats(window)` from `@iracedeck/sim-events-iracing`, `.lastLap` or `.avg`, converted with the existing `fuelToDisplayUnits`. `laps` is `samples` — the laps actually averaged, which is fewer than N early in a stint — so the engineer never claims a five-lap average built from two. A `null` value is published as `null` (decision 5).
- **Track / air temperature** — `TrackTempCrew` and `AirTemp`, the fields the session-start brief reads, converted by a new `celsiusToFahrenheit` beside the fuel helpers in `deck-core/src/unit-conversion.ts`.
- `DisplayUnits` unset counts as metric, the translator's convention.

With no telemetry (not connected) nothing is published — there is nothing true to say, and the Race Engineer is idle then anyway. The same holds for a temperature kind whose field is missing from the tick: the session-start brief reads a missing field as `0`, but a readout the driver asked for must never say "zero degrees" for a reading that does not exist.

The key shows a per-kind title and a readout glyph designed under `icons.md`. It shows no live value: the mode exists for drivers who cannot see the key, and Session Info already displays these figures.

### 3. Five contracts in a new catalog file

`packages/audio-scenarios/src/catalog/pit-crew/telemetry-readout.ts`, all `when: "telemetryReadout.requested"` with a `where` on `kind`:

| Contract | Fires for |
| --- | --- |
| `pit-crew.readout-fuel-last-lap` | `fuel-last-lap` with a value |
| `pit-crew.readout-fuel-average` | `fuel-average` with a value |
| `pit-crew.readout-track-temp` | `track-temp` |
| `pit-crew.readout-air-temp` | `air-temp` |
| `pit-crew.readout-no-data` | a fuel kind whose value is `null` |

The vocabulary reads `ctx.data`:

| Var | Resolves to |
| --- | --- |
| `readout.fuelNumber` | `numbers-fuel/<int>` — the integer part after rounding to 0.1 |
| `readout.fuelDecimal` | `numbers-fuel-decimal/<unit>-<d>` — the tenths digit plus the unit (`liters-4`, `gallons-0`) |
| `readout.laps` | `readout-laps/<n>` |
| `readout.tempNumber` | the shared `temperatureNumberRef` (`numbers-degrees`) |
| `readout.degreesUnit` | the shared `temperatureUnitRef` (`session-start/unit-celsius` / `unit-fahrenheit`) |

Rounding happens once, to 0.1, before the split, so 2.44 → `2` + `liters-4`, 2.45 → `2` + `liters-5` and 0.96 → `1` + `liters-0` — never a `0` + `liters-10`. A figure no clip exists for (above 120.9, a temperature outside −20…176) resolves to nothing and aborts the callout, per #836; no range is checked in code.

**The unit stays pack-optional for temperatures exactly as in the session-start brief.** `readout.degreesUnit` draws the same two `session-start/unit-*` clips as `sessionStart.degreesUnit`, so a pack that records them once can have both callouts say "degrees, Celsius". The reference script never names the var. Fuel says its unit because the `numbers-fuel-decimal` clips carry it; a pack wanting silence there records the tails without the word.

**Gating is the Race Engineer master only.** There is no per-callout opt-in and no `calloutEnabled*` key: pressing the key is the opt-in, and a checkbox that could leave a key doing nothing is a trap. Turning the Race Engineer off silences readouts, and they play at its volume on its bus with its walkie bed — the issue's out-of-scope line on independent mute and volume.

**Scheduling:** normal weight. A readout pressed while the bus is busy queues behind what is playing rather than being dropped — the driver asked for it — and a newer readout replaces a still-pending one, so hammering the key never builds a backlog. In the #652 interpreter that is `queueable: true` and nothing else: no `family` (a same-family fire replaces the one playing whatever its weight, so a second press would cut the readout being heard), no `queueBehind` (it would chain a new readout behind the waiting one — the backlog), no `interrupt`. The bus keeps one pending slot (#1185), so a readout pressed while a heavier queueable line is already waiting is dropped; that is the engine's limit, not this feature's, and the website says so.

**Wiring:** with no opt-in key the contracts are registered master-gated only, as the opponent-flag aggregate already is — no callout id, settings-key map or `PitCrewDeps` entry.

### 4. The figure is an integer clip plus a unit-bearing tail

The `default` voice gains, in `configs/default.voice.json`:

| Group | Clips | Text |
| --- | --- | --- |
| `telemetry-readout` | `fuel-last-lap-intro`, `fuel-average-intro`, `track-temp-intro`, `air-temp-intro`, `no-data` | "Fuel used last lap,", "Average fuel over the last", "Track temperature is", "Air temperature is", "No clean lap on the books yet." |
| `numbers-fuel` | `0` … `120` | the integer alone, each with `next_text: "point four liters"` |
| `numbers-fuel-decimal` | `liters-0` … `liters-9`, `gallons-0` … `gallons-9` | "point zero liters." … "point nine gallons.", each with `previous_request_ids` sampling three `numbers-fuel` clips |
| `readout-laps` | `1` … `20` | "lap," for 1, "<n> laps," above |

That is 166 clips. The shape is the lap-time one (`lap-time-second` carries `next_text: " point."`, `lap-time-decimal` samples three predecessors), which is proven on this voice. It was preferred over one clip per figure (1,210 per unit) and over a bare figure plus a separate unit clip (the join #1187 removed from temperatures): the one remaining seam is integer → "point", which the `next_text` conditioning exists for, and the unit is recorded inside the tail. The integer range reaches 120 so the group also serves readouts a later issue may add (a tank level); per-lap use today stays far below it.

Temperatures reuse `numbers-degrees` unchanged — no new temperature clips. The readout intros are the readout's own lines rather than the session-start ones, so a pack can phrase a mid-stint readout differently from the session brief (the session-start air intro is also lowercase mid-sentence prosody).

The voice pack's catalog entry and `pack-reference.json` are regenerated. Its version is bumped only if the current one has been published by then — an unpublished version's bytes may still change, per the release rules.

## Artifacts beyond the code

- Scenario harness: `event-names.ts` entry, and shortcuts for a liters and a gallons last lap, a full and a partial (3 of 5) average, no data, track °C, air °F, and the 120.9 edge.
- Website: the mode on `docs/actions/audio-voice/pit-crew.md` (and its mode-count badge), a Features line in `changelog.mdx`, and the developer Architecture page — the event bus gains a deck-side publisher.
- `iracedeck-actions` skill (Pit Crew gains a mode); a `race-engineer-callout-examples.md` entry for the first key-triggered callout.
- No manifest change: Pit Crew is one UUID in all three plugins, and it stays out of `action-comms.json`.

## Out of scope

- Readouts on a timer or a sim event.
- Kinds beyond these four; each later one adds clips and a kind.
- A dial surface for the mode.
- A live value on the key.
- A separate mute, volume or per-callout opt-in.
- Reworking the translator's inline temperature conversion onto the new helper — `sim-events-iracing` does not depend on `deck-core`, and moving the helper is its own change.

## Testing

**Suite.**

- Resolvers: rounding boundaries (2.44, 2.45, 0.04, 0.96, 120.9, 120.96), liters and gallons tails, `laps` 1 and 20, negative temperatures through the shared helper.
- Contracts: the sequence each kind resolves to in metric and imperial; `no-data` for both fuel kinds on `null`; no contract fires for a temperature kind on the fuel path and vice versa.
- Pit Crew: the payload per kind and unit system, `laps` equal to `samples` rather than the window, nothing published without telemetry, the settings schema's clamp and default.
- The bundled script-coverage and pack-reference freshness tests pick up the new contracts, vars and groups.

**Manual (the PR gate).** In iRacing, on metric and then imperial display units: each kind spoken correctly; a fuel readout before the first clean lap says the no-data line; an average early in a stint names the laps actually averaged; a press during another callout plays after it; a burst of presses speaks at most the readout already playing and the latest one; Race Engineer off leaves the key silent. The integer → tail seam is judged by ear across a spread of figures.
