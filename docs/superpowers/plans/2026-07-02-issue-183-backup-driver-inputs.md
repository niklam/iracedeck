# Backup Driver Input Controls (Issue #183) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four backup driver input modes — Handbrake, Second Clutch, Second Up Shift, Second Down Shift — to the existing Car Control action.

**Architecture:** Extend the Car Control action's mode enum, dispatch tables, and static-icon maps; add four graphic-snippet SVGs, four key-binding entries, and four comms-catalog descriptors. All icon assembly, hold/tap dispatch, missing-binding warnings, and PI status lines are handled by existing generic code once the mappings exist. Spec: `docs/superpowers/specs/2026-07-02-issue-183-backup-driver-inputs-design.md`.

**Tech Stack:** TypeScript, Zod, Vitest, EJS PI templates, Mustache SVG snippets, pnpm/turbo monorepo.

## Global Constraints

- Naming follows iRacing's Controls UI (per `docs/keyboard-shortcuts.md`): labels **Handbrake**, **Second Clutch**, **Second Up Shift**, **Second Down Shift**; control values `handbrake`, `second-clutch`, `second-up-shift`, `second-down-shift`; global setting keys `carControlHandbrake`, `carControlSecondClutch`, `carControlSecondUpShift`, `carControlSecondDownShift`.
- All four modes are key-binding only: no SDK support, no default key (empty `default` everywhere), no telemetry awareness.
- Handbrake and Second Clutch use the **hold** pattern; the two shifts are **tap**.
- Icons use only safe SVG Tiny 1.2 features (shapes, text, opacity — no filters/masks/clipPath/`<style>`), per `.claude/rules/svg-platform-compatibility.md`.
- Working directory: `C:\Users\Niklas\Projects\iRaceDeck\ir-183` (worktree, branch `feat/backup-driver-inputs`). No watcher is running — run all builds/tests manually. All commands run from the worktree root.
- If a full `pnpm build` fails with EPERM on `iracing_native.node`, a deck host app (Stream Deck / UlanziStudio) is holding the lock — stop and ask the user to quit it.
- Commit after every task with a conventional-commit message ending in `(#183)`.

---

### Task 1: Icon SVGs + generated previews/defaults

**Files:**
- Create: `packages/icons/car-control/handbrake.svg`
- Create: `packages/icons/car-control/second-clutch.svg`
- Create: `packages/icons/car-control/second-up-shift.svg`
- Create: `packages/icons/car-control/second-down-shift.svg`
- Generated: `packages/icons/preview/car-control/*.svg` (script output)
- Generated: `packages/iracing-actions/src/actions/data/icon-defaults.json` (script output)

**Interfaces:**
- Consumes: nothing.
- Produces: SVG modules imported by Task 2 as `@iracedeck/icons/car-control/<name>.svg`. Each has `<desc>` JSON metadata with `backgroundColor` `#2a3a2a` and a `title.text` default.

- [ ] **Step 1: Author `handbrake.svg`**

The dashboard handbrake warning symbol — circle with an exclamation mark, flanked by parenthesis arcs — in fixed semantic red (`#e74c3c`, like starter's fixed red; no `{{graphic1Color}}`, so global color presets can't clash):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 48" stroke-width="0.5" stroke="#fff" fill="#fff">
  <desc>{"colors":{"backgroundColor":"#2a3a2a","textColor":"#ffffff"},"title":{"text":"HANDBRAKE"},"border":{"color":"#5a6a5a"}}</desc>

    <path d="M 12 5 A 25 25 0 0 0 12 43" fill="none" stroke="#e74c3c" stroke-width="5" stroke-linecap="round"/>
    <path d="M 60 5 A 25 25 0 0 1 60 43" fill="none" stroke="#e74c3c" stroke-width="5" stroke-linecap="round"/>
    <circle cx="36" cy="24" r="17" fill="none" stroke="#e74c3c" stroke-width="5"/>
    <rect x="34" y="13" width="4" height="13" rx="2" fill="#e74c3c" stroke="none"/>
    <circle cx="36" cy="32" r="2.5" fill="#e74c3c" stroke="none"/>

</svg>
```

- [ ] **Step 2: Author the three "2ND" icons**

All three share a gold `#f39c12` "2ND" badge (dark text, fixed colors — text inside graphics is never colorizable) to distinguish them from other arrow/disc icons; primary artwork uses `{{graphic1Color}}`.

