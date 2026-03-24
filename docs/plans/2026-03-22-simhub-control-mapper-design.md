# SimHub Control Mapper Integration — Feature Design

> **Implementation Notes:** The actual implementation diverged significantly from this
> initial design. Instead of per-action `controlMethod`/`simHubRole` settings described
> below, the implementation uses a unified `BindingDispatcher` singleton that routes
> bindings based on a type-discriminated `BindingValue` union (`{ type: "keyboard" }` or
> `{ type: "simhub" }`). Bindings are stored in global settings (not per-action), and
> actions use `tapBinding()`/`holdBinding()`/`releaseBinding()` delegates from
> `ConnectionStateAwareAction`. The SimHub protocol and PI UX sections remain accurate.

## Overview

This document covers the design of a third control mechanism for iRaceDeck alongside the existing iRacing SDK commands and keyboard simulation. SimHub's Control Mapper exposes an HTTP API that allows external programs to activate named "roles" — pre-configured input mappings in SimHub — via a simple HTTP POST. Integrating this as an optional mechanism lets users who already use SimHub trigger their own SimHub Control Mapper roles directly from Stream Deck buttons without requiring iRacing key binding configuration.

---

## SimHub Control Mapper Protocol

This section documents the protocol based on research of the reference implementation at [pre-martin/StreamDeckSimHubPlugin](https://github.com/pre-martin/StreamDeckSimHubPlugin) and decompilation of `SimHub.Plugins.dll`.

### HTTP API

SimHub exposes a REST API on port **8888** (localhost only by default):

```text
POST http://localhost:8888/api/ControlMapper/StartRole/
POST http://localhost:8888/api/ControlMapper/StopRole/
GET  http://localhost:8888/api/ControlMapper/GetRoles/
```

**Request body** (for Start/Stop): `application/x-www-form-urlencoded`
- `ownerId` — a string identifying the caller (e.g., `"iRaceDeck"`)
- `roleName` — the name of the SimHub Control Mapper role to activate or deactivate

**Response**: HTTP 200 on success; non-2xx on failure.

**Timeout**: The reference implementation uses a 2-second HTTP client timeout.

**No authentication** is required. No custom headers.

### Role Semantics

A "role" in SimHub Control Mapper is a named group of input bindings that the user has configured inside SimHub. `StartRole` activates the role (presses the associated inputs), `StopRole` deactivates it (releases them). For momentary actions, both calls are needed (press on button down, release on button up). For toggle-style actions, only `StartRole` is needed.

### ownerId

The `ownerId` parameter identifies the caller to SimHub. It is used by SimHub for de-duplication and ownership tracking. The value `"iRaceDeck"` is a reasonable fixed constant.

### GetRoles

`GetRoles` returns a JSON array of available role name strings. This is used to populate a datalist in the Property Inspector so users do not have to type role names manually.

### Internal Architecture (from decompilation)

SimHub's `ControlMapperPlugin` internally fires `RolePressed`/`RoleReleased` events on its `RemapperWorker`, which feed into `PluginManager.TriggerInputPress`/`TriggerInputRelease`. These set `InputStatus.{roleName}` properties (value `1` for pressed, `0` for released) that are subscribable via the TCP Property Server (port 18082). However, this TCP protocol is **out of scope for v1** — the simple HTTP API is sufficient for triggering roles.

**Future opportunity:** A unified recording flow in the Property Inspector could temporarily connect to the TCP Property Server to detect when a user activates a role, enabling a "press to bind" experience for both keyboard shortcuts and SimHub roles. This is deferred to a future version.

---

## Approach

**Per-action Control Method selection.** Each keyboard-based action gains a `controlMethod` dropdown (`keyboard` / `simhub`) and an optional `simHubRole` field. When `simhub` is selected and a role is configured, pressing the button calls the SimHub HTTP API instead of the keyboard shortcut. When `keyboard` is selected (the default), behavior is unchanged from today.

This is per-action-instance — users can have one button using SimHub and another using keyboard for the same action type. Users who don't use SimHub see only the default "Keyboard" option and no behavioral change.

---

## User Stories

- As a SimHub user, I want to trigger my SimHub Control Mapper roles from a Stream Deck button so that I can use my existing SimHub input configuration without also setting up iRacing key bindings.
- As an iRaceDeck user without SimHub, I want the integration to be completely invisible and not interfere with existing keyboard-based or SDK-based actions.
- As a user, I want to pick my SimHub role from a dropdown list (populated from SimHub) rather than typing a name.
- As a user configuring a momentary hold action (e.g., look direction), I want the role to be activated on key-down and released on key-up, matching the hold semantics of keyboard simulation.

---

## Proposed Architecture

### New Module: `simhub-service.ts`

Following the pattern of `keyboard-service.ts` in `@iracedeck/deck-core`, a new `simhub-service.ts` module:

```typescript
// Initialization (called once at plugin startup)
function initializeSimHub(logger: ILogger): ISimHubService

// Access (called from action code)
function getSimHub(): ISimHubService
function isSimHubInitialized(): boolean
function _resetSimHub(): void  // testing only
```

The service interface:

```typescript
interface ISimHubService {
  /** Activate a named role. Returns true on success, false on error. */
  startRole(roleName: string): Promise<boolean>

  /** Deactivate a named role. Returns true on success, false on error. */
  stopRole(roleName: string): Promise<boolean>

  /** Fetch available role names from SimHub. Returns empty array if unreachable. */
  getRoles(): Promise<string[]>
}
```

**Implementation notes:**
- Uses Node's built-in `fetch`. No new runtime dependency needed.
- Fixed `ownerId` constant: `"iRaceDeck"`.
- Request timeout: 2 seconds (matching the reference implementation).
- Errors are logged at `warn` level and return `false` / `[]` — never throw into action code.
- Host and port are read dynamically from `getGlobalSettings()` on each call (defaults: `"127.0.0.1"`, `8888`).
- The service does not maintain a persistent connection — each call is an independent HTTP request.

### Integration into `plugin.ts`

```typescript
import { initializeSimHub } from "@iracedeck/deck-core";

// Always initialize — the service gracefully handles SimHub being absent
initializeSimHub(adapter.createLogger("SimHub"));
```

Initialized in `plugin.ts` before actions are registered, following the same pattern as `initializeKeyboard`. Added to both `stream-deck-plugin` and `mirabox-plugin`.

### Changes to Existing Actions

For actions that currently use keyboard shortcuts, the following changes are needed per action:

1. Add `controlMethod: z.enum(["keyboard", "simhub"]).default("keyboard")` and `simHubRole: z.string().default("")` to the action's settings schema.
2. In `onKeyDown`, check `controlMethod` and dispatch accordingly.
3. For hold-style actions (like `look-direction.ts`), call `startRole` on key-down and `stopRole` on key-up.
4. Update the Property Inspector template with the Control Method dropdown and conditional visibility.

**Example pattern for a tap action:**

```typescript
override async onKeyDown(ev: IDeckKeyDownEvent<Settings>): Promise<void> {
  const settings = Settings.parse(ev.payload.settings);

  if (settings.controlMethod === "simhub" && settings.simHubRole) {
    this.logger.info("Triggering SimHub role");
    this.logger.debug(`SimHub role: ${settings.simHubRole}`);
    await getSimHub().startRole(settings.simHubRole);
    return;
  }

  // Existing keyboard path
  const binding = parseKeyBinding(/* ... */);
  if (binding?.key) {
    await getKeyboard().sendKeyCombination(/* ... */);
  }
}
```

**Example pattern for a hold action:**

```typescript
override async onKeyDown(ev: IDeckKeyDownEvent<Settings>): Promise<void> {
  const settings = Settings.parse(ev.payload.settings);

  if (settings.controlMethod === "simhub" && settings.simHubRole) {
    await getSimHub().startRole(settings.simHubRole);
    this.heldSimHubRoles.set(ev.action.id, settings.simHubRole);
    return;
  }
  // keyboard hold path...
}

override async onKeyUp(ev: IDeckKeyUpEvent<Settings>): Promise<void> {
  const role = this.heldSimHubRoles.get(ev.action.id);
  if (role) {
    this.heldSimHubRoles.delete(ev.action.id);
    await getSimHub().stopRole(role);
    return;
  }
  // keyboard release path...
}

override async onWillDisappear(ev: IDeckWillDisappearEvent<Settings>): Promise<void> {
  const role = this.heldSimHubRoles.get(ev.action.id);
  if (role) {
    this.heldSimHubRoles.delete(ev.action.id);
    await getSimHub().stopRole(role);
  }
  await super.onWillDisappear(ev);
}
```

---

## Configuration Design

### Per-Action Settings

Each affected action's settings gains:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Control Method | Dropdown | `keyboard` | `keyboard` or `simhub` — determines which control mechanism is used |
| SimHub Role | Text (with datalist) | *(empty)* | SimHub Control Mapper role name (only visible when Control Method is `simhub`) |

The `controlMethod` field defaults to `keyboard`, preserving backward compatibility — existing configs without the field behave exactly as today.

**Mutual exclusivity:** The Property Inspector shows either the key binding field(s) OR the SimHub role field, never both. The `controlMethod` dropdown determines which is visible.

### Global Settings

Two new global settings:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| SimHub Host | Text | `127.0.0.1` | Hostname or IP address of the SimHub instance |
| SimHub Port | Number | `8888` | HTTP port for SimHub's REST API |

These live in `GlobalSettingsSchema`. The `simhub-service.ts` module reads these dynamically from `getGlobalSettings()` on each call, so users can change the host/port without restarting the plugin.

### Property Inspector: SimHub Role Input

The role field uses a text input with an HTML5 `<datalist>` for autocomplete. Available roles are fetched automatically from `GET /api/ControlMapper/GetRoles/` when the Property Inspector opens — no manual fetch button, no caching. If SimHub is unreachable, the datalist is empty and the user can type a role name manually.

```html
<sdpi-item label="SimHub Role" id="simhub-role-item" class="hidden">
  <input type="text" id="simhub-role-input" list="simhub-roles-list"
         setting="simHubRole" placeholder="Select or type a role name">
  <datalist id="simhub-roles-list"></datalist>
</sdpi-item>
```

The fetch reads SimHub host/port from global settings via `$SD.api.getGlobalSettings()` and populates the datalist on Property Inspector open.

---

## Property Inspector UX

### For Existing Actions

The Control Method dropdown appears above the key binding / SimHub role fields. Only the relevant field is visible based on the selection:

```text
Control Method:  [ Keyboard ▾ ]
Key Binding:     [ F1         ]        ← visible when Keyboard

Control Method:  [ SimHub   ▾ ]
SimHub Role:     [ Pit Limiter ▾ ]     ← visible when SimHub (datalist autocomplete)
```

**Property Inspector layout order:**
1. Action-specific settings (mode, direction, etc.)
2. Control Method dropdown
3. Key binding field(s) OR SimHub role field (mutually exclusive)
4. Common settings (flags overlay)
5. Color overrides
6. Global settings accordion (includes SimHub host/port)

**Global key binding actions** (black box selector, splits-delta-cycle): The global key bindings accordion remains visible regardless of control method selection. It is irrelevant to instances using SimHub, but hiding it could confuse users who have other instances of the same action still using keyboard.

**Role list population:** On Property Inspector open, JavaScript fetches `GET http://{host}:{port}/api/ControlMapper/GetRoles/` and populates the `<datalist>`. If SimHub is unreachable, the datalist is empty and the user can type a role name manually.

---

## Global Settings: SimHub Connection

Added to the existing Global Settings Property Inspector accordion:

```text
--- SimHub ---
SimHub Host: [127.0.0.1         ]
SimHub Port: [8888    ]
```

---

## Changes Required by Layer

### `@iracedeck/deck-core`

- Add `simhub-service.ts` implementing `ISimHubService`, `SimHubService`, `initializeSimHub()`, `getSimHub()`, `isSimHubInitialized()`, `_resetSimHub()`.
- Export all new symbols from `index.ts`.
- Extend `GlobalSettingsSchema` with `simHubHost` and `simHubPort` fields (with defaults).
- Add `simhub-service.test.ts` unit tests (mock `fetch`, test startRole/stopRole/getRoles success and error paths).

### `@iracedeck/actions`

- Add `controlMethod` and `simHubRole` fields to affected action settings schemas.
- Update `onKeyDown` (and `onKeyUp`/`onWillDisappear` for hold actions) to check control method and dispatch accordingly.

**Affected existing actions** (all keyboard-based):

- `black-box-selector.ts` — tap only (uses global key bindings)
- `look-direction.ts` — hold action
- `audio-controls.ts` — tap
- `camera-cycle.ts` — tap
- `camera-editor-adjustments.ts` — tap
- `camera-editor-controls.ts` — tap
- `cockpit-misc.ts` — tap
- `media-capture.ts` — tap
- `replay-control.ts` — tap
- `replay-navigation.ts` — tap
- `replay-speed.ts` — tap
- `replay-transport.ts` — tap
- `setup-*.ts` (aero, brakes, chassis, engine, fuel, hybrid, traction) — tap
- `toggle-ui-elements.ts` — tap
- `view-adjustment.ts` — tap

SDK-backed actions (`pit-quick-actions.ts`, `fuel-service.ts`, `chat.ts`, `car-control.ts`, `tire-service.ts`, `session-info.ts`, `race-admin.ts`, `ai-spotter-controls.ts`, `splits-delta-cycle.ts`, `telemetry-display.ts`, `telemetry-control.ts`, `camera-focus.ts`) do not use keyboard shortcuts and are **out of scope**.

### `@iracedeck/stream-deck-plugin`

- Add `initializeSimHub()` call in `plugin.ts` (after `initializeKeyboard`, before action registration).
- Update affected action Property Inspector templates to add Control Method dropdown, SimHub role input, and conditional visibility.
- Add SimHub host/port to the global settings Property Inspector accordion section.

### `@iracedeck/mirabox-plugin`

- Add `initializeSimHub()` call in `plugin.ts`.

---

## Risks and Trade-offs

### Risk 1: SimHub not running

If SimHub is not running, every HTTP call fails. The service returns `false` silently with a logged warning. Consistent with existing keyboard fallback behavior (if iRacing is not focused, key presses also silently have no effect).

**Mitigation:** Log a clear warning at `warn` level when `startRole` fails. Consider a future UI indicator, but do not block v1 on it.

### Risk 2: HTTP latency

HTTP over localhost is typically sub-millisecond, but there is a 2-second timeout ceiling. A hung SimHub instance could delay button presses.

**Mitigation:** Keep the 2-second timeout (matching reference implementation). Consider reducing to 500ms in a future iteration.

### Risk 3: Role name typos

If the user types a role name that does not exist in SimHub, the call returns a non-200 and the service returns `false`. No user feedback.

**Mitigation:** The datalist populated on Property Inspector open provides autocomplete, reducing typo risk.

### Risk 4: Per-action changes are a large surface area

Adding `controlMethod`/`simHubRole` to ~18 action schemas and their Property Inspector templates is repetitive but mechanical work. The fields are always optional with defaults, so fully backward compatible.

---

## Out of Scope (v1)

- Standalone SimHub Role Trigger action (may add in a future version)
- SimHub property telemetry (TCP Property Server integration for reading data)
- Unified "press to bind" recording flow (detecting SimHub role activations during Property Inspector recording)
- Two-way SimHub integration (displaying SimHub state on buttons)
- Per-action SimHub host/port overrides
- Connection status indicator in the Property Inspector

---

## Implementation Phases

### Phase 1: Core Service

**Deliverable:** `simhub-service.ts` in `@iracedeck/deck-core`, fully tested, exported from `index.ts`. Global settings schema extended with `simHubHost` and `simHubPort`. `initializeSimHub()` added to both plugin `plugin.ts` files.

Files:
- `packages/deck-core/src/simhub-service.ts` (new)
- `packages/deck-core/src/simhub-service.test.ts` (new)
- `packages/deck-core/src/global-settings.ts` (add `simHubHost`, `simHubPort`)
- `packages/deck-core/src/index.ts` (export new symbols)
- `packages/stream-deck-plugin/src/plugin.ts` (add `initializeSimHub`)
- `packages/mirabox-plugin/src/plugin.ts` (add `initializeSimHub`)

### Phase 2: First Action Integration (Test Case)

**Deliverable:** One keyboard-based action updated with `controlMethod`/`simHubRole` settings and Property Inspector changes. Validates the pattern end-to-end before rolling out to all actions.

Start with `black-box-selector.ts` (tap action, uses global key bindings — good test case for the control method / global key bindings coexistence).

Files:
- `packages/actions/src/actions/black-box-selector.ts` (add settings + dispatch logic)
- `packages/stream-deck-plugin/src/pi/black-box-selector.ejs` (add Control Method dropdown + SimHub role field)
- Global settings Property Inspector accordion (add SimHub host/port fields)

### Phase 3: All Remaining Actions

**Deliverable:** All ~17 remaining keyboard-based actions updated with the same pattern from Phase 2.

### Phase 4: Documentation

- Update `docs/keyboard-shortcuts.md` to note SimHub as an alternative.
- Update `.claude/skills/iracedeck-actions/SKILL.md` with SimHub control method info.
- Update `docs/reference/actions.json`.

---

## Summary of New Files

| File | Type |
|------|------|
| `packages/deck-core/src/simhub-service.ts` | New module |
| `packages/deck-core/src/simhub-service.test.ts` | Tests |

## Summary of Modified Files

| File | Change |
|------|--------|
| `packages/deck-core/src/global-settings.ts` | Add `simHubHost`, `simHubPort` |
| `packages/deck-core/src/index.ts` | Export SimHub service symbols |
| `packages/stream-deck-plugin/src/plugin.ts` | Add `initializeSimHub()` |
| `packages/mirabox-plugin/src/plugin.ts` | Add `initializeSimHub()` |
| All ~18 keyboard-based action files | Add `controlMethod`/`simHubRole` settings + dispatch |
| All ~18 corresponding Property Inspector `.ejs` files | Add Control Method dropdown + SimHub role field |
| Global settings Property Inspector partial | Add SimHub host/port fields |
