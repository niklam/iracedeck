# Dials and the touch strip show the disconnected look

> **Issue:** [#1671](https://github.com/niklam/iracedeck/issues/1671) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

#1599 dims every key that needs iRacing while it is not running. This change draws the same look on every dial screen whose dial needs it: the Stream Deck + strip slot and the Mirabox knob screen. It goes in the dial funnel #1670 adds, decided by the same setting and the same debounced presence signal, with the same exemptions. The issue carries the request. This spec records how the look fits a dial screen, which dials are exempt, and how a dial is redrawn when its look changes. It depends on #1599 and #1670 both being on `master`.

## Behaviour

- **Shown when all three hold:** **Dim keys that need iRacing** (`showDisconnectedState`) is on, the sim is absent by #1599's debounced signal, and this dial's own mode needs the sim. These are the conditions a key uses, read the same way.
- **Cleared on the first connected tick.** As on keys, a start with iRacing already running never flashes the look, and neither does a short SDK drop.
- **Where:** every frame a dial surface draws, on the Stream Deck + strip and on a Mirabox knob, through #1670's `setDialImage`. Ulanzi has no dial canvas and draws nothing.
- **The look is the key's look:**
  - the frame is drawn unchanged;
  - one black rectangle covers the whole canvas at `DISCONNECTED_DIM_OPACITY` (0.55);
  - on top of that goes `DISCONNECTED_BADGE`, the `plug-slash-red` badge Niklas picked for keys, anchored top-left;
  - only the badge's size is the dial's own (§3).
- **Other dial looks are drawn first and dimmed with the rest.** That covers the #612 ⚠, Replay Control's own dimmed box outside a replay, the replay busy mark, side marks and Camera Controls' neighbours, and the #1120 hold preview. They are all part of the surface's frame, as the binding ⚠ and the unavailable grey are part of a key's image.
- **Presses and turns still go through.** The look is information, not a gate. A dial keeps redrawing under the look, so a value that changes is still seen.
- **The name card is not decorated, pending Niklas.** On the Stream Deck + it is the app's dial tile, not a device screen; on a knob it is never sent. This is open question 1 below.

### Which dials need the sim

A dial needs the sim unless its action says otherwise for the dial's current mode. #1599's exemptions carry over. Only one exempt action has a dial:

| Dial action | Needs the sim? | Why |
| --- | --- | --- |
| Audio Controls, dial category Race Engineer or Radar | **no** | It steps the plugin's own audio buses (`INTERNAL_AUDIO_CATEGORIES`) |
| Audio Controls, dial category Voice Chat, Master or Spotter | yes | iRacing key bindings |
| The other 17 dial actions, every mode: Black Box Selector, Camera Controls, Camera Editor Adjustments, Cockpit Misc, Force Feedback, Fuel Service, Replay Control, Replay Markers, Setup Aero, Setup Brakes, Setup Chassis, Setup Engine, Setup Fuel, Setup Hybrid, Setup Traction, Splits & Reference, View Adjustment | yes | They talk to, or read, iRacing |

Pit Crew, Switch Profile and Telemetry Control, #1599's other exemptions, declare no dial.

**The dial reads its own category.** Audio Controls keeps the keypad's `category` and the dial's `dial.category` apart (dial settings live under `dial`, #759). #1599's override reads `category`, so for a dial it would answer for the key's category. A dial on Master over a key set to Radar would stay plain, and a dial on Radar over a key set to Master would dim.

## Architecture

### 1. `needsSim` learns the surface

```typescript
protected needsSim(settings: unknown, surface: "key" | "dial"): boolean; // ConnectionStateAwareAction, `true` by default
protected showsDisconnected(contextId: string, surface: "key" | "dial"): boolean; // BaseAction `false`; ConnectionStateAwareAction overrides
```

- `decorateKeyImage` passes `"key"`, and the dial funnel passes `"dial"`. The caller knows the surface for certain: the funnel is only ever handed a dial frame. Ulanzi learns that a context is a dial only from its first dial input (#1530), so the context's own `isDial()` would be the weaker source.
- Audio Controls answers `!isInternalAudioCategory(surface === "dial" ? s.dial.category : s.category)`. Pit Crew, Switch Profile and Telemetry Control ignore the parameter.
- **Why a parameter, not a second hook** (`dialNeedsSim`): a second hook defaulting to `true` would dim a dial added later to an exempt action unless somebody remembered the second override. With one hook, every override sees both surfaces. Reading the surface from the shape of the settings is not possible either: a context's settings carry both `category` and `dial`.

### 2. The dial funnel decorates, remembers and redraws

- **`setDialImage(action, image)`**, when the context has a canvas:
  - it reads `look = showsDisconnected(id, "dial")`; a throw counts as `false` and sends the frame undecorated, as on keys;
  - it records `{ action, image, look }` for the context, with the undecorated image;
  - it sends `look ? applyDisconnectedLook(image, { badgeScale }) : image`, with the badge scale for the canvas (§3).
  The record is made before the send's await, so the record always holds the latest frame the surface asked for.
- **Only a live context is recorded.** A live context is one `BaseAction` holds settings for: it has appeared and not disappeared. `onWillDisappear` drops the record. A frame for a context that is not live is still sent, as today, but it is not recorded, so a late frame cannot leave an entry behind (the #1329 class).
- **This depends on the super-call order.** A dial's first frame is recorded, and decided against that dial's own settings, only if the owning action awaits `super.onWillAppear(ev)` before it calls its surface's `willAppear`. The same holds for `super.onDidReceiveSettings(ev)` before the surface's `didReceiveSettings`, or the frame is decided against the previous settings. All 18 Encoder actions do this today, but nothing enforces it. So `actions/dial-surface-base-coverage.test.ts` gains a rule: in each Encoder action's `onWillAppear` and `onDidReceiveSettings`, the `super.<member>(…)` call comes before the first `this.dialSurface…` call (whatever the surface field is named, found by its type's `DialSurface` suffix). The rule reads the source text with the guard's existing `scanSource` and fails on a missing super call or one placed after the surface call. Its positive control is a planted action source with the order swapped, which the rule must report. Audio Controls' pre-super migration and seed writes are not surface calls and stay allowed.
- **`refreshDialLooks(only?: contextId)`** goes through the records, or only the named one. For each whose `showsDisconnected(id, "dial")` now differs from its recorded `look`, it re-sends the recorded image decorated for the new state and updates `look`. Three places call it:
  - `BaseAction`'s global-settings listener, after `refreshAllImages`: the setting was toggled;
  - `ConnectionStateAwareAction`'s presence handler: the sim came or went;
  - `BaseAction.onDidReceiveSettings`, for that one context, right after it stores the new settings. A settings change can flip `needsSim` (Audio Controls' dial from Master to Radar), and the surface may draw no new frame for it. A surface that does redraw goes through `setDialImage`, which decides afresh; the re-check costs nothing when the look did not flip.
- **A dial whose look did not flip is not re-sent.** A settings write therefore costs a dial nothing it does not cost today: no extra Elgato feedback, and no extra rasterisation on a Mirabox knob. This is where dials differ from keys, which `refreshAllImages` re-sends on every settings change. The surfaces already redraw themselves on settings changes they care about, so the only frame the funnel owes a dial is the one where the look changed.
- **Why the funnel redraws rather than asking the surface:** every surface dedupes on a render signature (`lastRenderSig`, `displayedSignature`) that does not contain the look. Asking the surfaces to redraw would mean adding the look to 18 signatures, which is 18 places to forget, the class #1670 closed. The recorded frame is the frame on screen, so re-sending it decorated is exact.
- **Ordering.** A re-send and a surface frame that are in flight together supersede each other through the adapter's per-context key (Elgato `<id>#box`, Mirabox `<id>`), and the later wins. Both decide the look when they are sent, so neither can carry a stale look.
- **Rate.** A flip adds one frame per dial, outside the surface's 10/s throttle (rule 6). That is accepted, since a flip happens a few times a session at most.
- **`setDialNameCard` is untouched.**

### 3. The look at dial sizes

- **`applyDisconnectedLook(svg, options?: { badgeScale?: number })`** in `icon-composer`. Without options it is byte-identical to #1599's, so the key output does not change. With a `badgeScale`, it draws the same badge at that scale, anchored at the same top-left inset times the scale. The dim rectangle, its opacity and the shape set (`rect`, `circle`, `polygon`, `path`, `opacity`; readable with `pngRasterization` off) are unchanged, so `svg-platform-compatibility.md` needs nothing new.
- **The scale per canvas** is `DISCONNECTED_BADGE_SCALE: Readonly<Record<DialCanvasId, number>>` in `deck-core/src/dial-canvas.ts`, beside the profiles and #1670's `DIAL_NAME_CARD`. It is exhaustive, so a new dial profile fails to compile until it has a badge size. The funnel looks it up by `profile.id`.
- **Placement constraints**, fixed here, on both canvases, for `renderDialBox` and for the four self-drawn surfaces (Fuel Service, Audio Controls, Camera Controls, Black Box Selector). The badge leaves clear:
  - the label and the value;
  - the side marks (on the label line, 0.3 of the width either side of the centre, `sideMarkGeometry`);
  - the #612 ⚠ (centre) and the caption mark (left end of the bottom caption line);
  - Camera Controls' neighbours.
- **Measured against the code**, at the key rule (the shorter side / 144):
  - **Strip (200×100):** scale 0.694. The plate spans x 5.6–33.4, and the left side mark starts at x ≈ 35.5, so it clears by about 2 px.
  - **Knob (176×112):** scale 0.778. The plate would span x 6.2–37.3, while the left side mark spans x ≈ 30–40 and y ≈ 15–29, so the two overlap. The knob therefore takes a smaller badge: the plate must end before x ≈ 28, which is scale ≤ 0.58 (a plate of about 23 px).
- **Starting values for the review:** strip 0.694, knob 0.55. Niklas sets the final two on the review page; the constraints above are the bounds he picks within.

### 4. The debounce, reused

Nothing is added. The look reads #1599's `isSimAbsent()` and `onSimPresenceChange()`, with `absentDelayMs` = `IRACING_EXIT_SDK_CONFIRM_MS` (5 s), passed by `deck-iracing`'s `initializeSDK`. `ConnectionStateAwareAction` already counts a dial context as a live context, so its presence listener is held while any key or dial of the action is on the deck. Its handler keeps #1599's filtered key refresh and gains `refreshDialLooks()`.

### 5. Setting and text

- **No new setting.** `showDisconnectedState` covers dials. #1599 §5 decided that one setting covers the look, and a dial-only switch would be a product addition nobody asked for.
- **The checkbox label and card title stay as drafted** ("Dim keys that need iRacing", "Disconnected Keys") unless Niklas renames them. This is open question 3 below.
- **The help text** in `global-disconnected-look.ejs` gains dials: dials and the Stream Deck + touch strip dim too, and the Race Engineer and Radar volume dials keep their look. The settings-window screenshots are recaptured with `pnpm capture:settings`.

## Review page

**"Dial disconnected look (#1671)"**, a private Artifact built with the `review-page` skill before any of the look is committed. For each canvas, the strip (200×100) and the knob (176×112), it shows the frame without and with the look:

- a Setup dial with a value (Setup Brakes ABS) and an identity-only one (Setup Engine boost level);
- a dial with side marks (Replay Markers, `k / N`);
- the #612 ⚠ (Camera Controls, Sub-Camera with its binding unset);
- Replay Control outside a replay (its own dimmed box), and in one with the caption mark;
- the four self-drawn surfaces: Fuel Service, Audio Controls on Voice Chat, Camera Controls' Car # carousel with neighbours, and Black Box Selector;
- an Audio Controls dial on Race Engineer, which never gets the look;
- a key with #1599's look beside them, for comparison.

The badge is shown at each canvas's starting scale and one step either side. The page also shows the Stream Deck + name card with and without the look, and the settings card with the current and a dial-inclusive wording. Niklas answers the three open questions there, unless he has settled them before implementation.

## Open questions for Niklas

These three are product decisions, and this spec does not make them. Niklas settles them before implementation starts, or on the review page before any of the look is committed. The drafted answer stands in each case until he does.

1. **The name card.** Should the Stream Deck + name card, shown only in the Stream Deck app, get the look? Drafted: no. A yes adds a record and a redraw for the card to §2.
2. **The badge size per canvas.** Which final `DISCONNECTED_BADGE_SCALE` values, within the §3 constraints? Drafted: strip 0.694, knob 0.55.
3. **The setting wording.** Should "Dim keys that need iRacing" and the "Disconnected Keys" card title be renamed to cover dials? Drafted: keep both, and change only the help text and the website paragraph.

## Alternatives rejected

- **A dial-specific look** (a strip-wide "IRACING NOT RUNNING" banner, a different badge). It would read as a different thing from the key look, which is what the issue asks to avoid.
- **The key's badge scale on the knob.** It overlaps the left side mark (§3).
- **Another corner on the knob.** The top-right mirrors the side-mark clash and the bottom-left holds the caption mark. A badge that moves corners between surfaces would also read as a different mark. Shrinking is the smaller change.
- **Redrawing through the surfaces** by adding the look to each render signature (§2).
- **A second `dialNeedsSim` hook** (§1).
- **Decorating in the adapters or in `renderDialBox`.** Rejected in #1670's spec for the same reasons: no per-context state there, and four surfaces never pass through `renderDialBox`.
- **Re-sending every recorded dial on every settings change,** as keys are re-sent. It would rasterise every knob on every settings write for no visible change.

## Out of scope

- **The name card:** left undecorated, pending Niklas's answer on the review page. If he wants it decorated, it needs a record and a redraw of its own.
- **Ulanzi dials:** no canvas (#1013).
- **Dropping dial input while disconnected:** the same product question #1599 left open for keys.
- **The key look.** Its geometry and badge are unchanged; the badge scale is an option only dials pass.
- **A look for a SimHub-bound dial while SimHub is unreachable:** as for keys, not built.

## Artifacts

- `packages/icon-composer`: the `badgeScale` option in `disconnected-look.ts`, its tests and `CLAUDE.md`.
- `packages/deck-core`:
  - `dial-canvas.ts`: `DISCONNECTED_BADGE_SCALE`;
  - `base-action.ts`: the record, the decoration, `refreshDialLooks`, and `showsDisconnected`'s surface parameter;
  - `connection-state-aware-action.ts`: `needsSim`'s surface parameter and the presence handler;
  - their tests and `CLAUDE.md`.
- `packages/iracing-actions`:
  - Audio Controls' `needsSim`, and the three other overrides' new signature;
  - the super-call-order rule in `actions/dial-surface-base-coverage.test.ts`;
  - the table test over every dial action (Testing);
  - `CLAUDE.md`.
- `packages/pi-components`: the help text in `global-disconnected-look.ejs`, and the screenshots through `pnpm capture:settings`.
- Website:
  - `docs/getting-started/settings.md`, *Disconnected Keys*: "Dials and the Stream Deck + touch strip are not dimmed." becomes the dial behaviour and the dial exemption;
  - the Architecture page's line on SEAM 3 ("the disconnected look … over every key that needs the sim") names dials too.
- Changelog: if #1599's fragment (`changelog.d/1599-disconnected-key-look.md`) is still unreleased when this merges, that fragment is edited to cover dials (one change, one fragment). Otherwise a new `Features` fragment, `1671-dial-disconnected-look.md`, is added.
- Rules:
  - `encoders-and-touchscreen.md`: the look in the dial funnel, the per-canvas badge scale, and the dial exemption reading `dial.category`;
  - `stream-deck-actions.md`: `needsSim`'s surface parameter;
  - `icons.md`: the badge's dial sizes.

## Testing

**Unit (Vitest):**

- **`applyDisconnectedLook`:**
  - with no options, the output is byte-identical to #1599's for the existing key fixtures;
  - with `badgeScale`, at 200×100 and 176×112, the plate's box is the inset and size times the scale;
  - the output holds no `filter`, `mask`, `clipPath` or `<style>`.
- **Geometry** (`iracing-actions`, `shared/dial-disconnected-look-geometry.test.ts`): at each canvas's `DISCONNECTED_BADGE_SCALE`, the plate's box does not intersect the box of `renderDialBox`'s label, value, side marks (`sideMarkGeometry`), centred ⚠ or caption mark. As a positive control, at the key rule on the knob the same check reports the side-mark overlap.
- **`BaseAction`'s dial funnel:**
  - it decorates exactly when `showsDisconnected(id, "dial")` is true;
  - the record holds the undecorated frame;
  - a look flip re-sends that frame once, decorated for the new state;
  - a global-settings change that flips nothing sends no dial frame;
  - a per-context settings change that flips `needsSim` while the surface draws no new frame (a stub action whose `needsSim` reads one setting, sim absent, look on) re-sends that dial's recorded frame once, decorated for the new answer, and leaves the action's other dials alone; a settings change that flips nothing re-sends nothing;
  - `onWillDisappear` drops the record, and a frame after it is sent but not recorded;
  - a throw from `showsDisconnected` sends the frame undecorated;
  - a `null` canvas sends and records nothing;
  - `setDialNameCard` is never decorated.
- **`ConnectionStateAwareAction`:**
  - `needsSim` is handed `"key"` for a key frame and `"dial"` for a dial frame;
  - a presence change re-sends a dial whose look flips and only that dial;
  - the listener stays held while only a dial of the action is live.
- **Audio Controls:**
  - a key on Radar beside a dial on Master, sim absent: only the dial is decorated;
  - a key on Master beside a dial on Race Engineer: only the key is.
  As a positive control, the same two arrangements run against #1599's override, which reads `category` for both surfaces, must decorate the wrong context. This is written as a test of that override, in the way #1599 pinned its per-instance bleed.
- **The super-call order** (`actions/dial-surface-base-coverage.test.ts`, extended): every Encoder action's `onWillAppear` and `onDidReceiveSettings` call `super` before the surface. A planted action with the order swapped, and one with no super call, are both reported (§2).
- **Every dial action** (`actions/dial-disconnected-look.test.ts`): a table over the Stream Deck manifest's `Encoder` actions, its count tied to the manifest as `dial-surface-base-coverage.test.ts` ties its own. Each action appears as a dial on each profile, with the setting on and the sim absent, and:
  - its first frame equals `applyDisconnectedLook` of the undecorated frame at that profile's scale;
  - Audio Controls on Race Engineer or Radar never gets the look;
  - with the setting off, no dial does.

**Manual (Niklas, on a Stream Deck + and a Mirabox knob):**

1. Tick **Dim keys that need iRacing**. With iRacing closed, restart the deck host. About 5 s after the plugin starts, every dial's strip slot and knob screen dims and shows the badge, beside the dimmed keys. The exceptions are Audio Controls dials on Race Engineer or Radar.
2. Start iRacing and join a session: the dials clear as it connects. Change session within the event: nothing flashes. Leave to the iRacing UI: the look returns about 5 s later.
3. Untick the setting with iRacing closed: the dials clear at once. Tick it: they dim again.
4. Turn a dimmed Setup or Audio Controls dial: the frame keeps updating under the look. A Replay Control dial outside a replay shows its own dimmed box under the look.
5. Switch pages with iRacing closed: the dials on the new page show the look at once.
6. Change an Audio Controls dial between Master and Radar with iRacing closed: the look comes and goes with the category.
7. With iRacing running, nothing about the dials differs from before this change.

**Review level:** `high`. This is ordinary domain code. It changes the `needsSim` / `showsDisconnected` signatures inside deck-core's action API, but no persisted setting, schema or adapter contract. **The second read applies:** the recorded per-dial look and its re-send from three triggers (global settings, presence, a context's own settings), against the surfaces' own frames, form a state machine.
