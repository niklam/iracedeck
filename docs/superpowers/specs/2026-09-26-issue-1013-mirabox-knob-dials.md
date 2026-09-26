# Dials on Mirabox knobs, with a live knob screen

> **Issue:** [#1013](https://github.com/niklam/iracedeck/issues/1013) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

#786 withdrew the `"Knob"` controller from every Mirabox manifest entry because no knob event had ever been observed through our adapter. The dial set has since grown from three actions to sixteen on Elgato, and none of them can be placed on a Mirabox knob.

Restoring the manifest alone would leave every knob screen showing the static 72×72 name card forever: every surface draws its live readout through `setFeedback`, which the Mirabox adapter no-ops. The maintainer chose to ship a live knob screen in the same change, drawn **for** the knob rather than scaled from the Stream Deck+ strip.

## Evidence

Two devices, same result. The #1013 reporter tested Fuel Service on a Soomfon CN003 (an N4-class clone). The maintainer then ran a raw-event probe build (every host event logged, settings stripped) on his own Mirabox knob device on 2026-09-26.

| Input on the knob | What the host sent (maintainer's device) |
| --- | --- |
| Placing Fuel Service on a knob | `willAppear` with `payload.controller: "Knob"` |
| Rotate | `dialRotate`, `ticks` ±1 per detent, `pressed: false` |
| Short click | `dialDown` + `dialUp`, 50 ms apart every time |
| Hold 5 s | a lone `dialDown`, **no `dialUp` ever** |
| Push and turn | a lone `dialDown`, **no `dialRotate`**, no `dialUp` |
| Tap the screen above the knob | `dialDown` + `dialUp`, 50 ms apart — a knob press |
| Touch-hold the screen 2 s | `dialDown` + `dialUp`, 50 ms apart — same as a tap |

The CN003 matched it: every release classified short and `pressed` was always false.

So on Mirabox the knob has exactly two gestures, **rotate and press**, and a screen tap is the same press. Long-press, push+turn and touch never reach the plugin as anything distinguishable. The proof of concept also showed that `setImage` on a Knob context draws on the LCD segment above the knob, and that a 176×112 drawing reads comfortably on the device.

Two facts in the current docs are wrong and are corrected by this change: a Mirabox hold does **not** "degrade to a short press" (it fires nothing, because the classifier waits for a `dialUp` that never comes), and `dialRotate.pressed` is **not** delivered on Mirabox.

## What the code looks like today

- **All sixteen surfaces push the same thing.** Each ends its render path in `setFeedback({ box: svgToDataUri(svg) })`: one full-canvas 200×100 pixmap keyed `box`, the only item in every Elgato layout under `layouts/`. Twelve build the SVG through `renderDialBox` in `shared/dial-box.ts`; Fuel Service, Audio Controls, Camera Controls and Black Box Selector draw their own.
- **`__FEATURE_DIAL_FEEDBACK__` gates four things at once:** the `touchTap` handler, the #1120 hold preview, `setTriggerDescription`, and the render. The `dialFeedback` key in each plugin's `platform-features.json` also hides Tap Display / Long Touch in the PI templates.
- **The Mirabox adapter has no image size per controller.** `setImage` rasterizes every context to the flat square `DEFAULT_KEY_IMAGE_SIZE` (144).

## Approaches weighed

- **Translate `setFeedback` into `setImage` inside the Mirabox adapter.** Rejected: the 200×100 drawing letterboxes into 176×112 and the adapter learns the Elgato layout's `box` key.
- **Reflow one layout at each canvas size** (`renderDialBox` already takes `width`/`height`). Rejected by the maintainer: one design stretched to a squarer screen is not a design for the knob, and the self-drawn surfaces have 200×100 geometry written in.
- **Branch on the platform in every surface.** Rejected: sixteen copies of one routing decision.
- **A dial-canvas seam in deck-core, with a separate renderer per device over shared primitives (chosen).**

## Design

### The seam (deck-core, sim-agnostic)

`IDeckActionContext` gains two members:

```typescript
/** The dial's own screen, or null when it has none (a key, or a host with no dial screen). */
dialCanvas(): DialCanvasProfile | null;

/** Push one full-canvas image to that screen. A no-op when dialCanvas() is null. */
setDialCanvas(dataUri: string): Promise<void>;

interface DialCanvasProfile {
  /** Which device class the drawing is for; renderers branch on this, never on the platform. */
  id: "sd-plus-strip" | "stream-dock-knob";
  width: number;
  height: number;
}
```

| Adapter and context | `dialCanvas()` | `setDialCanvas()` |
| --- | --- | --- |
| Elgato, Encoder | `sd-plus-strip`, 200×100 | `setFeedback({ [DIAL_CANVAS_KEY]: dataUri })` |
| Mirabox, Knob | `stream-dock-knob`, 176×112 | `setImage`, rasterized at 176×112 |
| Ulanzi, any context | `null` | no-op |
| Any adapter, key or Information context | `null` | no-op |

`DIAL_CANVAS_KEY = "box"` becomes a deck-core constant, since all sixteen Elgato layouts already use it. `toDeviceImage` and the rasterizer take a width and height instead of one square size; a square call keeps its current behaviour.

On a Mirabox knob, `setImage` and `setDialCanvas` address the same pixels, and the surfaces stop pushing the `willAppear` name card there — the live drawing owns that screen. On Elgato, `setImage` on a dial stays the app-UI canvas, unchanged.

The profile is a description of **hardware**, so it lives in deck-core beside the other device profiles and knows nothing about any sim. A future sim's action package gets the same profiles and the same primitives.

### Renderers: one per device, over shared primitives

Every dial drawing has a strip renderer and a knob renderer, selected by `profile.id`. They are deliberately separate functions — similar vocabulary, independent composition — so the knob design can drop, enlarge or rearrange elements without touching the strip.

- **Shared primitives** stay in one place and are used by both: the colour resolution (`resolveDialBoxColors`, `dialAppearanceFields`), the pending bar (`renderPendingBar`), the binding warning, value-fitting, and the self-drawn pieces a surface reuses across its two renderers (Fuel Service's `renderFuelBarSvg`).
- **`renderDialBox`** becomes a dispatcher over `renderStripBox` (today's drawing, byte-identical output at 200×100) and `renderKnobBox` (new), serving the twelve surfaces that use it.
- **Fuel Service, Audio Controls, Camera Controls and Black Box Selector** each gain a knob renderer beside their strip renderer. Fuel Service's is the proof-of-concept drawing the maintainer approved on the device: the same band, readout and two-segment bar, with a larger readout (up to 30 px) and a taller full-width bar.
- **The primitives and `renderDialBox` stay free of sim imports** — they import only deck-core and zod today. A guard test fails if any file under `shared/dial-*` imports `@iracedeck/iracing-sdk` or `@iracedeck/sim-events-iracing`, so they remain liftable into a sim-neutral package when a second action package exists. Moving them now is not part of this change.

### Surfaces

- All sixteen replace `setFeedback({ box })` with `setDialCanvas(render(profile, …))` and render only when `dialCanvas()` is non-null. The existing ≤ 10 renders/s throttles apply unchanged to both targets.
- **A lone `dialDown` fires nothing**, and must leave nothing behind that a later short press could misread. The classifier already overwrites `pressStart` on the next `dialDown`; a test pins it.

### The Stream Deck+ gesture set stays behind one flag

On Mirabox only rotate and press exist, so everything else is gated together: touch input (`touchTap`), trigger descriptions, the Long-press and push+turn behaviour, and the #1120 hold preview. The hold preview is here rather than with the display for a concrete reason: armed on a Mirabox hold's `dialDown`, it would never see the `dialUp` that disarms it and would stay stuck on the knob screen.

`__FEATURE_DIAL_FEEDBACK__` / `dialFeedback` is renamed `__FEATURE_DIAL_EXTENDED_GESTURES__` / `dialExtendedGestures` to say what it now gates; display is no longer part of it. True on Elgato, false on Mirabox and Ulanzi.

### Manifest and PI

- The Mirabox manifest declares `"Controllers": ["Keypad", "Knob"]` on all sixteen dial actions, with no `Knob` config block.
- A test asserts that the Elgato actions declaring `"Encoder"` and the Mirabox actions declaring `"Knob"` are the same set, so a new dial surface cannot silently stay Elgato-only.
- On Mirabox the dial PI shows only the settings a knob can reach: rotation settings, appearance, and the **Press** gesture. Long-press, Tap Display and Long Touch are hidden by the renamed flag, and any help text that mentions push+turn or long-press says so only on Elgato. Stored values in the hidden slots are kept untouched.
- Every PI that switches between keypad and dial views on `actionInfo.payload.controller` treats `"Knob"` as a dial (Fuel Service's already does).

### What a Mirabox user loses, stated plainly

Every gesture a surface offers on Long-press or a touch slot is also assignable to Press, so no function is unreachable. What is lost is capacity: one gesture per knob instead of up to four, and the fixed push+turn behaviours (Fuel Service's clockwise fill-full) have no knob equivalent. The website says so on the dials feature page.

## Out of scope

- **Ulanzi dials.** Its manifest stays `["Keypad"]`; `dialCanvas()` returns `null` there.
- **Per-device knob sizes.** One `stream-dock-knob` profile at 176×112. A knob without a screen is expected to ignore the image.
- **Recovering long-press or push+turn on Mirabox.** The host sends nothing that distinguishes them; a mid-hold timer that decides is forbidden by the encoders rule.
- **Moving the dial primitives into a sim-neutral package.** Guarded so it stays a mechanical move; done when a second action package exists.

## Documentation

- `.claude/rules/encoders-and-touchscreen.md`: the current-state bullets, rules 1, 2, 5, 7 and 8 and the Mirabox hardware facts rewritten around the seam, the per-device renderers and the observed gesture set.
- `docs/reference/stream-deck-plus-encoders.md` §8: the verdict table and checklist results replaced by the observed table above.
- `.claude/rules/platform-feature-flags.md`, `packages/iracing-plugin-mirabox/CLAUDE.md`, `packages/deck-core/CLAUDE.md`, the `iracedeck-actions` skill and `docs/reference/actions.json` for the flag rename and the Knob declarations.
- Website: the dials feature page (Mirabox support and its gesture limits), the sixteen action pages, the Architecture page (the seam), and one changelog **Features** line.

## Testing

**Suite.**

- Elgato adapter: `dialCanvas()` is the strip profile on an Encoder context and `null` on a key; `setDialCanvas` sends `setFeedback` with the `box` key.
- Mirabox adapter: `dialCanvas()` is the knob profile on a Knob context and `null` on Keypad and Information; `setDialCanvas` rasterizes at 176×112 and sends `setImage`.
- Rasterizer and `toDeviceImage`: a non-square target produces an image of that size; square calls are unchanged.
- `renderStripBox` output is byte-identical to today's `renderDialBox` at 200×100 for the existing fixtures, so no Stream Deck+ drawing moves.
- Each surface renders through the right renderer for each profile and pushes nothing when `dialCanvas()` is `null`; flag-off tests assert no touch handling, no trigger description and no hold preview while rendering continues. Setup Engine and Setup Hybrid gain the flag-off tests they lack today.
- A lone `dialDown` followed by a short press classifies that press as short and fires only it.
- The manifest parity test and the sim-import guard above.

**Manual.**

- The maintainer, on a Stream Deck+: every dial surface draws on the strip exactly as before; touch, long-press, push+turn, trigger descriptions and the hold preview all still work.
- The maintainer, on his Mirabox knob device: all sixteen actions can be placed on a knob; each knob screen shows its live knob drawing; rotate and press work; a hold and a push+turn fire nothing and leave nothing on the screen; the dial PI shows only the Press gesture slot.
