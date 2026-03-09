# Telemetry Display Rework — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rework Telemetry Display to use shared template context caching and remove preset modes in favor of custom-template-only design.

**Architecture:** Lazy-rebuild template context cache in SDKController (dirty flag pattern). Telemetry Display action simplified to custom template only. New standalone website page for template variable reference.

**Tech Stack:** TypeScript, Vitest, Zod, EJS templates, static HTML/CSS

**Design doc:** `docs/plans/2026-03-09-telemetry-display-rework-design.md`

---

### Task 1: Add lazy template context caching to SDKController

**Files:**
- Modify: `packages/iracing-sdk/src/SDKController.ts`

**Step 1: Add imports and private fields**

Add import for `buildTemplateContextFromData` and `TemplateContext` at the top of `SDKController.ts`:

```typescript
import { buildTemplateContextFromData, type TemplateContext } from "./template-context.js";
```

Add three private fields after `private reconnectEnabled = true;`:

```typescript
private templateContextDirty = true;
private lastTemplateContext: TemplateContext | null = null;
```

**Step 2: Mark context dirty on telemetry updates**

In the `update()` method, after `this.lastValidTelemetry = telemetry;` (line 159), add:

```typescript
this.templateContextDirty = true;
```

Also in `notifySubscribers` when called with `null` (disconnect path), invalidate context. In `stop()` after `this.isConnected = false;`, and in `setReconnectEnabled` disconnect path after `this.lastValidTelemetry = null;`, add:

```typescript
this.lastTemplateContext = null;
this.templateContextDirty = true;
```

**Step 3: Add getCurrentTemplateContext method**

Add after `getSessionInfo()`:

```typescript
/**
 * Get the current template context (lazy-built, cached per tick).
 * Returns null when not connected or no telemetry available.
 */
getCurrentTemplateContext(): TemplateContext | null {
  const telemetry = this.getCurrentTelemetry();
  if (!telemetry) return null;

  if (this.templateContextDirty || !this.lastTemplateContext) {
    const sessionInfo = this.getSessionInfo();
    this.lastTemplateContext = buildTemplateContextFromData(telemetry, sessionInfo);
    this.templateContextDirty = false;
  }

  return this.lastTemplateContext;
}
```

**Step 4: Export TemplateContext from index**

In `packages/iracing-sdk/src/index.ts`, the `TemplateContext` type is already exported. No change needed. But verify `buildTemplateContextFromData` is also exported (it is — line 106).

**Step 5: Run tests**

Run: `cd packages/iracing-sdk && pnpm test`
Expected: All existing tests pass (new method is additive).

**Step 6: Commit**

```
feat(iracing-sdk): add lazy template context caching to SDKController
```

---

### Task 2: Add SDKController template context tests

**Files:**
- Modify: `packages/iracing-sdk/src/SDKController.test.ts`

**Step 1: Write tests for getCurrentTemplateContext**

Add a new `describe("getCurrentTemplateContext")` block. The mock SDK's `getSessionInfo` already returns `null` and `getTelemetry` returns `{ Speed: 100, Gear: 3 }`.

