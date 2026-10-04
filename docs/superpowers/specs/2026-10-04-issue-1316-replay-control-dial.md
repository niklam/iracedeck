# Replay Control dial: Speed Control and Frame Jog

> **Issue:** [#1316](https://github.com/niklam/iracedeck/issues/1316), [#1317](https://github.com/niklam/iracedeck/issues/1317) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Replay Control gets a dial surface with two modes: **Speed Control** (#1316), a user-shaped speed ladder from reverse through pause to fast-forward, and **Frame Jog** (#1317), one frame per detent. #1316 builds the surface; #1317 adds a mode to it. The remaining rotation targets #801 once proposed (session, lap, incident, car) stay in #801 and are not designed here.

## The decision

Replay Control becomes a dual-surface action, like Fuel Service and Replay Markers (#1230): one UUID, `["Keypad", "Encoder"]` on the Elgato manifest with a committed layout, `["Keypad", "Knob"]` on Mirabox (the manifest parity test requires both, `encoders-and-touchscreen.md` rule 7), Ulanzi `["Keypad"]`. The dial logic lives in `replay-control/replay-control-dial-surface.ts` behind a small host interface, and every handler branches on `ev.action.isDial()`.

The action already carries `onDialDown` / `onDialRotate` with `executeDialDown` / `executeDialRotate`. They are unreachable: the manifests have declared the action keypad-only since #640. They are deleted with their tests, not adapted — they key the dial on the keypad's `mode`, which this design replaces with a dial-only `dial.mode`.

| Input | Speed Control | Frame Jog |
| --- | --- | --- |
| Rotate clockwise | one stop up the ladder (faster, signed) | next frame |
| Rotate counter-clockwise | one stop down the ladder (slower, signed) | previous frame |
| Press | `dial.pressAction`, default Play/Pause | same |
| Long press (Elgato) | `dial.longPressAction`, default Set 1x and play | same |
| Push + turn (Elgato) | a plain turn; the release fires nothing | same |
| Tap Display / Long Touch (Elgato) | `dial.tapAction` / `dial.longTouchAction`, default None | same |

The gesture slots are shared by both modes, so switching the Mode select never changes what the presses do. Every slot offers **Play/Pause**, **Set 1x and play**, **Reverse direction**, **Jump to Live** and **None**. Every long-press and touch option is also on Press, so a Mirabox knob (rotate and press only) reaches all of them (rule 2).

## The speed ladder

- **Order is signed.** The ladder runs from the fastest reverse speed through 0x to the fastest forward speed, and clockwise always moves toward +16x. From −8x, clockwise goes to −4x: slower in reverse, but "faster" on the signed ladder the user described.
- **The ladder is mirrored by construction.** The user picks **magnitudes**, and the ladder is `−m(n) … −m(1), 0x, m(1) … m(n)`. One choice cannot produce an asymmetric ladder, so there is nothing to keep in sync.
- **The magnitudes on offer are the powers of two iRacing's own replay bar uses:** 1/16, 1/8, 1/4, 1/2, 1, 2, 4, 8, 16. The default is **1/4, 1/2, 1, 2, 4, 8**, so the default ladder is −8x, −4x, −2x, −1x, −½x, −¼x, 0x, ¼x, ½x, 1x, 2x, 4x, 8x. The in-between integers (3x, 5x …) and odd fractions stay reachable from the keypad's Set Speed. A 31-box checklist offering them all would bury the choice in the PI.
- **Stored as tokens in the keypad's own speed format** (`parseSpeedSetting`: `"s4"` = 1/4x, `"2"` = 2x), as `dial.speedStops: string[]`. Parsing keeps only tokens in the offered set, dedupes them and sorts them by value. An empty or unparseable list parses to the default. That case is only reachable by hand-editing, because the PI will not let the last box be cleared. 0x is always on the ladder and is not a token.
- **A stop is `{ speed, slowMotion }`**, the shape `setPlaySpeed(speed, slowMotion)` takes: −¼x is `{ -4, true }` (the keypad's Slow Motion Rewind already sends that shape), 8x is `{ 8, false }`, 0x is `{ 0, false }`. Comparison goes through one signed numeric value (`slowMotion ? sign / |speed| : speed`), so the ladder and "where am I" share one function.

## Rotation — Speed Control

- **Read the live speed, not a cache.** The current speed is `ReplayPlaySpeed` / `ReplayPlaySlowMotion` from the latest telemetry, with the action's existing optimistic `setLocalSpeed` overlay so that two detents arriving before telemetry catches up do not compute from the same stale value. The Replay Markers dial needed a landing hold for exactly this, and this is that rule applied to speed.
- **One stop per detent, `|ticks|` stops for a fast spin, capped at 5 per event** (rule 3's cap), clamped at the ends without wrapping. A wrap from +8x to −8x would throw the replay backwards at full speed, which is the one surprise a speed dial must not give. One event sends **one** `setPlaySpeed`, to the last stop reached; at an end, nothing is sent.
- **Off the ladder:** when the live speed is not a stop (a key set 3x, iRacing's own bar set 16x when 16 is not chosen), the first detent goes to the nearest stop strictly beyond it in the turn's direction. 3x clockwise is 4x, and 3x counter-clockwise is 2x.
- **0x is a stop like any other.** Turning out of pause starts playback at the adjacent stop (¼x on the default ladder), never at the remembered speed: the ladder position is the replay's actual speed. Press is the route back to the remembered speed.

## Rotation — Frame Jog

- **One frame per detent:** `nextFrame()` / `prevFrame()`.
- **A fast spin sends one command:** `setPlayPosition(Current, ±n)` with `n = min(|ticks|, 5)`. The model is decided rather than deferred. It assumes `Current` is a relative offset that lands a paused replay `n` frames away, the same as `n` single steps would. The manual test below names the capture that confirms it. If it does not hold, the fallback is `n` back-to-back steps, and the spec is amended to say so.
- **A detent while playing pauses first.** If the live speed is non-zero, the first detent sends `pause()` before the step, so the jog always ends on a still frame whatever iRacing does to playback on a frame step. That is measured in the manual test, not assumed. The pause goes through the remembered-speed tracker, so Press resumes at the speed that was playing.

## The remembered speed

- **What it is:** the last non-zero speed the replay actually played at, as `{ speed, slowMotion }`. It is updated from telemetry on every tick where `ReplayPlaySpeed !== 0` and never overwritten by a 0, so it is right whoever changed the speed: the dial, a key, or iRacing's replay bar. Before any non-zero sample, it is 1x.
- **Where it lives:** one module-level tracker in `replay-control/`, shared by both modes and every dial context, because iRacing has one replay speed. It is in memory only. A plugin restart resets it to 1x; persisting it would be a settings key for a value that is stale the moment the replay changes.
- **Play/Pause:** a live speed other than 0 sends `pause()`, which the tracker has already recorded the speed for. 0x sends `setPlaySpeed(remembered)`.
- **Set 1x and play** sends `setPlaySpeed(1, false)` whatever the state.
- **Reverse direction** flips the sign of the live speed and keeps its magnitude and slow-motion flag. When paused, it flips the **remembered** speed and stays paused, so the next Play/Pause resumes the other way. The strip's resume caption shows the flip at once.
- **Jump to Live** runs the keypad's existing `jump-to-live` path.

## Commands and the replay cursor

- **Every send, from either mode or any gesture, first calls `cancelReplayCursorOwner("dial-…")`**, exactly as the keypad's speed and transport modes do (they call `cancelFastestLapWalk`). A speed change in the middle of a Jump to Fastest Lap walk would make the walk misread its own probes. The dial never claims the cursor: every event is a one-shot command.
- **Outside a replay, nothing is sent.** `IsReplayPlaying !== true` (which reads "in replay mode", not "playing", as `isCurrentlyPlaying` already notes) or missing telemetry makes rotation and every gesture a no-op, because iRacing ignores replay commands while driving.
- **All of it is iRacing API; no binding is involved.** The dial gets its own `comms-catalog.ts` entry keyed on `dial.mode`, with the gesture-slot values in the same map (the existing dial entries' pattern), all `api`, then `pnpm generate:action-comms`.

## Press gestures

Classified at release through `classifyDialReleaseForHost` with `getDualPressThresholdMs()`, as every dial does; no timer decides. On Mirabox every press is a short press (the adapter's atomic press, #1013).

- **Hold preview (#1120), Elgato only.** The long-press outcome is knowable before release, so when the hold passes the threshold the strip shows it ("▶ 1x", "◀ 4x", "LIVE"). `onThreshold` returns `false` when the slot is None or the release would do nothing (not in a replay, no telemetry), and absent telemetry previews nothing rather than a default. The pending state goes into the render arguments and the displayed signature, and `up()` disarms before its early returns (the four traps in `encoders-and-touchscreen.md`).
- **Trigger descriptions** (Elgato) name the mode's rotation and the slot assignments, so the Stream Deck app's dial hint matches the settings.

## The display

Drawn through `dialCanvas()` / `setDialCanvas()` on every host, so the same code draws the Stream Deck+ strip and the Mirabox knob screen, via the shared `renderDialBox` with `dialAppearanceFields` (rule 5).

| | Speed Control | Frame Jog |
| --- | --- | --- |
| Label | `SPEED` | `FRAME` |
| Value | live speed, `formatSpeedDisplay` (`PAUSED`, `4x`, `-1/4x`) | `ReplaySessionTime` as `m:ss.ss` — at 60 frames a second, every frame changes the hundredths |
| Caption | while paused: the resume speed, `▶ 4x` / `◀ 2x` | the play state, `PAUSED` or the live speed |
| Side marks | lit when a turn that way would change the speed, dim at a ladder end | both lit in a replay |

- **Not in a replay, or no telemetry:** the whole box dims, like the keypad's unavailable look.
- **Side marks on both sides:** `renderDialBox`'s `sideMarker` takes one side today. #1230 widens it to both, additively. Whichever of the two lands first does the widening, and the other reuses it.
- **Cadence:** re-evaluated on each SDK tick. The dedupe signature is built from what is displayed (label, value, caption, side marks, pending), never the raw frame, so a paused Speed Control dial pushes nothing. A playing Frame Jog dial changes its value every tick and is throttled to at most 10 pushes per second per dial (rule 6).

## Settings

A new `dial` root object on `ReplayControlSettings`, `.prefault({})`, holding `mode` (`"speed"` | `"frame-jog"`, default `"speed"`), `speedStops`, `pressAction`, `longPressAction`, `tapAction`, `longTouchAction` and the `dialAppearanceFields` colours, each with a `.catch` to its default. A stored setting is a persisted contract (`code-review.md`, xhigh), and this change only adds optional keys under a new root: existing keypad instances parse exactly as before, nothing is renamed or removed, and no migration is written. The top-level `mode` is still parsed on a dial instance and ignored there. `dial.mode`'s enum is where #801's modes will be added.

The PI branches on the controller (`fuel-service.ejs` is the pattern) and shows the dial section only on a dial. That section has a **Mode** select (label exactly "Mode", per `terminology-and-refs.md`) offering Speed Control and Frame Jog, a **Speeds** checkbox list (shown in Speed Control only) whose last ticked box cannot be cleared, the four gesture selects, and the appearance colours. Long Press, Tap Display and Long Touch are hidden where `dialExtendedGestures` is off.

## Out of scope

- **#801's session, lap, incident and car modes.** They get their own spec or an amendment of this one before work starts.
- **Asymmetric ladders.** Separate forward and reverse stop lists, or a "no reverse" toggle. Mirrored was the maintainer's call (2026-10-04); a forward-only user picks small magnitudes and ignores the reverse half.
- **Rotation acceleration** (bigger steps on a fast spin beyond the `|ticks|` walk).
- **Push + turn as a second function** (#801's shuttle/jog combo). Frame Jog is a mode of its own because push+turn exists only on Elgato.
- **Keypad behaviour.** The keypad's Play/Pause, speed walk and Set Speed are unchanged, including their 1x resume. Only the dial uses the remembered speed.
- **Persisting the remembered speed** across plugin restarts.
- **Ulanzi.** No Ulanzi dial is declared until its dials are verified (rule 7).

## Testing

**Unit (Vitest):**

- Ladder: building it from tokens (filtering, dedupe, sort, empty → default), the signed order, one-stop and multi-stop walks, the cap of 5, clamping at both ends (nothing sent), the nearest stop beyond an off-ladder speed in each direction, and 0x as a stop in both directions.
- Remembered speed: updated by non-zero samples, never by 0, defaulting to 1x, and shared across contexts.
- Gestures: Play/Pause both ways, Set 1x and play, Reverse while playing and while paused, Jump to Live, and None; the long-press classification with the extended-gesture flag on and off; push+turn firing nothing on release.
- Frame Jog: single steps, `setPlayPosition(Current, ±n)` for multi-tick with the cap, and the pause-first on a playing replay.
- Guards: nothing sent outside a replay or with no telemetry; `cancelReplayCursorOwner` before every send.
- Display: the dedupe signature (a paused speed dial pushes once), the hold preview's `false` cases, and the dimmed box.
- Settings: `dial` parses with `.catch` defaults; an existing keypad-only settings object parses unchanged.
- The comms catalog entry and the manifest parity test, green after `pnpm generate:action-comms`.

**Manual, in an iRacing replay**, on a Stream Deck+ and on the Mirabox knob:

- **Speed Control:** walk the default ladder end to end in both directions, check the clamp at ±8x, Play/Pause after a speed set from a key and after one set from iRacing's replay bar (the resume speed must match it), long-press to 1x, and Reverse while paused.
- **Frame Jog:** single detents both ways. **The capture that confirms the model:** from a paused replay, note `ReplayFrameNum`, spin three detents in one event, and check that the frame moved by exactly 3. Separately, step one frame while playing at 1x without the pause-first and record whether iRacing paused by itself. If the first check fails, the spec is amended to repeated steps.
- **From the car:** every input does nothing and the display is dimmed.
