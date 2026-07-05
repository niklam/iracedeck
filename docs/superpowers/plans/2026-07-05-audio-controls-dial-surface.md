# Audio Controls Dial Surface Implementation Plan (#782)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the existing Audio Controls action a proper dial surface (issue #782): rotate adjusts the selected audio category's volume, press is configurable as Push to Talk or Mute/Unmute, and the Elgato touch strip shows a live level bar for the iRaceDeck-internal categories (Race Engineer, Radar).

**Architecture:** Follow the Fuel Service (#759) dual-surface pattern exactly: dial settings under a `dial` root with `.prefault({})` in a dedicated settings module, all dial behavior in an `audio-dial-surface.ts` module behind a small host interface, every action handler branched on `ev.action.isDial()`, a controller-branched PI, and a second comms-catalog entry for the dial's binding-status lines. Pit Crew's private Race Engineer / Radar feature toggles are extracted into a shared `audio-toggles.ts` module so the dial's Mute/Unmute and Pit Crew consume one source of truth (the same move #590 made for the volume steppers).

**Tech Stack:** TypeScript, Zod, Vitest, EJS PI templates, pnpm/turbo monorepo.

## Global Constraints

- Worktree: `C:/Users/Niklas/Projects/iRaceDeck/ir-782`, branch `ir-782`, PR target `release/2.0`. Every command below runs from the worktree root (shell cwd resets to master between calls — always `cd` first or use absolute paths).
- No watcher is running: build/lint/test manually. Pre-commit = `pnpm lint:fix && pnpm format:fix`, plus `pnpm build` and `pnpm test` at every commit point (per `.claude/rules/build-and-commit.md`; memory: `pnpm build` catches more than `pnpm test`).
- `GlobalSettingsSchema` is NOT touched (no new global settings — reuses `audio*` bindings, `raceEngineerVolume`/`radarVolume`, `pitCrewRaceEngineerEnabled`/`pitCrewRadarEnabled`).
- Touch-strip feedback and trigger descriptions are gated behind the compile-time `__FEATURE_DIAL_FEEDBACK__` constant IN THE ACTION (the documented exception in `.claude/rules/encoders-and-touchscreen.md`). Feedback ≤ 10 `setFeedback`/s per dial.
- Strip SVG uses only SVG Tiny 1.2-safe features (rect/text, no filters/masks/clipPath). Text y values are BASELINES (the deck app ignores `dominant-baseline`).
- Conventional commits, one per task, scope `audio-controls` (plus `audio` / `pit-crew` where the change lives there).
- Rotation scales by `ticks` (signed, may be >1), never counts events. Keybind taps capped per event.
- Press semantics per approved design: PTT = hold on dialDown / release on dialUp (no release-time classification — there is no long-press slot); Mute/Unmute fires on dialDown; `none` does nothing. Mute/Unmute: voice-chat → `audioVoiceChatMute` tap; race-engineer/radar → feature-gate toggle; master → not offered (no iRacing master-mute keybind), action logs + no-ops on a stale persisted value.

---

### Task 1: Settings module — `audio-controls-settings.ts`

**Files:**
- Create: `packages/iracing-actions/src/actions/audio-controls/audio-controls-settings.ts`
- Create: `packages/iracing-actions/src/actions/audio-controls/audio-controls-settings.test.ts`
- Modify: `packages/iracing-actions/src/actions/audio-controls/audio-controls.ts` (import schema/keys from the new module; re-export `AUDIO_CONTROLS_GLOBAL_KEYS` for test back-compat)

**Interfaces:**
- Produces: `AudioControlsSettings` (schema + type, now includes `dial`), `AudioDialSettings`, `DialCategory`, `DialPressAction`, `DIAL_CATEGORIES`, `DIAL_PRESS_ACTIONS`, `parseAudioControlsSettings(raw)`, `rotationBindingKeys(category): string[]`, `pressBindingKeys(dial): string[]`, key constants `PUSH_TO_TALK_KEY`, `VOICE_CHAT_VOLUME_UP_KEY`, `VOICE_CHAT_VOLUME_DOWN_KEY`, `VOICE_CHAT_MUTE_KEY`, `MASTER_VOLUME_UP_KEY`, `MASTER_VOLUME_DOWN_KEY`, `AUDIO_CONTROLS_GLOBAL_KEYS`.

- [ ] **Step 1: Write the failing test** (`audio-controls-settings.test.ts`)

```typescript
import { describe, expect, it, vi } from "vitest";

// Real zod semantics for the extended schema (defaults + the `dial` prefault).
vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  return {
    CommonSettings: { extend: (shape: never) => z.object(shape).passthrough() },
  };
});

import {
  AUDIO_CONTROLS_GLOBAL_KEYS,
  parseAudioControlsSettings,
  pressBindingKeys,
  rotationBindingKeys,
} from "./audio-controls-settings.js";

describe("audio-controls settings", () => {
  it("parses empty settings to full defaults including the dial prefault", () => {
    const s = parseAudioControlsSettings({});
    expect(s.category).toBe("push-to-talk");
    expect(s.action).toBe("volume-up");
    expect(s.dial).toEqual({ category: "voice-chat", pressAction: "none" });
  });

  it("parses a missing dial key the same as an empty dial object", () => {
    expect(parseAudioControlsSettings({ category: "master" }).dial).toEqual(
      parseAudioControlsSettings({ category: "master", dial: {} }).dial,
    );
  });

  it("keeps persisted dial fields and defaults the rest", () => {
    const s = parseAudioControlsSettings({ dial: { category: "radar" } });
    expect(s.dial.category).toBe("radar");
    expect(s.dial.pressAction).toBe("none");
  });

  it("falls back to full defaults when the parse fails", () => {
    const s = parseAudioControlsSettings({ dial: { category: "bogus" } });
    expect(s.dial.category).toBe("voice-chat");
  });

  it("keeps the keypad global-key map intact", () => {
    expect(AUDIO_CONTROLS_GLOBAL_KEYS["push-to-talk"]).toBe("audioControlsPushToTalk");
    expect(AUDIO_CONTROLS_GLOBAL_KEYS["voice-chat-mute"]).toBe("audioVoiceChatMute");
    expect(AUDIO_CONTROLS_GLOBAL_KEYS["master-volume-down"]).toBe("audioMasterVolumeDown");
  });

  describe("rotationBindingKeys", () => {
    it("requires both volume keys for the keybind categories", () => {
      expect(rotationBindingKeys("voice-chat")).toEqual(["audioVoiceChatVolumeUp", "audioVoiceChatVolumeDown"]);
      expect(rotationBindingKeys("master")).toEqual(["audioMasterVolumeUp", "audioMasterVolumeDown"]);
    });

    it("requires no keys for the internal categories", () => {
      expect(rotationBindingKeys("race-engineer")).toEqual([]);
      expect(rotationBindingKeys("radar")).toEqual([]);
    });
  });

  describe("pressBindingKeys", () => {
    it("requires the PTT key for push-to-talk", () => {
      expect(pressBindingKeys({ category: "master", pressAction: "push-to-talk" })).toEqual([
        "audioControlsPushToTalk",
      ]);
    });

    it("requires the voice-chat mute key only for voice-chat mute", () => {
      expect(pressBindingKeys({ category: "voice-chat", pressAction: "mute-unmute" })).toEqual(["audioVoiceChatMute"]);
      expect(pressBindingKeys({ category: "race-engineer", pressAction: "mute-unmute" })).toEqual([]);
      expect(pressBindingKeys({ category: "radar", pressAction: "mute-unmute" })).toEqual([]);
      expect(pressBindingKeys({ category: "master", pressAction: "mute-unmute" })).toEqual([]);
    });

    it("requires nothing for none", () => {
      expect(pressBindingKeys({ category: "voice-chat", pressAction: "none" })).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && npx vitest run packages/iracing-actions/src/actions/audio-controls/audio-controls-settings.test.ts`
Expected: FAIL — module `./audio-controls-settings.js` not found.

- [ ] **Step 3: Write the module** (`audio-controls-settings.ts`)

```typescript
/**
 * Audio Controls settings schema (issue #782).
 *
 * One action, two surfaces (the #759 Fuel Service pattern): keypad settings
 * stay FLAT (`category` / `action`, shipped in stable 1.x); dial settings live
 * under the `dial` root object. The binding-key constants are shared by both
 * surfaces and by the comms catalog.
 */
import { CommonSettings } from "@iracedeck/deck-core";
import z from "zod";

/** Global-settings keys for the shared audio key bindings (both surfaces). */
export const PUSH_TO_TALK_KEY = "audioControlsPushToTalk";
export const VOICE_CHAT_VOLUME_UP_KEY = "audioVoiceChatVolumeUp";
export const VOICE_CHAT_VOLUME_DOWN_KEY = "audioVoiceChatVolumeDown";
export const VOICE_CHAT_MUTE_KEY = "audioVoiceChatMute";
export const MASTER_VOLUME_UP_KEY = "audioMasterVolumeUp";
export const MASTER_VOLUME_DOWN_KEY = "audioMasterVolumeDown";

/**
 * Mapping from keypad "{category}-{action}" keys to global settings keys.
 * The internal categories (race-engineer / radar) drive plugin audio and have
 * no entry — they never use a key binding.
 */
export const AUDIO_CONTROLS_GLOBAL_KEYS: Record<string, string> = {
  "push-to-talk": PUSH_TO_TALK_KEY,
  "voice-chat-volume-up": VOICE_CHAT_VOLUME_UP_KEY,
  "voice-chat-volume-down": VOICE_CHAT_VOLUME_DOWN_KEY,
  "voice-chat-mute": VOICE_CHAT_MUTE_KEY,
  "master-volume-up": MASTER_VOLUME_UP_KEY,
  "master-volume-down": MASTER_VOLUME_DOWN_KEY,
};

/**
 * What a dial ROTATION can control. No `push-to-talk` here — on the dial, PTT
 * is a press action, not a rotate category.
 */
export const DIAL_CATEGORIES = ["voice-chat", "master", "race-engineer", "radar"] as const;
export type DialCategory = (typeof DIAL_CATEGORIES)[number];

/**
 * What the dial PRESS runs. `push-to-talk` holds the PTT binding for the
 * duration of the press; `mute-unmute` taps the voice-chat mute binding or
 * toggles the Race Engineer / Radar feature gate (master offers no mute —
 * iRacing has no master-mute keybind). Default `none` (blind-safe).
 */
export const DIAL_PRESS_ACTIONS = ["push-to-talk", "mute-unmute", "none"] as const;
export type DialPressAction = (typeof DIAL_PRESS_ACTIONS)[number];

/**
 * Dial-surface settings, stored under the `dial` root key. All fields default,
 * so a keypad-only instance (or a fresh dial) parses `{}` to a full object.
 */
export const AudioDialSettings = z
  .object({
    category: z.enum(DIAL_CATEGORIES).default("voice-chat"),
    pressAction: z.enum(DIAL_PRESS_ACTIONS).default("none"),
  })
  // prefault (not default): a missing `dial` parses {} THROUGH the schema so
  // the per-field defaults apply — same shape as a partially-persisted object.
  .prefault({});

export type AudioDialSettings = z.infer<typeof AudioDialSettings>;

export const AudioControlsSettings = CommonSettings.extend({
  category: z.enum(["push-to-talk", "voice-chat", "master", "race-engineer", "radar"]).default("push-to-talk"),
  action: z.enum(["volume-up", "volume-down", "mute"]).default("volume-up"),
  dial: AudioDialSettings,
});

export type AudioControlsSettings = z.infer<typeof AudioControlsSettings>;

/** Parses raw settings, falling back to full defaults when the parse fails. */
export function parseAudioControlsSettings(raw: unknown): AudioControlsSettings {
  const parsed = AudioControlsSettings.safeParse(raw);

  return parsed.success ? parsed.data : AudioControlsSettings.parse({});
}

/**
 * Binding keys the dial ROTATION requires for a category. Both volume keys are
 * required for the keybind categories; the internal categories (plugin audio)
 * require none.
 */
export function rotationBindingKeys(category: DialCategory): string[] {
  if (category === "voice-chat") return [VOICE_CHAT_VOLUME_UP_KEY, VOICE_CHAT_VOLUME_DOWN_KEY];

  if (category === "master") return [MASTER_VOLUME_UP_KEY, MASTER_VOLUME_DOWN_KEY];

  return [];
}

/**
 * Binding keys the dial PRESS requires. PTT always needs its binding;
 * Mute/Unmute needs the voice-chat mute binding only for the voice-chat
 * category (internal categories toggle the feature gate — no binding).
 */
export function pressBindingKeys(dial: AudioDialSettings): string[] {
  if (dial.pressAction === "push-to-talk") return [PUSH_TO_TALK_KEY];

  if (dial.pressAction === "mute-unmute" && dial.category === "voice-chat") return [VOICE_CHAT_MUTE_KEY];

  return [];
}
```

- [ ] **Step 4: Rewire `audio-controls.ts` to consume the module.** Delete its local `AUDIO_CONTROLS_GLOBAL_KEYS` const and the inline `AudioControlsSettings = CommonSettings.extend({...})` block (keep `AudioCategory`/`AudioAction` local types, `AUDIO_ICONS`, `AUDIO_CONTROLS_TITLES`, `MUTE_CATEGORIES`, `INTERNAL_VOLUME_CATEGORIES`). Add:

```typescript
import {
  AUDIO_CONTROLS_GLOBAL_KEYS,
  type AudioControlsSettings,
  parseAudioControlsSettings,
} from "./audio-controls-settings.js";

// Re-export for test back-compat (@internal, tests import from this path).
export { AUDIO_CONTROLS_GLOBAL_KEYS };
```

Replace the body of `private parseSettings(settings: unknown)` with `return parseAudioControlsSettings(settings);` and drop the now-unused `z` import if nothing else uses it.

- [ ] **Step 5: Run tests**

Run: `cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && npx vitest run packages/iracing-actions/src/actions/audio-controls/`
Expected: PASS (new settings tests + all 49 existing audio-controls tests).

- [ ] **Step 6: Lint, format, commit**

```bash
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && pnpm lint:fix && pnpm format:fix
git add packages/iracing-actions/src/actions/audio-controls/
git commit -m "refactor(audio-controls): extract settings module with dial root schema (#782)"
```

---

### Task 2: Multi-step volume helpers in `audio-volume.ts`

**Files:**
- Modify: `packages/iracing-actions/src/audio/audio-volume.ts`
- Modify: `packages/iracing-actions/src/audio/audio-volume.test.ts` (add cases)

**Interfaces:**
- Produces: `stepRaceEngineerVolumeBy(steps: number): number`, `stepRadarVolumeBy(steps: number): number` — step by `steps × VOLUME_STEP` (signed, clamped 0–100, no-op persist when clamped at the boundary), persist + apply exactly like the existing single-step functions. Existing `stepRaceEngineerVolume(direction)` / `stepRadarVolume(direction)` delegate to them.

- [ ] **Step 1: Write failing tests** — add to the existing `audio-volume.test.ts` `describe` blocks (mirror the existing step tests' mock setup already in that file):

```typescript
it("stepRadarVolumeBy steps by ticks × 5 and clamps", () => {
  setStoredVolume("radarVolume", 50); // use this file's existing helper for seeding the mock store
  expect(stepRadarVolumeBy(3)).toBe(65);
  setStoredVolume("radarVolume", 95);
  expect(stepRadarVolumeBy(4)).toBe(100);
  setStoredVolume("radarVolume", 5);
  expect(stepRadarVolumeBy(-2)).toBe(0);
});

it("stepRadarVolumeBy is a no-op at the boundary", () => {
  setStoredVolume("radarVolume", 100);
  expect(stepRadarVolumeBy(2)).toBe(100);
  // no persist, no bus write — assert with this file's existing updateGlobalSettings/setBusVolume mocks
});

it("stepRaceEngineerVolumeBy steps by ticks × 5 and re-applies the gate", () => {
  setStoredVolume("raceEngineerVolume", 50);
  expect(stepRaceEngineerVolumeBy(-3)).toBe(35);
});
```

(Adapt the seeding/assertion helpers to whatever `audio-volume.test.ts` already uses — read the file first; its existing `stepRadarVolume` tests show the exact mock shape.)

- [ ] **Step 2: Run to verify failure**

Run: `cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && npx vitest run packages/iracing-actions/src/audio/audio-volume.test.ts`
Expected: FAIL — `stepRadarVolumeBy` is not exported.

- [ ] **Step 3: Implement** — in `audio-volume.ts`, replace the two step functions with:

```typescript
/**
 * Step the global `radarVolume` by `steps × VOLUME_STEP` (signed — a dial may
 * deliver several detents per event), persist it, and apply it to
 * {@link AudioBus.Alerts}. A no-op (no persist, no bus write) when already
 * clamped at the boundary. Returns the resulting volume.
 */
export function stepRadarVolumeBy(steps: number): number {
  const current = readRadarVolume();
  const next = clampVolume(current + steps * VOLUME_STEP);

  if (next === current) return current;

  updateGlobalSettings({ radarVolume: next });
  applyRadarVolume();

  return next;
}

/** Single-step convenience over {@link stepRadarVolumeBy}. */
export function stepRadarVolume(direction: "up" | "down"): number {
  return stepRadarVolumeBy(direction === "up" ? 1 : -1);
}

/**
 * Step the global `raceEngineerVolume` by `steps × VOLUME_STEP` (signed),
 * persist it, and re-apply the Race Engineer audio gate. While Race Engineer
 * is disabled the value still updates but Voice stays muted (the gate is
 * respected). A no-op when already clamped at the boundary. Returns the
 * resulting volume.
 */
export function stepRaceEngineerVolumeBy(steps: number): number {
  const current = readRaceEngineerVolume();
  const next = clampVolume(current + steps * VOLUME_STEP);

  if (next === current) return current;

  updateGlobalSettings({ raceEngineerVolume: next });
  applyRaceEngineerAudio();

  return next;
}

/** Single-step convenience over {@link stepRaceEngineerVolumeBy}. */
export function stepRaceEngineerVolume(direction: "up" | "down"): number {
  return stepRaceEngineerVolumeBy(direction === "up" ? 1 : -1);
}
```

(Delete the now-unused private `stepValue` helper if nothing else uses it.)

- [ ] **Step 4: Run tests** — same command. Expected: PASS (new + all existing audio-volume, pit-crew, audio-controls tests).

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && pnpm lint:fix && pnpm format:fix
git add packages/iracing-actions/src/audio/
git commit -m "feat(audio): add signed multi-step volume helpers for dial rotation (#782)"
```

---

### Task 3: Extract Race Engineer / Radar feature toggles into `audio-toggles.ts`

**Files:**
- Create: `packages/iracing-actions/src/audio/audio-toggles.ts`
- Create: `packages/iracing-actions/src/audio/audio-toggles.test.ts`
- Modify: `packages/iracing-actions/src/actions/pit-crew/pit-crew.ts` (delegate; keep test back-compat re-exports)

**Interfaces:**
- Produces: `toggleRaceEngineerFeature(logger: ILogger): boolean`, `toggleRadarFeature(logger: ILogger): boolean` (return the NEW gate state), `playVoiceSequence(paths, onComplete?): boolean`, `readJsonStringArray(key): string[]`, `isToggleAckEnabled(): boolean`, `playToggleAck(clipName, logger): void`.
- Consumes: `setRadarEnabled`, `stopRaceEngineerScenarios` from `@iracedeck/audio-scenarios/pit-crew`; `AudioBus`, `AudioChannel`, `getAudio` from `@iracedeck/audio-service`; `getGlobalSettings`, `resolveActiveRaceEngineerVoice`, `updateGlobalSettings` from `@iracedeck/deck-core`; `applyRaceEngineerAudio`, `isRaceEngineerEnabled`, `isRadarEnabled`, `readRaceEngineerVolume`, `setRaceEngineerToggleInFlight` from `./audio-volume.js`.

- [ ] **Step 1: Move code.** Create `audio-toggles.ts` with a module doc comment ("Shared Race Engineer / Radar feature-gate toggles (issue #782) — extracted from Pit Crew so the Audio Controls dial's Mute/Unmute and the Pit Crew toggle keys share one pathway, the same move #590 made for the volume steppers"). Move **verbatim** from `pit-crew.ts`: `readJsonStringArray` (line ~147), `playVoiceSequence` (line ~173, keep the `@internal` export), `isToggleAckEnabled` (line ~106; now `export`ed). Then add the two toggles + ack, converted from the Pit Crew private methods with `this.logger` → a `logger` parameter (bodies otherwise verbatim, including all comments):

```typescript
export function toggleRaceEngineerFeature(logger: ILogger): boolean {
  const next = !isRaceEngineerEnabled();
  logger.info(`Race Engineer ${next ? "enabled" : "disabled"}`);
  // ... (verbatim body of PitCrew.toggleRaceEngineer, including the
  // stopRaceEngineerScenarios(!next) block and the isToggleAckEnabled() ack)
  return next;
}

export function playToggleAck(clipName: "going-silent-01" | "resuming-01", logger: ILogger): void {
  // ... verbatim body of PitCrew.playToggleAck with this.logger → logger
}

export function toggleRadarFeature(logger: ILogger): boolean {
  const next = !isRadarEnabled();
  logger.info(`Radar ${next ? "enabled" : "disabled"}`);
  // Flip the engine synchronously so the tick loop stops/starts immediately.
  setRadarEnabled(next);
  updateGlobalSettings({ pitCrewRadarEnabled: next });
  return next;
}
```

- [ ] **Step 2: Delegate in `pit-crew.ts`.** Delete the moved functions/methods; import from `../../audio/audio-toggles.js`; the private methods become:

```typescript
private toggleRaceEngineer(): void {
  toggleRaceEngineerFeature(this.logger);
}

private toggleRadar(): void {
  toggleRadarFeature(this.logger);
}
```

Keep back-compat re-exports next to the existing #590 re-export block so `pit-crew.test.ts` keeps importing from `./pit-crew.js`:

```typescript
export { playVoiceSequence } from "../../audio/audio-toggles.js";
```

(Check `pit-crew.test.ts` imports first — re-export exactly what it imports from `./pit-crew.js`; `isRadioCheckEnabled`, `playRadioCheck`, and `playEngineerPreview` STAY in pit-crew.ts and now import `playVoiceSequence`/`readJsonStringArray` from the new module.)

- [ ] **Step 3: Write `audio-toggles.test.ts`.** Mock `@iracedeck/audio-scenarios/pit-crew` (`setRadarEnabled`, `stopRaceEngineerScenarios` as `vi.fn()`), `@iracedeck/audio-service` (`getAudio` returning `setBusVolume`/`playOnChannel`/`onChannelComplete` mocks), `@iracedeck/deck-core` (`getGlobalSettings` over a mutable store, `updateGlobalSettings` writing to it, `resolveActiveRaceEngineerVoice` returning `"default"`), and `./audio-volume.js` (spy `applyRaceEngineerAudio`, real-ish `isRaceEngineerEnabled`/`isRadarEnabled` over the same store, `setRaceEngineerToggleInFlight`, `readRaceEngineerVolume` → 50). Test at minimum:
  - RE toggle off→on: persists `pitCrewRaceEngineerEnabled: true`, calls `applyRaceEngineerAudio`, does NOT call `stopRaceEngineerScenarios`, returns `true`.
  - RE toggle on→off: persists `false`, calls `stopRaceEngineerScenarios`, returns `false`.
  - RE toggle with `calloutEnabledToggleRaceEngineer: false` in the store: no ack playback (no `playOnChannel`).
  - Radar toggle: calls `setRadarEnabled(next)` AND persists `pitCrewRadarEnabled`.
  - `playVoiceSequence` chain + failure paths are already covered by pit-crew tests via the re-export — don't duplicate.

- [ ] **Step 4: Run tests**

Run: `cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && npx vitest run packages/iracing-actions/src/audio/ packages/iracing-actions/src/actions/pit-crew/`
Expected: PASS — all new toggle tests AND the whole existing pit-crew suite.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && pnpm lint:fix && pnpm format:fix
git add packages/iracing-actions/src/audio/ packages/iracing-actions/src/actions/pit-crew/
git commit -m "refactor(audio): extract Race Engineer/Radar feature toggles for shared dial use (#782)"
```

---

### Task 4: Dial surface pure helpers — strip renderer + trigger description

**Files:**
- Create: `packages/iracing-actions/src/actions/audio-controls/audio-dial-surface.ts` (helpers only in this task; class added in Task 5)
- Create: `packages/iracing-actions/src/actions/audio-controls/audio-dial-surface.test.ts` (helper tests in this task)

**Interfaces:**
- Produces: `AudioStripState` interface `{ category: DialCategory; volume?: number; enabled?: boolean; pttHeld: boolean; bindingMissing: boolean }`, `renderAudioStripSvg(state): string`, `buildAudioTriggerDescription(dial: AudioDialSettings): DeckTriggerDescription`, `CATEGORY_LABELS: Record<DialCategory, string>` — all `@internal` exported for testing.

- [ ] **Step 1: Write failing helper tests** (start `audio-dial-surface.test.ts` with the same `vi.mock("@iracedeck/deck-core", ...)` real-zod pattern as `fuel-dial-surface.test.ts`, including a passthrough `svgToDataUri` and the REAL `applyBindingWarning` re-exported from the actual module is NOT needed — mock it as `(content: string) => `<g opacity="0.35">${content}</g><warning/>` ` so tests can assert the marker):

```typescript
describe("renderAudioStripSvg", () => {
  it("renders the category label band", () => {
    const svg = renderAudioStripSvg({ category: "voice-chat", pttHeld: false, bindingMissing: false });
    expect(svg).toContain("VOICE CHAT");
    expect(svg).toContain('viewBox="0 0 200 100"');
  });

  it("renders a level bar + numeric value for internal categories", () => {
    const svg = renderAudioStripSvg({
      category: "race-engineer", volume: 65, enabled: true, pttHeld: false, bindingMissing: false,
    });
    expect(svg).toContain("RACE ENGINEER");
    expect(svg).toContain(">65<"); // numeric readout
    expect(svg).toContain("#2ecc71"); // green fill when enabled
  });

  it("renders the OFF state (gray bar, OFF text) when the gate is disabled", () => {
    const svg = renderAudioStripSvg({
      category: "radar", volume: 40, enabled: false, pttHeld: false, bindingMissing: false,
    });
    expect(svg).toContain("OFF");
    expect(svg).toContain("#888888");
    expect(svg).not.toContain("#2ecc71");
  });

  it("renders no bar for keybind categories (no state available)", () => {
    const svg = renderAudioStripSvg({ category: "master", pttHeld: false, bindingMissing: false });
    expect(svg).toContain("MASTER");
    expect(svg).toContain("Turn to adjust");
    expect(svg).not.toContain("#2ecc71");
  });

  it("renders the ON AIR band while PTT is held", () => {
    const svg = renderAudioStripSvg({ category: "voice-chat", pttHeld: true, bindingMissing: false });
    expect(svg).toContain("ON AIR");
    expect(svg).toContain("#e74c3c");
  });

  it("applies the binding warning overlay when a required binding is missing", () => {
    const svg = renderAudioStripSvg({ category: "voice-chat", pttHeld: false, bindingMissing: true });
    expect(svg).toContain("<warning/>");
  });
});

describe("buildAudioTriggerDescription", () => {
  it("describes rotation per category and press per action", () => {
    expect(buildAudioTriggerDescription({ category: "master", pressAction: "push-to-talk" })).toEqual({
      rotate: "Adjust master volume",
      push: "Push to talk (hold)",
    });
    expect(buildAudioTriggerDescription({ category: "radar", pressAction: "mute-unmute" })).toEqual({
      rotate: "Adjust radar volume",
      push: "Mute / unmute",
    });
  });

  it("omits push for none", () => {
    expect(buildAudioTriggerDescription({ category: "voice-chat", pressAction: "none" })).toEqual({
      rotate: "Adjust voice chat volume",
    });
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement the helpers** in `audio-dial-surface.ts`:

```typescript
/**
 * Audio Controls — dial surface (issue #782).
 *
 * The encoder half of the Audio Controls action, following the Fuel Service
 * dial-surface pattern (#759). Rotating adjusts the selected category's
 * volume; the press is configurable as Push to Talk (hold) or Mute/Unmute.
 * The touch strip shows a live 0–100 level bar for the iRaceDeck-internal
 * categories (Race Engineer, Radar) — their volumes are plugin-owned globals.
 * The iRacing categories (voice chat, master) go through blind key bindings
 * and iRacing exposes no volume/mute state, so their strip shows category
 * identity only (a documented limitation, not an implementation gap).
 */
import {
  applyBindingWarning,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  type IDeckActionContext,
  onGlobalSettingsChange,
  svgToDataUri,
} from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";

import { toggleRaceEngineerFeature, toggleRadarFeature } from "../../audio/audio-toggles.js";
import {
  isRaceEngineerEnabled,
  isRadarEnabled,
  readRaceEngineerVolume,
  readRadarVolume,
  stepRaceEngineerVolumeBy,
  stepRadarVolumeBy,
} from "../../audio/audio-volume.js";
import {
  type AudioControlsSettings,
  type AudioDialSettings,
  type DialCategory,
  type DialPressAction,
  MASTER_VOLUME_DOWN_KEY,
  MASTER_VOLUME_UP_KEY,
  pressBindingKeys,
  PUSH_TO_TALK_KEY,
  rotationBindingKeys,
  VOICE_CHAT_MUTE_KEY,
  VOICE_CHAT_VOLUME_DOWN_KEY,
  VOICE_CHAT_VOLUME_UP_KEY,
} from "./audio-controls-settings.js";

/** Cap on binding taps dispatched for one rotate event (a fast spin coalesces ticks). */
const MAX_TAPS_PER_EVENT = 5;

/**
 * Leading+trailing throttle window for feedback renders, honoring the
 * documented ≤10 setFeedback/sec/dial cap (a fast internal-volume spin fires
 * a render per detent plus a global-settings echo per persist).
 */
const RENDER_THROTTLE_MS = 100;

const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const RED = "#e74c3c";
const GRAY = "#888888";
const BAND_BG = "#2a2f36";
const BAR_TRACK = "#1a1f26";

/** @internal Exported for testing */
export const CATEGORY_LABELS: Record<DialCategory, string> = {
  "voice-chat": "VOICE CHAT",
  master: "MASTER",
  "race-engineer": "RACE ENGINEER",
  radar: "RADAR",
};

const ROTATE_LABELS: Record<DialCategory, string> = {
  "voice-chat": "Adjust voice chat volume",
  master: "Adjust master volume",
  "race-engineer": "Adjust Race Engineer volume",
  radar: "Adjust radar volume",
};

const PRESS_LABELS: Record<DialPressAction, string | undefined> = {
  "push-to-talk": "Push to talk (hold)",
  "mute-unmute": "Mute / unmute",
  none: undefined,
};

/**
 * @internal Exported for testing
 *
 * Everything the strip render needs, resolved by the surface so the renderer
 * stays pure. `volume`/`enabled` are set only for the internal categories.
 */
export interface AudioStripState {
  category: DialCategory;
  /** 0–100 volume for the internal categories; undefined for keybind ones. */
  volume?: number;
  /** Feature-gate state for the internal categories; undefined for keybind ones. */
  enabled?: boolean;
  /** True while the PTT binding is held (press action = push-to-talk). */
  pttHeld: boolean;
  /** True when a binding this dial's rotate/press needs is unconfigured (#612). */
  bindingMissing: boolean;
}

/**
 * @internal Exported for testing
 *
 * Computes the encoder trigger descriptions from the current dial settings.
 */
export function buildAudioTriggerDescription(dial: AudioDialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = { rotate: ROTATE_LABELS[dial.category] };
  const pushLabel = PRESS_LABELS[dial.pressAction];

  if (pushLabel) description.push = pushLabel;

  return description;
}

/**
 * @internal Exported for testing
 *
 * Draws the 200×100 touch-strip slot as one self-drawn pixmap (the fuel
 * surface convention): a top band with the category label (red "ON AIR"
 * while PTT is held), then a live level bar + numeric value for the internal
 * categories, or a "Turn to adjust volume" hint for the keybind categories
 * (iRacing exposes no volume state — identity only, by design). Text y values
 * are BASELINES (the deck app's QT renderer ignores dominant-baseline).
 */
export function renderAudioStripSvg(state: AudioStripState): string {
  const bandColor = state.pttHeld ? RED : BAND_BG;
  const bandText = state.pttHeld ? "ON AIR" : CATEGORY_LABELS[state.category];

  const parts = [
    `<rect x="0" y="0" width="200" height="30" fill="${bandColor}"/>`,
    `<text x="100" y="21" text-anchor="middle" fill="${WHITE}" font-family="Arial, sans-serif" font-size="16" font-weight="bold">${bandText}</text>`,
  ];

  if (state.volume !== undefined) {
    const barX = 8;
    const barY = 50;
    const barW = 184;
    const barH = 32;
    const on = state.enabled !== false;
    const fillW = Math.max(0, Math.min(barW, (state.volume / 100) * barW));
    const valueText = on ? String(Math.round(state.volume)) : "OFF";

    parts.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="8" fill="${BAR_TRACK}"/>`);

    if (fillW > 0) {
      parts.push(
        `<rect x="${barX}" y="${barY}" width="${fillW.toFixed(1)}" height="${barH}" rx="8" fill="${on ? GREEN : GRAY}"/>`,
      );
    }

    parts.push(
      `<text x="100" y="${barY + barH / 2 + 6}" text-anchor="middle" fill="${WHITE}" font-family="Arial, sans-serif" font-size="17" font-weight="bold">${valueText}</text>`,
    );
  } else {
    parts.push(
      `<text x="100" y="70" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="13">Turn to adjust volume</text>`,
    );
  }

  const content = parts.join("");

  // Missing binding: dim the slot and draw the centered #612 warning triangle
  // over it (same convention as the Fuel Service strip box).
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">${
    state.bindingMissing ? applyBindingWarning(content) : content
  }</svg>`;
}
```

(The imports that the Task 5 class needs are declared now; if `pnpm lint` flags unused imports at this intermediate commit, either fold Tasks 4+5 into one commit or trim the import list to what Task 4 uses and extend it in Task 5 — prefer trimming.)

- [ ] **Step 4: Run helper tests** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && pnpm lint:fix && pnpm format:fix
git add packages/iracing-actions/src/actions/audio-controls/
git commit -m "feat(audio-controls): add dial strip renderer and trigger descriptions (#782)"
```

---

### Task 5: `AudioDialSurface` class + action routing

**Files:**
- Modify: `packages/iracing-actions/src/actions/audio-controls/audio-dial-surface.ts` (add host interface + class)
- Modify: `packages/iracing-actions/src/actions/audio-controls/audio-controls.ts` (branch on `isDial()`, remove legacy dial handlers)
- Modify: `packages/iracing-actions/src/actions/audio-controls/audio-dial-surface.test.ts` (behavior tests driven through the action, the fuel pattern)

**Interfaces:**
- Produces: `AudioDialHost { readonly logger: ILogger; tapBinding(settingKey): Promise<void>; holdBinding(actionId, settingKey): Promise<void>; releaseBinding(actionId): Promise<void>; isBindingMissing(keys): boolean }`; `class AudioDialSurface { constructor(host); willAppear(action, settings); willDisappear(actionId): Promise<void>; didReceiveSettings(action, settings); rotate(action, settings, ticks); down(action, settings); up(actionId); }`.
- Consumes: Task 1 keys/helpers, Task 2 `step*By`, Task 3 toggles, Task 4 renderer.

- [ ] **Step 1: Write failing behavior tests.** Extend `audio-dial-surface.test.ts` with a mocked-module setup mirroring `fuel-dial-surface.test.ts`: `vi.mock("@iracedeck/deck-core")` (real-zod `CommonSettings.extend`, mock `ConnectionStateAwareAction` exposing `tapBinding`/`holdBinding`/`releaseBinding`/`isBindingMissing` hoisted mocks, `onGlobalSettingsChange: vi.fn((cb) => { capturedGlobalListener.value = cb; return () => {}; })`, passthrough `svgToDataUri`, marker `applyBindingWarning`, plus the icon-assembly stubs the keypad path imports — copy the list from `audio-controls.test.ts`), `vi.mock("../../audio/audio-volume.js")` (hoisted `mockStepRaceEngineerVolumeBy`/`mockStepRadarVolumeBy`/`mockReadRaceEngineerVolume` → 50/`mockReadRadarVolume` → 50/`mockIsRaceEngineerEnabled` → true/`mockIsRadarEnabled` → true), `vi.mock("../../audio/audio-toggles.js")` (hoisted `mockToggleRaceEngineerFeature`/`mockToggleRadarFeature`). Import `AudioControls` from `./audio-controls.js` and drive it with fake events:

```typescript
function dialAction(id = "dial-1") {
  return {
    id,
    isDial: () => true,
    isKey: () => false,
    setFeedback: vi.fn().mockResolvedValue(undefined),
    setFeedbackLayout: vi.fn().mockResolvedValue(undefined),
    setTriggerDescription: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
    setImage: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
  };
}

function dialSettings(dial: Record<string, unknown>) {
  return { dial };
}
```

Behavior cases (each: `const action = new AudioControls(); const ctx = dialAction();` then `await action.onWillAppear({ action: ctx, payload: { settings } })` etc.):
  - **willAppear on a dial** pushes a trigger description and one feedback render; does NOT call `setTitle`/`setKeyImage` (keypad path skipped).
  - **rotate on race-engineer** with `ticks: 3` calls `mockStepRaceEngineerVolumeBy(3)`; radar with `ticks: -2` calls `mockStepRadarVolumeBy(-2)`; no `tapBinding`.
  - **rotate on voice-chat** with `ticks: 2` taps `audioVoiceChatVolumeUp` twice; `ticks: -1` taps `audioVoiceChatVolumeDown` once; `ticks: 9` taps 5 times (cap); master maps to the master keys.
  - **rotate with a missing binding** (mock `isBindingMissing` → true) taps nothing.
  - **PTT press**: `onDialDown` with `pressAction: "push-to-talk"` calls `holdBinding(ctx.id, "audioControlsPushToTalk")` and a feedback render containing `ON AIR`; `onDialUp` calls `releaseBinding(ctx.id)` and re-renders without `ON AIR`.
  - **mute press per category**: voice-chat → `tapBinding("audioVoiceChatMute")`; race-engineer → `mockToggleRaceEngineerFeature`; radar → `mockToggleRadarFeature`; master (stale persisted value) → none of those, logs a warning.
  - **none press**: nothing fires on down or up.
  - **willDisappear while PTT held** calls `releaseBinding(ctx.id)`.
  - **global-settings echo**: after willAppear, invoking `capturedGlobalListener.value()` triggers a (throttled) re-render — use `vi.useFakeTimers()` and advance past `RENDER_THROTTLE_MS` to assert the trailing render.
  - **feedback flag off**: `vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false)` → rotate/press still work, `setFeedback`/`setTriggerDescription` never called (and `vi.unstubAllGlobals()` in `afterEach`).
  - **keypad events keep working**: a `{ isDial: () => false, isKey: () => true, ... }` context routed through `onKeyDown` with `category: "voice-chat"` still taps the keypad binding (regression guard for the branch).

- [ ] **Step 2: Run to verify failure** — `AudioDialSurface` not exported / routing absent.

- [ ] **Step 3: Implement the class** (append to `audio-dial-surface.ts`):

```typescript
/** Per-context runtime state. */
interface AudioDialContext {
  settings: AudioControlsSettings;
  action: IDeckActionContext;
  /** True while the PTT binding is held for this context. */
  pttHeld: boolean;
  /** Trailing-throttle timer for feedback renders, or null when idle. */
  renderTimer: ReturnType<typeof setTimeout> | null;
  /** Whether a render was requested during the current throttle window. */
  renderQueued: boolean;
}

/**
 * What the dial surface needs from the owning action: scoped logging and the
 * base-class binding delegates (which must stay on the action so #612
 * readiness/warning semantics are unchanged).
 */
export interface AudioDialHost {
  readonly logger: ILogger;
  tapBinding(settingKey: string): Promise<void>;
  holdBinding(actionId: string, settingKey: string): Promise<void>;
  releaseBinding(actionId: string): Promise<void>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
}

/**
 * The dial surface of the Audio Controls action. One instance per
 * AudioControls instance; holds every dial context's runtime state and all
 * dial-side behavior. The owning action routes events here after parsing
 * settings.
 */
export class AudioDialSurface {
  private contextsState = new Map<string, AudioDialContext>();
  /**
   * Unsubscribe handle for the global-settings listener. Registered lazily on
   * the first dial appear and kept for the plugin lifetime (the action is a
   * singleton) — the internal categories' volume/gate can change from the PI
   * sliders, Pit Crew keys, or another Audio Controls instance, and the strip
   * must track it live.
   */
  private unsubscribeGlobalSettings: (() => void) | null = null;

  constructor(private readonly host: AudioDialHost) {}

  async willAppear(action: IDeckActionContext, settings: AudioControlsSettings): Promise<void> {
    const ctx = this.ensureContext(action, settings);
    this.ensureGlobalListener();
    await this.applyTriggerDescription(ctx);
    this.scheduleRender(ctx);
  }

  async willDisappear(actionId: string): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (ctx) {
      // SAFETY: never leave the PTT key held after the context is gone.
      if (ctx.pttHeld) await this.host.releaseBinding(actionId);

      if (ctx.renderTimer !== null) clearTimeout(ctx.renderTimer);
    }

    this.contextsState.delete(actionId);
  }

  async didReceiveSettings(action: IDeckActionContext, settings: AudioControlsSettings): Promise<void> {
    const ctx = this.ensureContext(action, settings);
    ctx.settings = settings;
    await this.applyTriggerDescription(ctx);
    this.scheduleRender(ctx);
  }

  async rotate(action: IDeckActionContext, settings: AudioControlsSettings, ticks: number): Promise<void> {
    const ctx = this.ensureContext(action, settings);
    ctx.settings = settings;

    if (ticks === 0) return;

    const category = settings.dial.category;

    // Internal categories step the plugin-owned volume globals directly (the
    // #590 deferral this closes) — one signed multi-step persist+apply.
    if (category === "race-engineer" || category === "radar") {
      const next = category === "race-engineer" ? stepRaceEngineerVolumeBy(ticks) : stepRadarVolumeBy(ticks);
      this.host.logger.debug(`${category} volume → ${next} (ticks=${ticks})`);
      this.scheduleRender(ctx);

      return;
    }

    // Keybind categories tap the volume binding once per detent, capped so a
    // fast spin can't queue a long tap burst (iRacing steps a fixed amount per
    // press — there is no absolute-volume command to scale instead).
    const key =
      category === "voice-chat"
        ? ticks > 0
          ? VOICE_CHAT_VOLUME_UP_KEY
          : VOICE_CHAT_VOLUME_DOWN_KEY
        : ticks > 0
          ? MASTER_VOLUME_UP_KEY
          : MASTER_VOLUME_DOWN_KEY;

    if (this.host.isBindingMissing(key)) {
      this.host.logger.debug(`Rotate ignored — ${key} binding not configured`);

      return;
    }

    const taps = Math.min(Math.abs(ticks), MAX_TAPS_PER_EVENT);

    for (let i = 0; i < taps; i++) {
      await this.host.tapBinding(key);
    }
  }

  async down(action: IDeckActionContext, settings: AudioControlsSettings): Promise<void> {
    const ctx = this.ensureContext(action, settings);
    ctx.settings = settings;
    const press = settings.dial.pressAction;

    if (press === "none") return;

    if (press === "push-to-talk") {
      if (this.host.isBindingMissing(PUSH_TO_TALK_KEY)) {
        this.host.logger.warn("PTT press ignored — push-to-talk binding not configured");

        return;
      }

      ctx.pttHeld = true;
      this.host.logger.info("Audio dial PTT held");
      await this.host.holdBinding(action.id, PUSH_TO_TALK_KEY);
      this.scheduleRender(ctx);

      return;
    }

    // Mute / Unmute fires immediately on dialDown (no long-press slot exists,
    // so no release-time classification is needed).
    this.host.logger.info("Audio dial mute pressed");
    await this.doMute(ctx);
  }

  async up(actionId: string): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (!ctx?.pttHeld) return;

    ctx.pttHeld = false;
    this.host.logger.info("Audio dial PTT released");
    await this.host.releaseBinding(actionId);
    this.scheduleRender(ctx);
  }

  /**
   * Runs Mute / Unmute for the current category: voice chat taps the iRacing
   * mute binding; the internal categories toggle their feature gate with
   * semantics identical to the Pit Crew toggle keys (shared pathway). Master
   * has no mute (no iRacing keybind exists) — the PI never offers it, so a
   * reached master here is a stale persisted value: log + no-op.
   */
  private async doMute(ctx: AudioDialContext): Promise<void> {
    const category = ctx.settings.dial.category;

    if (category === "voice-chat") {
      if (this.host.isBindingMissing(VOICE_CHAT_MUTE_KEY)) {
        this.host.logger.warn("Mute press ignored — voice chat mute binding not configured");

        return;
      }

      await this.host.tapBinding(VOICE_CHAT_MUTE_KEY);

      return;
    }

    if (category === "race-engineer") {
      toggleRaceEngineerFeature(this.host.logger);
      this.scheduleRender(ctx);

      return;
    }

    if (category === "radar") {
      toggleRadarFeature(this.host.logger);
      this.scheduleRender(ctx);

      return;
    }

    this.host.logger.warn(`Mute / Unmute is not available for the ${category} category`);
  }

  private ensureContext(action: IDeckActionContext, settings: AudioControlsSettings): AudioDialContext {
    let ctx = this.contextsState.get(action.id);

    if (!ctx) {
      ctx = { settings, action, pttHeld: false, renderTimer: null, renderQueued: false };
      this.contextsState.set(action.id, ctx);
    }

    ctx.action = action;

    return ctx;
  }

  private ensureGlobalListener(): void {
    if (this.unsubscribeGlobalSettings) return;

    this.unsubscribeGlobalSettings = onGlobalSettingsChange(() => {
      for (const ctx of this.contextsState.values()) this.scheduleRender(ctx);
    });
  }

  /**
   * Leading+trailing render throttle per context: the first request renders
   * immediately; requests inside the window coalesce into one trailing render.
   * Keeps a fast spin (render per detent + a global-settings echo per persist)
   * under the ≤10 setFeedback/sec/dial cap.
   */
  private scheduleRender(ctx: AudioDialContext): void {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (ctx.renderTimer !== null) {
      ctx.renderQueued = true;

      return;
    }

    void this.renderFeedback(ctx);
    ctx.renderTimer = setTimeout(() => {
      ctx.renderTimer = null;

      if (ctx.renderQueued) {
        ctx.renderQueued = false;
        this.scheduleRender(ctx);
      }
    }, RENDER_THROTTLE_MS);
  }

  /** Pushes the encoder trigger descriptions for a dial (Elgato only). */
  private async applyTriggerDescription(ctx: AudioDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildAudioTriggerDescription(ctx.settings.dial));
  }

  /** Resolve everything the strip renderer needs for this context. */
  private stripState(ctx: AudioDialContext): AudioStripState {
    const category = ctx.settings.dial.category;
    const internal = category === "race-engineer" || category === "radar";

    return {
      category,
      volume: internal ? (category === "race-engineer" ? readRaceEngineerVolume() : readRadarVolume()) : undefined,
      enabled: internal ? (category === "race-engineer" ? isRaceEngineerEnabled() : isRadarEnabled()) : undefined,
      pttHeld: ctx.pttHeld,
      bindingMissing: this.host.isBindingMissing([
        ...rotationBindingKeys(category),
        ...pressBindingKeys(ctx.settings.dial),
      ]),
    };
  }

  private async renderFeedback(ctx: AudioDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    const feedback: DeckFeedbackPayload = { box: svgToDataUri(renderAudioStripSvg(this.stripState(ctx))) };
    await ctx.action.setFeedback(feedback);
  }
}
```

- [ ] **Step 4: Route events in `audio-controls.ts`.**
  - Add the field:

```typescript
/** The dial half of the action; all IDeck dial events route here (#782). */
private readonly dialSurface = new AudioDialSurface({
  logger: this.logger,
  tapBinding: (settingKey) => this.tapBinding(settingKey),
  holdBinding: (actionId, settingKey) => this.holdBinding(actionId, settingKey),
  releaseBinding: (actionId) => this.releaseBinding(actionId),
  isBindingMissing: (keys) => this.isBindingMissing(keys),
});
```

  - `onWillAppear` / `onDidReceiveSettings`: after `super` + parse, insert

```typescript
if (ev.action.isDial()) {
  await this.dialSurface.willAppear(ev.action, settings); // didReceiveSettings in the other hook
  return;
}
```

  - `onWillDisappear` becomes:

```typescript
override async onWillDisappear(ev: IDeckWillDisappearEvent<AudioControlsSettings>): Promise<void> {
  await this.dialSurface.willDisappear(ev.action.id);
  await this.releaseBinding(ev.action.id);
  await super.onWillDisappear(ev);
}
```

  - Replace the three legacy dial handlers wholesale:

```typescript
override async onDialRotate(ev: IDeckDialRotateEvent<AudioControlsSettings>): Promise<void> {
  const settings = this.parseSettings(ev.payload.settings);
  await this.dialSurface.rotate(ev.action, settings, ev.payload.ticks);
}

override async onDialDown(ev: IDeckDialDownEvent<AudioControlsSettings>): Promise<void> {
  const settings = this.parseSettings(ev.payload.settings);
  await this.dialSurface.down(ev.action, settings);
}

override async onDialUp(ev: IDeckDialUpEvent<AudioControlsSettings>): Promise<void> {
  await this.dialSurface.up(ev.action.id);
}
```

  - Update the `INTERNAL_VOLUME_CATEGORIES` doc comment (it still says "Dial/encoder control for them is intentionally out of scope for now (issue #590)") to say dial control now lives in the dial surface (#782). Update the class doc comment similarly.

- [ ] **Step 5: Run the whole actions test package**

Run: `cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && npx vitest run packages/iracing-actions/`
Expected: PASS — new behavior tests + all existing suites (the legacy dial tests in `audio-controls.test.ts` that asserted the old inline dial behavior must be UPDATED, not deleted-silently: rewrite them to assert the new routing, e.g. dial rotate on voice-chat now taps per tick).

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && pnpm lint:fix && pnpm format:fix
git add packages/iracing-actions/src/actions/audio-controls/
git commit -m "feat(audio-controls): route dial events to the new dial surface (#782)"
```

---

### Task 6: Comms catalog + Property Inspector

**Files:**
- Modify: `packages/iracing-actions/src/actions/comms-catalog.ts`
- Regenerate: `packages/iracing-actions/src/actions/data/action-comms.json` (`pnpm generate:action-comms`)
- Modify: `packages/iracing-actions/src/actions/audio-controls/audio-controls.ejs`

- [ ] **Step 1: Add the dial catalog entry** right after the existing `"audio-controls"` entry:

```typescript
// The dial surface of Audio Controls (#782): rotation is keyed by
// `dial.category` (BOTH volume keys required for the keybind categories; the
// internal categories drive plugin audio — no binding), press by
// `dial.pressAction` — one shared map, the value sets don't collide (the
// #759 shared-map pattern). The PI hides the press status line for
// internal-category Mute / Unmute (plugin audio, nothing to configure);
// "none" is omitted so its line renders nothing.
"audio-controls-dial": entry("dial.category", {
  "voice-chat": pair("audioVoiceChatVolumeUp", "audioVoiceChatVolumeDown"),
  master: pair("audioMasterVolumeUp", "audioMasterVolumeDown"),
  "race-engineer": keybindFixed(),
  radar: keybindFixed(),
  "push-to-talk": keybind("audioControlsPushToTalk"),
  "mute-unmute": keybindBy("dial.category", { "voice-chat": "audioVoiceChatMute" }),
}),
```

- [ ] **Step 2: Regenerate + test**

```bash
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && pnpm generate:action-comms
npx vitest run packages/iracing-actions/src/actions/comms-catalog.test.ts
```

Expected: PASS (freshness + key cross-check — all six keys exist in `key-bindings.json`'s `audioControls` list).

- [ ] **Step 3: Restructure `audio-controls.ejs`.** Using `fuel-service.ejs` as the exact reference:
  1. Wrap the existing keypad controls (Mode select + keypad `ird-binding-status` + Action select + internal-volume note) in `<div id="keypad-settings">…</div>`.
  2. Wrap the per-action appearance includes (`title-overrides` → `common-settings`) in `<div id="keypad-appearance">…</div>`; wrap the global appearance includes (`global-title-defaults` → `global-flag-flash`) in `<div id="keypad-global-appearance">…</div>`. Leave `global-key-bindings` and `global-common-settings` outside (both surfaces use the same `audioControls` bindings — always shown).
  3. Add the dial comms var next to the keypad one: `<% var __dialComms = require('./data/action-comms.json')['audio-controls-dial']; %>`
  4. Add the dial section after `#keypad-settings`:

```ejs
<!-- Dial settings — shown only when this instance is a dial (#782). -->
<div id="dial-settings" class="hidden">
	<sdpi-item label="Volume">
		<sdpi-select id="dial-category-select" setting="dial.category" default="voice-chat">
			<optgroup label="iRacing audio">
				<option value="voice-chat">Voice Chat</option>
				<option value="master">Master</option>
			</optgroup>
			<optgroup label="iRaceDeck audio">
				<option value="race-engineer">Race Engineer</option>
				<option value="radar">Radar</option>
			</optgroup>
		</sdpi-select>
	</sdpi-item>
	<div class="ird-supporting-text hidden" id="dial-internal-note">
		Adjusts iRaceDeck's own audio level — the touch display shows the live level.
	</div>
	<ird-binding-status mode-setting="dial.category" comms='<%= JSON.stringify(__dialComms) %>'></ird-binding-status>

	<sdpi-item label="Press Action">
		<sdpi-select id="dial-press-select" setting="dial.pressAction" default="none">
			<option value="push-to-talk">Push to Talk</option>
			<option value="mute-unmute" id="dial-mute-option">Mute / Unmute</option>
			<option value="none">None</option>
		</sdpi-select>
	</sdpi-item>
	<div id="dial-press-status">
		<ird-binding-status mode-setting="dial.pressAction" comms='<%= JSON.stringify(__dialComms) %>'></ird-binding-status>
	</div>
</div>
```

  5. Extend the `<script>` block: keep the existing keypad `updateVisibility` logic untouched, then append the fuel-style controller detection plus the dial JS (all inside the same script):

```javascript
// Which surface this instance sits on (#759 pattern): fall back to the
// keypad view when unknown.
async function resolveController() {
	try {
		const client = window.SDPIComponents && window.SDPIComponents.streamDeckClient;
		const info = client && (await client.getConnectionInfo());
		const controller = info && info.actionInfo && info.actionInfo.payload && info.actionInfo.payload.controller;
		return controller === "Encoder" || controller === "Knob" ? "Encoder" : "Keypad";
	} catch (err) {
		return "Keypad";
	}
}

function applyDialView() {
	document.getElementById("keypad-settings")?.classList.add("hidden");
	document.getElementById("keypad-appearance")?.classList.add("hidden");
	document.getElementById("keypad-global-appearance")?.classList.add("hidden");
	document.getElementById("dial-settings")?.classList.remove("hidden");
}

// Master has no Mute / Unmute (iRacing has no master-mute keybind): detach
// the option (sdpi-select re-renders options via MutationObserver — the same
// pattern as the keypad mute option above). The press status line is hidden
// for internal-category Mute / Unmute — the mute is plugin-internal, there
// is nothing to configure.
const DIAL_MUTABLE_CATEGORIES = new Set(["voice-chat", "race-engineer", "radar"]);
const DIAL_INTERNAL_CATEGORIES = new Set(["race-engineer", "radar"]);
let dialMuteOption = null;
let dialMuteOptionParent = null;

function updateDialVisibility() {
	const categorySelect = document.getElementById("dial-category-select");
	const pressSelect = document.getElementById("dial-press-select");
	const category = (categorySelect && categorySelect.value) || "voice-chat";
	const press = (pressSelect && pressSelect.value) || "none";
	const internalNote = document.getElementById("dial-internal-note");
	const pressStatus = document.getElementById("dial-press-status");

	if (internalNote) internalNote.classList.toggle("hidden", !DIAL_INTERNAL_CATEGORIES.has(category));

	if (pressStatus) {
		const hideStatus = press === "mute-unmute" && DIAL_INTERNAL_CATEGORIES.has(category);
		pressStatus.classList.toggle("hidden", hideStatus);
	}

	if (!dialMuteOption || !dialMuteOptionParent) return;

	const isAttached = dialMuteOption.parentNode === dialMuteOptionParent;

	if (!DIAL_MUTABLE_CATEGORIES.has(category)) {
		if (pressSelect && pressSelect.value === "mute-unmute") {
			pressSelect.value = "none";
			pressSelect.dispatchEvent(new Event("input", { bubbles: true }));
			pressSelect.dispatchEvent(new Event("change", { bubbles: true }));
		}
		if (isAttached) dialMuteOption.remove();
	} else if (!isAttached) {
		dialMuteOptionParent.appendChild(dialMuteOption);
	}
}
```

  6. In `initialize()`: after the existing keypad wiring, add

```javascript
dialMuteOption = document.querySelector('#dial-press-select option[value="mute-unmute"]');
dialMuteOptionParent = dialMuteOption ? dialMuteOption.parentNode : null;

for (const id of ["dial-category-select", "dial-press-select"]) {
	const el = document.getElementById(id);
	if (!el) continue;
	el.addEventListener("change", updateDialVisibility);
	el.addEventListener("input", updateDialVisibility);
}
updateDialVisibility();
setInterval(updateDialVisibility, 100); // polling fallback (sdpi events are unreliable)

if ((await resolveController()) === "Encoder") {
	applyDialView();
}
```

- [ ] **Step 4: Compile the PI + verify output**

```bash
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && pnpm --filter @iracedeck/iracing-plugin-stream-deck build
grep -c "dial-settings" packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/ui/audio-controls.html
```

Expected: build succeeds; grep ≥ 1.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && pnpm lint:fix && pnpm format:fix
git add packages/iracing-actions/src/actions/comms-catalog.ts packages/iracing-actions/src/actions/data/action-comms.json packages/iracing-actions/src/actions/audio-controls/audio-controls.ejs
git commit -m "feat(audio-controls): dial comms catalog entry and controller-branched PI (#782)"
```

---

### Task 7: Manifests + Elgato layout

**Files:**
- Create: `packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/layouts/audio-controls.json`
- Modify: `packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/manifest.json` (audio-controls entry)
- Modify: `packages/iracing-plugin-mirabox/com.iracedeck.sd.core.sdPlugin/manifest.json` (audio-controls entry)
- Ulanzi manifest: NO change (already `["Keypad", "Encoder"]` + `$UA1`; the surface routing changes its dial behavior automatically)

- [ ] **Step 1: Layout file** (`layouts/audio-controls.json`):

```json
{
  "$schema": "https://schemas.elgato.com/streamdeck/plugins/layout.json",
  "id": "audio-controls",
  "items": [
    {
      "key": "box",
      "type": "pixmap",
      "rect": [0, 0, 200, 100]
    }
  ]
}
```

- [ ] **Step 2: Elgato manifest.** In the audio-controls entry: `"Controllers": ["Keypad", "Encoder"]` and add (after `"Controllers"`, matching the fuel-service entry's shape):

```json
"Encoder": {
  "layout": "layouts/audio-controls.json",
  "TriggerDescription": {
    "Rotate": "Adjust volume",
    "Push": "Push to talk / mute"
  }
},
```

Update the Tooltip to: `"Audio volume and mute controls (iRacing voice chat & master; iRaceDeck Race Engineer & Radar); on a dial: rotate for volume, push to talk or mute"`.

- [ ] **Step 3: Mirabox manifest.** `"Controllers": ["Keypad", "Knob"]` (no Encoder block — no touch strip); Tooltip: same as Elgato with "on a dial" → "on a knob".

- [ ] **Step 4: Build all plugins + run manifest tests**

```bash
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && pnpm build && pnpm test
```

Expected: build 20/20 tasks; all tests pass (including `scripts/manifest-actions-order.test.mjs`).

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-plugin-stream-deck/ packages/iracing-plugin-mirabox/
git commit -m "feat(plugins): declare Audio Controls dial support in Elgato and Mirabox manifests (#782)"
```

---

### Task 8: Documentation artifacts

**Files:**
- Modify: `packages/website/src/content/docs/docs/actions/audio-voice/audio-controls.md` (dial section; mirror the dial section format in the website `fuel-service` page / `website-action-docs.md` rule)
- Modify: `packages/website/src/content/docs/changelog.mdx` (2.0.0 section, `**Features**` bullet)
- Modify: `docs/reference/actions.json` (audio-controls: mark encoder support — copy the exact field shape from the fuel-service entry)
- Modify: `.claude/skills/iracedeck-actions/SKILL.md` (Audio Controls row: replace "dial control is out of scope for now (#590)" with the dial surface description; update any dial-capable-actions list)
- Modify: `.claude/rules/encoders-and-touchscreen.md` (add Audio Controls to the dial-surface consumers in "Current state")

- [ ] **Step 1: Website action page.** Add a dial section to `audio-controls.md` documenting: rotate = volume for the selected category (per-category Communication Method: voice chat/master = Key binding ×2 required; Race Engineer/Radar = internal), press action = Push to Talk (hold) / Mute–Unmute (voice chat = Key binding; Race Engineer/Radar = toggles the feature like the Pit Crew keys; master = not available) / None (default), touch display = live level bar for Race Engineer/Radar with OFF state, identity-only for iRacing categories (state not exposed by iRacing), ON AIR indicator while PTT held. Note Mirabox/Ulanzi: rotate + press only (no touch display).
- [ ] **Step 2: Changelog.** Under the in-development `## 2.0.0` section's `**Features**` list add ONE line (check whether an Audio Controls line already exists to fold into):

```markdown
- Audio Controls works on Stream Deck+ dials and Mirabox knobs: rotate adjusts the selected audio's volume (voice chat, master, Race Engineer, Radar), the press is configurable as push-to-talk or mute/unmute, and the touch display shows a live level bar for the Race Engineer and Radar levels.
```

- [ ] **Step 3: Reference data + skill + rule.** Make the three remaining edits (actions.json encoder flag, SKILL.md row + counts/notes, encoders-and-touchscreen.md consumer list). In SKILL.md also fix the Audio Controls row's "#590 out of scope" note.
- [ ] **Step 4: Verify website builds**

```bash
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && pnpm --filter @iracedeck/website build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/website/ docs/reference/actions.json .claude/
git commit -m "docs(audio-controls): document the dial surface across website, reference data, and rules (#782)"
```

---

### Task 9: Full verification sweep

- [ ] **Step 1: Full build, lint, format, test from clean state**

```bash
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-782" && pnpm lint:fix && pnpm format:fix && pnpm build && pnpm test
```

Expected: no lint/format diffs, build 20/20, ALL tests pass. If lint/format changed files, commit them (`chore(audio-controls): lint/format pass (#782)`).

- [ ] **Step 2: Manual smoke of generated artifacts** — `ui/audio-controls.html` contains the dial section and both `ird-binding-status` lines with escaped comms JSON; Elgato `manifest.json` has the Encoder block; `bin/plugin.js` for Mirabox contains no `setFeedback` call from the audio surface path is NOT required (the flag gates behavior at runtime call sites; just confirm the Mirabox build succeeded).
- [ ] **Step 3: STOP.** Do NOT push, do NOT create a PR. Report completion and wait for Niklas's manual iRacing/Stream Deck test (per standing instruction). Remaining for the PR phase (after manual test): PR targeting `release/2.0` titled `feat(audio-controls): add a dial surface to Audio Controls (#782)` using the repo PR template.

## Verification items from the issue deferred to manual testing

- PTT hold semantics on a real Mirabox knob (dialDown/dialUp duration).
- Keypad instances of the now-dual-controller action still join multi-actions.
- Ulanzi encoder placement behavior change works with the `$UA1` layout.