`second-clutch.svg` — clutch friction disc (rim, hub, four spring circles) + badge:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 66" stroke-width="0.5" stroke="#fff" fill="#fff">
  <desc>{"colors":{"backgroundColor":"#2a3a2a","textColor":"#ffffff","graphic1Color":"#ffffff"},"title":{"text":"2ND\nCLUTCH"},"border":{"color":"#5a6a5a"}}</desc>

    <circle cx="30" cy="30" r="27" fill="none" stroke="{{graphic1Color}}" stroke-width="4"/>
    <circle cx="30" cy="30" r="7" fill="{{graphic1Color}}" stroke="none"/>
    <circle cx="30" cy="13" r="4.5" fill="{{graphic1Color}}" stroke="none" opacity="0.6"/>
    <circle cx="30" cy="47" r="4.5" fill="{{graphic1Color}}" stroke="none" opacity="0.6"/>
    <circle cx="13" cy="30" r="4.5" fill="{{graphic1Color}}" stroke="none" opacity="0.6"/>
    <circle cx="47" cy="30" r="4.5" fill="{{graphic1Color}}" stroke="none" opacity="0.6"/>
    <rect x="34" y="48" width="30" height="18" rx="4" fill="#f39c12" stroke="none"/>
    <text x="49" y="57" text-anchor="middle" dominant-baseline="central" fill="#2a2a2a" font-family="Arial, sans-serif" font-size="11" font-weight="bold" stroke="none">2ND</text>

</svg>
```

`second-up-shift.svg` — bold up arrow + badge:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 58 64" stroke-width="0.5" stroke="#fff" fill="#fff">
  <desc>{"colors":{"backgroundColor":"#2a3a2a","textColor":"#ffffff","graphic1Color":"#ffffff"},"title":{"text":"2ND\nSHIFT UP"},"border":{"color":"#5a6a5a"}}</desc>

    <polygon points="25,0 46,24 34,24 34,46 16,46 16,24 4,24" fill="{{graphic1Color}}" stroke="none"/>
    <rect x="28" y="46" width="30" height="18" rx="4" fill="#f39c12" stroke="none"/>
    <text x="43" y="55" text-anchor="middle" dominant-baseline="central" fill="#2a2a2a" font-family="Arial, sans-serif" font-size="11" font-weight="bold" stroke="none">2ND</text>

</svg>
```

`second-down-shift.svg` — the same arrow pointing down (badge in the same spot):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 58 64" stroke-width="0.5" stroke="#fff" fill="#fff">
  <desc>{"colors":{"backgroundColor":"#2a3a2a","textColor":"#ffffff","graphic1Color":"#ffffff"},"title":{"text":"2ND\nSHIFT DOWN"},"border":{"color":"#5a6a5a"}}</desc>

    <polygon points="25,46 4,22 16,22 16,0 34,0 34,22 46,22" fill="{{graphic1Color}}" stroke="none"/>
    <rect x="28" y="46" width="30" height="18" rx="4" fill="#f39c12" stroke="none"/>
    <text x="43" y="55" text-anchor="middle" dominant-baseline="central" fill="#2a2a2a" font-family="Arial, sans-serif" font-size="11" font-weight="bold" stroke="none">2ND</text>

