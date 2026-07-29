# Pit Crew "Corner Names" Toggle Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `corner-names` mode to the Pit Crew action that toggles the corner-name callouts (#888) from a deck key, with a spoken acknowledgment (issue #897).

**Architecture:** The key flips the existing `calloutEnabledCornerNames` global setting — the same key the PI checkbox writes — so both surfaces mirror one value and the corner-name scenario's live-read opt-in gate picks the change up on the next event with no re-registration. The toggle helper lives in `src/audio/audio-toggles.ts` beside `toggleRaceEngineerFeature`/`toggleRadarFeature` (the #554 UI-side ack pattern); a new `calloutEnabledToggleCornerNames` opt-in (default ON) gates the ack, and the ack additionally respects the Race Engineer master gate — master off means silent flip, no bus-mute bypass needed since flipping corner names never mutes Voice.

**Tech Stack:** TypeScript, Zod, Vitest, EJS Property Inspector templates, ElevenLabs TTS (paid — generation is a user-gated step).

## Global Constraints

- Mode value is `"corner-names"`, user-facing label **"Corner Names"** — never "Turn Names" (decided in #897; matches the shipped #888 terminology).
- Ack opt-in key is `calloutEnabledToggleCornerNames` (the `callout<Polarity><Family><Subject>` convention), Zod default `true` — new Race Engineer functionality defaults ON.
- The toggled setting is the EXISTING `calloutEnabledCornerNames`; do not introduce a second gate for the callout itself.
- No new bus event, no audio-scenarios change, no `registerPitCrew` parameter, no comms-catalog entry (Pit Crew is internal for #612), no scenario-harness change.
- After the `GlobalSettingsSchema` change, verify with `pnpm build --force` — turbo caches deck-core and a plain `pnpm build` can falsely pass.
- ElevenLabs generation is paid: always `generate:dry-run --group toggle` first and confirm it lists ONLY the two new entries; never run unfiltered `generate`.
- Commit after each task (conventional commits, no `--no-verify`). Do NOT push or open a PR — the user manual-tests in iRacing first.

---

### Task 1: `calloutEnabledToggleCornerNames` schema field (deck-core)

**Files:**
- Modify: `packages/deck-core/src/global-settings.ts` (insert after the `calloutEnabledToggleRaceEngineer` field, ~line 549)
- Modify: `packages/deck-core/src/simhub-service.test.ts` (BOTH settings literals — ~line 104 and ~line 290, next to `calloutEnabledToggleRaceEngineer: true`)
- Test: `packages/deck-core/src/global-settings.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GlobalSettings.calloutEnabledToggleCornerNames: boolean` (default `true`) — read via `getGlobalSettings()` in Task 2.

- [ ] **Step 1: Write the failing test**

Add a new describe block in `packages/deck-core/src/global-settings.test.ts`, after the existing callout-defaults blocks (e.g. after the "spotter callout defaults" block), in the same style:

```typescript
describe("corner-names toggle ack opt-in default (issue #897)", () => {
  it("defaults calloutEnabledToggleCornerNames to true", () => {
    const parsed = GlobalSettingsSchema.parse({}) as Record<string, unknown>;
    expect(parsed.calloutEnabledToggleCornerNames).toBe(true);
  });

  it("coerces the string 'false' to boolean false", () => {
    const parsed = GlobalSettingsSchema.parse({ calloutEnabledToggleCornerNames: "false" }) as Record<string, unknown>;
    expect(parsed.calloutEnabledToggleCornerNames).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/deck-core/src/global-settings.test.ts`
Expected: FAIL — `parsed.calloutEnabledToggleCornerNames` is `undefined`.

- [ ] **Step 3: Add the schema field**

In `packages/deck-core/src/global-settings.ts`, directly after the `calloutEnabledToggleRaceEngineer` field (keep the JSDoc style of its neighbours):

```typescript
    /**
     * Corner Names toggle acknowledgment (issue #897). When enabled, the Pit
     * Crew Corner Names key speaks a short confirmation on every toggle.
     * Only gates the ack — the toggle itself always applies. Default `true`.
     */
    calloutEnabledToggleCornerNames: z
      .union([z.boolean(), z.string()])
      .transform((val) => val === true || val === "true")
      .default(true),
```

In `packages/deck-core/src/simhub-service.test.ts`, add to BOTH object literals, next to the existing key (lines ~104 and ~290):

```typescript
      calloutEnabledToggleCornerNames: true,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/deck-core/src/global-settings.test.ts packages/deck-core/src/simhub-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/deck-core/src/global-settings.ts packages/deck-core/src/global-settings.test.ts packages/deck-core/src/simhub-service.test.ts
git commit -m "feat(deck-core): add calloutEnabledToggleCornerNames global setting (#897)"
```

---

### Task 2: `toggleCornerNamesFeature` + readers (audio-toggles)

**Files:**
- Modify: `packages/iracing-actions/src/audio/audio-toggles.ts`
- Test: `packages/iracing-actions/src/audio/audio-toggles.test.ts`

**Interfaces:**
- Consumes: `getGlobalSettings`, `updateGlobalSettings`, `resolveActiveRaceEngineerVoice` (deck-core), `playVoiceSequence` (same module), `isRaceEngineerEnabled` (already imported from `./audio-volume.js`).
- Produces (used by Task 3): `isCornerNamesEnabled(): boolean`, `toggleCornerNamesFeature(logger: ILogger): boolean` (returns the NEW state). Also `isCornerNamesToggleAckEnabled(): boolean` (internal, exported for tests).

- [ ] **Step 1: Write the failing tests**

Add to `packages/iracing-actions/src/audio/audio-toggles.test.ts`. Extend the import at the top:

```typescript
import {
  isCornerNamesEnabled,
  isCornerNamesToggleAckEnabled,
  isToggleAckEnabled,
  readJsonStringArray,
  toggleCornerNamesFeature,
  toggleRaceEngineerFeature,
  toggleRadarFeature,
} from "./audio-toggles.js";
```

Add a describe block after the `toggleRadarFeature` block:

```typescript
  describe("toggleCornerNamesFeature (issue #897)", () => {
    it("disables from the default-on state, persists, and plays the off ack when the master is on", () => {
      hoisted.setGlobalSettings({
        pitCrewRaceEngineerEnabled: true,
        _raceEngineerVoices: JSON.stringify(["default"]),
      });

      expect(toggleCornerNamesFeature(logger)).toBe(false);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ calloutEnabledCornerNames: false });
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(0, "voice/default/toggle/corner-names-off-01.mp3");
    });

    it("re-enables from off and plays the on ack", () => {
      hoisted.setGlobalSettings({
        calloutEnabledCornerNames: false,
        pitCrewRaceEngineerEnabled: true,
        _raceEngineerVoices: JSON.stringify(["default"]),
      });

      expect(toggleCornerNamesFeature(logger)).toBe(true);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ calloutEnabledCornerNames: true });
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(0, "voice/default/toggle/corner-names-on-01.mp3");
    });

    it("toggles silently when the Race Engineer master gate is off", () => {
      hoisted.setGlobalSettings({ _raceEngineerVoices: JSON.stringify(["default"]) });

      expect(toggleCornerNamesFeature(logger)).toBe(false);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ calloutEnabledCornerNames: false });
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("toggles silently when the ack opt-in is off", () => {
      hoisted.setGlobalSettings({
        pitCrewRaceEngineerEnabled: true,
        calloutEnabledToggleCornerNames: false,
        _raceEngineerVoices: JSON.stringify(["default"]),
      });

      toggleCornerNamesFeature(logger);
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("still toggles when no voice is available (ack skipped silently)", () => {
      hoisted.resolveActiveRaceEngineerVoice.mockReturnValue(null as never);
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });

      expect(toggleCornerNamesFeature(logger)).toBe(false);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ calloutEnabledCornerNames: false });
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });
  });

  describe("isCornerNamesEnabled / isCornerNamesToggleAckEnabled", () => {
    it("default to enabled and only an explicit false opts out", () => {
      expect(isCornerNamesEnabled()).toBe(true);
      expect(isCornerNamesToggleAckEnabled()).toBe(true);

      hoisted.setGlobalSettings({ calloutEnabledCornerNames: false, calloutEnabledToggleCornerNames: false });
      expect(isCornerNamesEnabled()).toBe(false);
      expect(isCornerNamesToggleAckEnabled()).toBe(false);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/iracing-actions/src/audio/audio-toggles.test.ts`
Expected: FAIL — the new exports don't exist.

- [ ] **Step 3: Implement**

In `packages/iracing-actions/src/audio/audio-toggles.ts`, after `toggleRadarFeature`:

```typescript
/**
 * Whether the corner-name callouts (issue #888) are enabled. Reads the SAME
 * per-callout opt-in the PI checkbox writes (`calloutEnabledCornerNames`), so
 * the Pit Crew Corner Names key and the checkbox mirror one value. Defaults
 * to enabled — only an explicit `false` opts out (the callout family's
 * natural baseline).
 */
export function isCornerNamesEnabled(): boolean {
  return (getGlobalSettings() as Record<string, unknown>).calloutEnabledCornerNames !== false;
}

/**
 * Per-callout opt-in for the Corner Names toggle acknowledgment (issue #897).
 * Same defaults-to-enabled live-read shape as {@link isToggleAckEnabled}.
 */
export function isCornerNamesToggleAckEnabled(): boolean {
  return (getGlobalSettings() as Record<string, unknown>).calloutEnabledToggleCornerNames !== false;
}

/**
 * Flip the corner-name callout opt-in (issue #897) — the pathway behind the
 * Pit Crew Corner Names toggle key. Returns the NEW state.
 *
 * The corner-name scenario reads the opt-in live on every event arrival, so
 * persisting the flip is the whole toggle — nothing to stop or re-register,
 * and an in-flight clip plays through (the #554 opt-in semantics).
 *
 * The acknowledgment plays only when the Race Engineer master gate is on:
 * unlike the master toggle this flip never mutes the Voice bus, so no
 * in-flight bypass or bus-volume force is needed — with the master on, Voice
 * is already at the slider value. Master off means a silent flip (the
 * engineer is off the air). Skipped silently when no voice is available.
 */
export function toggleCornerNamesFeature(logger: ILogger): boolean {
  const next = !isCornerNamesEnabled();
  logger.info(`Corner name callouts ${next ? "enabled" : "disabled"}`);

  updateGlobalSettings({ calloutEnabledCornerNames: next });

  if (isRaceEngineerEnabled() && isCornerNamesToggleAckEnabled()) {
    const voice = resolveActiveRaceEngineerVoice(readJsonStringArray("_raceEngineerVoices"));

    if (voice) {
      playVoiceSequence([`voice/${voice}/toggle/corner-names-${next ? "on" : "off"}-01.mp3`]);
    } else {
      logger.debug("Corner names toggle ack skipped — no voice available");
    }
  }

  return next;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/iracing-actions/src/audio/audio-toggles.test.ts`
Expected: PASS (new tests plus every existing test).

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-actions/src/audio/audio-toggles.ts packages/iracing-actions/src/audio/audio-toggles.test.ts
git commit -m "feat(pit-crew): add corner-names feature toggle with voice ack (#897)"
```

---

### Task 3: `corner-names` mode on the Pit Crew action

**Files:**
- Modify: `packages/iracing-actions/src/actions/pit-crew/pit-crew.ts`
- Test: `packages/iracing-actions/src/actions/pit-crew/pit-crew.test.ts`

**Interfaces:**
- Consumes: `isCornerNamesEnabled`, `toggleCornerNamesFeature` from `../../audio/audio-toggles.js` (Task 2).
- Produces: `Settings` mode enum gains `"corner-names"`; `generatePitCrewSvg` renders the new mode; `onKeyDown` dispatches the toggle.

- [ ] **Step 1: Write the failing tests**

In `packages/iracing-actions/src/actions/pit-crew/pit-crew.test.ts`, add alongside the existing mode describe blocks (reuse the file's `buildAppearEvent` helper and `hoisted` mocks):

```typescript
  describe("Settings — corner-names mode", () => {
    it("accepts corner-names as a mode value", () => {
      expect(Settings.parse({ mode: "corner-names" }).mode).toBe("corner-names");
    });
  });

  describe("generatePitCrewSvg — corner-names mode", () => {
    it("shows the on status bar when the callout opt-in is enabled (default)", () => {
      const svg = decodeURIComponent(generatePitCrewSvg(Settings.parse({ mode: "corner-names" })));
      expect(svg).toContain("status-bar-on");
      expect(svg).toContain("CORNER");
    });

    it("shows the off status bar when the callout opt-in is disabled", () => {
      hoisted.setGlobalSettings({ calloutEnabledCornerNames: false });
      const svg = decodeURIComponent(generatePitCrewSvg(Settings.parse({ mode: "corner-names" })));
      expect(svg).toContain("status-bar-off");
    });
  });

  describe("onKeyDown — corner-names mode", () => {
    it("flips calloutEnabledCornerNames off from the default-on state", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "corner-names" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "corner-names" }) as never);

      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ calloutEnabledCornerNames: false });
      expect(hoisted.setRadarEnabled).not.toHaveBeenCalled();
    });

    it("flips back on when already off", async () => {
      hoisted.setGlobalSettings({ calloutEnabledCornerNames: false });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "corner-names" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "corner-names" }) as never);

      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ calloutEnabledCornerNames: true });
    });

    it("does not touch the race-engineer or radar gates", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "corner-names" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "corner-names" }) as never);

      const updates = hoisted.updateGlobalSettings.mock.calls.flatMap(([partial]) => Object.keys(partial));
      expect(updates).not.toContain("pitCrewRaceEngineerEnabled");
      expect(updates).not.toContain("pitCrewRadarEnabled");
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/iracing-actions/src/actions/pit-crew/pit-crew.test.ts`
Expected: FAIL — Zod rejects `"corner-names"`.

- [ ] **Step 3: Implement the mode**

In `packages/iracing-actions/src/actions/pit-crew/pit-crew.ts`:

1. Extend the import from `../../audio/audio-toggles.js`:

```typescript
import {
  isCornerNamesEnabled,
  playVoiceSequence,
  readJsonStringArray,
  toggleCornerNamesFeature,
  toggleRaceEngineerFeature,
  toggleRadarFeature,
} from "../../audio/audio-toggles.js";
```

2. Extend the mode enum (update the settings JSDoc with a `corner-names` bullet: flips the global `calloutEnabledCornerNames` opt-in, issue #897):

```typescript
  mode: z.enum(["race-engineer", "radar", "radar-volume", "corner-names"]).default("race-engineer"),
