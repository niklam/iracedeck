---
paths:
  - packages/website/src/content/docs/docs/actions/**
---
# Website Action Documentation

## Canonical Example

See `packages/website/src/content/docs/docs/actions/pit-service/tire-service.md` as the reference template.

## Page Structure

```markdown
---
title: Action Name
description: One-line description.
sidebar:
  badge:
    text: "N modes"
    variant: tip
---

Introduction paragraph.

## Modes

Select the mode from the **Action** dropdown in the Property Inspector.

### Mode Name

Description of what this mode does.

#### Details

- **Method:** `iRacing API`, `Key binding`, or `Chat command`
- **Dial:** Describe rotation behavior, or `No rotation support`
- **Default binding:** `` `Key` ``, or `No default key binding`, or `No keyboard binding`
- **Telemetry-aware icon:** `Yes` (with a brief note on what updates), or `No`

#### Settings

- No additional settings

---

### Mode With Settings

Description of what this mode does.

#### Details

- **Method:** `iRacing API`, `Key binding`, or `Chat command`
- **Dial:** Describe rotation behavior, or `No rotation support`
- **Default binding:** `` `Key` ``, or `No default key binding`, or `No keyboard binding`
- **Telemetry-aware icon:** `Yes` (with a brief note on what updates), or `No`

#### Setting: Setting Name

Description including default value. Options as bullet list if applicable.

#### Setting: Another Setting

Description including default value.
```

## Rules

### Mode sections

- Each mode gets its own `###` subheader under `## Modes`
- Modes are separated by horizontal rules (`---`), no trailing rule after the last mode
- Each mode is self-contained — all its settings, dial behavior, and explanation are within the mode section
- Repetition across modes is acceptable; clarity over brevity

### Per-mode Details block

Each mode section must include a `#### Details` subheader containing a bullet list with the following items, in order:

1. **Method:** how the mode talks to iRacing — one of (issue #612):
   - `iRacing API` — sends an iRacing SDK/broadcast command (`getCommands().*`). Most reliable, no binding needed.
   - `Key binding` — triggers a configurable key binding (keyboard OR SimHub role) via `tapBinding`/`holdBinding`. Requires the binding to be set.
   - `Chat command` — types an iRacing chat/text command, e.g. a `#…` pit macro, via `getCommands().chat.sendMessage(...)`.
2. **Dial:** rotation behavior, or `No rotation support`
3. **Default binding:** one of:
   - `` `Key` `` — action ships with a default keyboard binding (e.g., `` `F1` ``, `` `Ctrl+Shift+R` ``)
   - `No default key binding` — action uses a configurable keyboard shortcut but ships without a default; user must set both the iRacing binding and the action binding
   - `No keyboard binding` — mode does not use the keyboard at all (typically SDK or chat). Use this for `iRacing API` and `Chat command` modes.
4. **Telemetry-aware icon:** `Yes` (followed by a short note on what the icon reflects — e.g., "shows the currently selected pit service compound") or `No`. A mode is telemetry-aware when its icon re-renders in response to live `TelemetryData` updates; a mode that only renders a static icon on settings change is `No`.

Trailing periods are omitted from each Details bullet value (the bullet list is terse metadata, not prose).

The Details block is mode-specific: within a single action, different modes may use SDK for some behaviors, key bindings for others, and chat for others. Document each mode as it actually behaves in code. **The per-mode `Method` is sourced from the generated `packages/iracing-actions/src/actions/data/action-comms.json`** (authored in `comms-catalog.ts`): `"api"` → `iRacing API`, `"keybind"` → `Key binding`, `"chat"` → `Chat command`. The dispatch in `packages/iracing-actions/src/actions/<action>/<action>.ts` (`getCommands().*` vs `tapBinding`/`holdBinding` vs `chat.sendMessage("#…")`, and whether the icon path reads `TelemetryData`) is the underlying source of truth; `packages/iracing-actions/src/actions/<action>/<action>.ejs` (the `default` attribute on `ird-key-binding`) and `packages/iracing-actions/src/actions/data/key-bindings.json` are the source of truth for default keys.

### Settings block

- For modes without settings, add `#### Settings` followed by a single bullet: `- No additional settings`
- For modes with settings, omit the `#### Settings` wrapper and use `#### Setting: <name>` subheaders directly under the Details block.

### Setting subheaders

- Use `####` (h4) with prefix: `#### Setting: Setting Name`
- Include the default value in the description text (not in a table)
- List options as bullet points with bold option names: `- **Option** — description`
- Use `:::tip` blocks for recommendations

### What NOT to include

- No settings summary tables (Type/Default columns add no value)
- No separate "Dial Support" / "Encoder Support" top-level section (documented per mode)
- No "Properties" table (Action ID, SDK support, etc. — that belongs in internal docs)
