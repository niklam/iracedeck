---
title: Telemetry Display
description: Display any telemetry or session variable using a custom Mustache template.
sidebar:
  badge:
    text: "1 mode"
    variant: tip
---

Telemetry Display is a flexible, template-driven button that can show any iRacing telemetry or session variable. Instead of a fixed mode enum, you write a Mustache template in the Property Inspector and the button renders whatever the template resolves to. Telemetry Display is purely a display action — pressing the button does nothing.

See the [Template Variables](/docs/features/template-variables/) reference for the full list of available variables.

## Modes

This action has a single mode — there is no Mode dropdown in the Property Inspector.

### Template Display

Render a Mustache template using live iRacing telemetry and session data. The button re-renders whenever the referenced variables change.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the rendered value updates whenever any telemetry or session variable referenced in the template changes

#### Setting: Title

The title text shown above the rendered value. Supports Mustache templating, so you can drive it from telemetry too. Defaults to `I AM`.

#### Setting: Template

The Mustache template used to render the value. Defaults to `#{{self.car_number}}\n{{self.first_name}}` — this renders your car number and first name, e.g., `#42` / `John`.

Multi-line output is supported — newlines in the rendered output stack vertically on the button.

#### Setting: Font Size

The font size for the rendered value. Defaults to `15`. Adjust to fit more text on the button or to make small values easier to read at a glance.
