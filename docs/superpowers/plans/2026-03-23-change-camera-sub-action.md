# Change Camera Sub-Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Change Camera" sub-action to Camera Controls that switches directly to a user-selected camera group while keeping the currently viewed car.

**Architecture:** Adds `"change-camera"` as a 12th target to the existing CameraControls action (`camera-controls.ts`). Uses the same `switchNum()` SDK pattern already used by `cycle-camera` to maintain the viewed car while changing camera groups. The 20 camera-select icon SVGs already exist and are already imported.

**Tech Stack:** TypeScript, Zod, iRacing SDK commands, EJS templates, Vitest

**Issue:** #173

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/actions/src/actions/camera-controls.ts` | Modify | Add target, setting, icon map, key press handler |
| `packages/actions/src/actions/camera-controls.test.ts` | Modify | Add tests for new target |
| `packages/stream-deck-plugin/src/pi/camera-focus.ejs` | Modify | Add dropdown option + camera group selector |
| `docs/reference/actions.json` | Modify | Add `change-camera` mode to Camera Controls |
| `.claude/skills/iracedeck-actions/SKILL.md` | Modify | Update Camera Controls mode count and listing |

**Note:** The Mirabox plugin compiles its PI HTML from the same `camera-focus.ejs` template (via `piTemplatePlugin` in its rollup config pointing to `stream-deck-plugin/src/pi/`). No separate Mirabox PI update is needed — rebuilding covers both plugins.

**Design note:** Dial rotation (`onDialRotate`) is intentionally not supported for `change-camera`. It's a direct-select action (user picks a specific camera group), not a cycling action. The existing early return for non-cycle targets already handles this correctly.

**Design note:** `switchNum(carNumberRaw, cameraGroup, 0)` passes `0` for the sub-camera number, which means "use the first sub-camera in the group." This is intentional — the user is selecting a camera group, so getting its default sub-camera is the right behavior. This is consistent with the `cycle-camera` pattern (line 490).

---

### Task 1: Add `change-camera` target and `cameraGroup` setting

**Files:**
- Modify: `packages/actions/src/actions/camera-controls.ts:62-84` (target types)
- Modify: `packages/actions/src/actions/camera-controls.ts:130-142` (settings schema)

- [ ] **Step 1: Add `change-camera` to target values**

Add `"change-camera"` to the target enum. It's neither a cycle nor a focus target — it's its own category. Add it to `TARGET_VALUES` alongside the existing arrays:

```typescript
const CHANGE_CAMERA_TARGET_VALUES = ["change-camera"] as const;

const TARGET_VALUES = [...CYCLE_TARGET_VALUES, ...FOCUS_TARGET_VALUES, ...CHANGE_CAMERA_TARGET_VALUES] as const;

type Target = (typeof TARGET_VALUES)[number];
```

The `Target` type will automatically include `"change-camera"`. No need for a separate type guard — we'll just check `settings.target === "change-camera"` directly.

- [ ] **Step 2: Add `cameraGroup` setting**

Add `cameraGroup` to the settings schema (after `cameraState`):

```typescript
const CameraControlsSettings = CommonSettings.extend({
  target: z.enum(TARGET_VALUES).default("focus-your-car"),
  direction: z.enum(["next", "previous"]).default("next"),
  position: z.coerce.number().int().min(1).default(1),
  carNumber: z.coerce.number().int().min(0).default(0),
  cameraState: z.coerce.number().int().min(0).default(0),
  cameraGroup: z.coerce.number().int().min(1).max(20).default(9),
});
```

Default is 9 (Cockpit).

- [ ] **Step 3: Commit**

```bash
git add packages/actions/src/actions/camera-controls.ts
git commit -m "feat(actions): add change-camera target and cameraGroup setting to CameraControls"
```

---

### Task 2: Add `CAMERA_GROUP_MAP` and update icon generation

**Files:**
- Modify: `packages/actions/src/actions/camera-controls.ts:144-260` (icon maps + generation)

- [ ] **Step 1: Add `CAMERA_GROUP_MAP` constant**

Add after the existing `CAMERA_SELECT_ICONS` map (line 207). This maps group numbers to names and icons, reusing the already-imported SVGs:

```typescript
/**
 * @internal Exported for testing
 *
 * Camera group number → name and icon SVG for change-camera target
 */
