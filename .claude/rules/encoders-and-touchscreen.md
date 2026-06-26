# Encoders (Dials) & Touchscreen

How Stream Deck+ dials and the LCD touch strip work, what Mirabox knobs actually support, and the rules for dial-support actions. Full payload/schema tables and sources live in `docs/reference/stream-deck-plus-encoders.md`.

## Current state (rebuild begun, #681)

The dial-support rebuild (planned in #640) **has begun**. `fuel-dial` is the first and reference consumer:

- **Elgato** declares `"Controllers": ["Keypad", "Encoder"]` with an `Encoder` block whose `layout` points at a committed custom touch layout (`layouts/fuel-dial.json`) and a `TriggerDescription` for Rotate/Push/Touch.
- **Mirabox** declares `"Controllers": ["Keypad", "Knob"]` with **no** `Encoder`/`Knob` config block and **no** touch strip (per the Mirabox findings below).

There is no longer a blanket prohibition on dial manifests — **follow the rules below and use `fuel-dial` as the reference** when adding a dial-capable action. The "Encoder Support" section in `.claude/rules/stream-deck-actions.md` points here for the per-action mechanics.

### Infrastructure now built

Plumbing that exists today (verify against the code before relying on a detail):

- **deck-core** (`packages/deck-core/src/types.ts`): `IDeckActionContext` gained `isDial()`, `setFeedback(feedback)`, and `setFeedbackLayout(layout)`; the new `IDeckTouchTapEvent<T>` (`tapPos`, `hold`) and the `onTouchTap` handler on `IDeckActionHandler`. The touch-strip feedback payload model is `DeckFeedbackPayload` in `packages/deck-core/src/feedback-types.ts` (keyed by layout item `key`; each value a primitive shorthand or a partial item override — `DeckFeedbackBarItem` / `DeckFeedbackTextItem` / `DeckFeedbackPixmapItem`).
- **deck-adapter-elgato** (`src/adapter.ts`): `ElgatoActionContext` bridges `isDial`/`setFeedback`/`setFeedbackLayout` to the SDK `DialAction`, and the bridge action delegates `onTouchTap` (via `wrapTouchTapEvent`) plus `onDialRotate`/`onDialDown`/`onDialUp`.
- **deck-adapter-mirabox** (`src/adapter.ts`): `isDial()` returns true for `Knob`/`Encoder` contexts; `setFeedback`/`setFeedbackLayout` are **no-ops** (the protocol has no plugin touch strip), and there is no touch-tap input.

### Press vs long-press: release-time classification (no timer)

Dial press, long-press, and push+turn are **all cross-platform** and are decided at `dialUp`, not by a mid-hold timer. `onDialDown` records the press start and clears a `rotatedWhilePressed` guard; `onDialUp` calls `classifyDialRelease({ pressStartMs, nowMs, rotatedWhilePressed, thresholdMs })`, which returns `"push-turn"` (a rotation happened while held → fire nothing on release), `"long"` (held ≥ the threshold), or `"short"`. Pass the plugin-wide **Long-press threshold** global setting as `thresholdMs` via `getDualPressThresholdMs()` (shared with the dual-press feature, default 500 ms, range 200–2000); `classifyDialRelease` falls back to `DIAL_LONG_PRESS_THRESHOLD_MS` (500 ms) when no `thresholdMs` is given. There is **no `setTimeout`**, and there is **no `__FEATURE_DIAL_LONG_PRESS__` fast-path** — that flag has been removed. A knob that reports `dialUp` instantly simply degrades a hold to a short press; the model needs no per-platform branch. `classifyDialRelease` and `DIAL_LONG_PRESS_THRESHOLD_MS` live in `packages/deck-core/src/dial-gesture.ts`; `fuel-dial.ts` is the reference consumer.

### Where dial gating lives

**Touch-strip BEHAVIORAL gating lives in the ACTION**, branching on the single compile-time constant `__FEATURE_DIAL_FEEDBACK__` (Elgato-true / Mirabox-/Ulanzi-false). This is the **documented exception** to "gate in shared utilities, not actions" in `.claude/rules/platform-feature-flags.md` — that rule is about SVG-_rendering_ gating (which belongs in `icon-composer`/`deck-core`); per-platform dial _behavior_ (Mirabox/Ulanzi have no plugin touch strip, so feedback/touch-tap must be skipped) is action logic and is gated in the action itself. `fuel-dial.ts` is the reference (e.g. `if (!__FEATURE_DIAL_FEEDBACK__) return;` in `onTouchTap` and the feedback path). Dial rotation, press, long-press, and push+turn are **not** gated — they work on every platform via the release-time classifier above.

For the bundled `@iracedeck/iracing-actions` sources to resolve that constant, each plugin carries its own `src/platform-features.d.ts` (mirroring `src/svg.d.ts`), so the constant is visible in the plugin's TypeScript program. See `.claude/rules/platform-feature-flags.md` for the flag mechanics.

## Hardware & platform facts (the load-bearing ones)

- Stream Deck+ = 8 LCD keys, 4 push-rotate dials, one 800×100 touch strip; **each encoder action owns a 200×100 slot** of the strip. Strip swipe is consumed by the Stream Deck app (page switching) and never reaches plugins.
- Elgato events: `dialRotate` (`ticks` signed, coalesces — |ticks| > 1 on fast spins; `pressed` flag for rotate-while-held), `dialDown`/`dialUp`, `touchTap` (`tapPos` relative to the 200×100 slot; `hold: true` = long touch). There is **no native dial long-press event** — classify it at `dialUp` (a duration comparison, see "Press vs long-press" above), not by counting a mid-hold timer.
- Elgato feedback: manifest `Encoder` block (`layout` `$X1`/`$A0`/`$A1`/`$B1`/`$B2`/`$C1` or custom JSON, `TriggerDescription` Rotate/Push/Touch/LongTouch, `Icon`, `background`, `StackColor`); runtime `setFeedback`/`setFeedbackLayout`. For dials, `setTitle` updates the layout `title` item and `setImage` only sets the app-UI dial canvas — strip imagery goes through layout `pixmap` items. **Throttle feedback to ≤ 10 calls/second per dial.**
- Mirabox (VSD Craft / Stream Dock protocol): manifest uses `"Knob"` (not `"Encoder"`); knob **rotation and press reach plugins** (`dialRotate` with `ticks`, `dialDown` **and** `dialUp` — same event names as Elgato; a real `dialUp` is wired in the StreamDock C++ SDK as `kESDSDKEventDialUp` and in the Qt SDK, and the Mirabox adapter delivers it). The **only** Mirabox gap is the touch strip: **no plugin-facing touchscreen or feedback API exists** (`setFeedback`/`setFeedbackLayout`/layouts are not in the protocol — update knob icons via `setImage`), so Tap Display / Long Touch gestures and bar feedback have nowhere to land. Press, long-press, and rotate-while-pressed are part of the common denominator (long-press is classified at `dialUp` per the model above; one third-party report of `dialUp` arriving instantly on N4-class hardware would only degrade a hold to a short press, never break it). Knob events are not yet verified through our adapter on a real knob device — the hardware-test checklist is in the reference page §8.

## Rules for dial actions

1. **Dial behavior lives in shared action code** consuming `IDeck*` events. Press / long-press / push+turn classification is platform-agnostic (release-time `classifyDialRelease`, no timer). The only per-platform _behavioral_ difference is the touch strip, gated in the action via `__FEATURE_DIAL_FEEDBACK__` so the Mirabox/Ulanzi bundles ship none of the touch/feedback paths (see "Where dial gating lives" above and `fuel-dial.ts`). SVG-_rendering_ gating still belongs in shared `icon-composer`/`deck-core` utilities, not actions.
2. **Press, long-press, and push+turn are cross-platform** — classify them at `dialUp`. `dialRotate.pressed` (rotate-while-held) is delivered on Elgato, Mirabox, **and** Ulanzi (Ulanzi encodes it as the `hold-left`/`hold-right` `rotateEvent`, normalized to `pressed` in `ulanzi-client.ts`). A long-press is a held `dialUp` past the threshold; if a knob ever reported release instantly it would degrade the hold to a short press, not break the action — so a long-press default should still be safe (e.g. blind-safe for VR), never load-bearing for the only way to reach a function.
3. **Scale steps by `ticks`**, never count events; clamp if a single event's magnitude would overshoot.
4. **Touch strip is Elgato-only.** Touch input (`onTouchTap` / `IDeckTouchTapEvent`) and feedback (`setFeedback`/`setFeedbackLayout`) only do anything on Elgato; the Mirabox/Ulanzi adapters no-op feedback and deliver no touch tap. Gate touch/feedback work behind `__FEATURE_DIAL_FEEDBACK__`. Default the touch slots (Tap Display, Long Touch) to **None** so a VR driver who can't see the strip isn't surprised by a tap.
5. **Throttle feedback to ≤ 10 `setFeedback` calls/second per dial.** `fuel-dial` coalesces a continuous spin into a leading/trailing throttled flush so a fast rotation can't exceed the cap.
6. Declaring an action as `["Keypad", "Encoder"]` (Elgato) / `["Keypad", "Knob"]` (Mirabox) means `willAppear` fires for both surfaces — branch on `ev.action.isKey()` / `ev.action.isDial()`, and remember encoder actions cannot join multi-actions.
7. Before relying on any Mirabox knob support on real hardware, run the hardware-test checklist in `docs/reference/stream-deck-plus-encoders.md` §8 on a real N3/N4-class device; the protocol delivers rotation, press, and release, but no commit/test has yet recorded an observed knob event through our adapter.
