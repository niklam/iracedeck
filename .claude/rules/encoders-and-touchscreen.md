# Encoders (Dials) & Touchscreen

How Stream Deck+ dials and the LCD touch strip work, what Mirabox knobs actually support, and the rules for the planned dial-support rebuild. Full payload/schema tables and sources live in `docs/reference/stream-deck-plus-encoders.md`.

## Current state (issue #640)

Dial/encoder/knob support was **de-claimed**: no action in either plugin manifest declares `Encoder` (Elgato) or `Knob` (Mirabox), every action is Keypad-only (plus the two Mirabox `Information` actions), and no user-facing copy claims dial support. This was intentionally backwards-incompatible — existing user dial assignments were reset.

What stays, dormant, as the rebuild foundation:

- `onDial*` handlers in `packages/iracing-actions` action code (unreachable while manifests don't route dial events)
- `IDeckDialRotateEvent` / `IDeckDialDownEvent` / `IDeckDialUpEvent` in `deck-core` and the base-action stubs
- Dial event wiring in both adapters (`deck-adapter-elgato`, `deck-adapter-mirabox`)

**Do not add `Encoder`/`Knob` manifest blocks to new actions** until the rebuild lands. The superseded "Encoder Support" section in `.claude/rules/stream-deck-actions.md` points here.

## Hardware & platform facts (the load-bearing ones)

- Stream Deck+ = 8 LCD keys, 4 push-rotate dials, one 800×100 touch strip; **each encoder action owns a 200×100 slot** of the strip. Strip swipe is consumed by the Stream Deck app (page switching) and never reaches plugins.
- Elgato events: `dialRotate` (`ticks` signed, coalesces — |ticks| > 1 on fast spins; `pressed` flag for rotate-while-held), `dialDown`/`dialUp`, `touchTap` (`tapPos` relative to the 200×100 slot; `hold: true` = long touch). There is **no native dial long-press event** — time `dialDown`→`dialUp` yourself.
- Elgato feedback: manifest `Encoder` block (`layout` `$X1`/`$A0`/`$A1`/`$B1`/`$B2`/`$C1` or custom JSON, `TriggerDescription` Rotate/Push/Touch/LongTouch, `Icon`, `background`, `StackColor`); runtime `setFeedback`/`setFeedbackLayout`. For dials, `setTitle` updates the layout `title` item and `setImage` only sets the app-UI dial canvas — strip imagery goes through layout `pixmap` items. **Throttle feedback to ≤ 10 calls/second per dial.**
- Mirabox (VSD Craft / Stream Dock protocol): manifest uses `"Knob"` (not `"Encoder"`); knob **rotation and press provably reach plugins** (`dialRotate` with `ticks`, `dialDown`/`dialUp` — same event names as Elgato; Mirabox's own knob plugins use them). But: **no plugin-facing touchscreen or feedback API exists** (`setFeedback`/`setFeedbackLayout`/layouts are not in the protocol — update knob icons via `setImage`), and **press-and-hold is unreliable** (`dialUp` reported to fire immediately after `dialDown` on N4-class hardware). Never yet verified through our adapter on a real knob device — the hardware-test checklist is in the reference page §8.

## Rules for the rebuild

1. **Dial behavior lives in shared action code** consuming `IDeck*` events — never platform-specific branches in actions. Elgato-only surfaces (touch strip, feedback layouts) must be gated behind platform feature flags (`.claude/rules/platform-feature-flags.md`) so the Mirabox bundle ships none of it.
2. **Never design cross-platform dial UX around press-and-hold** — it cannot work on Mirabox knobs. Tap (press+release) and rotation are the common denominator; rotate-while-pressed is Elgato-only (`dialRotate.pressed`).
3. **Scale steps by `ticks`**, never count events; clamp if a single event's magnitude would overshoot.
4. Touch support requires new plumbing first: an `IDeckTouchTapEvent` type in `deck-core`, a base-action stub, and adapter wiring — none of that exists today. Per #640's Mirabox findings, build it Elgato-only.
5. Declaring an action as `["Keypad", "Encoder"]` means `willAppear` fires for both surfaces — branch on `payload.controller`, and remember encoder actions cannot join multi-actions.
6. Before shipping any Mirabox knob support, run the hardware-test checklist in `docs/reference/stream-deck-plus-encoders.md` §8 on a real N3/N4-class device; its outcome (especially the `dialUp` timing question) gates what Mirabox dial UX is possible.