```

3. Add the artwork glyph next to `radarPathContent` (placeholder per the existing convention — the icon designer replaces it):

```typescript
/**
 * Simple stroked corner-apex glyph for the Corner Names mode (issue #897) —
 * two concentric track-corner bends. Placeholder artwork, same convention as
 * the radar glyph. Drawn inside MECHANIC_BOUNDS so it flows through the same
 * scaling pipeline as the other glyphs.
 */
function cornerNamesPathContent(color: string): string {
  return (
    `<g fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">` +
    `<path stroke-width="5" d="M 14 62 L 14 34 Q 14 14 34 14 L 60 14"/>` +
    `<path stroke-width="3" d="M 30 62 L 30 44 Q 30 30 44 30 L 60 30"/>` +
    `</g>`
  );
}
```

4. Add the `modePresentation` case:

```typescript
    case "corner-names":
      return {
        defaultTitle: "CORNER\nNAMES",
        stateIndicator: isCornerNamesEnabled() ? "on" : "off",
      };
```

5. Add the `pickArtwork` case:

```typescript
    case "corner-names":
      return cornerNamesPathContent(color);
```

6. Add the `onKeyDown` case (before the `radar-volume` case, matching the enum order):

```typescript
      case "corner-names":
        toggleCornerNamesFeature(this.logger);
        break;
