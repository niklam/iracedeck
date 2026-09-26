# Dials on Mirabox knobs, with a live knob screen

> **Issue:** [#1013](https://github.com/niklam/iracedeck/issues/1013) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

#786 withdrew the `"Knob"` controller from every Mirabox manifest entry because no knob event had ever been observed through our adapter. The dial set has since grown from three actions to sixteen on Elgato, and none of them can be placed on a Mirabox knob.

The hardware gap is now closed. The #1013 reporter tested Fuel Service on a Soomfon CN003, an N4-class clone speaking the same VSD Craft protocol, and observed:

| Check (reference page §8 checklist) | Observed on the CN003 |
| --- | --- |
| A `"Knob"` action with no config block can be placed on a knob slot | Yes |
| `willAppear` carries `payload.controller: "Knob"` | Yes |
| `dialRotate` arrives and drives the action | Yes |
| `setImage` on a Knob context renders to the LCD segment above the knob | Yes |
| A short press fires the press gesture | Yes |
| A 2 s hold classifies as long | **No** — every release classifies as short |
| `dialRotate.pressed` is true while turning a held knob | **No** — always `false` |

We measure the hold ourselves: the surface stamps `Date.now()` on `dialDown`, and `classifyDialRelease` compares it with `Date.now()` on `dialUp`. A 2 s hold measuring short therefore means the host delivers the two events close together rather than a hold apart. Either both arrive at press or both at release; the report does not say which. Either way, no rotation lands between them, so the `rotatedWhilePressed` guard never sees push+turn either.

So the input path works, long-press and push+turn cannot be reached on this device, and the knob screen is reachable only through `setImage`.

Restoring the manifest alone would leave every Mirabox knob showing the static 72×72 name card forever, because every surface draws its live readout through `setFeedback`, which the Mirabox adapter no-ops. The maintainer chose to ship the live knob screen in the same change.

## What the code looks like today

- **All sixteen surfaces already push the same thing.** Each ends its render path in `setFeedback({ box: svgToDataUri(svg) })`, one full-canvas pixmap keyed `box`, 200×100. Every Elgato layout under `layouts/` is that one item. Thirteen surfaces build the SVG through `renderDialBox` in `shared/dial-box.ts`, which takes `width`/`height` as arguments; Fuel Service, Audio Controls and Camera Controls draw their own SVG with 200×100 geometry written in.
- **`__FEATURE_DIAL_FEEDBACK__` gates four things at once:** the `touchTap` handler, the #1120 hold preview, `setTriggerDescription`, and the render itself. The same `dialFeedback` key in each plugin's `platform-features.json` also hides the Tap Display / Long Touch settings in the PI templates.
- **The Mirabox adapter has no image size per controller.** `setImage` rasterizes every context to the flat square `DEFAULT_KEY_IMAGE_SIZE` (144). The N4 knob screen is 176×112 (Device SDK `_2rdScreen*`, reference page §1).

## Approaches weighed

- **Translate `setFeedback` into `setImage` inside the Mirabox adapter.** No surface changes. Rejected: the surfaces keep drawing 200×100, which letterboxes into 176×112 and shrinks every glyph by about 12 %, and the adapter would have to know the Elgato layout's `box` key.
- **Branch on the platform in every surface.** Rejected: sixteen copies of one routing decision.
- **A dial-canvas seam in deck-core (chosen).** The context says what screen it has and takes one image for it; each adapter owns the routing; each surface renders at the native size.

## Design

### The seam

`IDeckActionContext` gains two members:

```typescript
/** Native size of this dial's own screen, or null when it has none (a key, or a host with no dial screen). */
dialCanvas(): { width: number; height: number } | null;

/** Push one full-canvas image to this dial's screen. A no-op when dialCanvas() is null. */
setDialCanvas(dataUri: string): Promise<void>;
```

| Adapter and context | `dialCanvas()` | `setDialCanvas()` |
| --- | --- | --- |
| Elgato, Encoder | 200×100 | `setFeedback({ [DIAL_CANVAS_KEY]: dataUri })` |
| Mirabox, Knob | 176×112 | `setImage`, rasterized at 176×112 |
| Ulanzi, any context | `null` | no-op |
| Any adapter, key or Information context | `null` | no-op |

`DIAL_CANVAS_KEY = "box"` becomes a deck-core constant, since all sixteen Elgato layouts already use it. `toDeviceImage` and the rasterizer take a width and a height instead of one square size, so a non-square target is possible; a square call keeps its current behaviour.

On a Mirabox knob, `setImage` and `setDialCanvas` address the same pixels. Both go through `toDeviceImage`'s existing per-context latest-wins supersede, so the name card a surface pushes in `willAppear` is simply replaced by the first live frame. On Elgato, `setImage` on a dial stays the app-UI canvas, unchanged.

The member pair changes `IDeckActionContext`, a published contract (review row: xhigh). The Architecture page's seam description is updated in the same change.

### Surfaces

- All sixteen replace `setFeedback({ box })` with `setDialCanvas(svg)`, rendering at `dialCanvas()`'s size. The thirteen `renderDialBox` callers pass that size through instead of the literal 200×100. Fuel Service, Audio Controls and Camera Controls derive their geometry from the canvas size.
- A surface renders only when `dialCanvas()` is non-null. Display is therefore a **runtime** property of the context, not a compile-time one.
- The #1120 hold preview is gated on the same runtime test, so it works on any knob that reports real release timing (a genuine N4 may; the CN003 does not, and there the preview is armed and disarmed back to back without drawing).
- The existing per-surface ≤ 10 renders/s throttles apply unchanged.

### The feature flag narrows and is renamed

`__FEATURE_DIAL_FEEDBACK__` / `dialFeedback` keeps gating only what is truly Elgato-only: touch input (`touchTap`, Tap Display / Long Touch in the PI) and `setTriggerDescription`. It is renamed `__FEATURE_DIAL_TOUCH__` / `dialTouch`, because once Mirabox draws live values the word "feedback" would describe something every platform has. Values are unchanged: true on Elgato, false on Mirabox and Ulanzi.

### Manifest and PI

- The Mirabox manifest declares `"Controllers": ["Keypad", "Knob"]` on all sixteen dial actions, with no `Knob` config block (the #722 finding, confirmed on the CN003).
- A test asserts that the set of Elgato actions declaring `"Encoder"` equals the set of Mirabox actions declaring `"Knob"`, so a new dial surface cannot silently stay Elgato-only on Mirabox.
- Every PI that switches between keypad and dial views on `actionInfo.payload.controller` treats `"Knob"` as a dial, as it does `"Encoder"`.

### Gestures on a knob without release timing

No function is lost. Every gesture assignable to a touch slot is equally assignable to Press and Long-press, and the existing rule that a long-press default is never load-bearing already covers a knob that reports no hold. On the CN003 the reachable set is rotate and press; the docs say so plainly rather than claiming long-press and push+turn are cross-platform everywhere.

## Out of scope

- **Ulanzi dials.** Its manifest stays `["Keypad"]`; no hardware has been tested, and Ulanzi `add` frames carry no controller hint. `dialCanvas()` returns `null` there.
- **Per-device knob sizes.** One 176×112 for every Mirabox knob. An N3 knob has no screen, and the host is expected to ignore the image; if it does not, that is a follow-up.
- **The N4 secondary-screen touch.** Host-managed, not reachable over the plugin WebSocket (reference page §8).
- **Recovering long-press or push+turn on hardware that sends no release timing.** A mid-hold timer that decides is forbidden by the encoders rule; nothing here changes that.

## Documentation

- `.claude/rules/encoders-and-touchscreen.md`: the current-state bullets, rule 2, rule 5, rule 7 and rule 8, and the Mirabox paragraph under the hardware facts, rewritten around the seam and the CN003 findings.
- `docs/reference/stream-deck-plus-encoders.md` §8: the "unknown — needs hardware test" row and the checklist results recorded as observed on the CN003.
- `.claude/rules/platform-feature-flags.md`, `packages/iracing-plugin-mirabox/CLAUDE.md`, `packages/deck-core/CLAUDE.md`, the `iracedeck-actions` skill and `docs/reference/actions.json` for the flag rename and the Knob declarations.
- Website: the dials feature page, the sixteen action pages, the Architecture page, and one changelog **Features** line.

## Testing

**Suite.**

- Elgato adapter: `dialCanvas()` is 200×100 on an Encoder context and `null` on a key; `setDialCanvas` sends `setFeedback` with the `box` key.
- Mirabox adapter: `dialCanvas()` is 176×112 on a Knob context and `null` on Keypad and Information; `setDialCanvas` rasterizes at 176×112 and sends `setImage`; a later name-card `setImage` and a later canvas supersede each other in call order.
- Rasterizer and `toDeviceImage`: a non-square target produces an image of that size; square calls are unchanged.
- Each surface renders at both canvas sizes and pushes nothing when `dialCanvas()` is `null`. The flag-off tests move to the renamed flag and assert touch and trigger descriptions stay off while rendering continues; Setup Engine and Setup Hybrid gain the flag-off tests they lack today.
- The manifest parity test above.

**Manual.**

- The maintainer, on a Stream Deck+: every dial surface draws on the strip exactly as before, touch gestures and trigger descriptions still work, and the hold preview still appears.
- The #1013 reporter, on the CN003: the sixteen actions can be placed on knobs, each knob screen shows the live readout at 176×112, and three hardware questions get answers — whether VSD scales, crops or rejects a 176×112 image, whether the knob screen has an update-rate limit below 10 per second, and whether `dialDown` and `dialUp` both arrive at press or both at release (the debug log's timestamps on a 2 s hold settle it, and the docs record which).
