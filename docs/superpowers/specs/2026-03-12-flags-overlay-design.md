# Flags Overlay — Design Spec

**Issue:** #106 — Add Flags Overlay setting to all actions
**Date:** 2026-03-12

## Overview

Add a per-action **Flags Overlay** setting that, when enabled, flashes the Stream Deck button with the active race flag color. This provides immediate visual flag awareness on any button, not just the Session Info action.

## Architecture Decisions

- **Flag overlay logic lives in `BaseAction`** — alongside the existing grayscale overlay system, keeping all overlay concerns in one place.
- **`BaseAction` subscribes to telemetry directly** via `getController()` (same singleton pattern `ConnectionStateAwareAction` uses). One shared subscription for all overlay-enabled contexts. Trade-off: this gives `BaseAction` a telemetry dependency, making it no longer a lightweight base class. Acceptable because all 30 actions extend `ConnectionStateAwareAction` in practice, and the overlay system belongs alongside the existing grayscale overlay.
- **Flag utility extracted to `@iracedeck/iracing-sdk`** — `FlagInfo`, `FLAG_DEFINITIONS`, `resolveActiveFlag`, and new `resolveAllActiveFlags` are pure iRacing domain logic, reusable by future plugins.
- **CommonSettings schema** — shared Zod schema that all action settings extend, providing `flagsOverlay` (and future common settings) without per-action changes.

## Components

### 1. Shared Flag Utility (`@iracedeck/iracing-sdk`)

**New file:** `packages/iracing-sdk/src/flag-utils.ts`

Extracted from `session-info.ts`:

```typescript
interface FlagInfo {
  label: string;
  color: string;
  textColor: string;
  pulse: boolean;
}

const FLAG_DEFINITIONS: ReadonlyArray<{ check: (flags: number) => boolean; info: FlagInfo }>;

function resolveActiveFlag(sessionFlags: number | undefined): FlagInfo | null;
```

New function for multi-flag overlay:

```typescript
function resolveAllActiveFlags(sessionFlags: number | undefined): FlagInfo[];
```

Returns all matching flags (not just highest priority) for multi-flag alternation (e.g., yellow + blue alternate each cycle). **Excludes Green** — green is the normal racing state and should not trigger an overlay.

All exported from the SDK package barrel (`index.ts`).

### 2. CommonSettings Schema

**New file:** `packages/stream-deck-plugin/src/shared/common-settings.ts`

```typescript
const CommonSettings = z.object({
  flagsOverlay: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(false),
});
```

- Exported from `shared/index.ts`
- All action settings extend it: `CommonSettings.extend({ direction: ... })`
- Actions with no other settings use `CommonSettings` directly
- Uses union+transform for boolean because `sdpi-checkbox` sends string values and `z.coerce.boolean()` treats `"false"` as truthy

### 3. Flag Overlay in `BaseAction`

#### New state fields

| Field | Type | Purpose |
|-------|------|---------|
| `flagOverlayContexts` | `Set<string>` | Contexts with overlay enabled |
| `flagOverlayActive` | `Set<string>` | Contexts currently displaying a flag color |
| `flagFlashTimer` | `NodeJS.Timeout \| null` | Shared timer for all flashing contexts |
| `currentFlags` | `FlagInfo[]` | Current active flags from telemetry |
| `flagFlashIndex` | `number` | Which flag color to show next (rotates) |
| `telemetrySubscriptionId` | `string \| null` | Single shared SDK subscription |

#### Image output gating

`setKeyImage` and `updateKeyImage` are modified to:

1. **Always store** the new SVG in the `contexts` Map (so the restore image stays current)
2. **Skip `action.setImage()`** when `flagOverlayActive` contains the context

This prevents telemetry-driven actions (e.g., speed display updating every 250ms) from overwriting the flag color. When flags clear, the most recent SVG is restored — not a stale value from when the flag started.

#### Lifecycle integration

- **`onWillAppear`**: if `settings.flagsOverlay` is truthy, add context to `flagOverlayContexts` and ensure telemetry subscription is active
- **`onWillDisappear`**: remove context from `flagOverlayContexts`; if set is empty, unsubscribe and stop timer
- **`onDidReceiveSettings`** (new override in `BaseAction`): update `flagOverlayContexts` membership when user toggles the checkbox. Subclasses call `super.onDidReceiveSettings(ev)`.

**IMPORTANT:** All actions must add `await super.onWillAppear(ev)` and `await super.onDidReceiveSettings(ev)` calls. Currently no actions chain to `super` for these methods. Without these calls, `BaseAction` lifecycle hooks will silently not fire.

#### Flash cycle

1. Telemetry callback calls `resolveAllActiveFlags(sessionFlags)`
2. If flags changed from previous state: **clear existing timer with `clearInterval`** before starting a new one (prevents timer leaks during rapid flag transitions), update `currentFlags`, reset `flagFlashIndex`, start new timer
3. Timer fires every 500ms: for each context in `flagOverlayContexts`, set image to solid color SVG of `currentFlags[flagFlashIndex % length]`, increment index. Add context to `flagOverlayActive`. (If many buttons have overlay enabled, this sends one `setImage` per context per tick — acceptable.)
4. If `currentFlags` becomes empty: stop timer, restore original SVGs for all overlay contexts, remove from `flagOverlayActive`.