```

No other action changes: the global-settings listener registered in `onWillAppear` already re-renders every visible instance when the setting flips (PI checkbox, another key, or this press via `rerenderAll`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/iracing-actions/src/actions/pit-crew/pit-crew.test.ts`
Expected: PASS (new tests plus every existing test).

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-actions/src/actions/pit-crew/pit-crew.ts packages/iracing-actions/src/actions/pit-crew/pit-crew.test.ts
git commit -m "feat(pit-crew): add Corner Names toggle mode (#897)"
```

---

### Task 4: Property Inspector — mode option + ack opt-in row

**Files:**
- Modify: `packages/iracing-actions/src/actions/pit-crew/pit-crew.ejs`

**Interfaces:**
- Consumes: setting keys `mode` (value `corner-names`), `calloutEnabledToggleCornerNames` (Task 1).
- Produces: PI UI only — no code interface.

- [ ] **Step 1: Add the mode option**

In the Mode `sdpi-select` (~line 10), after the Radar option and before the deprecated radar-volume option:

```html
				<option value="corner-names">Corner Names</option>
```

The `initializeDirectionVisibility` script needs no change — the Direction item stays hidden for every mode except `radar-volume`, and the radar-volume option-removal logic keys on that option's own id.

- [ ] **Step 2: Add the ack opt-in checkbox**

Extend the existing `cornerNameCallouts` array (~line 258) — the "Corner Names" `sdpi-item` grid auto-balances via `cornerNameRowCount`, so no layout change is needed:

```javascript
			var cornerNameCallouts = [
				{ setting: "calloutEnabledCornerNames", label: "Corner names (practice/test)" },
				{ setting: "calloutEnabledToggleCornerNames", label: "Toggle on/off acknowledgment" },
			];
