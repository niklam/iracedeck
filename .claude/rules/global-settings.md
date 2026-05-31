---
# Global Settings

## Overview

Global settings are plugin-level settings shared across all action instances. Use them for:
- Key bindings that should be consistent across actions (keyboard or SimHub)
- User preferences that apply to all actions
- SimHub connection configuration (host/port)

## When to Use Global vs Action Settings

| Setting Type | Storage | Use Case |
|-------------|---------|----------|
| **Global** | Plugin-level | Key bindings, SimHub config, user preferences |
| **Action** | Per-instance | Mode selection, action-specific options |

## Binding Types

Global settings support two binding types via a discriminated union:

```typescript
// Keyboard binding (type defaults to "keyboard" for backward compatibility)
type KeyBindingValue = {
  type: "keyboard";
  key: string;
  modifiers: string[];
  code?: string;
  displayKey?: string;
};

// SimHub Control Mapper role binding
type SimHubBindingValue = {
  type: "simhub";
  role: string;
};

// Union type
type BindingValue = KeyBindingValue | SimHubBindingValue;

// Type guard
isSimHubBinding(value: BindingValue | null | undefined): value is SimHubBindingValue
```

## Property Inspector Usage

### Global Key Binding Input

Use the `global` attribute on `ird-key-binding`. Users can switch between Keyboard
and SimHub modes via a dropdown on each binding:

```html
<sdpi-item label="Lap Timing Key">
  <ird-key-binding setting="blackBoxLapTiming" default="F1" global></ird-key-binding>
</sdpi-item>
```

### Using the Global Key Bindings Partial

For multiple key bindings, use the template partial:

```ejs
<%- include('global-key-bindings', {
  keyBindings: require('./data/key-bindings.json').blackBox
}) %>
```

This renders a collapsible "Global Settings" section with all key bindings.

### Other Global Settings

For non-key-binding global settings, use the `global` attribute on sdpi components:

```html
<sdpi-checkbox
  setting="disableWhenDisconnected"
  label="Disable when disconnected"
  global
  default="true"
></sdpi-checkbox>
```

## Action Code Usage

### Executing Bindings (Preferred)

Actions extending `ConnectionStateAwareAction` use binding dispatch delegates:

```typescript
// Declare active binding for readiness tracking
this.setActiveBinding("blackBoxLapTiming");

// Execute (routes to keyboard or SimHub automatically)
await this.tapBinding("blackBoxLapTiming");
await this.holdBinding(ev.action.id, settingKey);
await this.releaseBinding(ev.action.id);
```

### Reading Global Settings Directly

```typescript
import { getGlobalSettings, parseBinding, isSimHubBinding } from "@iracedeck/deck-core";

const globalSettings = getGlobalSettings() as Record<string, unknown>;
const binding = parseBinding(globalSettings["blackBoxLapTiming"]);
// Returns KeyBindingValue | SimHubBindingValue | undefined
```

### Subscribing to Changes

```typescript
import { onGlobalSettingsChange } from "@iracedeck/deck-core";

const unsubscribe = onGlobalSettingsChange((settings) => {
  // React to settings changes
});
// Call unsubscribe() to clean up
```

### GlobalSettingsSchema

Global settings are validated with Zod. The schema is in `deck-core/src/global-settings.ts`:

```typescript
const GlobalSettingsSchema = z.object({
  disableWhenDisconnected: z.boolean().default(true),
  debugLogging: z.boolean().default(false), // opt-in verbose logging (issue #609)
  focusIRacingWindow: z.boolean().default(false),
  simHubHost: z.string().default("127.0.0.1"),
  simHubPort: z.coerce.number().min(1).max(65535).default(8888),
}).passthrough();
```

The `.passthrough()` allows dynamic key binding properties (e.g., `blackBoxLapTiming`, `lookDirectionLeft`) without declaring them explicitly in the schema.

## Title Settings Keys

Plugin-level title defaults are stored as flat keys with a `title` prefix and read via `getGlobalTitleSettings()`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `titleShowTitle` | boolean | `true` | Show title text on key |
| `titleShowGraphics` | boolean | `true` | Show graphics on key |
| `titleBold` | string | `"default"` | Bold: `"default"`, `"true"`, `"false"` |
| `titleFontSizeDefault` | boolean | `true` | Use icon default font size (hides range when true) |
| `titleFontSize` | number | `9` | Title font size in PI units (5–100, doubled for SVG) |
| `titlePosition` | string | `"default"` | Position: `"default"`, `"top"`, `"middle"`, `"bottom"`, `"custom"` |
| `titleCustomPosition` | number | `0` | Vertical offset for custom position (−100 to +100) |

