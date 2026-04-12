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

**Encoder:** Describe rotation behavior, or "No rotation support."

**Settings:** No additional settings.

---

### Mode With Settings

Description of what this mode does.

**Encoder:** Describe rotation behavior, or "No rotation support."

##### Setting: Setting Name

Description including default value. Options as bullet list if applicable.

##### Setting: Another Setting

Description including default value.
```

## Rules

### Mode sections

- Each mode gets its own `###` subheader under `## Modes`
- Modes are separated by horizontal rules (`---`), no trailing rule after the last mode
- Each mode is self-contained — all its settings, encoder behavior, and explanation are within the mode section
- Repetition across modes is acceptable; clarity over brevity

### Encoder and Settings lines

- **Encoder** comes before **Settings** within each mode
- Both use bold labels: `**Encoder:**` and `**Settings:**`
- Separate them with a blank line so they render on different lines
- For modes without settings: `**Settings:** No additional settings.`
- For modes with settings: omit the **Settings** line and use `##### Setting:` subheaders instead

### Setting subheaders

- Use `#####` (h5) with prefix: `##### Setting: Setting Name`
- Include the default value in the description text (not in a table)
- List options as bullet points with bold option names: `- **Option** — description`
- Use `:::tip` blocks for recommendations

### What NOT to include

- No settings summary tables (Type/Default columns add no value)
- No separate "Encoder Support" top-level section (documented per mode)
- No "Properties" table (Action ID, SDK support, etc. — that belongs in internal docs)