```

- [ ] **Step 3: Verify the template compiles**

Run: `pnpm --filter @iracedeck/iracing-plugin-stream-deck build`
Expected: build succeeds; `packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/ui/pit-crew.html` contains `value="corner-names"` and `calloutEnabledToggleCornerNames`.

- [ ] **Step 4: Commit**

```bash
git add packages/iracing-actions/src/actions/pit-crew/pit-crew.ejs
git commit -m "feat(pit-crew): PI mode option and ack opt-in for Corner Names (#897)"
```

---

### Task 5: Ack voice clips (audio-assets)

**Files:**
- Modify: `packages/audio-assets/configs/default.voice.json` (the `toggle` group, ~line 1388)
- Generated: `packages/audio-assets/voice/default/toggle/corner-names-on-01.mp3`, `corner-names-off-01.mp3`, `packages/audio-assets/generate.manifest.json`, `packages/audio-assets/manifest.json`

**Interfaces:**
- Consumes: clip paths referenced by Task 2 (`toggle/corner-names-on-01`, `toggle/corner-names-off-01`) — names must match exactly.
- Produces: the committed mp3 clips + regenerated manifests.

- [ ] **Step 1: Add the config entries**

In `default.voice.json`, extend the `toggle` group (after `radio-check-01`):

```json
      {
        "name": "corner-names-on-01",
        "text": "Roger that. <break time=\"0.2s\"/> Corner calls coming up."
      },
      {
        "name": "corner-names-off-01",
        "text": "Copy that. <break time=\"0.2s\"/> Dropping the corner calls."
      }
