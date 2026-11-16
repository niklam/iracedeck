# A key-press acknowledgment cuts in through the scheduler

> **Issue:** [#1698](https://github.com/niklam/iracedeck/issues/1698) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

The Pit Crew Corner Names acknowledgment (#897) plays by path straight onto `AudioChannel.Voice` through `playVoiceSequence`, beside the scenario engine. Pressed while a callout plays, its `playOnChannel` cuts the callout and its `onChannelComplete` replaces the one callback audio-service keeps per channel, which was the scheduler's. The callout's fire never hears its clip end: it stays the bus's active fire, so every later callout waits until its max wait runs out or drops as "bus busy", until the Race Engineer master is switched off (`stopAll`). The radio check had the same shape and now plays through the engine (`playClips`, #1696), with the one busy rule it needs, `whenBusy: "skip"`. A key press needs a different one: the driver asked, so the answer comes now.

Two more plugin-played Voice lines share the shape. The voice Test button in the Settings window (`playRaceEngineerVoiceTest`) can be pressed with the master on and a callout playing, and strands its fire the same way; a later callout can also take its completion callback, leaving `raceEngineerTestInFlight` stuck. The Race Engineer on/off acknowledgments (`playToggleAck`) play right after the gate flips: "going silent" after `stopAll`, onto a free bus, but "resuming" onto a live engine, where a callout arriving in its second and a half cuts it and takes the callback that clears `raceEngineerToggleInFlight`.

## Decisions

1. **A second `whenBusy` value, `"interrupt"`.** `playClips(id, paths, { weight, whenBusy: "interrupt" })` plays at once on a busy bus by cutting the running fire through the same path an `interrupt` contract takes: the running fire is stashed when it is queueable (`stashRunningIfQueueable`: a `resumable` one continues from the cut clip, another replays whole, after the ack), then cancelled through `cancelActiveFire`, so its fire completes properly and nothing is stranded. A non-queueable fire is simply over, as when any interrupt cuts it.
2. **It cuts only what is not heavier than itself.** A running fire, or a held focus floor, above the ack's `weight` is not cut: the ack plays nothing and returns `"bus-busy"`, logged at debug. The acks use weight `NORMAL`, so they cut chatter and routine callouts but never a safety-band line (SAFETY, CRITICAL) or the spotter while it holds its SAFETY focus floor. The toggle itself has already applied, and the key icon shows the new state. Fires waiting in the queue with the bus idle (a pending hold) do not stop it; they wait behind it as behind any fire.
3. **Once on the bus it is arbitrated like any clip fire (#1696).** An arriving fire of equal or lower weight waits when queueable and drops when not; a heavier `interrupt` fire cuts it. A running clip fire is cut like a callout, and never stashed, so a second press while the first ack plays speaks only the newer state, and an ack cuts a radio check.
4. **`playClips` gains an optional `onComplete`,** run once when the clip fire leaves the bus, finished or cut, through the fire's existing `onSettled`, (as `playFramePreview`'s does). It does not run on `"bus-busy"`: nothing started, and the caller reads the result, as with the frame preview, so a caller that set an in-flight flag clears it on that result itself. The in-flight flags of the Test and the on/off acks hang on it.
5. **Every plugin-played Voice line goes through `playClips` while the engine is up:**

   | Line | `whenBusy` | Notes |
   | --- | --- | --- |
   | Corner Names ack (all six clips once #1699 lands, through `playTrackCallsAck`) | `"interrupt"` | |
   | Race Engineer "resuming" / "going silent" | `"interrupt"` | `onComplete` clears `raceEngineerToggleInFlight`; "going silent" finds a free bus after `stopAll` |
   | Voice Test (Settings window) | `"interrupt"` | `onComplete` clears `raceEngineerTestInFlight` |
   | Radio check (#1696) | `"skip"` | unchanged |

   One helper in `audio/audio-toggles.ts` makes the choice: `playClips` when `isAudioScenariosInitialized()`, `playVoiceSequence` (today's direct play) when it is not. `playVoiceSequence` then has no caller with a live engine.
6. **No script, no pack, no clip change.** The lines stay "played by path outside any script".

## Alternatives rejected

- **Ducking the callout under the ack:** both lines on one Voice channel is not possible (`playOnChannel` replaces), a second voice channel is an audio-service and mixer change, and two voices at once is what the engineer must never do.
- **Waiting for a free bus** (`"skip"`'s test, or queueing the ack): a press answered several seconds later, after a lap-time readout, reads as a missed press, and the toggle has already happened.
- **Cutting anything, safety band included:** a toggle confirmation is never worth losing a "yellow flag" or a car alongside.
- **Making audio-service keep several callbacks per channel:** it would stop the stranding but not the talking over; the scheduler owning every Voice line is the fix.

## Out of scope

- What the Corner Names key toggles, its press classification and the four new clips (#1699).
- The radio check's busy rule (#1696).
- Background test (`playFramePreview`), which already plays through the engine and skips on a busy bus (#1124).
- How long a stashed fire may wait after the ack, and from when it counts (#1681).
- Press sounds and the limiter, pit-exit and radar cues, which play on their own channels.

## Testing

- Engine (`scheduler.test.ts` / `interpreter.test.ts`, fake clock, `createFakeAudio`), first reproducing the bug: a callout playing, then a direct Voice play, leaves the fire active and drops the next callout. Then for `"interrupt"`: a queueable resumable callout playing is cut, the ack plays, the callout resumes from the cut clip, and the next callout plays normally; a non-queueable one is cut and not replayed, and its fire is settled; a SAFETY fire or a SAFETY focus floor returns `"bus-busy"` and plays nothing; a running clip fire (a second ack, the radio check) is cut and not replayed; an idle bus is unchanged; `onComplete` runs once on finish, on a cut, and on `stopAll`, and not on `"bus-busy"`, where each in-flight flag is cleared by its caller.
- Actions (`audio-toggles.test.ts`, `audio-previews.test.ts`, `feature-gates.test.ts`): each line calls `playClips` with its id, paths, weight and `whenBusy`; the in-flight flags clear on `onComplete`; with the engine not initialised each falls back to the direct play.
- Manual (Stream Deck, iRacing practice, Race Engineer on): press the Corner Names key while the engineer is speaking: the ack cuts in, the cut line picks up after it, and the next callout plays (before the fix the engineer went quiet). Press it twice quickly: one ack, for the final state. Press Test in the Settings window while the engineer speaks. Toggle the Race Engineer off and on during a callout.