</svg>
```

(On `second-down-shift.svg` the arrow occupies y 0–46 and the badge y 46–64; the down arrow head is at the bottom-left region, so the badge overlapping bottom-right stays legible. Inspect the generated previews and nudge coordinates if anything clips — the viewBox must stay trimmed to the artwork extent.)

- [ ] **Step 3: Regenerate previews and icon defaults**

```bash
node scripts/generate-icon-previews.mjs
node scripts/generate-icon-defaults.mjs
```

Expected: four new files under `packages/icons/preview/car-control/`; `icon-defaults.json` diff only adds/changes nothing for `car-control` (the PI defaults for car-control come from its existing entry — verify the diff and keep whatever the script writes).

- [ ] **Step 4: Visually inspect the previews**

Read the four files in `packages/icons/preview/car-control/` (they have colors baked in) and confirm: nothing clips outside the viewBox, the badge doesn't cover the arrow head, the handbrake symbol reads as ⚠-style brake light. Adjust source SVGs and re-run the preview script if needed.

- [ ] **Step 5: Run the icon freshness test**

```bash
npx vitest run packages/icons
```

Expected: PASS (previews match templates).

- [ ] **Step 6: Commit**

```bash
git add packages/icons packages/iracing-actions/src/actions/data/icon-defaults.json
git commit -m "feat(icons): add handbrake, second clutch, and second shift car-control icons (#183)"
```

---

### Task 2: Car Control action — modes, dispatch, tests (TDD)

**Files:**
- Modify: `packages/iracing-actions/src/actions/car-control/car-control.ts`
- Test: `packages/iracing-actions/src/actions/car-control/car-control.test.ts`

**Interfaces:**
- Consumes: the four SVG modules from Task 1.
- Produces: control values `handbrake` / `second-clutch` / `second-up-shift` / `second-down-shift` accepted by `CarControlSettings`; `CAR_CONTROL_GLOBAL_KEYS` entries `carControlHandbrake` / `carControlSecondClutch` / `carControlSecondUpShift` / `carControlSecondDownShift` (Tasks 3–5 must use these exact strings).

- [ ] **Step 1: Write the failing tests**

In `car-control.test.ts`, add icon mocks next to the existing `vi.mock` blocks (top of file):

```typescript
vi.mock("@iracedeck/icons/car-control/handbrake.svg", () => ({
  default: "<svg>handbrake-icon</svg>",
}));
vi.mock("@iracedeck/icons/car-control/second-clutch.svg", () => ({
  default: "<svg>second-clutch-icon</svg>",
}));
vi.mock("@iracedeck/icons/car-control/second-up-shift.svg", () => ({
  default: "<svg>second-up-shift-icon</svg>",
}));
vi.mock("@iracedeck/icons/car-control/second-down-shift.svg", () => ({
  default: "<svg>second-down-shift-icon</svg>",
}));
```

In the `CAR_CONTROL_GLOBAL_KEYS` describe block, add four mapping tests and update the count test (10 → 14):

```typescript
it("should have correct mapping for handbrake", () => {
  expect(CAR_CONTROL_GLOBAL_KEYS["handbrake"]).toBe("carControlHandbrake");
});

it("should have correct mapping for second-clutch", () => {
  expect(CAR_CONTROL_GLOBAL_KEYS["second-clutch"]).toBe("carControlSecondClutch");
});

it("should have correct mapping for second-up-shift", () => {
  expect(CAR_CONTROL_GLOBAL_KEYS["second-up-shift"]).toBe("carControlSecondUpShift");
});

it("should have correct mapping for second-down-shift", () => {
  expect(CAR_CONTROL_GLOBAL_KEYS["second-down-shift"]).toBe("carControlSecondDownShift");
});