export const CAMERA_GROUP_MAP: Record<number, { name: string; icon: string }> = {
  1: { name: "Nose", icon: noseSvg },
  2: { name: "Gearbox", icon: gearboxSvg },
  3: { name: "Roll Bar", icon: rollBarSvg },
  4: { name: "LF Susp", icon: lfSuspSvg },
  5: { name: "LR Susp", icon: lrSuspSvg },
  6: { name: "Gyro", icon: gyroSvg },
  7: { name: "RF Susp", icon: rfSuspSvg },
  8: { name: "RR Susp", icon: rrSuspSvg },
  9: { name: "Cockpit", icon: cockpitSvg },
  10: { name: "Blimp", icon: blimpSvg },
  11: { name: "Chopper", icon: chopperSvg },
  12: { name: "Chase", icon: chaseSvg },
  13: { name: "Far Chase", icon: farChaseSvg },
  14: { name: "Rear Chase", icon: rearChaseSvg },
  15: { name: "Pit Lane", icon: pitLaneSvg },
  16: { name: "Pit Lane 2", icon: pitLane2Svg },
  17: { name: "TV1", icon: tv1Svg },
  18: { name: "TV2", icon: tv2Svg },
  19: { name: "TV3", icon: tv3Svg },
  20: { name: "Scenic", icon: scenicSvg },
};
```

- [ ] **Step 2: Update `generateCameraControlsSvg` to handle `change-camera`**

Update the function signature to accept `cameraGroup` and add a branch for `change-camera`. The function currently handles cycle targets and focus targets — add `change-camera` as a third branch before the focus fallback:

```typescript
export function generateCameraControlsSvg(
  settings: { target: Target; direction?: Direction; cameraGroup?: number } & Partial<CommonSettings>,
): string {
  const { target, direction = "next" } = settings;

  let iconSvg: string;
  let labels: { mainLabel: string; subLabel: string };

  if (isCycleTarget(target)) {
    iconSvg = CYCLE_ICONS[target]?.[direction] || CYCLE_ICONS["cycle-camera"]["next"];
    labels = CYCLE_LABELS[target]?.[direction] || CYCLE_LABELS["cycle-camera"]["next"];
  } else if (target === "change-camera") {
    const group = CAMERA_GROUP_MAP[settings.cameraGroup ?? 9] ?? CAMERA_GROUP_MAP[9];
    iconSvg = group.icon;
    labels = { mainLabel: group.name.toUpperCase(), subLabel: "CAMERA" };
  } else {
    iconSvg = FOCUS_ICONS[target] || FOCUS_ICONS["focus-your-car"];
    labels = FOCUS_LABELS[target] || FOCUS_LABELS["focus-your-car"];
  }

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
    ...colors,
  });

  return svgToDataUri(svg);
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/actions/src/actions/camera-controls.ts
git commit -m "feat(actions): add CAMERA_GROUP_MAP and change-camera icon generation"
```

---

### Task 3: Add key press and dial handlers for `change-camera`

**Files:**
- Modify: `packages/actions/src/actions/camera-controls.ts:411-441` (onKeyDown, onDialDown, onDialRotate)
- Modify: `packages/actions/src/actions/camera-controls.ts:523-590` (executeFocus)

- [ ] **Step 1: Update `onKeyDown` and `onDialDown` to handle `change-camera`**

Add a third branch in `onKeyDown` and `onDialDown` for the new target. The `change-camera` handler needs its own method since it's neither a cycle nor a focus action:

```typescript
override async onKeyDown(ev: IDeckKeyDownEvent<CameraControlsSettings>): Promise<void> {
  this.logger.info("Key down received");
  const settings = this.parseSettings(ev.payload.settings);

  if (isCycleTarget(settings.target)) {
    this.executeCycle(settings.target, settings.direction);
  } else if (settings.target === "change-camera") {
    this.executeChangeCamera(settings.cameraGroup);
  } else {
    this.executeFocus(settings);
  }
}

