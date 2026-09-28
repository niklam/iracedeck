# Replay jump playback: Remember state / Play / Stopped

> **Issue:** [#1276](https://github.com/niklam/iracedeck/issues/1276) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Builds on #1275, and settles the part of that fix both issues share: how a jump waits for the cursor. #1275 can ship on its own; if both land in one branch, this spec is the design for the shared sequence.

## The sim fact this rests on

A long `ReplaySetPlayPosition` is not one step. iRacing moves the cursor at most `maxFramesToSearchPerUpdate` frames per update (2048 in the maintainer's `app.ini`), and a replay command arriving while that search is under way ends it wherever it has got to. Measured on 2026-09-28 (#1275): Jump to Fastest Lap, which sent `ReplaySetPlaySpeed(1)` 3 ms after the seek, landed only when the target was within a couple of thousand frames ahead and otherwise moved the cursor forward by roughly 6000 frames; Previous / Next Marker, which sends the seek and nothing after it, landed from any distance. So **nothing may follow a seek until `ReplayFrameNum` reads the target** — neither a speed command nor a camera switch.

## The decision

### One global setting, three values

`replayJumpPlayback` in `GlobalSettingsSchema`: `z.enum(["remember", "play", "stopped"]).default("remember").catch("remember")` — the `.catch` so a value a future version adds reads as the default here rather than failing the whole settings parse. The settings window's Replay card (`global-common-replay.ejs`) gets an `sdpi-select` labelled **Replay jump playback** above Fastest Lap Search Delay:

| Value | Label | After the jump |
| --- | --- | --- |
| `remember` | Remember state | The replay continues at exactly the speed it had before the press: paused stays paused, and 1×, slow motion, fast-forward and rewind carry on at the same speed and direction from the new spot. |
| `play` | Play | Plays at 1×. |
| `stopped` | Stopped | Paused on the new spot. |

Global, not per key (maintainer's ruling): one preference about how the replay behaves, not a property of a particular key. It covers **Jump to Fastest Lap** (Replay Control) and **Previous / Next Marker** (Replay Markers). Default `remember` changes Jump to Fastest Lap's behaviour for everyone — it plays at 1× today — which is the point: the press used to throw away a pause the driver had chosen.

### "Remember" means the exact speed, read from telemetry at the press

The speed to restore is `replaySpeedFromSdk(ReplayPlaySpeed, ReplayPlaySlowMotion)` read from the latest telemetry at the press, before any command goes out. Telemetry rather than Replay Control's local speed cache because Replay Markers has no such cache and both actions must remember the same thing; the decode is the #1202 one, so a slow-motion speed restores as the speed the driver chose, not one step off.

### One shared jump sequence

A helper in `iracing-actions/src/shared/` (both actions import it), in this order:

1. **Capture** the speed as above.
2. **Pause first when the replay is moving** (captured speed ≠ 0): `setPlaySpeed(0)`. Two reasons. While the replay plays, `ReplayFrameNum` moves past the target the moment it lands, so "reads the target" could never be observed reliably; and whether ongoing playback also cuts a long seek short is not measured, so the sequence does not depend on it. A paused replay sends nothing here.
3. **Seek**: `setPlayPosition(Begin, frame)`.
4. **Wait** until `ReplayFrameNum === frame`, polling at the walk's `STABILIZATION_POLL_INTERVAL_MS`, with the walk's timeout (`readFastestLapSearchDelayMs() × STABILIZATION_TIMEOUT_MULTIPLIER`). This is the wait the walk's `search` closure already does; it is extracted from `runFastestLapWalk` rather than written twice.
5. **The action's own step, if any**: Jump to Fastest Lap's `CamSwitchNum` onto the target car moves here, after the landing. Only the walk's camera-relative lap search needs the camera on the car before it moves, and the walk keeps its switch where it is.
6. **Apply the setting**: the desired speed is the captured one (`remember`), 1× (`play`) or 0 (`stopped`). Send `setPlaySpeed(desired)` only when it differs from the speed now reading. A paused `remember` press therefore sends only the seek — exactly what Replay Markers does today.

The sequence registers as the replay-cursor owner for its duration (the `cancelReplayCursorOwner` mechanism #1203 added), so another replay press during the wait cancels it rather than racing it; a cancelled sequence sends nothing more.

**On timeout** the sequence logs a warning with the last frame seen and sends nothing more. The replay stays paused where the seek stopped, whatever the setting says: playing from a spot the driver did not ask for is worse than stopping there.

### Jump to Fastest Lap's two paths

- **Record hit**: steps 1–6 with the recorded frame − 60, in place of today's `switchNum` → `setPlayPosition` → `play()`.
- **Walk**: it already captures nothing and ends with a hard-coded play at 1×. It captures the speed at the press (step 1) and ends through step 6 instead. Its own pause-first and per-probe waits are unchanged.

`setLocalSpeed` is updated with whatever speed step 6 leaves the replay at, so Replay Control's icons follow without waiting for telemetry.

## Out of scope

- Replay Control's other jumps — Previous/Next Lap, Session and Incident, Jump to Live, Jump to My Car. Several are iRacing's own searches, and whether each can honour the setting needs checking; a later issue if wanted.
- A per-key override. Global only, by ruling; a per-key value can be added later without migrating this one.
- Raising or reading `maxFramesToSearchPerUpdate`. The sequence works at any value; the setting stays iRacing's.
- Speed changes the driver makes during the wait: those cancel the sequence (cursor owner), they are not merged into what it restores.

## Testing

**Unit** (both actions, deck-core mock, a telemetry mock that reports `ReplayFrameNum` landing after N polls):

- For each value × each captured state (paused, 1×, slow motion 1/4, fast-forward 8×, rewind −8×): the commands sent, in order, and the speed left at the end. `remember` + paused sends only the seek.
- Nothing is sent between the seek and the landing; the camera switch comes after it on the record path.
- Timeout: a warning, no command after the seek, replay paused.
- Cancellation: a second replay press during the wait ends the first sequence with no further command.
- The schema: default `remember`; an unknown stored value reads as `remember`; the `simhub-service.test.ts` fixtures carry the key.

**Manual** (in-session replay of a race longer than ~5 minutes, a Telemetry Display key showing `{{telemetry.ReplayFrameNum}}`):

1. For each setting value, press Jump to Fastest Lap from more than 20000 frames before the lap and from after it, once paused and once playing at 1×. Expect it to land on the lap start − 60 every time and leave the replay in the state the table above describes.
2. The same for Previous / Next Marker with markers far apart.
3. **Remember** while rewinding at −8× and in slow motion: the rewind or slow motion carries on from the new spot.
4. Set Fastest Lap Search Delay to its minimum (50 ms) and jump from the far end of a long replay: if the landing times out, the warning names the last frame seen and the replay is paused there. That run is also the measurement of whether the walk-derived timeout is long enough for a far seek.
