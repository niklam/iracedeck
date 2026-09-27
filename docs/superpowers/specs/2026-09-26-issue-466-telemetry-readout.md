> **Issue:** [#466](https://github.com/niklam/iracedeck/issues/466) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: telemetry readout on a key press

## The problem

A VR driver cannot glance at the deck. The fuel figures Session Info shows since #465 (last lap, average over N laps) and the temperatures the session-start brief speaks once are all out of reach mid-stint unless someone reads them out. projektdotnet42 asked on Discord for exactly that: map a button, have the Race Engineer say the number.

The issue was filed before the callout-script split (#1064), pack-bound voices (#1144) and the #1187 temperature rework, and its plan — a code-side `number-speech.ts` composing "one hundred" + "and" + "twenty five" from separate clips, framing clips played by the action — no longer fits the engine. This spec replaces that plan; the issue's what and why stand.

## What ships

Pressing a **Session Info** key speaks the figure it shows. A new per-key setting, **Speak value on press** (default on), exists on every item; four items speak today — Fuel → Last Lap, Fuel → Average, and two new items, **Track Temperature** and **Air Temperature** — and the Race Engineer speaks the value in the driver's display units:

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

### 2. Session Info computes the value

The readout lives in **Session Info**, the action that already shows these figures: the key a driver reads is the key they press to hear it. (The first build put it in Pit Crew as a fifth mode with a per-key readout picker; the maintainer moved it after the manual test, because a separate key for a figure Session Info already displays duplicates the item list, and Session Info had no press behaviour to collide with.)

`packages/iracing-actions/src/actions/session-info/session-info.ts` gains:

- **`speakOnPress`** — "Speak value on press", default **on**, on every item. The action-level setting is deliberately not limited to the items that speak today: it is the switch for the whole action, its help text names the items that speak, and an item that gains speech later needs no settings change. On an item with no speech yet, a press does nothing. The setting is independent of #1165's planned `onPress` (what a press sends to iRacing): the maintainer chose a separate checkbox over making speech one value of that enum, so a press may both send a binding and speak once #1165 lands; the #1165 spec records the same. Existing keys start speaking on press after the update, which is intended (new Race Engineer functionality defaults on); the Race Engineer master still gates every readout.
- **Two new items**, `track-temp` and `air-temp`, showing the rounded figure with its unit ("41°C" / "106°F") in the driver's display units.

On key down, with `speakOnPress` on and telemetry present, the item maps to a kind:

- **Fuel → Last Lap / Average (N laps)** — `getFuelStats(window)` from `@iracedeck/sim-events-iracing` with the key's existing `fuelLapWindow`, `.lastLap` or `.avg`, converted with the existing `fuelToDisplayUnits`. `laps` is `samples` — the laps actually averaged, which is fewer than N early in a stint — so the engineer never claims a five-lap average built from two. A `null` value is published as `null`. A key in percentage format still speaks the amount. Fuel → Now does not speak yet.
- **Track / Air Temperature** — `TrackTempCrew` and `AirTemp`, the fields the session-start brief reads, converted by a new `celsiusToFahrenheit` beside the fuel helpers in `deck-core/src/unit-conversion.ts`.
- `DisplayUnits` unset counts as metric, the translator's convention.

With no telemetry (not connected) nothing is published — there is nothing true to say, and the Race Engineer is idle then anyway. The same holds for a temperature whose field is missing from the tick: the session-start brief reads a missing field as `0`, but a readout the driver asked for must never say "zero degrees" for a reading that does not exist; the key shows `--` then.

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

**Gating is the Race Engineer master.** There is no per-callout opt-in and no `calloutEnabled*` key in the Race Engineer settings: pressing the key is the opt-in, and the only other switch is the key's own `speakOnPress`. Turning the Race Engineer off silences readouts, and they play at its volume on its bus with its walkie bed — the issue's out-of-scope line on independent mute and volume.

**Scheduling:** a weight between chatter and normal (`WEIGHT.NORMAL - 10`), `queueable: true`, and nothing else. A readout pressed while the bus is busy waits for what is playing rather than being dropped — the driver asked for it — and a newer readout replaces a still-pending one, so hammering the key never builds a backlog. The weight is below normal so that a key press never displaces the Race Engineer's own lines: the bus keeps one pending slot (#1185) and an equal-weight newcomer takes it, so at normal weight a readout pressed during the pit-entry readback would silently delete a waiting `limiter-missing` warning (found in the branch review). The cost is the mirror image, accepted: a readout pressed while an engineer line of normal weight or above is waiting, or one that arrives while the readout waits, means the readout is not read — the driver presses again, and the website says so. It still displaces waiting chatter (the pit readback). No `family` (a same-family fire replaces the one playing whatever its weight, so a second press would cut the readout being heard), no `queueBehind` (it would chain a new readout behind the waiting one — the backlog), no `interrupt`.

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
- Website: the two items and the setting on the Session Info page (and its mode-count badge), a Features line in `changelog.mdx` saying where it lives, and the developer Architecture page — the event bus gains a deck-side publisher.
- `iracedeck-actions` skill (Session Info gains two items and the setting); a `race-engineer-callout-examples.md` entry for the first key-triggered callout.
- No manifest change: Session Info is one UUID in all three plugins.

## Out of scope

- Readouts on a timer or a sim event.
- Speech for the other Session Info items (Fuel → Now, incidents, position, …); each later one adds clips and a kind.
- A dial surface — Session Info is keypad-only.
- A separate mute, volume or per-callout opt-in.
- Reworking the translator's inline temperature conversion onto the new helper — `sim-events-iracing` does not depend on `deck-core`, and moving the helper is its own change.

## Testing

**Suite.**

- Resolvers: rounding boundaries (2.44, 2.45, 0.04, 0.96, 120.9, 120.96), liters and gallons tails, `laps` 1 and 20, negative temperatures through the shared helper.
- Contracts: the sequence each kind resolves to in metric and imperial; `no-data` for both fuel kinds on `null`; no contract fires for a temperature kind on the fuel path and vice versa.
- Session Info: the payload per item and unit system, `laps` equal to `samples` rather than the window, nothing published without telemetry or with `speakOnPress` off, a press on a non-speaking item publishing nothing, the two temperature items' display in both unit systems and on a missing reading, the setting's default.
- The bundled script-coverage and pack-reference freshness tests pick up the new contracts, vars and groups.

**Manual (the PR gate).** In iRacing, on metric and then imperial display units: each kind spoken correctly; a fuel readout before the first clean lap says the no-data line; an average early in a stint names the laps actually averaged; a press during another callout plays after it; a burst of presses speaks at most the readout already playing and the latest one; Race Engineer off, or Speak value on press off, leaves the key silent. The integer → tail seam is judged by ear across a spread of figures.