```typescript
describe("getCurrentTemplateContext", () => {
  it("should return null when no telemetry available", () => {
    vi.mocked(mockSdk.getTelemetry).mockReturnValue(null);

    expect(controller.getCurrentTemplateContext()).toBeNull();
  });

  it("should return a template context when telemetry is available", () => {
    vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100, Gear: 3 });
    vi.mocked(mockSdk.getSessionInfo).mockReturnValue(null);

    const ctx = controller.getCurrentTemplateContext();

    expect(ctx).not.toBeNull();
    expect(ctx!.telemetry).toBeDefined();
    expect(ctx!.telemetry.Speed).toBe("100");
  });

  it("should cache context within the same tick", () => {
    vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100, Gear: 3 });
    vi.mocked(mockSdk.getSessionInfo).mockReturnValue(null);

    const ctx1 = controller.getCurrentTemplateContext();
    const ctx2 = controller.getCurrentTemplateContext();

    expect(ctx1).toBe(ctx2); // Same object reference
  });

  it("should rebuild context after telemetry update", () => {
    vi.mocked(mockSdk.connect).mockReturnValue(true);
    vi.mocked(mockSdk.isConnected).mockReturnValue(true);
    vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100, Gear: 3 });
    vi.mocked(mockSdk.getSessionInfo).mockReturnValue(null);

    controller.subscribe("test", vi.fn());

    const ctx1 = controller.getCurrentTemplateContext();

    // Simulate new telemetry tick
    vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 200, Gear: 4 });
    vi.advanceTimersByTime(250);

    const ctx2 = controller.getCurrentTemplateContext();

    expect(ctx2).not.toBe(ctx1);
    expect(ctx2!.telemetry.Speed).toBe("200");
  });

  it("should return null after disconnect", () => {
    vi.mocked(mockSdk.getTelemetry).mockReturnValue({ Speed: 100 });
    vi.mocked(mockSdk.getSessionInfo).mockReturnValue(null);

    // Get a valid context first
    expect(controller.getCurrentTemplateContext()).not.toBeNull();

    // Now disconnect
    vi.mocked(mockSdk.getTelemetry).mockReturnValue(null);

    expect(controller.getCurrentTemplateContext()).toBeNull();
  });
});
```

**Step 2: Run tests**

Run: `cd packages/iracing-sdk && pnpm test`
Expected: All tests pass including new ones.

**Step 3: Commit**

```
test(iracing-sdk): add SDKController template context caching tests
```

---

### Task 3: Add 0/1 boolean field conversion to flattenForDisplay

**Files:**
- Modify: `packages/iracing-sdk/src/template-context.ts`
- Modify: `packages/iracing-sdk/src/template-context.test.ts`

**Step 1: Write failing tests**

Add tests to `describe("flattenForDisplay")` in `template-context.test.ts`:

```typescript
it("should convert known boolean-semantic integer fields to Yes/No", () => {
  const result = flattenForDisplay({ IsOnTrack: 1, IsReplayPlaying: 0, Speed: 100 });

  expect(result.IsOnTrack).toBe("Yes");
  expect(result.IsReplayPlaying).toBe("No");
  expect(result.Speed).toBe("100");
});

it("should not convert unknown integer fields to Yes/No", () => {
  const result = flattenForDisplay({ Gear: 1, Lap: 0 });

  expect(result.Gear).toBe("1");
  expect(result.Lap).toBe("0");
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/iracing-sdk && pnpm test`
Expected: FAIL — `IsOnTrack` returns `"1"` instead of `"Yes"`.

**Step 3: Implement boolean field detection in flattenForDisplay**

In `template-context.ts`, add a set of known boolean-semantic field name prefixes before `flattenForDisplay`:

```typescript
/**
 * Field names that are integers (0/1) but represent boolean values.
 * These get converted to "Yes"/"No" instead of "0"/"1".
 */
const BOOLEAN_INT_FIELDS = new Set([
  "IsOnTrack",
  "IsOnTrackCar",
  "IsReplayPlaying",
  "IsInGarage",
  "IsDiskLoggingEnabled",
  "IsDiskLoggingActive",
  "PlayerCarDryTireSetAvailable",
  "DriverMarker",
  "PushToPass",
  "PushToTalk",
  "OnPitRoad",
  "PitstopActive",
  "PlayerCarInPitStall",
]);
```

In the `walk` function, inside the `typeof value === "number"` branch, before the existing integer/float check, add:

```typescript
if (typeof value === "number") {
  // Check leaf key (last segment after dots) for boolean-semantic fields
  const leafKey = fullKey.includes(".") ? fullKey.substring(fullKey.lastIndexOf(".") + 1) : fullKey;
  if (BOOLEAN_INT_FIELDS.has(leafKey) && (value === 0 || value === 1)) {
    result[fullKey] = value === 1 ? "Yes" : "No";
  } else {
    result[fullKey] = Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
}
```

Replace the existing `typeof value === "number"` block with this new one.

**Step 4: Run tests**

Run: `cd packages/iracing-sdk && pnpm test`
Expected: All tests pass.

**Step 5: Commit**