override async onDialDown(ev: IDeckDialDownEvent<CameraControlsSettings>): Promise<void> {
  this.logger.info("Dial down received");
  const settings = this.parseSettings(ev.payload.settings);

  if (isCycleTarget(settings.target)) {
    this.executeCycle(settings.target, settings.direction);
  } else if (settings.target === "change-camera") {
    this.executeChangeCamera(settings.cameraGroup);
  } else {
    this.executeFocus(settings);
  }
}
```

- [ ] **Step 2: Add `executeChangeCamera` method**

Add after `executeFocus`. This follows the same `switchNum` pattern as `cycle-camera` (lines 484-498):

```typescript
private executeChangeCamera(cameraGroup: number): void {
  const telemetry = this.sdkController.getCurrentTelemetry();

  if (!telemetry) {
    this.logger.warn("No telemetry available for change camera");
    return;
  }

  const camera = getCommands().camera;
  const carIdx = telemetry.CamCarIdx ?? 0;
  const sessionInfo = this.sdkController.getSessionInfo();
  const carNumberRaw = sessionInfo ? getCarNumberRawFromSessionInfo(sessionInfo, carIdx) : null;

  if (carNumberRaw !== null) {
    const success = camera.switchNum(carNumberRaw, cameraGroup, 0);
    this.logger.info("Camera changed");
    this.logger.debug(`Result: ${success}, cameraGroup: ${cameraGroup}`);
  } else {
    this.logger.warn("Cannot change camera: car number not found in session info");
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/actions/src/actions/camera-controls.ts
git commit -m "feat(actions): add change-camera key press handler using switchNum"
```

---

### Task 4: Add tests for `change-camera`

**Files:**
- Modify: `packages/actions/src/actions/camera-controls.test.ts`

- [ ] **Step 1: Update test imports**

Add `CAMERA_GROUP_MAP` to the import:

```typescript
import {
  CAMERA_GROUPS_GLOBAL_KEY,
  CAMERA_GROUP_MAP,
  DEFAULT_CAMERA_GROUPS,
  DEFAULT_ENABLED_GROUPS,
  generateCameraControlsSvg,
  getEnabledGroupNames,
  getNextSelectedGroup,
} from "./camera-controls.js";
```

- [ ] **Step 2: Add `CAMERA_GROUP_MAP` tests**

Add a new `describe` block inside the `"constants"` describe:

```typescript
it("should have all 20 camera groups in CAMERA_GROUP_MAP", () => {
  expect(Object.keys(CAMERA_GROUP_MAP)).toHaveLength(20);
});

it("should have correct names for known groups", () => {
  expect(CAMERA_GROUP_MAP[1].name).toBe("Nose");
  expect(CAMERA_GROUP_MAP[9].name).toBe("Cockpit");
  expect(CAMERA_GROUP_MAP[17].name).toBe("TV1");
  expect(CAMERA_GROUP_MAP[20].name).toBe("Scenic");
});

it("should have icon SVGs for all groups", () => {
  for (const [, group] of Object.entries(CAMERA_GROUP_MAP)) {
    expect(group.icon).toBeTruthy();
  }
});
```

- [ ] **Step 3: Add `generateCameraControlsSvg` tests for `change-camera`**

Add a new `describe("change-camera target")` block inside `generateCameraControlsSvg`:

```typescript
describe("change-camera target", () => {
  it("should generate a valid data URI for change-camera with default group", () => {
    const result = generateCameraControlsSvg({ target: "change-camera" });
    expect(result).toContain("data:image/svg+xml");
  });

  it("should use Cockpit icon for default cameraGroup (9)", () => {
    const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "change-camera", cameraGroup: 9 }));
    expect(decoded).toContain("cockpit");
    expect(decoded).toContain("COCKPIT");
  });

  it("should use Nose icon for cameraGroup 1", () => {
    const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "change-camera", cameraGroup: 1 }));
    expect(decoded).toContain("nose");
    expect(decoded).toContain("NOSE");
  });

  it("should use TV1 icon for cameraGroup 17", () => {
    const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "change-camera", cameraGroup: 17 }));
    expect(decoded).toContain("tv1");
    expect(decoded).toContain("TV1");
  });

  it("should include CAMERA sublabel", () => {
    const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "change-camera", cameraGroup: 1 }));
    expect(decoded).toContain("CAMERA");
  });

  it("should fall back to Cockpit for invalid cameraGroup", () => {
    const decoded = decodeURIComponent(generateCameraControlsSvg({ target: "change-camera", cameraGroup: 99 }));
    expect(decoded).toContain("cockpit");
  });

  it("should produce different icons for different camera groups", () => {
    const groups = [1, 9, 12, 17];
    const results = groups.map((g) => generateCameraControlsSvg({ target: "change-camera", cameraGroup: g }));
    const uniqueResults = new Set(results);
    expect(uniqueResults.size).toBe(groups.length);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/actions/src/actions/camera-controls.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/actions/src/actions/camera-controls.test.ts
git commit -m "test(actions): add change-camera sub-action tests"
```

---

### Task 5: Update Property Inspector template

**Files:**
- Modify: `packages/stream-deck-plugin/src/pi/camera-focus.ejs:54-96` (dropdown + conditional items)
- Modify: `packages/stream-deck-plugin/src/pi/camera-focus.ejs:209-233` (updateVisibility function)

- [ ] **Step 1: Add "Change Camera" option to target dropdown**

Add after the `set-camera-state` option (line 66):

```html
<option value="change-camera">Change Camera</option>
```

- [ ] **Step 2: Add camera group dropdown**

Add after the `camera-state-item` (line 96), before `common-settings`:

```html
<sdpi-item label="Camera Group" id="camera-group-item" class="hidden">
  <sdpi-select setting="cameraGroup" default="9">
    <option value="1">Nose</option>
    <option value="2">Gearbox</option>
    <option value="3">Roll Bar</option>
    <option value="4">LF Susp</option>
    <option value="5">LR Susp</option>
    <option value="6">Gyro</option>
    <option value="7">RF Susp</option>
    <option value="8">RR Susp</option>
    <option value="9">Cockpit</option>
    <option value="10">Blimp</option>
    <option value="11">Chopper</option>
    <option value="12">Chase</option>
    <option value="13">Far Chase</option>
    <option value="14">Rear Chase</option>
    <option value="15">Pit Lane</option>
    <option value="16">Pit Lane 2</option>
    <option value="17">TV1</option>
    <option value="18">TV2</option>
    <option value="19">TV3</option>
    <option value="20">Scenic</option>
  </sdpi-select>
</sdpi-item>
```

- [ ] **Step 3: Update `updateVisibility` function**

Add the camera group visibility toggle inside `updateVisibility` (after line 232):

```javascript
var cameraGroupItem = document.getElementById("camera-group-item");
if (cameraGroupItem) {
  cameraGroupItem.classList.toggle("hidden", target !== "change-camera");
}
```

- [ ] **Step 4: Build and verify**

Run: `pnpm build`
Expected: Build succeeds with no TypeScript errors. Check the output for any `TS` diagnostics.

- [ ] **Step 5: Commit**

```bash
git add packages/stream-deck-plugin/src/pi/camera-focus.ejs
git commit -m "feat(stream-deck-plugin): add Change Camera dropdown to Camera Controls PI"
```

---

### Task 6: Update documentation and skills

**Files:**
- Modify: `docs/reference/actions.json:424-436` (Camera Controls modes array)
- Modify: `.claude/skills/iracedeck-actions/SKILL.md:41,81` (View & Camera counts + Camera Controls row)

- [ ] **Step 1: Update `docs/reference/actions.json`**

Add `change-camera` to the Camera Controls action's modes array (after `set-camera-state` on line 435):

```json
{ "value": "change-camera", "label": "Change Camera" }
```

- [ ] **Step 2: Update `.claude/skills/iracedeck-actions/SKILL.md`**

Update the View & Camera category overview row (line 41) — change control count from `102` to `103`:

```markdown
| View & Camera | 5 | 103 | FOV, replay, camera controls, broadcast tools |
```

Update the Camera Controls row (line 81) — change mode count from `11` to `12` and add "change camera" to the description:

```markdown
| Camera Controls | 12 | Cycle: camera (with group subset selection), sub-camera, car, driving; Focus: your car, leader, incident, exiting, by position, by car number, camera state; Change: direct camera group select |
```

- [ ] **Step 3: Commit**

```bash
git add docs/reference/actions.json .claude/skills/iracedeck-actions/SKILL.md
git commit -m "docs: add Change Camera sub-action to actions reference and skills"
```

---

## Verification

After all tasks are complete:

1. `pnpm test --filter @iracedeck/actions` — all tests pass
2. `pnpm build` — no TypeScript errors (check full output for `TS[0-9]+:` patterns)
3. `pnpm lint:fix && pnpm format:fix` — no remaining issues
4. Manual test: Add Camera Controls button → select "Change Camera" → select a camera group → verify icon updates → press in iRacing → verify camera switches while keeping viewed car