#### Overlay priority

Flag overlay takes priority over grayscale. When flags are active and overlay is enabled, show the flag color regardless of connection state. When flags clear, the normal overlay logic kicks in (grayscale if disconnected, original if connected).

Button presses (`onKeyDown`, `onDialRotate`, etc.) continue to fire normally during active flag overlay — the overlay is purely visual and does not block action functionality.

#### Session-info interaction

`session-info.ts` continues to use `resolveActiveFlag` (singular) for its own flags mode display. Its own flash/pulse logic is separate from the BaseAction overlay. When session-info is in flags mode with overlay enabled, session-info's own flag visualization takes precedence (it already calls `updateKeyImage` with its flag-styled SVG, and the BaseAction overlay simply shows the same flag color).

### 4. Flag Overlay SVG

Minimal solid-color rectangle. No text — color alone is sufficient and unmistakable:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <rect width="72" height="72" rx="8" fill="${flagInfo.color}"/>
</svg>
```

Generated by a private helper in `BaseAction`.

### 5. Common Settings PI Partial

**New file:** `packages/stream-deck-plugin/src/pi-templates/partials/common-settings.ejs`

Collapsible "Common Settings" section (styled like "Related Key Bindings" accordion):

```ejs
<%- include('accordion', {
  title: 'Common Settings',
  content: `
    <sdpi-item label="Flags Overlay">
      <sdpi-checkbox setting="flagsOverlay" label="Flash flag colors on button"></sdpi-checkbox>
    </sdpi-item>
  `
}) %>
```

- No `default` attribute (unchecked by default)
- Included at the bottom of every action's `.ejs` template
- Designed for future common settings additions

## Files to Create

| File | Purpose |
|------|---------|
| `packages/iracing-sdk/src/flag-utils.ts` | `FlagInfo`, `FLAG_DEFINITIONS`, `resolveActiveFlag`, `resolveAllActiveFlags` |
| `packages/stream-deck-plugin/src/shared/common-settings.ts` | `CommonSettings` Zod schema |
| `packages/stream-deck-plugin/src/pi-templates/partials/common-settings.ejs` | PI partial |

## Files to Modify

| File | Change |
|------|--------|
| `packages/iracing-sdk/src/index.ts` | Export flag-utils |
| `packages/stream-deck-plugin/src/shared/index.ts` | Export CommonSettings |
| `packages/stream-deck-plugin/src/shared/base-action.ts` | Flag overlay logic, image output gating |
| `packages/stream-deck-plugin/src/actions/session-info.ts` | Import flag utils from SDK instead of local definitions |
| All 30 action `.ts` files | Extend CommonSettings, add `super.onWillAppear(ev)` and `super.onDidReceiveSettings(ev)` calls |
| All action `.ejs` templates | Include common-settings partial |
| `.claude/rules/stream-deck-actions.md` | Document CommonSettings pattern and super call requirements |
| `packages/stream-deck-plugin/CLAUDE.md` | Document CommonSettings and common-settings partial conventions |

## Files NOT Modified

| File | Reason |
|------|--------|
| `connection-state-aware-action.ts` | Untouched — overlay logic is in BaseAction |
| `plugin.ts` | No new initialization needed — BaseAction uses existing `getController()` singleton |
| Manifest files | No new actions or settings declarations |

## Testing

- Unit tests for `resolveAllActiveFlags` (multiple flags, no flags, single flag)
- Unit tests for CommonSettings schema (boolean, string "true"/"false", default)
- Unit tests for BaseAction flag overlay logic:
  - Image gating: `updateKeyImage` stores but doesn't display during active overlay
  - Flash cycle: alternates between flag colors at 500ms
  - Restore: correct (latest) SVG restored when flags clear
  - Lifecycle: subscribe/unsubscribe on appear/disappear
  - Settings toggle: enabling/disabling flagsOverlay via PI

## Acceptance Criteria

- [ ] CommonSettings schema exists and all action settings extend it
- [ ] Common Settings section appears in every action's Property Inspector
- [ ] Flags Overlay checkbox defaults to unchecked
- [ ] Active flag causes button to show solid flag color at 500ms flash interval
- [ ] Multiple simultaneous flags alternate each cycle
- [ ] Normal icon restores (with latest value) when flags clear
- [ ] Telemetry-driven actions don't overwrite flag overlay during active flags
- [ ] Flag overlay is handled in BaseAction (no per-action logic needed)
- [ ] Flag detection utilities live in `@iracedeck/iracing-sdk` for cross-plugin reuse
- [ ] Unit tests cover flag detection, flashing, gating, and multi-flag rotation
- [ ] Build succeeds without TypeScript warnings