```
feat(iracing-sdk): convert known 0/1 boolean telemetry fields to Yes/No
```

---

### Task 4: Simplify Telemetry Display action

**Files:**
- Modify: `packages/stream-deck-plugin/src/actions/telemetry-display.ts`

**Step 1: Remove presets and simplify settings schema**

Replace the entire file content. The new action:
- Removes `PRESET_MODES`, `extractPresetValue`, unit conversion constants
- Removes `mode` setting
- Renames `customTemplate` → `template`, `customTitle` → `title`
- Uses `sdkController.getCurrentTemplateContext()` instead of `buildTemplateContext()`

```typescript
import streamDeck, { action, DidReceiveSettingsEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { resolveTemplate, type TemplateContext } from "@iracedeck/iracing-sdk";
import z from "zod";

import sessionInfoTemplate from "../../icons/session-info.svg";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

const TelemetryDisplaySettings = z.object({
  template: z.string().default("{{telemetry.Speed}}"),
  title: z.string().default("TELEMETRY"),
  backgroundColor: z.string().default("#2a3444"),
  textColor: z.string().default("#ffffff"),
  fontSize: z.coerce.number().default(18),
});

type TelemetryDisplaySettings = z.infer<typeof TelemetryDisplaySettings>;

/**
 * @internal Exported for testing
 */
export function generateTelemetryDisplaySvg(title: string, value: string, settings: TelemetryDisplaySettings): string {
  const svg = renderIconTemplate(sessionInfoTemplate, {
    backgroundColor: settings.backgroundColor,
    titleLabel: title,
    value,
    valueFontSize: String(settings.fontSize),
    valueY: "50",
    textColor: settings.textColor,
  });

  return svgToDataUri(svg);
}

/**
 * Telemetry Display Action
 * Displays live telemetry values on the Stream Deck key using mustache templates.
 */
@action({ UUID: "com.iracedeck.sd.core.telemetry-display" })
export class TelemetryDisplay extends ConnectionStateAwareAction<TelemetryDisplaySettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("TelemetryDisplay"), LogLevel.Info);

  private activeContexts = new Map<string, TelemetryDisplaySettings>();
  private lastState = new Map<string, string>();

  override async onWillAppear(ev: WillAppearEvent<TelemetryDisplaySettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();

      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings) {
        this.updateDisplayFromTelemetry(ev.action.id, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<TelemetryDisplaySettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TelemetryDisplaySettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);
    this.lastState.delete(ev.action.id);
    await this.updateDisplay(ev, settings);
  }

  private parseSettings(settings: unknown): TelemetryDisplaySettings {
    const parsed = TelemetryDisplaySettings.safeParse(settings);

    return parsed.success ? parsed.data : TelemetryDisplaySettings.parse({});
  }

  private async updateDisplay(
    ev: WillAppearEvent<TelemetryDisplaySettings> | DidReceiveSettingsEvent<TelemetryDisplaySettings>,
    settings: TelemetryDisplaySettings,
  ): Promise<void> {
    this.updateConnectionState();

    const { title, value } = this.resolveDisplay(settings);

    const svgDataUri = generateTelemetryDisplaySvg(title, value, settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);

    const stateKey = this.buildStateKey(title, value, settings);
    this.lastState.set(ev.action.id, stateKey);
  }

  private resolveDisplay(settings: TelemetryDisplaySettings): { title: string; value: string } {
    const context = this.sdkController.getCurrentTemplateContext();

    if (!context) return { title: settings.title, value: "---" };

    const value = resolveTemplate(settings.template, context);

    return { title: settings.title, value: value || "---" };
  }

  private buildStateKey(title: string, value: string, settings: TelemetryDisplaySettings): string {
    return `${title}|${value}|${settings.backgroundColor}|${settings.textColor}|${settings.fontSize}`;
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    settings: TelemetryDisplaySettings,
  ): Promise<void> {
    const { title, value } = this.resolveDisplay(settings);
    const stateKey = this.buildStateKey(title, value, settings);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey !== stateKey) {
      this.lastState.set(contextId, stateKey);
      const svgDataUri = generateTelemetryDisplaySvg(title, value, settings);
      await this.updateKeyImage(contextId, svgDataUri);
    }
  }
}
```

