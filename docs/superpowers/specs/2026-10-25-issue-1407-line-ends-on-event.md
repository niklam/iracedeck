# Race Engineer: a line that ends when the car leaves pit road

> **Issue:** [#1407](https://github.com/niklam/iracedeck/issues/1407) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

A bug, but the fix needs a new engine capability and an addition to the voice-script grammar, so it gets a spec. The issue carries the report and the cause.

## The model

A line that is only true while the car is on pit road must not be heard after it leaves. Today nothing in the engine can end a line because the condition it describes stopped being true:

- `cancelActiveFire` (`interpreter.ts`) is the only way a playing line is cut. It is reached by a same-family replacement, a heavier `interrupt`, `setEnabled(id, false)` and `stopAll()`, and none of those knows about pit road. It hard-stops the fire's channels, so the radio frame's close ops never play.
- `limiter-dropped` is neither `queueable` nor gated, but on a busy bus a heavier fire without `interrupt` is still enqueued. At `WEIGHT.NORMAL` it waits behind any lighter pit-road line (the readback, the pit-box count-in, the pit-status nags, a readout) for up to `maxQueueWaitMs` (8 s), then speaks with no check at all. That is a second route to the same symptom: the warning heard out on the track.
- `family: "limiter"` covers six contracts, including `limiter-on-track`, which is triggered by `pitLane.exited` itself and must keep playing after the exit. A family-wide cancel on the exit would kill it.
- `pitLane.exited` (`sim-events-iracing/src/diff/pit-lane.ts`) is published on the first tick `OnPitRoad` reads false, in that tick's batch, with no debounce. `limiter.dropped` is never emitted on that tick: the limiter diff emits nothing when `OnPitRoad` is false.

## Decision

- **A contract field, not a family cancel.** `ScenarioContract` gains an optional `endsOn: { event: SimEventName; description: string }`. When that event is published, the engine ends every fire of that contract, wherever it is. A family-level cancel was rejected because the family already mixes lines that must and must not survive the exit (`limiter-on-track`). It would need an exclusion list, and the next family member added would be cut or spared by accident.
- **Keyed on the bus event, not a polled predicate.** The event is the same signal every other pit-road consumer uses, it lands on the tick the exit happens, and a test drives it by publishing one event. A live `OnPitRoad` poll would add a timer per playing fire, and a second source of truth that can disagree with the bus for a tick.
- **What "ends" means, for each state a fire can be in:**
  - **A pending `triggerDelay` / `settle` timer**: cleared, as `setEnabled(id, false)` clears it.
  - **A waiting fire in its bus's queue**, including one an `interrupt` cut and stashed: removed and logged with a new `QueueDropReason`, `"ended"`.
  - **The playing fire, before any body clip has started** (still in the frame's open ops): a silent hard stop, as `cancelActiveFire` does today. No close ops play. The common case is a limiter dropped a few frames before the line: `limiter.dropped` takes the bus at once, and `pitLane.exited` arrives one tick later. A close click there would turn the old bug into a routine click-click at ordinary pit exits. Niklas decided this on 2026-10-25, matching the issue's "if it has not started, it does not start".
  - **The playing fire, once a body clip has started**: the body is cut mid-clip, then the frame's **cut tail** plays (below), so the engineer audibly abandons the line and lets go of the button. Niklas asked for this on 2026-10-25: "never mind…", then the radio closing. The bus stays held until the tail finishes, then drains as after any fire. While the tail plays, the fire is still the bus's playing fire under the ordinary rules: a same-family or heavier `interrupt` arrival can cut it, and nothing stashes it.
  - **The playing fire, once its close ops have begun**: left to finish. The line was heard in full, and a "never mind" after it would be wrong. (Amended during implementation: the task review found the first draft would have played the tail here.)
  - **Never re-queued.** An ended fire is not stashed, whatever its `queueable` or `resumable` settings say.
- **The cut tail is the frame's, defined by the voice.** A frame definition in `callouts.json` gains an optional `cut` step list beside `open` and `close`. After an end that cut words, the engine plays the frame's `cut`. A frame with no `cut` plays its `close` instead, so a third-party pack that never heard of `cut` still gets the closing click. A fire with `frame: "none"` plays nothing after the cut.
  - Both first-party voices (`default`, `shawn`) define `radio.cut` as the "never mind" pool, followed by the same two steps as `close`: `[ambient stop, tick-close]`.
  - **"Never mind" is the engineer speaking, not a beep.** Niklas decided this on 2026-10-25, after a first build played it like the clicks. The cut tail is expanded with the callout's own channel, so its spoken clips play at voice volume, as the body does. Only the built-in ticks ride the sound-effects channel. The Radio beeps switch drops only those ticks from the tail, and Pit ambience drops only its ambient steps, so "never mind" is heard whatever the frame switches say.
  - It is a frame part rather than a per-callout script entry because the line is the same whichever callout was abandoned, and every future `endsOn` contract gets it for free. A per-entry `ended` body was considered and rejected: it would need writing once per contract per voice, for no difference anyone would hear. The choice between the two was my call.
- **The "never mind" clips.** A new pool in each first-party voice, generated through the ElevenLabs pipeline (`configs/<voice>.voice.json`). It has a few short takes so it does not sound canned, for example "Never mind.", "Scratch that." and "Forget it." The exact wording and number of takes are my call, and the generated takes get Niklas's listen during the manual test. It follows the existing two-voice recipe for shared clips.
- **The grammar change ships behind `minPluginVersion`.** `FrameDefinitionSchema` is a strict object, and `schema: 1` has shipped. An older plugin given a script with `cut` reports `cut: unrecognized key` and drops the whole voice. *Evolving the grammar* in `packages/callout-script/CLAUDE.md` names two routes: a schema version bump, or a `minPluginVersion` on the pack's catalog entry. This fix takes the second, as #1284 did: both first-party packs' catalog entries get `minPluginVersion: "3.7.0"`, with a pack version bump and regenerated catalog entries. Publishing the archives stays the tag workflow's job (`build-and-commit.md`, *Releasing*). That route only covers the catalog the plugin offers, which lists first-party packs alone: a third-party pack has no `minPluginVersion` to declare, so a plugin older than 3.7.0 drops any voice of such a pack whose script adopts `cut`, its other voices staying available. The voice-pack format page and `packages/callout-script/CLAUDE.md` tell authors so. (Amended during implementation: the first draft said a third-party pack could carry `minPluginVersion` too.)
- **Existing packs keep working unchanged.** `endsOn` is code-owned and never appears in `callouts.json`, and `cut` is optional. A pack without `cut` loads as before, and its ended lines play its `close`. The one change every pack sees is intended: `limiter-dropped` is now ended at the pit exit whichever voice speaks it.
- **Only `pit-crew.limiter-dropped` carries it in this fix**, with `endsOn: { event: "pitLane.exited", … }`. Niklas scoped it on 2026-10-25 to the line he hit. `limiter-missing`, `limiter-speeding` and `no-limiter-speeding` have the same shape and are left as they are (see Out of scope).
- **Surfaced in the pack reference**, the way `speakGate` is. `ContractReport` and the generated reference carry `endsOn.description`, and the website renders it as "Ends when: …" beside "Re-checked at speak time". The description follows the `speakGate` description rules (one sentence in the sim's terms, ends with a full stop, at most 200 characters, does not start with the id) and is held by the same test. A pack cannot change or remove it: it is pacing, which #1064 withholds from packs.
- **Validated at load time**: `endsOn.event` must differ from `when.event`, since a line that ends on its own trigger could never be heard. An error disables the contract, like the other scheduling checks.

### Left to the builder

- **How the engine subscribes.** One bus subscription per distinct `endsOn` event, made when the first contract naming it registers, is the expected shape. Whether `endsOn` handling runs before or after other handlers of the same event does not matter for this fix: nothing that ends a line on `pitLane.exited` also fires on it.
- **How the cut tail is played.** `ExecOp.frame` tags the frame's ops by position (`expandFrame`), and the cut tail can be expanded the same way, with a third tag. The ended fire can continue into the tail once the body's channels are stopped, or be replaced by a short fire made of it. Either way, the ambient bed stop in the tail runs. One trap: `stopChannel` fires the channel's complete callback, so the cut must keep `stepNext` from moving into the next body op before the tail starts.
- **Where "a body clip has started" is read from.** The fire's op cursor against the first op without a frame tag is the obvious source.
- **Log level and wording** for an ended fire, within `.claude/rules/logging.md`. Debug is the likely fit: a cut is an expected outcome, not an anomaly.
- **`describeState`.** Nothing needs to appear there.

### Settled during the builder check (my calls)

- `endsOn` on a contract with no `when` is allowed. It is harmless: an `engine.fire(id)` test fire is ended like any other.
- The website's strict pack-reference parser (`CALLOUT_KEYS`, `pack-reference-types.ts`) and its view learn the new field in the same change.
- A `Bug Fixes` changelog fragment, because the #1051 warning has shipped.
- The harness audition is a `telemetrySequence`, since a shortcut cannot publish two events at separate times. It sets both the `EngineWarnings` limiter bit and `dcPitSpeedLimiterToggle`, keeps speed above the 5 m/s crawl threshold, and drops the limiter before the exit, so `limiter-on-track` stays silent. It also has a variant that crosses the line during the open click, to audition the silent stop.

## Out of scope

- `pit-crew.limiter-missing`, `pit-crew.limiter-speeding` and `pit-crew.no-limiter-speeding`. Each can still finish playing after the exit. Adding `endsOn` to them later is a one-line contract change each.
- The pit-speeding beeper (`pit-speeding-engine.ts`). It is not a scenario, and it already stops its loop within 300 ms of `OnPitRoad` reading false.
- Exits that publish no `pitLane.exited`: replay entry, disconnect and session-change teardown. A line still playing then is ended by whatever already ends it there, or not at all, as today.
- The signal mismatch between the limiter diff (`EngineWarnings.PitSpeedLimiter`) and the contracts' gates (`dcPitSpeedLimiterToggle`).
- A fade on cut. The native mixer has no fade, and the cut tail covers the abruptness.
- A `cut` tail on any frame other than the first-party `radio`, and a schema version bump. `minPluginVersion` is the route taken.

## Testing

**Unit (`@iracedeck/audio-scenarios`).**

Engine, with a test contract that carries `endsOn`:

- A pending `triggerDelay` timer is cleared: the line never plays.
- A waiting fire is removed with reason `"ended"`. This covers both a fire queued behind a lighter line and an interrupt-stashed one.
- A fire ended during its open ops stops silently: no cut tail and no close ops play.
- A fire ended mid-body plays its frame's `cut`. The bus is released after it, and the queue drains.
- A fire whose frame defines no `cut` plays the frame's `close` instead.
- With `frame: "none"`, a playing fire is cut and nothing more plays.
- The cut tail itself can be cut by a heavier `interrupt` arrival, and the cut fire is not stashed.
- An ended fire is never re-queued, including a `queueable` and `resumable` one.
- A fire of another contract is untouched: one on the same bus, and one in the same family without `endsOn`.
- The ending event arriving with no fire of the contract anywhere is a no-op.
- Validation refuses an `endsOn.event` equal to `when.event`.

Catalog:

- `limiter-dropped` carries `endsOn` on `pitLane.exited`.
- `limiter-on-track` still fires after a `pitLane.exited` that ended a playing `limiter-dropped`.
- The description rules hold, via the `speakGate` description test extended to `endsOn`.

**Script grammar (`@iracedeck/callout-script`).** The schema accepts `cut` on a frame and refuses an unknown key beside it. `collectScriptReferences` walks `cut` like `open` and `close`, so the "never mind" pool counts as referenced and the coverage check flags a voice that names it without shipping it.

**Voices (`@iracedeck/audio-assets`).** Both first-party scripts define `radio.cut`, and the bundled-script tests and `lint:pack` pass. Both catalog entries carry `minPluginVersion: "3.7.0"` and a bumped pack version.

**Reference.** `pnpm generate:pack-reference` regenerates `pack-reference.json` with the new field. The freshness test (`scripts/generate-pack-reference.test.mjs`) keeps it committed.

**Harness.** A new shortcut auditions the cut. It drives the car down pit road with the limiter on, drops it, then crosses the exit line while the warning is still playing. You should hear the warning cut mid-word, then "never mind" and the closing click. The early variant should be silent apart from a clipped open click at most.

**Manual, in the sim.** Drive pit road with the limiter on and the Race Engineer on. Drop the limiter just before the exit line at speed and cross it. Either the warning never starts, or it is cut at the line with "never mind" and the closing click. Repeat with the limiter left on through the exit: the "limiter still on" warning still plays.