`"default"` means defer to the icon's `<desc>` title metadata default. These are configured in the Global Settings PI section under "Title Defaults". Use `getGlobalTitleSettings()` in action code to read them:

```typescript
import { getGlobalTitleSettings, resolveTitleSettings } from "@iracedeck/deck-core";

const globalTitleSettings = getGlobalTitleSettings();
const title = resolveTitleSettings(graphicSvg, globalTitleSettings, settings.titleOverrides, "DEFAULT\nTITLE");
```

## Per-callout opt-in/out — `callout<Polarity><Family><Subject>`

For features that expose N parallel opt-ins for individual callouts the Race Engineer makes (e.g. issue #467: every flag color), use one boolean global-settings key per subject under a uniform naming convention:

**Naming.** `callout` prefix + `Enabled` polarity word + family noun + subject identifier. Examples: `calloutEnabledFlagYellowLocal`, `calloutEnabledFlagMeatball`, future `calloutEnabledPitActionFuel`. A `grep calloutEnabled` finds every callout-toggle setting in one shot. The polarity is **always** positive (`Enabled`); each schema field's *default* encodes the family's natural baseline (callouts default `true`; opt-in families would default `false`).

**Why per-item booleans (not an array, not a bitmask).** Forward-compat: when a new subject ships in a later release, its newly-added Zod field defaults `true` for every existing user via `passthrough()` — no migration, no "this new feature is mysteriously off". Array-based storage and enabled-bitmasks both fail this property; per-item booleans don't.

**Pattern.**

1. **Schema** — add one boolean field per subject to `GlobalSettingsSchema`. Use the standard string/boolean coercion: `z.union([z.boolean(), z.string()]).transform((val) => val === true || val === "true").default(true)`.
2. **Canonical id↔key map** — keep next to the feature catalog (not in `deck-core`). Export `type SubjectId = "x" | "y" | …` and `const FOO_SETTING_KEYS: Record<SubjectId, string>`. Plugins import both and read the live cache via `(getGlobalSettings() as Record<string, unknown>)[FOO_SETTING_KEYS[id]] !== false`.
3. **Live gating** — when the feature dispatches via the audio-scenarios `where:` predicate (or any equivalent per-event hook), read the live setting on every event arrival rather than re-registering on `onGlobalSettingsChange`. Gating at event arrival means a toggle taking effect mid-session never cuts work already in flight.
4. **PI** — group all subjects of a family inside a single `<sdpi-item label="<Family>">` containing `<sdpi-checkbox setting="..." label="..." global default="true">` rows. Layout: keep the list of `{ setting, label }` pairs in a small JS array at the top of the EJS template, then build the inner div with `grid-template-rows: repeat(<%= Math.ceil(items.length / 2) %>, auto); grid-auto-flow: column;` — items fill column 1 top-to-bottom, then column 2, and the layout stays at exactly two columns no matter how the list grows (see `pit-crew.ejs` "Flags" item, currently 11 split 6+5). Don't hardcode the row count; the array drives both the option list and the grid template. One accordion per feature category (e.g., "Race Engineer Callouts") holds every family's `sdpi-item`. Use `default="true"` (renders checked); `default="false"` is the trap (also renders checked because the HTML attribute is truthy).

**Vertical-space follow-up.** A future custom `<ird-checkbox-list>` component will accept the same per-item-setting model and render multi-column for vertical-space wins; that work is tracked separately and should land alongside the second family (Pit Actions) so it has two consumers at once. Per-item booleans + the `callout<…>` naming stay the persistence shape regardless of how the UI groups them.

Reference implementation: per-flag callouts in `packages/audio-scenarios/src/catalog/pit-crew/index.ts` (`FlagCalloutId`, `FLAG_CALLOUT_SETTING_KEYS`, `wrapFlagScenario`).

## Settings Key Convention

Global key bindings use flat key names:
- `blackBoxLapTiming`, `blackBoxFuel`, `lookDirectionLeft`, etc.

Global settings use flat key names (e.g., `blackBoxLapTiming`), not nested paths.
