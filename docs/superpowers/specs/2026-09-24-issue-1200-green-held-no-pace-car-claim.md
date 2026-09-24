# Green held says nothing about the pace car

> **Issue:** [#1200](https://github.com/niklam/iracedeck/issues/1200) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

`pit-crew.flag-green-held` fires on `flag.green-held.raised`, the rising edge of iRacing's `GreenHeld` session flag. Three of its five lines in the default voice say where the pace car is: `green-held-01` ("Pace car's coming in"), `green-held-02` ("Pace car's peeling off") and `green-held-04` ("Pace car's gone"). The flag does not track the pace car, so those lines play while the pace car is still on track.

The gap is structural, not specific to Bristol. The #1127 Homestead capture (`docs/superpowers/specs/2026-09-17-issue-1127-oval-caution-restart.md`, findings 5 and 6) measured `GreenHeld` rising 15.0 s before the restart green, and the pace car's `CarIdxTrackSurface` leaving the racing surface about 5 s before the green. That is the ~10 s the Bristol report describes.

## Decision

The two callouts split the work. **Only the pace car's own exit speaks about the pace car.**

- `pit-crew.caution-pace-car-off` (on `paceCar.off`, gated on the `one-to-go` caution phase, #1127) already says "Pace car's off." / "Pace car's peeling off." at the real exit. It is unchanged and is now the only line that places the pace car.
- `pit-crew.flag-green-held` keeps its trigger and its timing, because a ~15 s warning that the green is coming is useful, but its lines make **no claim about the pace car**. They state only that the green is imminent.

The three offending lines are reworded in `packages/audio-assets/configs/default.voice.json` and their clips regenerated:

| Clip | Before | After |
| --- | --- | --- |
| `green-held-01` | This is it. Pace car's coming in. Green any second now, so get ready to launch. | This is it. Green any second now, so get ready to launch. |
| `green-held-02` | Pace car's peeling off. Eyes up, pick your gear, and launch clean off the line. | Nearly time. Eyes up, pick your gear, and launch clean off the line. |
| `green-held-04` | Pace car's gone. Stand by... it's racing the moment that gap opens up. | Stand by... stand by. It's racing the moment the green drops. |

`green-held-03` and `green-held-05` already make no pace-car claim and stay as they are. The pool keeps five lines.

The contract's `description` ("… as the pace car pulls in …") carries the same wrong assumption, and it feeds the generated Voice Packs reference that pack authors read. It is reworded to say the flag rises shortly before the green, while the pace car may still be on track, and the reference is regenerated.

### The opening rolling start gets the pace-car call too

Found in manual testing. #1127 kept `caution-pace-car-off` silent at an opening rolling start on purpose: the start's own green-held line "already owns that moment" (`caution.ts`, module header finding 1). That line was the one saying "Pace car's peeling off". With the pace-car claim gone from it, an opening rolling start would announce the pace car rolling off (`rolling-start-pace-car`) and never announce it leaving.

So `caution-pace-car-off` also speaks at an opening rolling start. Its gate becomes: live in the race car, and either the caution phase is `one-to-go` (unchanged, restarts) **or** there is no caution (`none`) and iRacing's `GreenHeld` bit is up in the event's telemetry. The #1127 Homestead capture measures it: at the rolling start `GreenHeld` rises at 186.28 s, the pace car (car index 64) goes OnTrack → AproachingPits at 196.53 s with `GreenHeld` still up, and the green comes at 201.18 s. The restart repeats the pattern (477.77 / 488.07 / 492.82 s).

The road-course deploy that #1127 guards against stays silent. It happens mid-caution, while the phase is `waving`, never `none`, and `GreenHeld` is not up.

A standing start never raises `GreenHeld` and has no pace car leaving, so it is unaffected.

## Alternatives rejected

- **Re-trigger green held on `paceCar.off`.** This duplicates `caution-pace-car-off` at the same instant and throws away the ~15 s heads-up, which is the only thing the green-held callout adds.
- **Drop the three lines and keep a two-line pool.** No TTS generation, but two lines repeat on every restart of a caution-heavy oval race.
- **Delay the green-held line until the pace car leaves.** This is the previous alternative plus a wait, with the same duplication.

## Out of scope

- The trigger (`flag.green-held.raised`), `rollingFormationOnly`, the `paceCar.off` event and its detection. `caution-pace-car-off` changes only in the gate above; its lines and its restart behaviour stay as they are.
- The scenario harness's *Caution → restart* shortcut and its test, which assert the event sequence rather than any wording.
- A new telemetry capture: the #1127 measurement settles the gap. How much wider it gets with dual pit roads does not change the decision, since no green-held line depends on it any more.
- Other callouts' wording.

## Testing

- **No wording guard.** A test that rejected any green-held line mentioning the pace car was considered and dropped: `green-held-05` ("Last few seconds behind the pace car") mentions it without placing it, so the test would need a rule for which mentions count as a claim — hard to maintain for a small risk.
- **The pace-car-off gate:** unit tests show that "Pace car's off" speaks when there is no caution and GreenHeld is up (the opening rolling start). It stays silent when there is no caution and GreenHeld is down, and while a caution is still waving even with GreenHeld up. The road-course capture tests from #1127 stay green.
- **Existing guards stay green:** script coverage, the callout-scripts freshness test, the pack-reference freshness test, and the voice-pack catalog entry. The pack's `version` is bumped and its catalog entry regenerated through `pack:voice default`, as #1116 requires.
- **Manual:** audition the three regenerated clips through the radio filter, then play the harness's *Caution → restart* shortcut and hear a green-held line with no pace-car wording, followed by the pace-car-off line.
- **Changelog:** a **Bug Fixes** line, since the lines shipped in earlier releases.
