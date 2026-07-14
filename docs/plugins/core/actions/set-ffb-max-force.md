# Set FFB Max Force

> **Consolidated in #827:** this Cockpit Misc mode is a hidden legacy alias of the Force Feedback action's **FFB Force (max force)** mode. Existing buttons keep working (same bindings, now the same icons); new buttons should use Force Feedback. The mode no longer appears in the Cockpit Misc PI dropdown.

Adjusts iRacing's force feedback "max force" setting (Nm) via a configurable key binding. Kept only so buttons configured before #827 keep working.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.cockpit-misc` (mode `ffb-max-force`) |
| Type | +/- |
| SDK Support | No |
| Dial Support | No |
| Communication Method | Key binding |

## Legacy alias contract

- The mode value `ffb-max-force` stays in the Cockpit Misc settings schema and key handler, but its `<option>` is hidden in the Property Inspector (precedent: Pit Crew `radar-volume` after #590, Chat `respond-pm`).
- It fires the same global key bindings as Force Feedback's `ffb-force` mode — `cockpitMiscFfbForceIncrease` / `cockpitMiscFfbForceDecrease` — so configuring the binding in either PI updates both.
- It renders Force Feedback's `ffb-force-increase` / `ffb-force-decrease` icons, so legacy buttons look identical to their Force Feedback replacements.

## Keyboard Simulation Table

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Increase | *(none)* | Max force increase |
| Decrease | *(none)* | Max force decrease |

## Icon States

| Mode/State | Icon |
|------------|------|
| Increase | Force Feedback steering wheel with Nm weight and INCREASE title |
| Decrease | Force Feedback steering wheel with Nm weight and DECREASE title |

## Notes

- For new buttons, use **Force Feedback → FFB Force (max force)** — see `force-feedback.md`.
- Higher values = stronger feedback but possible clipping; lower values = weaker feedback but more detail.
