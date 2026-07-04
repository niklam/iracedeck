---
paths:
  - docs/plugins/**/actions/**
# Action Documentation Standards

## Document Structure

Action documentation follows this section order:

1. **Title** (H1) - Action name
2. **Description** - One-line description of what the action does
3. **Properties** - Table with Action ID, Type, SDK Support, Dial Support
4. **Behavior** - Button Press and Dial subsections (if applicable)
5. **Settings** - Configuration options table + option lists as bullet points
6. **Keyboard Simulation** - Keys sent and iRacing setting names
7. **Icon States** - Visual states table
8. **Telemetry Integration** - (if applicable)
9. **Notes** - Additional context, limitations, tips

## Properties Table

```markdown
| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.{plugin}.{action-name}` |
| Type | Button / Toggle / +/- / Multi-toggle |
| SDK Support | Yes / No |
| Dial Support | Yes / No |
| Communication Method | iRacing API / Key binding / Chat command |
```

## Communication Method (issue #612)

Every mode talks to iRacing through exactly one of three mechanisms — state it explicitly:

- **iRacing API** — sends an iRacing SDK/broadcast command (`getCommands().*`). Most reliable, needs no binding.
- **Key binding** — triggers a configurable key binding (keyboard OR SimHub role) via `tapBinding`/`holdBinding`. Requires a binding to be set.
- **Chat command** — types an iRacing chat/text command, e.g. a `#…` pit macro, via `getCommands().chat.sendMessage(...)`.

The value is sourced from the generated `packages/iracing-actions/src/actions/data/action-comms.json` (authored in `comms-catalog.ts`): `"api"` → iRacing API, `"keybind"` → Key binding, `"chat"` → Chat command. For a single-behavior doc page use the **Communication Method** row above. For a multi-mode action, state the method **per mode** (a row in the modes table or a line in each mode's section) — an action can mix methods (e.g. Fuel Service: API for every fuel value since #759, Key binding for autofuel/lap-margin; Tire Service: API for clear/compound, Chat for the `#t` tire macros).

## Settings Section

Use a table for settings overview, then **bullet point lists** for options (never inline backtick lists like `` `A` or `B` ``):

```markdown
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Direct | Selection mode |

### Mode Options
- **Direct** - Opens a specific item immediately
- **Next** - Cycles to the next item
- **Previous** - Cycles to the previous item
```

For actions with no settings, use:
```markdown
## Settings

None.
```

## Keyboard Simulation Table

**IMPORTANT**:
- Always use "Default Key" (not just "Key") as the column header
- All key bindings are user-configurable via Property Inspector; defaults are just starting values
- Users may have different iRacing key bindings configured

```markdown
| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Increase | ] | Increase Setting Name |
```

- Use `*(none)*` for actions without a default iRacing keybind (user must configure both iRacing and the action)

## Icon States

- Icons for related actions must be visually distinguishable from similar icons elsewhere
- Use labels/badges (e.g., "BB" for black box) to differentiate action categories
- Describe icons clearly so designers can implement consistently

```markdown
All icons include a small "XX" label to distinguish them from similar icons.

| Mode/State | Icon |
|------------|------|
| Default | Description + label |
```

## Reference Template

See `docs/plugins/core/actions/black-box-selector.md` as the canonical example.
