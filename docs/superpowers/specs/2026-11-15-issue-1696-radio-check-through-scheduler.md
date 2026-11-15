# The radio check plays through the scheduler

> **Issue:** [#1696](https://github.com/niklam/iracedeck/issues/1696) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

The telemetry-connect radio check (#554) is played by Pit Crew straight onto `AudioChannel.Voice` with `playOnChannel`, beside the scenario engine. The engine's Voice bus therefore reads idle, and the session-start brief — due about 3 s after the synthetic connect `session.changed` — takes it and plays over the check. Its `playOnChannel` replaces the clip, and its `onChannelComplete` replaces the check's one-shot step callback, so a cut in the name clip loses the "radio check" clip entirely. The race-start brief does the same on a connect before the green. Nothing arbitrated: the scheduler cannot order what it does not see.

## Decisions

1. **The radio check becomes a fire on the Voice bus,** through a new `IScenarioEngine` entry point beside `playFramePreview`: `playClips(id, paths, { weight, whenBusy })`. It plays exactly the clip paths given, in order, on the Voice channel, with no radio frame (as today), through `Playback` like any fire.
2. **It is arbitrated like a contract's fire once it holds the bus.** An arriving fire of equal or lower weight waits when queueable and drops when not; a heavier one without `interrupt` waits for it; a heavier one with `interrupt` cuts it. A cut clip fire is over: it is never stashed or replayed. The radio check uses weight `NORMAL`, so the NORMAL, queueable session-start and race-start briefs wait behind it and play right after, and the safety band can still cut it.
3. **What it does on a busy bus is an option, `whenBusy`.** This spec defines one value, `"skip"`, which the radio check uses: it starts only on a free bus (no active fire, an empty queue, no focus floor), the test `playFramePreview` uses, except that the frame preview yields to it as to any callout. On a busy bus it plays nothing and returns `"bus-busy"`; the radio check then logs `Radio check skipped — the engineer holds the radio` at debug. The engineer already speaking is the confirmation the line exists to give, and a late ack would be noise.
4. **The trigger and the gates stay in Pit Crew.** The rising-edge detection, the Race Engineer master gate, the opt-in, the voice and the name clip are unchanged; only the play call moves. With the engine not initialised, Pit Crew plays as it does today.
5. **No script, no pack change.** The clips stay "played by path outside any script", so every installed pack, third-party ones included, keeps the line, and the pack reference and linter are unchanged.

## Alternatives rejected

- **A focus floor around the direct play** (`acquireFocus` / `releaseFocus`): it would make the greeting wait, but the release hangs on the sequence's completion callback, which a channel stop or another play on Voice discards, leaving the floor up and the engineer silent for the session; and it still plays over a fire already on the bus.
- **A scripted `pit-crew.radio-check` contract:** every voice's `callouts.json` would need the entry, and a pack without it would lose the line.
- **Delaying the session-start brief at connect:** a special case in one contract that leaves race-start, and any other early callout, cutting the check.

## Out of scope

- The corner-names, Race Engineer on/off and Test-button acknowledgments, which also play by path; the corner-names one can cut a callout and strand its fire. Its own issue, since a key press needs an answer even while the engineer talks.
- Where the radio check is triggered (a visible Pit Crew key's SDK subscription).
- How long a waiting fire may wait and when that wait starts (#1681).
- Other `whenBusy` values, such as an acknowledgment that cuts the running callout and lets it resume (#1698). (Amended 2026-11-15: the busy rule is an option so #1698 can add its value; #1696 implements and tests only `"skip"`.)

## Testing

- Engine (`scheduler.test.ts` / `interpreter.test.ts`, fake clock and `createFakeAudio`): an idle bus plays the clips in order; the real `pit-crew.session-start` contract coming due mid-check waits and plays after the last clip ends, within its max queue wait; a non-queueable NORMAL fire drops; an `interrupt` fire above NORMAL cuts it and nothing replays it; a busy bus or a held focus floor returns `"bus-busy"` and plays nothing; a running frame preview is cut; `stopAll` clears it; `describeState` shows it as the active fire.
- Pit Crew (`pit-crew.test.ts`): the rising edge calls `playClips` with the name clip and `toggle/radio-check-01`; `"bus-busy"` logs the skip; an uninitialised engine falls back to the direct play; the gate and opt-in skips are unchanged.
- Manual (Stream Deck, iRacing): connect into a practice session in the garage and hear the whole radio check, then the session brief; the same into a race session before the green with the race-start brief.