**Step 2: Run build to check for type errors**

Run: `pnpm build:stream-deck`
Expected: Build succeeds (or check with user if watch mode is running).

**Step 3: Commit**

```
refactor(stream-deck-plugin): simplify Telemetry Display to custom template only
```

---

### Task 5: Update Telemetry Display tests

**Files:**
- Modify: `packages/stream-deck-plugin/src/actions/telemetry-display.test.ts`

**Step 1: Rewrite tests for simplified action**

Replace the test file. Remove all preset-related tests. Test `generateTelemetryDisplaySvg` only (the main testable export).

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateTelemetryDisplaySvg } from "./telemetry-display.js";

vi.mock("@elgato/streamdeck", () => ({
  default: {
    logger: {
      createScope: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
      })),
    },
  },
  action: () => (target: unknown) => target,
}));

vi.mock("../../icons/session-info.svg", () => ({
  default:
    '<svg xmlns="http://www.w3.org/2000/svg">{{backgroundColor}} {{titleLabel}} {{value}} {{valueFontSize}} {{textColor}}</svg>',
}));

vi.mock("@iracedeck/iracing-sdk", () => ({
  resolveTemplate: vi.fn((template: string) => template.replace("{{telemetry.Speed}}", "156.79")),
}));

vi.mock("../shared/index.js", () => ({
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    sdkController = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getCurrentTelemetry: vi.fn(() => null),
      getCurrentTemplateContext: vi.fn(() => null),
    };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    updateKeyImage = vi.fn();
  },
  createSDLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
  LogLevel: { Info: 2 },
  renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
    let result = template;

    for (const [key, value] of Object.entries(data)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }

    return result;
  }),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

describe("TelemetryDisplay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateTelemetryDisplaySvg", () => {
    it("should produce a data URI", () => {
      const result = generateTelemetryDisplaySvg("TELEMETRY", "100", {
        template: "{{telemetry.Speed}}",
        title: "TELEMETRY",
        backgroundColor: "#2a3444",
        textColor: "#ffffff",
        fontSize: 18,
      });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should use custom colors", () => {
      const result = generateTelemetryDisplaySvg("TEST", "42", {
        template: "42",
        title: "TEST",
        backgroundColor: "#ff0000",
        textColor: "#00ff00",
        fontSize: 24,
      });

      expect(result).toContain(encodeURIComponent("#ff0000"));
      expect(result).toContain(encodeURIComponent("#00ff00"));
      expect(result).toContain(encodeURIComponent("24"));
    });

    it("should encode title and value", () => {
      const result = generateTelemetryDisplaySvg("SPEED", "150", {
        template: "",
        title: "SPEED",
        backgroundColor: "#2a3444",
        textColor: "#ffffff",
        fontSize: 18,
      });

      expect(result).toContain(encodeURIComponent("SPEED"));
      expect(result).toContain(encodeURIComponent("150"));
    });
  });
});
```

**Step 2: Run tests**

Run: `cd packages/stream-deck-plugin && pnpm test`
Expected: All tests pass.

**Step 3: Commit**

```
test(stream-deck-plugin): update Telemetry Display tests for template-only design
```

---

### Task 6: Simplify Property Inspector

**Files:**
- Modify: `packages/stream-deck-plugin/src/pi/telemetry-display.ejs`

**Step 1: Rewrite PI template**

Remove mode dropdown, conditional visibility JS, and rename settings:

```ejs
<!doctype html>
<html lang="en">
	<head>
		<%- include('head-common') %>
	</head>
	<body>
		<sdpi-item label="Title">
			<sdpi-textfield setting="title" default="TELEMETRY"></sdpi-textfield>
		</sdpi-item>

		<sdpi-item label="Template">
			<sdpi-textfield setting="template" default="{{telemetry.Speed}}"></sdpi-textfield>
		</sdpi-item>

		<div style="padding: 0 16px 8px; font-size: 11px; color: #9e9e9e; line-height: 1.5;">
			Use <b>{{telemetry.FieldName}}</b> placeholders.
			<a href="https://iracedeck.com/docs/template-variables" style="color: #9e9e9e;">Variable reference</a>
		</div>

		<sdpi-item label="Background Color">
			<sdpi-color setting="backgroundColor" default="#2a3444"></sdpi-color>
		</sdpi-item>

		<sdpi-item label="Text Color">
			<sdpi-color setting="textColor" default="#ffffff"></sdpi-color>
		</sdpi-item>

		<sdpi-item label="Font Size">
			<sdpi-select setting="fontSize" default="18">
				<option value="12">Small (12)</option>
				<option value="14">Medium (14)</option>
				<option value="18">Large (18)</option>
				<option value="24">Extra Large (24)</option>
			</sdpi-select>
		</sdpi-item>
	</body>