```

Only `default.voice.json` — other voices may add their own wording later (#664); a voice without the clip skips the ack silently (`playVoiceSequence` handles the missing file).

- [ ] **Step 2: Dry-run the generator (REQUIRED before the paid call)**

Run: `pnpm --filter @iracedeck/audio-assets generate:dry-run --group toggle`
Expected: lists ONLY `corner-names-on-01` and `corner-names-off-01` (existing toggle entries are hash-cached). If anything else is listed, STOP and investigate before generating.

- [ ] **Step 3: Generate the clips (paid ElevenLabs call — confirm with the user first)**

Run: `pnpm --filter @iracedeck/audio-assets generate --group toggle`
Then: `pnpm --filter @iracedeck/audio-assets generate:manifest`
Expected: two new mp3s under `voice/default/toggle/`, `generate.manifest.json` gains their hashes, `manifest.json` lists them.

- [ ] **Step 4: Audition the clips**

Play both mp3s locally (or via the scenario harness Pit Crew audio) and confirm they sound right; bump the entry's `seed` deliberately and regenerate if a take sounds off.

- [ ] **Step 5: Commit**

```bash
git add packages/audio-assets/configs/default.voice.json packages/audio-assets/generate.manifest.json packages/audio-assets/manifest.json packages/audio-assets/voice/default/toggle/corner-names-on-01.mp3 packages/audio-assets/voice/default/toggle/corner-names-off-01.mp3
git commit -m "feat(audio-assets): corner-names toggle acknowledgment clips (#897)"
```

---

### Task 6: Documentation, changelog, reference data

**Files:**
- Modify: `packages/website/src/content/docs/docs/actions/audio-voice/pit-crew.md`
- Modify: `packages/website/src/content/docs/changelog.mdx`
- Modify: `docs/plugins/core/actions/pit-crew.md`
- Modify: `docs/reference/actions.json`
- Check: `.claude/skills/iracedeck-actions/SKILL.md` (update only if it enumerates Pit Crew modes/counts)

**Interfaces:** none — documentation only. Terminology: "Corner Names" (mode), "corner-name callouts" (feature), practice/test sessions.

- [ ] **Step 1: Website action page**

In `packages/website/src/content/docs/docs/actions/audio-voice/pit-crew.md`:
- Add a `### Corner Names` mode section after `### Radar` (follow `website-action-docs.md` per-mode format): pressing the key toggles the corner-name callouts (practice & test) on/off — the same setting as the **Race Engineer Callouts → Corner Names** checkbox, so key and checkbox mirror each other; status bar green ↔ red; the engineer confirms each press (*"Roger that. Corner calls coming up."* / *"Copy that. Dropping the corner calls."*) when the Race Engineer master is on — disable under **Race Engineer Callouts → Corner Names → Toggle on/off acknowledgment**; note that with the Race Engineer master off the callouts stay silent regardless of this key.
- In the "Corner names (practice & test)" section (~line 254) add one sentence: the Pit Crew action's **Corner Names** mode toggles this from a deck key.
- In the per-subject opt-in list (~line 372), extend the **Corner Names** entry: two callouts are toggleable — the corner-name announcement (`calloutEnabledCornerNames`) and the toggle acknowledgment (`calloutEnabledToggleCornerNames`), both enabled by default.

