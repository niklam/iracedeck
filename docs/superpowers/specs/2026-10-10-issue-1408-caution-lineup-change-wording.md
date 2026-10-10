# Race Engineer: the caution lineup-change call says whether you are already behind the car

> **Issue:** [#1408](https://github.com/niklam/iracedeck/issues/1408) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

The lineup-change call loses its "Change —" opener and gains a branch. When the car you line up behind changes under a full-course caution, the engineer says **"Get behind car seven."** if you are not yet behind that car on track and **"You're behind car seven."** if you already are. The request was only to drop the opener (it "is an odd turn of phrase"); the branch is Niklas's answer to what should replace it (2026-10-10), because the two situations behind the call ask different things of the driver. After a stop under caution the car to follow is somewhere up the road. When the car ahead pits, the driver is already in place and only the number changed.

When it cannot be told, the engineer says "Get behind". It is still a correct instruction to a driver who is already there, while "You're behind" is false to one who is not.

## What "already behind" means

The caution lineup answers who to follow, which lane, and whether you lead, all from `CarIdxPaceLine` / `CarIdxPaceRow` (`sim-events-iracing/src/diff/caution-lineup.ts`). It knows nothing about where the cars are on track. This adds one answer, `behindFollowCar`, read from `CarIdxLapDistPct`:

> The car you follow is the nearest car ahead of you on track among the lined-up cars of your own pace line, and it is less than half a lap ahead.

- **Own line only.** Double file, the car alongside in the other lane is routinely a few metres further round the lap. It is not between you and the car you follow.
- **Lined-up cars only.** A car that holds no pace row (in the pits, towing) is not part of the queue, wherever it is on track.
- **No closeness test.** A driver catching the tail of the field with nothing between them and the car they follow is behind it, with a gap to close. Deciding how close is close enough would need a threshold nobody has measured, and "You're behind car seven" is true at any gap.
- **Half a lap is a sanity bound, not a closeness test.** Without it, a follow car that is physically behind you, in a line holding no other car, is found by wrapping round the lap and read as "ahead".
- **Along the track only.** Telemetry has no lateral position, so the answer cannot tell whether the driver is in the right lane. The lane wording says which lane either way.

It is `false` whenever it cannot be read: no `CarIdxLapDistPct`, no follow car, the pace car as the follow car (that is the leader line's case), or a lineup the reader withholds.

The nearest-car search goes through `findNearestCarOnTrack` (`@iracedeck/iracing-sdk` `track-utils.ts`), the project's one track-order primitive, with its `skipIdx` filter set to every car that is not a lined-up car of the player's line. `race-positions.md` forbids sorting cars by lap distance anywhere else.

**This model is not yet checked against a capture.** The 2026-09-17 oval capture that the lineup reader rests on (`local/telemetry-watch-20260917-191825-092.jsonl`) recorded the pace lines and rows but not `CarIdxLapDistPct`, so the committed fixtures cannot show whether a row order and a track order agree while the field is formed up, or what a car rejoining from the pits reads on the way to its slot. The capture that settles it is a `pnpm telemetry-watch` run through one oval caution with `CarIdxLapDistPct` added to that capture's variable list, including a stop by the player under caution and a stop by the car directly ahead. It is cut into a fixture and replayed as part of this issue; if it contradicts the model, the model changes here before the clips are recorded.

## Where it is read

`resolveCautionLineup` gains the field, and `getCautionLineup()` serves it like the rest: live, at speak time, memoised per tick. It is not added to the `caution.lineup.changed` payload. The call waits two seconds after the change and can wait longer for the bus, and a car that was up the road when the event fired can be directly ahead by the time the sentence starts.

The vocabulary gains one condition, `caution.isBehindFollowCar`, registered in `registerCautionVocabulary` with a description that says what `false` covers. It is a pure read, as every condition a pack may name must be.

Nothing else about the call changes: the event, the two-second hold, the `speakGate` that judges the change against the car last named (#1286), its weight, its place outside the `flag` family and its `queueBehind` list are all as they are.

## The script and the clips

`pit-crew.caution-lineup-changed` in both first-party voices (`configs/default.voice.json`, `configs/shawn.voice.json`):

```text
followsPaceCar            -> lineup-changed-leader
else hasFollowCarNumber
       isBehindFollowCar  -> case line: inside / outside / default  (the "You're ..." clips) + car number
       else               -> case line: inside / outside / default  (the "Get ..." clips)    + car number
else                      -> lineup-changed-noname
```

| Clip (`caution/…`) | Text | |
| --- | --- | --- |
| `lineup-changed-inside-01` | You're on the inside, behind | re-recorded |
| `lineup-changed-outside-01` | You're on the outside, behind | re-recorded |
| `lineup-changed-plain-01` | You're behind | re-recorded |
| `lineup-changed-get-inside-01` | Get to the inside, behind | new |
| `lineup-changed-get-outside-01` | Get to the outside, behind | new |
| `lineup-changed-get-plain-01` | Get behind | new |
| `lineup-changed-leader-01` | You're at the front now, just the pace car ahead. | re-recorded |
| `lineup-changed-noname-01`, `-02` | unchanged | |

The six car-naming clips keep `next_text: "car ninety five"`, since the car number follows each. The three existing bases keep their names and become the "You're …" lines. The Terse voice's texts are Default's today and stay so; its clips and manifest rows are copies, with no second generation.

The wording was read aloud for a competing parse (the #1051 lesson): "Get behind" has none.

## The packs

Both packs are published at their current versions, so each takes a `version` bump (`default` 1.1.2 → 1.1.3, `iracedeck-terse` 1.0.1 → 1.0.2) and a regenerated catalog entry. Both also raise `minPluginVersion` to `3.6.0`: the script now names a condition older plugins do not register, and a plugin that auto-updated to this pack would skip the whole call with an "unknown condition" warning (the #1284 precedent).

## Out of scope

- **The first call of a caution** ("Line up behind car seven") and the two-to-green and one-to-go calls, which also name the car. They speak while the field is still forming, where "get behind" is the only thing to say.
- **When the call fires.** The #1286 rules about what counts as news stand.
- **A "close up" call, or any distance in the wording.** The model has no closeness test on purpose.
- **Whether the driver is in the right lane.** Not knowable from telemetry.
- **Variants.** Each line keeps one take; a second take is a clip-only change later.

## Testing

Suite:

- **The reader:** single file, directly behind; a same-line car between; the follow car more than half a lap ahead; the follow car behind the player with no other car in the line; double file with an other-lane car between (still behind); a car with no pace row between (still behind); no `CarIdxLapDistPct`; the pace car as the follow car; a withheld lineup.
- **The capture fixture** described above, replayed through the translator: at each `caution.lineup.changed` it emits, `behindFollowCar` is asserted against what the driver did in the capture.
- **The contract:** with the real script, each of the seven branches plays its own clip; the answer is read at speak time (a lineup that changes between the event and the gate speaks the later one).
- **The packs:** `bundled-scripts.test.ts` and `script-coverage.test.ts` pass for both voices, which holds every new clip to a reference in the script and every reference to a clip.

Harness: the lineup-change shortcut becomes two, one that places the player directly behind the new car and one that leaves a same-line car between, and the script entry's `test` line names both.

By hand, in an oval race with cautions:

1. Pit under caution and rejoin at the tail: "Get behind car N" (with the lane once double file).
2. Stay out while the car ahead pits: "You're behind car N".
3. Lead after the leaders pit: "You're at the front now, just the pace car ahead."
4. No "Change" in any of them, and the first call of the caution is unchanged.