it("should have exactly 14 entries", () => {
  expect(Object.keys(CAR_CONTROL_GLOBAL_KEYS)).toHaveLength(14);
});
```

(The existing `"should have exactly 10 entries"` test is replaced by the 14-entry version — delete the old one.)

Add a new describe block for the backup input modes (place after the `"long-press behavior (starter)"` block):

```typescript
describe("backup driver inputs (issue #183)", () => {
  let action: CarControl;

  beforeEach(() => {
    action = new CarControl();
  });

  it("should generate valid data URIs with the default titles for all four modes", () => {
    const expected: Record<string, string[]> = {
      handbrake: ["HANDBRAKE"],
      "second-clutch": ["2ND", "CLUTCH"],
      "second-up-shift": ["2ND", "SHIFT UP"],
      "second-down-shift": ["2ND", "SHIFT DOWN"],
    };

    for (const [control, labels] of Object.entries(expected)) {
      const result = generateCarControlSvg({ control: control as any });

      expect(result).toContain("data:image/svg+xml");
      const decoded = decodeURIComponent(result);

      for (const label of labels) {
        expect(decoded).toContain(label);
      }
    }
  });

  it("should produce a distinct icon per mode", () => {
    const controls = ["handbrake", "second-clutch", "second-up-shift", "second-down-shift"] as const;
    const unique = new Set(controls.map((control) => generateCarControlSvg({ control })));

    expect(unique.size).toBe(controls.length);
  });

  it("should hold the handbrake binding on keyDown and release on keyUp", async () => {
    await action.onKeyDown(fakeEvent("action-1", { control: "handbrake" }) as any);

    expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlHandbrake");
    expect(mockTapBinding).not.toHaveBeenCalled();

    await action.onKeyUp(fakeEvent("action-1") as any);

    expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
  });

  it("should hold the second-clutch binding on keyDown and release on keyUp", async () => {
    await action.onKeyDown(fakeEvent("action-1", { control: "second-clutch" }) as any);

    expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlSecondClutch");
    expect(mockTapBinding).not.toHaveBeenCalled();

    await action.onKeyUp(fakeEvent("action-1") as any);

    expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
  });

  it("should hold on dialDown and release on dialUp for handbrake", async () => {
    await action.onDialDown(fakeEvent("action-1", { control: "handbrake" }) as any);

    expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "carControlHandbrake");

    await action.onDialUp(fakeEvent("action-1") as any);

    expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
  });

  it("should tap the second-up-shift binding on keyDown", async () => {
    await action.onKeyDown(fakeEvent("action-1", { control: "second-up-shift" }) as any);

    expect(mockTapBinding).toHaveBeenCalledWith("carControlSecondUpShift");
    expect(mockHoldBinding).not.toHaveBeenCalled();
  });

  it("should tap the second-down-shift binding on keyDown", async () => {
    await action.onKeyDown(fakeEvent("action-1", { control: "second-down-shift" }) as any);

    expect(mockTapBinding).toHaveBeenCalledWith("carControlSecondDownShift");
    expect(mockHoldBinding).not.toHaveBeenCalled();
  });

  it("should release a held handbrake on onWillDisappear", async () => {
    await action.onKeyDown(fakeEvent("action-1", { control: "handbrake" }) as any);
    await action.onWillDisappear(fakeEvent("action-1", { control: "handbrake" }) as any);

    expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run packages/iracing-actions/src/actions/car-control/car-control.test.ts
```

Expected: FAIL — the four mapping tests get `undefined`, the 14-entry test gets 10, the icon tests fall back to the starter icon (no distinct icons), and the dispatch tests warn "No global key mapping".

- [ ] **Step 3: Implement in `car-control.ts`**

Add SVG imports (keep the import list alphabetical by path):

```typescript
import handbrakeIcon from "@iracedeck/icons/car-control/handbrake.svg";
import secondClutchIcon from "@iracedeck/icons/car-control/second-clutch.svg";
import secondDownShiftIcon from "@iracedeck/icons/car-control/second-down-shift.svg";
import secondUpShiftIcon from "@iracedeck/icons/car-control/second-up-shift.svg";
```

Extend `CarControlType` (append after `"escape"`):

```typescript
type CarControlType =
  | "starter"
  | "ignition"
  | "pit-speed-limiter"
  | "enter-exit-tow"
  | "pause-sim"
  | "headlight-flash"
  | "push-to-pass"
  | "drs"
  | "tear-off-visor"
  | "escape"
  | "handbrake"
  | "second-clutch"
  | "second-up-shift"
  | "second-down-shift";
```

Extend `CAR_CONTROL_STATIC_TITLES`:

```typescript
  escape: "ESCAPE",
  handbrake: "HANDBRAKE",
  "second-clutch": "2ND\nCLUTCH",
  "second-up-shift": "2ND\nSHIFT UP",
  "second-down-shift": "2ND\nSHIFT DOWN",
```

Extend `HOLD_CONTROLS`:

```typescript
const HOLD_CONTROLS = new Set<CarControlType>([
  "starter",
  "headlight-flash",
  "enter-exit-tow",
  "handbrake",
  "second-clutch",
]);
```

Extend `STATIC_CAR_CONTROL_ICONS`:

```typescript
  escape: escapeIcon,
  handbrake: handbrakeIcon,
  "second-clutch": secondClutchIcon,
  "second-up-shift": secondUpShiftIcon,
  "second-down-shift": secondDownShiftIcon,
```

Extend `CAR_CONTROL_GLOBAL_KEYS`:

```typescript
  "tear-off-visor": "carControlTearOffVisor",
  escape: "",
  handbrake: "carControlHandbrake",
  "second-clutch": "carControlSecondClutch",
  "second-up-shift": "carControlSecondUpShift",
  "second-down-shift": "carControlSecondDownShift",
```

Extend the Zod enum in `CarControlSettings` (append after `"pause-sim"`):

```typescript
      "pause-sim",
      "handbrake",
      "second-clutch",
      "second-up-shift",
      "second-down-shift",
```

Update the class JSDoc line listing hold controls:

```typescript
 * Provides core car operation controls (starter, ignition, pit limiter, enter/exit/tow, pause,
 * headlight flash, push to pass, DRS, tear off visor, escape, and backup inputs: handbrake,
 * second clutch, second up/down shift).
 * Starter, headlight flash, enter/exit/tow, handbrake, and second clutch use long-press
 * (hold while pressed); all others use tap.
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/iracing-actions/src/actions/car-control/car-control.test.ts
```

Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-actions/src/actions/car-control/car-control.ts packages/iracing-actions/src/actions/car-control/car-control.test.ts
git commit -m "feat(actions): add backup driver input modes to Car Control (#183)"
```

---

### Task 3: Key bindings + comms catalog

**Files:**
- Modify: `packages/iracing-actions/src/actions/data/key-bindings.json` (the `carControl` array)
- Modify: `packages/iracing-actions/src/actions/comms-catalog.ts` (the `"car-control"` entry, ~line 120)
- Generated: `packages/iracing-actions/src/actions/data/action-comms.json` (via `pnpm generate:action-comms`)

**Interfaces:**
- Consumes: the setting keys produced by Task 2 (`carControlHandbrake`, `carControlSecondClutch`, `carControlSecondUpShift`, `carControlSecondDownShift`) — must match exactly (a cross-check test verifies every comms keybind key exists in `key-bindings.json`).
- Produces: PI key-binding rows (rendered by the `global-key-bindings` partial) and per-mode comms descriptors (consumed by `ird-binding-status` and by the docs in Task 5).

- [ ] **Step 1: Append the four entries to `key-bindings.json` → `carControl`**

After the `tearOffVisor` entry:

```json
    {
      "id": "handbrake",
      "label": "Handbrake",
      "default": "",
      "setting": "carControlHandbrake"
    },
    {
      "id": "secondClutch",
      "label": "Second Clutch",
      "default": "",
      "setting": "carControlSecondClutch"
    },
    {
      "id": "secondUpShift",
      "label": "Second Up Shift",
      "default": "",
      "setting": "carControlSecondUpShift"
    },
    {
      "id": "secondDownShift",
      "label": "Second Down Shift",
      "default": "",
      "setting": "carControlSecondDownShift"
    }
```

- [ ] **Step 2: Extend the `"car-control"` entry in `comms-catalog.ts`**

Insert before the `// Hardcoded Escape` comment line:

```typescript
    handbrake: keybind("carControlHandbrake"),
    "second-clutch": keybind("carControlSecondClutch"),
    "second-up-shift": keybind("carControlSecondUpShift"),
    "second-down-shift": keybind("carControlSecondDownShift"),
```

- [ ] **Step 3: Regenerate the comms JSON**

```bash
pnpm generate:action-comms
```

Expected: `packages/iracing-actions/src/actions/data/action-comms.json` diff shows the four new `car-control` keybind modes.

- [ ] **Step 4: Run the iracing-actions test suite (freshness + cross-check + car-control)**

```bash
npx vitest run packages/iracing-actions
```

Expected: PASS — including the comms freshness test and the key cross-check against `key-bindings.json`.

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-actions/src/actions/data/key-bindings.json packages/iracing-actions/src/actions/comms-catalog.ts packages/iracing-actions/src/actions/data/action-comms.json
git commit -m "feat(actions): register backup input key bindings and comms descriptors (#183)"
```

---

### Task 4: Property Inspector dropdown + build

**Files:**
- Modify: `packages/iracing-actions/src/actions/car-control/car-control.ejs`

**Interfaces:**
- Consumes: control values from Task 2, comms JSON from Task 3 (already wired via the existing `ird-binding-status` include).
- Produces: compiled `ui/car-control.html` in each plugin (build output, not committed).

- [ ] **Step 1: Append the four options to the Control dropdown**

After `<option value="pause-sim">Pause Sim</option>`:

```html
					<option value="handbrake">Handbrake</option>
					<option value="second-clutch">Second Clutch</option>
					<option value="second-up-shift">Second Up Shift</option>
					<option value="second-down-shift">Second Down Shift</option>
```

(The file uses tab indentation — match it.)

- [ ] **Step 2: Full build to compile templates and type-check everything**

```bash
pnpm build
```

Expected: success. (If EPERM on `iracing_native.node`: a deck host app holds the lock — ask the user to quit it, don't work around.)

- [ ] **Step 3: Commit**

```bash
git add packages/iracing-actions/src/actions/car-control/car-control.ejs
git commit -m "feat(pi): add backup driver input options to the Car Control dropdown (#183)"
```

---

### Task 5: Docs, reference data, skill, changelog

**Files:**
- Modify: `packages/website/src/content/docs/docs/actions/driving/car-control.md`
- Modify: `packages/website/src/content/docs/changelog.mdx` (1.24.0 section)
- Modify: `docs/reference/actions.json` (car-control `modes` array, ~line 129)
- Modify: `.claude/skills/iracedeck-actions/SKILL.md` (category table + Car Control row)

**Interfaces:**
- Consumes: final mode labels/values and hold/tap semantics from Tasks 2–4.
- Produces: user-facing docs; nothing downstream.

- [ ] **Step 1: Update the website car-control page**

Frontmatter badge: `text: "10 modes"` → `text: "14 modes"`. Intro paragraph — replace the existing sentence with:

```markdown
Quick access to essential car functions: toggle the pit speed limiter, headlights, Push To Pass, DRS, starter, ignition, or tear off your visor — plus exit the car with Escape, pause the sim, and backup driver inputs (handbrake, second clutch, second shift) for when primary hardware fails — all from a single button.
```

Append after the Pause Sim section (which currently ends the file — add a `---` separator before each new section, none after the last):

```markdown
---

### Handbrake

Apply the handbrake while the button is held — a backup control for when your handbrake hardware fails mid-session.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support; press and hold the dial to apply the handbrake, release to let go
- **Default binding:** No default key binding — Handbrake has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Second Clutch

Engage iRacing's Second Clutch while the button is held — a backup for a failed clutch pedal.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support; press and hold the dial to engage the clutch, release to let go
- **Default binding:** No default key binding — Second Clutch has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Second Up Shift

Shift up a gear via iRacing's Second Up Shift control — a backup for a broken upshift paddle.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — Second Up Shift has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Second Down Shift

Shift down a gear via iRacing's Second Down Shift control — a backup for a broken downshift paddle.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — Second Down Shift has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** No

#### Settings

- No additional settings
```

- [ ] **Step 2: Add the changelog entry**

In `changelog.mdx`, under `## 1.24.0` → `**Features**`, append the bullet:

```markdown
- Car Control gained four backup driver input modes — **Handbrake**, **Second Clutch**, **Second Up Shift**, and **Second Down Shift** — so you can keep driving when a shifter paddle, clutch pedal, or handbrake fails mid-session. Handbrake and Second Clutch stay engaged while the button is held; the shifts are single taps. None have default iRacing bindings, so set the binding in both iRacing and the Property Inspector.
```

- [ ] **Step 3: Update `docs/reference/actions.json`**

Append to the car-control `modes` array after the `pause-sim` entry:

```json
            { "value": "handbrake", "label": "Handbrake", "controlType": "hold" },
            { "value": "second-clutch", "label": "Second Clutch", "controlType": "hold" },
            { "value": "second-up-shift", "label": "Second Up Shift" },
            { "value": "second-down-shift", "label": "Second Down Shift" }
```

- [ ] **Step 4: Update the `iracedeck-actions` skill**

In `.claude/skills/iracedeck-actions/SKILL.md`:

- Category table: `| Driving Controls | 6 | 31 |` → `| Driving Controls | 6 | 35 |`; total row `| **Total** | **31** | **291** |` → `| **Total** | **31** | **295** |`.
- Car Control row: change `| Car Control | 10 |` to `| Car Control | 14 |` and append to its mode list (before the closing ` |`):

```text
, handbrake (hold), second-clutch (hold), second-up-shift, second-down-shift (backup driver inputs, #183 — no default iRacing bindings)
```

- [ ] **Step 5: Build the website**

```bash
pnpm --filter @iracedeck/website build
```

Expected: success; the changelog page and `/docs/actions/driving/car-control/` render.

- [ ] **Step 6: Commit**

```bash
git add packages/website/src/content/docs/docs/actions/driving/car-control.md packages/website/src/content/docs/changelog.mdx docs/reference/actions.json .claude/skills/iracedeck-actions/SKILL.md
git commit -m "docs: document Car Control backup driver input modes (#183)"
```

---

### Task 6: Full verification

**Files:** none new — verification only (plus any fixups it forces).

- [ ] **Step 1: Lint and format**

```bash
pnpm lint:fix
pnpm format:fix
```

Expected: exit 0. Fix any reported issue (never dismiss pre-existing ones — fix them too).

- [ ] **Step 2: Full build and full test suite**

```bash
pnpm build
pnpm test
```

Expected: both pass. (`pnpm build` catches type errors vitest's esbuild path tolerates — do not skip it.)

- [ ] **Step 3: Commit any fixup diffs**

```bash
git status --short
```

If lint/format changed files: `git add -A && git commit -m "chore: lint/format fixups (#183)"`. If clean, nothing to do.

- [ ] **Step 4: STOP — hand back to the user**

Do NOT push and do NOT create a PR. The user manually tests in iRacing first (per project workflow), then decides on push/PR.