- [ ] **Step 2: Changelog — edit the existing line, do not add one**

The corner-name feature (#888) ships in the same unreleased 2.3.0 as this mode, so per the one-change-one-line rule EDIT the existing 2.3.0 **Features** bullet: append a sentence such as "A Corner Names mode on the Pit Crew action toggles the callouts from a deck key, with a spoken confirmation." to the existing corner-names line.

- [ ] **Step 3: Repo action docs**

In `docs/plugins/core/actions/pit-crew.md`:
- Add a **Corner Names mode** bullet to the behavior list (~line 26): flips the plugin-global `calloutEnabledCornerNames` opt-in (default on); spoken ack via `calloutEnabledToggleCornerNames`, ack respects the Race Engineer master gate.
- Add `corner-names` to the Mode Options section and confirm the settings-table Mode row's description still holds.
- In the icon-states section (~line 129), note Corner Names paints the same green/red status bar as Race Engineer/Radar with a corner-bend glyph.

- [ ] **Step 4: actions.json reference**

In `docs/reference/actions.json`, add to the Pit Crew entry's `modes` array (before the deprecated radar-volume entries):

```json
  {
   "mode": "corner-names",
   "label": "Corner Names",
   "description": "Toggles the corner-name callouts (practice/test) on/off — flips the same calloutEnabledCornerNames setting as the PI checkbox, with a spoken acknowledgment (#897)"
  }
```

Also refresh the entry's `description` string: it still says the initial release exposes only Radar — reword to mention the Race Engineer toggle, Radar, and Corner Names modes.

- [ ] **Step 5: Skill check**

Grep `.claude/skills/iracedeck-actions/SKILL.md` for the Pit Crew row (category table ~line 79). If it lists a mode count or mode names for Pit Crew, update it; if it only names the action, leave it.

- [ ] **Step 6: Verify website build and commit**

Run: `pnpm --filter @iracedeck/website build`
Expected: PASS (changelog is MDX — a bare `<` breaks the build; keep literals in backticks).

```bash
git add packages/website/src/content/docs/docs/actions/audio-voice/pit-crew.md packages/website/src/content/docs/changelog.mdx docs/plugins/core/actions/pit-crew.md docs/reference/actions.json .claude/skills/iracedeck-actions/SKILL.md
git commit -m "docs(pit-crew): document the Corner Names toggle mode (#897)"
```

---

### Task 7: Full verification

**Files:** none new.

- [ ] **Step 1: Full build (forced — deck-core schema changed)**

Run: `set -o pipefail && pnpm build --force 2>&1 | tail -5`
Expected: all tasks successful. (`--force` because turbo caches deck-core and a plain build can falsely pass after a `GlobalSettingsSchema` change.)

- [ ] **Step 2: Full test suite**

Run: `set -o pipefail && pnpm test 2>&1 | tail -6`
Expected: all tests pass (baseline was 7232; expect the new tests on top).

- [ ] **Step 3: Lint + format**

Run: `pnpm lint:fix && pnpm format:fix`
Then re-run `pnpm test` if either changed files.

- [ ] **Step 4: Commit any lint/format fallout**

```bash
git status --short   # commit only if lint/format touched files
git add -A && git commit -m "chore(pit-crew): lint/format fixes for Corner Names mode (#897)"
```

- [ ] **Step 5: STOP — manual test gate**

Do NOT push or open a PR. Hand off to the user for manual verification in iRacing / the deck app:
- Key toggles the callouts and the PI checkbox mirrors it (both directions).
- Ack plays on toggle with the master on; silent with the master off or the ack opt-in unchecked.
- Status bar/border reflect the state live when the PI checkbox changes.
- Corner callouts actually stop/resume in a practice session.
