# Dial screens draw through one funnel in deck-core

> **Issue:** [#1670](https://github.com/niklam/iracedeck/issues/1670) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Every key image passes through `BaseAction`'s one decoration (`decorateKeyImage`, #1599). Dial screens have no such path: each of the 18 dial surfaces calls the context itself. This refactor gives dial screens the same shape, a funnel in `BaseAction` that every dial-screen draw on every host goes through, and a guard that fails on a draw around it. Nothing a user sees changes. #1671 then draws the disconnected look in it.

## What draws a dial screen today

Two context calls reach a dial screen, and 35 call sites make them. Line numbers are at `master` `cee88f778`, before #1599 lands; #1599 shifts some of them but adds or removes none.

**The live canvas**: one `await ctx.action.setDialCanvas(svgToDataUri(...))` per surface, each behind its own `if (!canvas) return`. These are the 18 call sites #1599's spec counted:

| Surface (`packages/iracing-actions/src/actions/…`) | Line |
| --- | --- |
| `audio-controls/audio-dial-surface.ts` | 628 |
| `black-box-selector/black-box-selector-dial-surface.ts` | 390 |
| `camera-controls/camera-dial-surface.ts` | 1762 |
| `camera-editor-adjustments/camera-editor-adjustments-dial-surface.ts` | 599 |
| `cockpit-misc/cockpit-misc-dial-surface.ts` | 510 |
| `force-feedback/force-feedback-dial-surface.ts` | 524 |
| `fuel-service/fuel-dial-surface.ts` | 2322 |
| `replay-control/replay-control-dial-surface.ts` | 1494 |
| `replay-markers/replay-markers-dial-surface.ts` | 646 |
| `setup-aero/setup-aero-dial-surface.ts` | 370 |
| `setup-brakes/setup-brakes-dial-surface.ts` | 570 |
| `setup-chassis/setup-chassis-dial-surface.ts` | 701 |
| `setup-engine/setup-engine-dial-surface.ts` | 370 |
| `setup-fuel/setup-fuel-dial-surface.ts` | 363 |
| `setup-hybrid/setup-hybrid-dial-surface.ts` | 379 |
| `setup-traction/setup-traction-dial-surface.ts` | 573 |
| `splits-delta-cycle/splits-delta-cycle-dial-surface.ts` | 395 |
| `view-adjustment/view-adjustment-dial-surface.ts` | 482 |

**The name card**: `pushDialNameIcon(action, { line1, line2, backgroundColor }, logger)` in each surface's `willAppear`, 17 call sites (every surface above but Audio Controls, which has none): Black Box Selector 239, Camera Controls 1022, Camera Editor Adjustments 396, Cockpit Misc 281, Force Feedback 289, Fuel Service 1045, Replay Control 735, Replay Markers 220, Setup Aero 183, Setup Brakes 249, Setup Chassis 375, Setup Engine 188, Setup Fuel 176, Setup Hybrid 193, Setup Traction 296, Splits & Reference 217, View Adjustment 258. They all end in one `action.setImage(...)` at `shared/dial-name-icon.ts:52`, sent only when `dialCanvas()?.id === "sd-plus-strip"`.

No other non-test source outside `deck-core/src/base-action.ts` and the three adapters calls `setImage`, `setDialCanvas` or `setFeedback`.

The three surfaces the issue names map onto those two calls per host:

| Host | Live canvas (`setDialCanvas`) | Name card (`setImage`) |
| --- | --- | --- |
| Stream Deck + strip (`sd-plus-strip`, 200×100) | the adapter sends `setFeedback({ box })`, rasterised at the slot width | sent: the Stream Deck app's dial tile, not on the device |
| Mirabox knob (`stream-dock-knob`, 176×112) | the adapter sends `setImage`, rasterised at 176×112 — the knob screen | never sent: on a knob `setImage` is the live screen |
| Ulanzi | `dialCanvas()` is `null`; the surfaces draw nothing | never sent |

## Decision

### 1. The funnel: two `BaseAction` members

```typescript
/** Every frame of a dial's own screen. Nothing is sent where the context has no dial canvas. */
protected async setDialImage(action: IDeckActionContext, image: string): Promise<void>;

/** The dial's name card: sent only where it is not the live screen (the Stream Deck + strip). Fire-and-forget. */
protected setDialNameCard(action: IDeckActionContext, image: string): void;
```

- **`setDialImage`** returns without sending when `action.dialCanvas()` is `null`, and otherwise awaits `action.setDialCanvas(image)` with the image unchanged. A rejection propagates, as the surfaces' own `await` does today. It takes a raw SVG or a data URI. The surfaces pass the data URI they build today, so no frame changes.
- **`setDialNameCard`** is `pushDialNameIcon`'s gate, now stated as a hardware fact. It calls `action.setImage(image)` only when `DIAL_NAME_CARD[profile.id]` is `true` for the context's canvas, and sends nothing without a canvas. It logs a rejection at debug on the action's logger (`Dial name card push failed: …`) and never throws.
- **`DIAL_NAME_CARD: Readonly<Record<DialCanvasId, boolean>>`** sits in `deck-core/src/dial-canvas.ts`, beside the profiles: `sd-plus-strip` is `true` (`setImage` sets the app's dial tile, a separate image from the canvas) and `stream-dock-knob` is `false` (`setImage` is the live screen). The fact sits with the profiles that describe the hardware, so a renderer or the funnel never compares a profile id to a literal. Because the record is exhaustive, a new profile fails to compile until it says whether it has a name card. It sends exactly what the `=== "sd-plus-strip"` check sends today. #1671's `DISCONNECTED_BADGE_SCALE` sits beside it.
- **They live beside `decorateKeyImage`.** `BaseAction` holds what #1671 decides on: each context's raw settings (`getContextSettings`) and, through `ConnectionStateAwareAction`, the sim-presence listener. Every one of the 18 owning actions extends it.
- **Two members, not one with a kind.** The name card is a different image sent to a different target. It is a static tile, not a frame, and #1671 leaves it undecorated pending Niklas's answer (#1671's spec). Each member says what it is at the call site.
- **#1670 records nothing.** #1671 adds the record of each live dial's last frame, which it needs to redraw that dial when its look changes. Added here, the record would have no reader.

### 2. Per-host differences stay where they are

The funnel holds one rule that depends on the screen: the name-card gate, read from `DIAL_NAME_CARD` by profile id. Everything else stays where it lives now. The adapters keep the transport: Elgato's `setFeedback({ box })` at the slot width, Mirabox's `setImage` at 176×112, Ulanzi's no-op. The renderers still pick a drawing by `profile.id`, and the surfaces keep their `if (!canvas) return`, because they need the profile to choose a renderer before they have an image. `IDeckActionContext`, `IDeckPlatformAdapter` and `DialCanvasProfile` do not change, so SEAM 2 is untouched. `dial-canvas.ts` gains only the `DIAL_NAME_CARD` record. When Ulanzi dials get a canvas, they draw through the funnel with no change to it.

### 3. How the surfaces reach it, and how they migrate

- **The host carries the funnel.** `DialSurfaceHost` (`shared/dial-surface-base.ts`) gains `setDialImage(action, image): Promise<void>` and `setDialNameCard(action, image): void`. Each surface's own host type overrides the base's `host`, so it must be assignable to `DialSurfaceHost`. A host without the two members therefore fails to compile, on all 18 surfaces.
- **Each owning action wires its host in two lines:** `setDialImage: (action, image) => this.setDialImage(action, image)` and the same for the name card, beside the delegates it already passes (`tapBinding`, `isBindingMissing`).
- **Canvas sites:** `await ctx.action.setDialCanvas(svgToDataUri(x))` becomes `await this.host.setDialImage(ctx.action, svgToDataUri(x))`. Nothing else in the render path moves: not the signature dedupe, not the throttle, not the hold preview.
- **Name-card sites:** `pushDialNameIcon` is deleted. `renderDialNameIcon` stays in `shared/dial-name-icon.ts`, and the 17 calls become `this.host.setDialNameCard(action, renderDialNameIcon({ … }))`.
- **Surface tests** build their hosts with a shared pass-through, `passThroughDialFunnel()` in `shared/dial-funnel.test-support.ts`. It returns the two members, and they forward to the context exactly as the real funnel does (the strip gate included). So every existing assertion on `action.setDialCanvas` and `action.setImage` holds unchanged, and that is the evidence that no frame moved. The real funnel is tested in deck-core (Testing).
- **Commit order:** first the funnel, the host members and the test support; then the surfaces (mechanical, by recipe); then the guard, in the commit that moves the last site, since it fails until that site moves.

### 4. The guard

`scripts/deck-image-funnel.test.mjs` parses every non-test `.ts`, `.mts` and `.mjs` source under `packages/*/src` with TypeScript's parser (`ts.createSourceFile`, syntax only, as `plugin-shell-dependencies.test.mjs` reads imports). `.astro` files are left out: they are the website's components and hold no deck context, and TypeScript's parser cannot read them. It fails, naming file and line, on any use of `setDialCanvas`, `setImage` or `setFeedback` outside the allowed files:

- **What counts as a test file:** the same kinds `eslint.config.js`'s `tests()` names, `<name>.<kind>.<ext>` for every kind (`test`, `test-support`, `test-util`) in every script extension (`ts`, `mts`, `mjs`). A test file may reach the context freely, since it asserts on the mocks. Those two lists are copied, not imported, because the config is not a module the test can load without running ESLint. A copy that drifts would show up as a planted control failing (below).

- **What counts as a use:** a property access by that name, whether called or passed along; an element access with that string literal (`action["setImage"]`); or a destructuring binding of that name (`const { setDialCanvas } = action`).
- **Allowed files:** `packages/deck-core/src/base-action.ts`, which holds the two dial funnels, the key funnel and the flag frames, and `packages/deck-adapter-*/src/**`, which implement those methods and forward to their hosts. A class method that declares one of these names is a declaration, not an access, so a mock adapter is not flagged.
- **Why `setImage` too:** a name-card push is a `setImage`, and on a Mirabox knob `setImage` draws the live screen. A dial surface that reached for it would bypass the funnel exactly as a direct `setDialCanvas` would. That also gives the #1599 key funnel a guard it lacks. No key code moves for it, since the key funnel's only file is already allowed.
- **Positive controls**, in the pattern of `deck-adapter-order-contract.test.mjs`: planted fixture sources in a temporary directory, one per bypass shape (a call, a reference passed along, an element access, a destructuring), each reported exactly once. The same shapes at an allowed path are not reported, and neither are they in a planted `.test-support.ts`, `.test-util.mts` or `.test.mjs` file, one per kind and one per extension, which pins the test-file boundary. A planted `.support.ts` file that is not a test kind is reported, so the exemption is no wider than `tests()`. The real tree must yield at least one allowed use in `base-action.ts`, so a scanner that reads nothing fails.

## Alternatives rejected

- **Draw in the adapters' `setDialCanvas`.** An adapter knows neither a context's settings nor the sim's presence, so #1671's decision cannot be made there without putting sim state into the deck seam. It would also be three copies of the decision.
- **Draw in `renderDialBox`.** Four surfaces draw for themselves (Fuel Service, Audio Controls, Camera Controls, Black Box Selector) and never pass through it. It is also action code with no per-context state, and it cannot redraw a frame when only the look changed.
- **Wrap the context the action hands its surface** (a context whose `setDialCanvas` goes through the funnel). The surfaces would not change, but every routing site in 18 actions, one per handler, would have to wrap. A raw `ev.action` handed on anywhere would bypass the funnel with nothing in the types to say so. Putting the funnel on the host makes it a typed member of every surface.
- **A method on `DialSurfaceBase` that calls the context.** That base lives in `iracing-actions` and has no access to `BaseAction`'s per-context settings or the presence listener.
- **A free deck-core function.** It would need, as parameters, the per-context state that `BaseAction` already owns.
- **The guard as an ESLint `no-restricted-syntax` rule.** The `packages/*/src` block in `eslint.config.js` already owns that rule's options (#1376's cast selectors and #1208's), and a later flat-config block replaces a rule's options rather than merging them. So a new block would silently drop those selectors, and merging into the existing block would tie two unrelated guards together. A syntax-tree test also catches the element-access and destructuring shapes directly.
- **Keep the `=== "sd-plus-strip"` comparison.** It states a hardware fact as a literal in the funnel, and a new profile would silently get no name card.
- **A field on `DialCanvasProfile`** (for example, `hasNameCard`). It would widen a type every adapter returns, for a fact only the funnel reads. The exhaustive record beside the profiles gives the same compile-time completeness without touching the type.

## Out of scope

- Any visible change. The disconnected look and the record of each dial's last frame are #1671.
- Throttling. It stays in the surfaces (rule 6 of `encoders-and-touchscreen.md`); the funnel sends what it is given, when it is given.
- Ulanzi dial screens: `dialCanvas()` stays `null` (#1013).
- Audio Controls' missing name card: it has none today and gets none.
- `setFeedbackLayout`, `setTriggerDescription` and `setTitle`, which draw no image.
- The flag overlay on dials, which stays key-only.

## Docs

- `packages/deck-core/CLAUDE.md`: the `BaseAction` bullet names the dial funnel beside the key funnel, and the `dial-canvas.ts` bullet names `DIAL_NAME_CARD`.
- `.claude/rules/encoders-and-touchscreen.md`:
  - the dial-canvas seam bullet and rule 5: draw through the host's `setDialImage` / `setDialNameCard`, never through the context;
  - the `pushDialNameIcon` sentence is replaced;
  - the guard is named.
- `.claude/rules/stream-deck-actions.md`, *Encoder (Dial) & Touchscreen Support*: the `ev.action.setDialCanvas(...)` snippet and the `pushDialNameIcon` line.
- `.claude/rules/platform-feature-flags.md:76`: "draws through `dialCanvas()` / `setDialCanvas()`" names the funnel.
- `packages/iracing-actions/CLAUDE.md:92` (`dial-name-icon.ts`).
- Architecture page, the *Device differences leak around the adapter* paragraph: every dial frame passes through `BaseAction`'s dial funnel on its way to `setDialCanvas`. The diagrams do not change, since no package or seam interface does.

## Testing

**Unit (Vitest):**

- **`base-action.test.ts`:**
  - `setDialImage` sends the image unchanged, on both profiles;
  - it sends nothing for a `null` canvas (a key, an Information context, Ulanzi);
  - a rejection from `setDialCanvas` reaches the caller;
  - `setDialNameCard` sends on the strip profile only, never on the knob profile or with no canvas;
  - `DIAL_NAME_CARD` holds `true` for `sd-plus-strip` and `false` for `stream-dock-knob` (the exhaustive `Record` type covers any new profile at compile time);
  - its rejection is logged at debug and never thrown.
- **Every surface's existing test file** passes unchanged apart from building its host through `passThroughDialFunnel()`. The byte-pinned fixtures (`dial-strip-box.test.ts`, `dial-box-baseline.test.ts`) are untouched.
- **The guard** and its positive controls (§4).

**Manual regression (Niklas, on hardware):**

1. **Stream Deck +:** place all 18 dial actions, four at a time. For each:
   - the strip slot draws as before;
   - a turn updates it;
   - the 17 name cards show in the Stream Deck app (Audio Controls shows none, as before).
   Also hold Fuel Service's dial past the threshold: the hold preview draws and reverts.
2. **Mirabox:** place all 18 dial actions on knobs. For each:
   - the knob screen draws and updates on a turn and a press;
   - no name card flashes on the screen when the dial appears.
3. With debug logging on, no new warn or error lines appear in either host's log.

Ulanzi declares no dials, so it has nothing to check.

**Review level:** `high`. This is ordinary domain code across deck-core and the dial surfaces, and it changes no published contract (the context, the adapter interface and the profiles stay as they are). The diff has none of the second read's three kinds (no runtime gate, release path or state machine; the guard is a test). The issue lead confirms that against the `second-read` skill's list.
