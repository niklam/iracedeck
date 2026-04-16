# Automated Car Control Triggers — Design Spec

## Context

Community request (Discord, SebKun, 2026-03-24): users want automated car controls that fire based on telemetry conditions — tear off visor N times per lap (iRacing's built-in auto tear-off only fires once), pit limiter that engages reliably on pit approach, and headlight flash on an interval for manual safety car in leagues.

GitHub issue: #241

## Overview

A background automation engine that executes car control commands based on configurable telemetry triggers. Each automation rule is controlled via a dedicated Stream Deck action button that toggles the rule on/off and shows its status.

## Architecture

Three components:

1. **AutomationEngine** (`packages/deck-core/src/automation-engine.ts`) — Singleton service managing rules. Subscribes to SDKController with stable IDs, evaluates triggers at ~4Hz, executes commands via BindingDispatcher. Runs independently of action visibility (survives Stream Deck page switches).

2. **AutoControl action** (`packages/actions/src/actions/auto-control.ts`) — Extends `ConnectionStateAwareAction`. Each button = one automation rule. Shows active/inactive icon. Key press toggles the rule. PI configures command + trigger settings.

3. **Property Inspector** (`packages/stream-deck-plugin/src/pi/auto-control.ejs`) — Command dropdown, trigger dropdown, conditional sub-settings.

### Initialization Order

In `plugin.ts`, after `initializeBindingDispatcher()` and before `initAppMonitor()`:

```typescript
initializeAutomationEngine(adapter.createLogger("AutomationEngine"));
```

### Data Flow

```text
User presses button → Action toggles rule in AutomationEngine
AutomationEngine subscribes to SDKController → receives telemetry at 4Hz
Engine evaluates trigger conditions → fires command via BindingDispatcher
Action (when visible) reads engine state → updates icon display
```

## Commands (v1)

Four commands, all executed via existing global key bindings:

| Command | Global Binding Key | Execution | Default Key |
|---------|-------------------|-----------|-------------|
| Tear-off visor | `carControlTearOffVisor` | `tap()` | *(none)* |
| Pit limiter | `carControlPitSpeedLimiter` | `tap()` | `A` |
| Headlight flash | `carControlHeadlightFlash` | `hold()` + delay + `release()` | *(none)* |
| Trigger wipers | `cockpitMiscTriggerWipers` | `tap()` | `Ctrl+Alt+W` |

No new key bindings are needed — the engine reuses existing bindings from the car-control and cockpit-misc actions. Users configure key bindings once in those actions' PIs.

### Headlight Flash Execution

- Settings: `flashCount` (1–10, default 1), `flashDuration` (100–1000ms, default 200ms)
- For each flash: `hold(ruleId, key)` → wait `flashDuration` → `release(ruleId)` → wait `flashDuration` (gap)
- Sequence is asynchronous; engine does not block telemetry evaluation during flash

## Trigger Types

### Lap-Based

Fires at evenly-spaced track positions, optionally skipping laps.

**Settings:**

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `everyXLaps` | number | 1 | 1–99 | Fire every Nth lap |
| `timesPerLap` | number | 1 | 1–20 | Firings per qualifying lap |

**Logic:**

- Compute threshold positions: `[0/N, 1/N, ..., (N-1)/N]` where N = `timesPerLap`
- On each telemetry tick, detect when `LapDistPct` crosses a threshold (compare previous vs current value)
- Track `LapCompleted` counter. Only fire on laps where `LapCompleted % everyXLaps === 0`
- Edge detection prevents double-firing: once a threshold is crossed, mark it as fired until the next threshold or new lap

**Wrapping:** When `LapDistPct` wraps from ~99% to ~1% (new lap), the engine detects the wrap and checks for any threshold in the wrap range.

### Pit Boundary

Fires on pit approach and/or pit exit. Designed for pit limiter automation but available for any command.

**Settings:**

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enableOnApproach` | boolean | false | Fire when approaching pit road |
| `disableOnExit` | boolean | false | Fire when leaving pit road |

**Logic:**

- **Approach detection**: Fire when `PlayerTrackSurface` transitions to `TrkLoc.AproachingPits` (value 2). Edge-detected — fires once per approach, resets when `PlayerTrackSurface` leaves `AproachingPits`.
- **Exit detection**: Fire when `OnPitRoad` transitions `true → false`. Track previous `OnPitRoad` value for edge detection.
- At least one checkbox must be checked for the trigger to be active.

### Interval

Fires on a timed interval.

**Settings:**

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `intervalSeconds` | number | 5 | 1–300 | Seconds between firings |

**Logic:**

- Track `SessionTime` from telemetry. Fire when `currentSessionTime - lastFireTime >= intervalSeconds`
- Uses `SessionTime` (not wall clock) so the timer pauses when the sim pauses
- Reset `lastFireTime` on rule activation

## Engine API

```typescript
interface AutomationRuleConfig {
  command: "tear-off-visor" | "pit-limiter" | "headlight-flash" | "trigger-wipers";
  trigger: "lap" | "pit-boundary" | "interval";
  // Lap trigger
  everyXLaps: number;
  timesPerLap: number;
  // Interval trigger
  intervalSeconds: number;
  // Pit boundary trigger
  enableOnApproach: boolean;
  disableOnExit: boolean;
  // Headlight flash
  flashCount: number;
  flashDuration: number;
}

interface AutomationRuleState {
  active: boolean;
  lastFiredAt: number | null; // SessionTime
  fireCount: number;
}

// Singleton lifecycle
function initializeAutomationEngine(logger: ILogger): void;
function getAutomationEngine(): IAutomationEngine;

interface IAutomationEngine {
  registerRule(ruleId: string, config: AutomationRuleConfig): void;
  updateRule(ruleId: string, config: AutomationRuleConfig): void;
  removeRule(ruleId: string): void;
  activateRule(ruleId: string): void;
  deactivateRule(ruleId: string): void;
  getRuleState(ruleId: string): AutomationRuleState | undefined;
  isRuleActive(ruleId: string): boolean;
}
```

The engine subscribes to SDKController with a single stable ID (`"automation-engine"`). On each telemetry tick, it iterates active rules and evaluates their triggers.

### Telemetry Subscription

- One subscription for the entire engine (not per-rule)
- Subscription is created when the first rule is activated, removed when the last rule is deactivated
- Previous telemetry values are cached for edge detection (threshold crossing, state transitions)

### Command Dispatch

Commands are dispatched via `getBindingDispatcher()`:

| Command | Dispatch |
|---------|----------|
| Tear-off visor | `dispatcher.tap("carControlTearOffVisor")` |
| Pit limiter | `dispatcher.tap("carControlPitSpeedLimiter")` |
| Headlight flash | `dispatcher.hold(ruleId, "carControlHeadlightFlash")` → delay → `dispatcher.release(ruleId)` |
| Trigger wipers | `dispatcher.tap("cockpitMiscTriggerWipers")` |

### Error Handling

- If a binding key has no configured value (user hasn't placed a car-control/cockpit-misc action to configure the key binding), the dispatcher silently skips (existing behavior). The automation button has no global key bindings of its own — it reuses bindings from other actions.
- If iRacing disconnects, telemetry becomes `null` and all triggers pause (no state transitions detected)
- The engine does not retry failed dispatches

## Action Design

### Lifecycle

- **onWillAppear**: Register rule config in engine (inactive). Subscribe to telemetry for icon updates. Set initial icon.
- **onKeyDown**: Toggle rule active/inactive in engine. Update icon.
- **onWillDisappear**: Unsubscribe from telemetry for icon updates. Do NOT remove or deactivate the rule (it persists in the engine).
- **onDidReceiveSettings**: Update rule config in engine (if rule is active, update takes effect immediately). Update icon.
- **Plugin startup**: All rules start inactive (manual activation only, per user preference).

### Rule Identity

Each action context gets a unique rule ID (the action context ID). This means:
- Multiple auto-control buttons = multiple independent rules
- Each button manages exactly one rule
- Rules are never explicitly removed — they persist in the engine for the plugin's lifetime. Since all rules start inactive on startup and require manual activation, stale rules (from deleted buttons) are harmless and get cleaned up on plugin restart.

### Icon

Uses the DRS/push-to-pass pattern — dynamic template with status bar:

- **Template**: `auto-control.svg` dynamic template (144x144 viewBox)
- **Status bar**: green when active (ON), gray when inactive (OFF), using `statusBarOn()` / `statusBarOff()` from `status-bar.ts`
- **Icon content area**: Renders the command-specific icon graphic by importing the relevant SVG from `@iracedeck/icons` (e.g., `tear-off-visor.svg`, `headlight-flash.svg`) and extracting its artwork content via `extractGraphicContent()`, then placing it in the template's icon content area
- **Title**: Handled by the title settings system. Default titles per command:
  - Tear-off visor: `"AUTO\nVISOR"`
  - Pit limiter: `"AUTO\nLIMITER"`
  - Headlight flash: `"AUTO\nFLASH"`
  - Trigger wipers: `"AUTO\nWIPERS"`
- **Border**: Supports border overrides with state-driven color (`borderColorForState()`)

### Category Icon

The robot SVG from `/Users/niklaslampen/Downloads/robot-svgrepo-com.svg` is used as the action's category icon. It must be converted to:
- `imgs/actions/auto-control/icon.svg` — 20x20, monochrome white on transparent

### Attribution

Create `THIRD-PARTY-LICENSES.md` in the repo root:

```markdown
# Third-Party Licenses

## Robot Icon (auto-control action)

Source: SVG Repo (robot-svgrepo-com.svg)
Author: Gerrit Halfmann
License: MIT

Copyright (c) 2019 Gerrit Halfmann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Settings Schema

```typescript
const AutoControlSettings = CommonSettings.extend({
  command: z.enum(["tear-off-visor", "pit-limiter", "headlight-flash", "trigger-wipers"])
    .default("tear-off-visor"),
  trigger: z.enum(["lap", "pit-boundary", "interval"]).default("lap"),
  // Lap trigger
  everyXLaps: z.coerce.number().min(1).max(99).default(1),
  timesPerLap: z.coerce.number().min(1).max(20).default(1),
  // Interval trigger
  intervalSeconds: z.coerce.number().min(1).max(300).default(5),
  // Pit boundary trigger
  enableOnApproach: z.union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(false),
  disableOnExit: z.union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(false),
  // Headlight flash
  flashCount: z.coerce.number().min(1).max(10).default(1),
  flashDuration: z.coerce.number().min(100).max(1000).default(200),
});
```

## Property Inspector Layout

```text
--- Action Settings ---
[Command Type]     ▼ Tear Off Visor / Pit Limiter / Headlight Flash / Trigger Wipers
[Trigger Type]     ▼ Lap-Based / Pit Boundary / Interval

--- Lap-Based Settings (shown when trigger = lap) ---
[Every X laps]     [1] (number input, 1–99)
[Times per lap]    [1] (number input, 1–20)

--- Pit Boundary Settings (shown when trigger = pit-boundary) ---
[✓] Turn on when approaching pits
[✓] Turn off when leaving pits

--- Interval Settings (shown when trigger = interval) ---
[Interval (seconds)] [5] (number input, 1–300)

--- Headlight Flash Settings (shown when command = headlight-flash) ---
[Flash count]        [1] (number input, 1–10)
[Flash duration (ms)] [200] (number input, 100–1000)

--- Standard Overrides ---
Title Overrides
Color Overrides (slots: backgroundColor, textColor, graphic1Color)
Border Overrides
Graphic Overrides
Common Settings (flags overlay)

--- Global Settings ---
Title Defaults
Color Defaults
Border Defaults
Graphic Defaults
Common Settings (window focus, SimHub)
```

Conditional visibility uses the established polling-fallback pattern from existing PIs.

## Files to Create

| File | Description |
|------|-------------|
| `packages/deck-core/src/automation-engine.ts` | AutomationEngine service |
| `packages/deck-core/src/automation-engine.test.ts` | Engine unit tests |
| `packages/actions/src/actions/auto-control.ts` | AutoControl action |
| `packages/actions/src/actions/auto-control.test.ts` | Action unit tests |
| `packages/icons/auto-control/default.svg` | 144x144 template with status bar |
| `com.iracedeck.sd.core.sdPlugin/imgs/actions/auto-control/icon.svg` | 20x20 category icon (robot) |
| `com.iracedeck.sd.core.sdPlugin/imgs/actions/auto-control/key.svg` | 72x72 key icon |
| `packages/stream-deck-plugin/src/pi/auto-control.ejs` | Property Inspector template |
| `packages/stream-deck-plugin/icons/auto-control.svg` | Dynamic template for icon rendering |
| `THIRD-PARTY-LICENSES.md` | Third-party attribution |
| `docs/plugins/core/actions/auto-control.md` | Action documentation |

## Files to Modify

| File | Change |
|------|--------|
| `packages/deck-core/src/index.ts` | Export automation engine init/get functions |
| `packages/actions/src/index.ts` | Export AutoControl action + UUID |
| `packages/stream-deck-plugin/src/plugin.ts` | Import, register action, init engine |
| `packages/mirabox-plugin/src/plugin.ts` | Import, register action, init engine |
| `com.iracedeck.sd.core.sdPlugin/manifest.json` | Add action entry |
| `packages/mirabox-plugin/com.iracedeck.sd.core.sdPlugin/manifest.json` | Add action entry |
| `packages/stream-deck-plugin/src/pi/data/docs-urls.json` | Add docs URL entry |
| `packages/stream-deck-plugin/src/pi/data/icon-defaults.json` | Regenerate (run script) |
| `docs/reference/actions.json` | Add action entry |
| `.claude/skills/iracedeck-actions/SKILL.md` | Update action listings |
| `README.md` | Update action count if applicable |

## Edge Cases

- **Wrapping threshold** (lap-based): when `LapDistPct` goes from ~99% to ~1%, detect the wrap and fire any threshold in the wrap zone
- **Pit approach near start/finish** (pit boundary): `DriverPitTrkPct` wrapping is handled by using `PlayerTrackSurface === AproachingPits` instead of percentage math
- **Multiple rules active**: engine iterates all active rules per tick; no conflicts since they use independent state
- **Flash sequence interruption**: if rule is deactivated mid-flash, release any held binding immediately
- **iRacing disconnect**: telemetry becomes `null`, triggers pause, no false fires
- **Rule update while active**: engine applies new config immediately; resets trigger state (last fired, thresholds)

## Testing

### Unit Tests

**`automation-engine.test.ts`**:
- Lap trigger: fires at correct `LapDistPct` positions, respects `everyXLaps`, handles wrapping
- Pit boundary: fires on `PlayerTrackSurface` transition to `AproachingPits`, fires on `OnPitRoad` false transition
- Interval: fires at correct `SessionTime` intervals, pauses on null telemetry
- Command dispatch: correct binding key called for each command
- Flash sequence: hold/release timing, multiple flashes, interruption cleanup
- Lifecycle: register, activate, deactivate, remove rules

**`auto-control.test.ts`**:
- Icon generation for each command/state combination
- Settings parsing with Zod
- Action lifecycle (appear, key press toggle, settings update)
- Global key names

### Integration Verification

```bash
pnpm build          # Compilation succeeds
pnpm test           # All unit tests pass
pnpm lint:fix       # No lint issues
pnpm format:fix     # Formatting clean
```

Manual verification:
1. Place auto-control button on deck, configure tear-off visor with lap trigger (every 1 lap, 3 times per lap)
2. Activate the automation, drive a lap
3. Verify fires at ~0%, ~33%, ~66% of track
4. Switch to a different Stream Deck page and back — automation continues running
5. Deactivate by pressing the button — icon shows inactive, automation stops