</html>
```

**Step 2: Build to regenerate HTML**

Run: `pnpm build:stream-deck` (or confirm watch mode is running).

**Step 3: Commit**

```
refactor(stream-deck-plugin): simplify Telemetry Display Property Inspector
```

---

### Task 7: Update manifest and actions reference

**Files:**
- Modify: `packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/manifest.json`
- Modify: `docs/reference/actions.json`

**Step 1: Update manifest tooltip**

In `manifest.json`, find the Telemetry Display action entry and update the tooltip:

```json
"Tooltip": "Display live telemetry values using custom templates"
```

No other manifest changes needed — the UUID, icon paths, and PI path stay the same.

**Step 2: Update actions.json**

Replace the Telemetry Display entry:

```json
{
  "id": "com.iracedeck.sd.core.telemetry-display",
  "name": "Telemetry Display",
  "file": "telemetry-display.ts",
  "encoder": false,
  "description": "Custom mustache template display for any telemetry or session variable"
}
```

Remove the `settingsKey` and `modes` fields — there are no modes anymore.

**Step 3: Commit**

```
docs: update Telemetry Display manifest and actions reference
```

---

### Task 8: Create website template variables reference page

**Files:**
- Create: `packages/website/public_html/docs/template-variables.html`

**Step 1: Generate the page**

Create a standalone HTML page. The telemetry variable list should be generated from `docs/reference/telemetry-vars.json` — read the JSON and write out every variable. Exclude `CarIdx*` array fields (length 64) and high-frequency `*_ST` fields (countAsTime: true) as they are not available in the template context.

The page structure:
- Minimal self-contained CSS (no external stylesheets)
- Jump links: Driver Info | Session | Track | Telemetry | Session Info
- Each section: heading, then a definition list of `{{placeholder}}` → description
- Driver Info section: list fields once with note about prefixes
- Telemetry section: every non-excluded variable from the JSON with unit in description
- Session Info section: note that these use dot-notation paths from iRacing YAML

Design for a small fixed-size window (no nav chrome, compact layout, scrollable body).

**Step 2: Test locally**

Open the HTML file in a browser and verify:
- Jump links work
- All sections render
- Readable at small window sizes (~400x500px)

**Step 3: Commit**

```
feat(website): add template variables reference page
```

---

### Task 9: Update design doc progress

**Files:**
- Modify: `docs/plans/2026-03-09-telemetry-display-rework-design.md`

**Step 1: Check off completed items in the Progress section**

Mark all completed items with `[x]`.

**Step 2: Commit**

```
docs: update telemetry display rework progress
```

---

### Task 10: Build verification and lint/format

**Step 1: Run lint and format**

Run: `pnpm lint:fix && pnpm format:fix`

**Step 2: Run all tests**

Run: `pnpm test`
Expected: All tests pass across all packages.

**Step 3: Run full build**

Run: `pnpm build`
Expected: Build succeeds with no TypeScript warnings (ignore Circular dependency warnings from zod).

**Step 4: Commit any fixes**

If lint/format made changes:
```
chore: fix lint and formatting
```

**Step 5: Remove docs/reference/template-variables.md**

The branch added this file but it's superseded by the website page. Delete it.

```
chore: remove superseded template-variables.md
```
