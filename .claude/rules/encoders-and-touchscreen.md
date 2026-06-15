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

### Where dial gating lives

**BEHAVIORAL dial gating lives in the ACTION**, branching on the compile-time constants `__FEATURE_DIAL_FEEDBACK__` and `__FEATURE_DIAL_LONG_PRESS__` (both Elgato-true / Mirabox-false). This is the **documented exception** to "gate in shared utilities, not actions" in `.claude/rules/platform-feature-flags.md` — that rule is about SVG-*rendering* gating (which belongs in `icon-composer`/`deck-core`); per-platform dial *behavior* (Mirabox knobs fire `dialUp` immediately so long-press can't work; Mirabox has no touch strip so feedback/touch-tap must be skipped) is action logic and is gated in the action itself. `fuel-dial.ts` is the reference (e.g. `if (!__FEATURE_DIAL_LONG_PRESS__) { …press now… }`, `if (!__FEATURE_DIAL_FEEDBACK__) return;`).

For the bundled `@iracedeck/iracing-actions` sources to resolve those constants, each plugin carries its own `src/platform-features.d.ts` (mirroring `src/svg.d.ts`), so the constants are visible in the plugin's TypeScript program. See `.claude/rules/platform-feature-flags.md` for the flag mechanics.

## Hardware & platform facts (the load-bearing ones)

- Stream Deck+ = 8 LCD keys, 4 push-rotate dials, one 800×100 touch strip; **each encoder action owns a 200×100 slot** of the strip. Strip swipe is consumed by the Stream Deck app (page switching) and never reaches plugins.
- Elgato events: `dialRotate` (`ticks` signed, coalesces — |ticks| > 1 on fast spins; `pressed` flag for rotate-while-held), `dialDown`/`dialUp`, `touchTap` (`tapPos` relative to the 200×100 slot; `hold: true` = long touch). There is **no native dial long-press event** — time `dialDown`→`dialUp` yourself.
- Elgato feedback: manifest `Encoder` block (`layout` `$X1`/`$A0`/`$A1`/`$B1`/`$B2`/`$C1` or custom JSON, `TriggerDescription` Rotate/Push/Touch/LongTouch, `Icon`, `background`, `StackColor`); runtime `setFeedback`/`setFeedbackLayout`. For dials, `setTitle` updates the layout `title` item and `setImage` only sets the app-UI dial canvas — strip imagery goes through layout `pixmap` items. **Throttle feedback to ≤ 10 calls/second per dial.**
- Mirabox (VSD Craft / Stream Dock protocol): manifest uses `"Knob"` (not `"Encoder"`); knob **rotation and press provably reach plugins** (`dialRotate` with `ticks`, `dialDown`/`dialUp` — same event names as Elgato; Mirabox's own knob plugins use them). But: **no plugin-facing touchscreen or feedback API exists** (`setFeedback`/`setFeedbackLayout`/layouts are not in the protocol — update knob icons via `setImage`), and **press-and-hold is unreliable** (`dialUp` reported to fire immediately after `dialDown` on N4-class hardware). Never yet verified through our adapter on a real knob device — the hardware-test checklist is in the reference page §8.

## Rules for dial actions

1. **Dial behavior lives in shared action code** consuming `IDeck*` events. Per-platform *behavioral* differences (long-press, touch, feedback) are gated in the action via `__FEATURE_DIAL_LONG_PRESS__` / `__FEATURE_DIAL_FEEDBACK__` so the Mirabox bundle ships none of the Elgato-only paths (see "Where dial gating lives" above and `fuel-dial.ts`). SVG-*rendering* gating still belongs in shared `icon-composer`/`deck-core` utilities, not actions.
2. **Never design cross-platform dial UX around press-and-hold** — it cannot work on Mirabox knobs (they fire `dialUp` immediately after `dialDown`, so no reliable hold). Tap (press+release) and rotation are the common denominator; rotate-while-pressed is Elgato-only (`dialRotate.pressed`).
3. **Scale steps by `ticks`**, never count events; clamp if a single event's magnitude would overshoot.
4. **Touch is Elgato-only.** Touch input (`onTouchTap` / `IDeckTouchTapEvent`) and feedback (`setFeedback`/`setFeedbackLayout`) only do anything on Elgato; the Mirabox adapter no-ops feedback and delivers no touch tap. Gate touch/feedback work behind `__FEATURE_DIAL_FEEDBACK__`.
5. **Throttle feedback to ≤ 10 `setFeedback` calls/second per dial.** `fuel-dial` coalesces a continuous spin into a leading/trailing throttled flush so a fast rotation can't exceed the cap.
6. Declaring an action as `["Keypad", "Encoder"]` (Elgato) / `["Keypad", "Knob"]` (Mirabox) means `willAppear` fires for both surfaces — branch on `ev.action.isKey()` / `ev.action.isDial()`, and remember encoder actions cannot join multi-actions.
7. Before relying on any Mirabox knob support on real hardware, run the hardware-test checklist in `docs/reference/stream-deck-plus-encoders.md` §8 on a real N3/N4-class device; its outcome (especially the `dialUp` timing question) gates what Mirabox dial UX is possible.
