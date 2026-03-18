# Replay Control Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate three replay actions into a single unified Replay Control action with 17 modes and telemetry-driven play/pause toggle.

**Architecture:** Single action class with a mode dropdown, reusing existing icon SVGs from the three legacy replay action icon directories. The three old actions are hidden via `VisibleInActionsList: false` in the manifest but remain fully functional. The new action subscribes to `IsReplayPlaying` telemetry for the play/pause toggle.

**Tech Stack:** TypeScript, Zod, Stream Deck SDK (`@elgato/streamdeck`), iRacing SDK (`@iracedeck/iracing-sdk`), Vitest, EJS templates.

**Spec:** `docs/superpowers/specs/2026-03-13-replay-control-design.md`

---

## Task 1: Copy icon SVGs for the new action

**Files:**
- Create: `packages/icons/replay-control/play-pause.svg` (and 16 more — see full list below)
- Create: `packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/imgs/actions/replay-control/icon.svg`
- Create: `packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/imgs/actions/replay-control/key.svg`

Copy existing icon SVGs into a new `packages/icons/replay-control/` directory. These are the 17 mode icons:

| Target file | Source |
|-------------|--------|
| `play-pause.svg` | `packages/icons/replay-transport/play.svg` |
| `stop.svg` | `packages/icons/replay-transport/stop.svg` |
| `fast-forward.svg` | `packages/icons/replay-transport/fast-forward.svg` |
| `rewind.svg` | `packages/icons/replay-transport/rewind.svg` |
| `slow-motion.svg` | `packages/icons/replay-transport/slow-motion.svg` |
| `frame-forward.svg` | `packages/icons/replay-transport/frame-forward.svg` |
| `frame-backward.svg` | `packages/icons/replay-transport/frame-backward.svg` |
| `speed-increase.svg` | `packages/icons/replay-speed/increase.svg` |
| `speed-decrease.svg` | `packages/icons/replay-speed/decrease.svg` |
| `next-session.svg` | `packages/icons/replay-navigation/next-session.svg` |
| `prev-session.svg` | `packages/icons/replay-navigation/prev-session.svg` |
| `next-lap.svg` | `packages/icons/replay-navigation/next-lap.svg` |
| `prev-lap.svg` | `packages/icons/replay-navigation/prev-lap.svg` |
| `next-incident.svg` | `packages/icons/replay-navigation/next-incident.svg` |
| `prev-incident.svg` | `packages/icons/replay-navigation/prev-incident.svg` |
| `jump-to-beginning.svg` | `packages/icons/replay-navigation/jump-to-start.svg` |
| `jump-to-live.svg` | `packages/icons/replay-navigation/jump-to-end.svg` |

Also copy category and key icons:
- `com.iracedeck.sd.core.sdPlugin/imgs/actions/replay-control/icon.svg` ← copy from `imgs/actions/replay-transport/icon.svg`
- `com.iracedeck.sd.core.sdPlugin/imgs/actions/replay-control/key.svg` ← copy from `imgs/actions/replay-transport/key.svg`

- [ ] **Step 1:** Create `packages/icons/replay-control/` directory and copy all 17 SVGs with the names shown in the table above.

```bash
mkdir -p packages/icons/replay-control
cp packages/icons/replay-transport/play.svg packages/icons/replay-control/play-pause.svg
cp packages/icons/replay-transport/stop.svg packages/icons/replay-control/stop.svg
cp packages/icons/replay-transport/fast-forward.svg packages/icons/replay-control/fast-forward.svg
cp packages/icons/replay-transport/rewind.svg packages/icons/replay-control/rewind.svg
cp packages/icons/replay-transport/slow-motion.svg packages/icons/replay-control/slow-motion.svg
cp packages/icons/replay-transport/frame-forward.svg packages/icons/replay-control/frame-forward.svg
cp packages/icons/replay-transport/frame-backward.svg packages/icons/replay-control/frame-backward.svg
cp packages/icons/replay-speed/increase.svg packages/icons/replay-control/speed-increase.svg
cp packages/icons/replay-speed/decrease.svg packages/icons/replay-control/speed-decrease.svg
cp packages/icons/replay-navigation/next-session.svg packages/icons/replay-control/next-session.svg
cp packages/icons/replay-navigation/prev-session.svg packages/icons/replay-control/prev-session.svg
cp packages/icons/replay-navigation/next-lap.svg packages/icons/replay-control/next-lap.svg
cp packages/icons/replay-navigation/prev-lap.svg packages/icons/replay-control/prev-lap.svg
cp packages/icons/replay-navigation/next-incident.svg packages/icons/replay-control/next-incident.svg
cp packages/icons/replay-navigation/prev-incident.svg packages/icons/replay-control/prev-incident.svg
cp packages/icons/replay-navigation/jump-to-start.svg packages/icons/replay-control/jump-to-beginning.svg
cp packages/icons/replay-navigation/jump-to-end.svg packages/icons/replay-control/jump-to-live.svg
```

- [ ] **Step 2:** Create category and key icon directories and copy icons.

```bash
mkdir -p "packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/imgs/actions/replay-control"
cp "packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/imgs/actions/replay-transport/icon.svg" "packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/imgs/actions/replay-control/icon.svg"
cp "packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/imgs/actions/replay-transport/key.svg" "packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/imgs/actions/replay-control/key.svg"
```

All commands run from the repo root directory `C:\Users\nikla\Coding\iRaceDeck`.

- [ ] **Step 3:** Verify all 19 files exist (17 mode icons + category icon + key icon).

```bash
ls packages/icons/replay-control/ | wc -l  # Should be 17
ls packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/imgs/actions/replay-control/  # Should list icon.svg and key.svg
```

- [ ] **Step 4:** Commit.

```bash
git add packages/icons/replay-control/ packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/imgs/actions/replay-control/
git commit -m "feat(stream-deck-plugin): add Replay Control icon SVGs

Copy existing replay icon artwork into new replay-control icon directory.
All 17 mode icons plus category and key icons."
```

---

## Task 2: Write the action tests (TDD — red phase)

**Files:**
- Create: `packages/stream-deck-plugin/src/actions/replay-control.test.ts`

Write the unit tests first before writing the action implementation.

- [ ] **Step 1:** Create the test file `packages/stream-deck-plugin/src/actions/replay-control.test.ts` with the following content:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateReplayControlSvg } from "./replay-control.js";

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

// Mock all 17 replay-control icon SVGs
vi.mock("@iracedeck/icons/replay-control/play-pause.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">play-pause {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/stop.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">stop {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/fast-forward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">fast-forward {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/rewind.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">rewind {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/slow-motion.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">slow-motion {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/frame-forward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">frame-forward {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/frame-backward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">frame-backward {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/speed-increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">speed-increase {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/speed-decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">speed-decrease {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/next-session.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next-session {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/prev-session.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">prev-session {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/next-lap.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next-lap {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/prev-lap.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">prev-lap {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/next-incident.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">next-incident {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/prev-incident.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">prev-incident {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/jump-to-beginning.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">jump-to-beginning {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-control/jump-to-live.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">jump-to-live {{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("../shared/index.js", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
      const schema = {
        parse: (data: Record<string, unknown>) => ({ ...data }),
        safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
      };

      return schema;
    },
    parse: (data: Record<string, unknown>) => ({ ...data }),
    safeParse: (data: Record<string, unknown>) => ({ success: true, data: { ...data } }),
  },
  ConnectionStateAwareAction: class MockConnectionStateAwareAction {
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn(() => null) };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
  },
  createSDLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
  getCommands: vi.fn(() => ({
    replay: {
      play: vi.fn(() => true),
      pause: vi.fn(() => true),
      fastForward: vi.fn(() => true),
      rewind: vi.fn(() => true),
      slowMotion: vi.fn(() => true),
      nextFrame: vi.fn(() => true),
      prevFrame: vi.fn(() => true),
      nextSession: vi.fn(() => true),
      prevSession: vi.fn(() => true),
      nextLap: vi.fn(() => true),
      prevLap: vi.fn(() => true),
      nextIncident: vi.fn(() => true),
      prevIncident: vi.fn(() => true),
      goToStart: vi.fn(() => true),
      goToEnd: vi.fn(() => true),
    },
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

describe("ReplayControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateReplayControlSvg", () => {
    const ALL_MODES = [
      "play-pause",
      "stop",
      "fast-forward",
      "rewind",
      "slow-motion",
      "frame-forward",
      "frame-backward",
      "speed-increase",
      "speed-decrease",
      "next-session",
      "prev-session",
      "next-lap",
      "prev-lap",
      "next-incident",
      "prev-incident",
      "jump-to-beginning",
      "jump-to-live",
    ] as const;

    it.each(ALL_MODES)("should generate a valid data URI for %s", (mode) => {
      const result = generateReplayControlSvg({ mode });

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different modes", () => {
      const results = ALL_MODES.map((mode) => generateReplayControlSvg({ mode }));

      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(ALL_MODES.length);
    });

    // Transport labels
    it("should include PLAY label for play-pause mode", () => {
      const result = generateReplayControlSvg({ mode: "play-pause" });

      expect(decodeURIComponent(result)).toContain("PLAY");
      expect(decodeURIComponent(result)).toContain("REPLAY");
    });

    it("should include STOP label for stop mode", () => {
      const result = generateReplayControlSvg({ mode: "stop" });

      expect(decodeURIComponent(result)).toContain("STOP");
      expect(decodeURIComponent(result)).toContain("REPLAY");
    });

    it("should include FWD label for fast-forward mode", () => {
      const result = generateReplayControlSvg({ mode: "fast-forward" });

      expect(decodeURIComponent(result)).toContain("FWD");
      expect(decodeURIComponent(result)).toContain("REPLAY");
    });

    it("should include REWIND label for rewind mode", () => {
      const result = generateReplayControlSvg({ mode: "rewind" });

      expect(decodeURIComponent(result)).toContain("REWIND");
      expect(decodeURIComponent(result)).toContain("REPLAY");
    });

    it("should include SLOW MO label for slow-motion mode", () => {
      const result = generateReplayControlSvg({ mode: "slow-motion" });

      expect(decodeURIComponent(result)).toContain("SLOW MO");
      expect(decodeURIComponent(result)).toContain("REPLAY");
    });

    it("should include FRAME FWD labels for frame-forward mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "frame-forward" }));

      expect(decoded).toContain("FRAME FWD");
      expect(decoded).toContain("REPLAY");
    });

    it("should include FRAME BACK labels for frame-backward mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "frame-backward" }));

      expect(decoded).toContain("FRAME BACK");
      expect(decoded).toContain("REPLAY");
    });

    // Speed labels
    it("should include SPEED UP label for speed-increase mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-increase" }));

      expect(decoded).toContain("SPEED UP");
      expect(decoded).toContain("REPLAY");
    });

    it("should include SLOW DOWN label for speed-decrease mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "speed-decrease" }));

      expect(decoded).toContain("SLOW DOWN");
      expect(decoded).toContain("REPLAY");
    });

    // Navigation labels
    it("should include NEXT and SESSION labels for next-session mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "next-session" }));

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("SESSION");
    });

    it("should include PREVIOUS and SESSION labels for prev-session mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "prev-session" }));

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("SESSION");
    });

    it("should include NEXT and LAP labels for next-lap mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "next-lap" }));

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("LAP");
    });

    it("should include PREVIOUS and LAP labels for prev-lap mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "prev-lap" }));

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("LAP");
    });

    it("should include NEXT and INCIDENT labels for next-incident mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "next-incident" }));

      expect(decoded).toContain("NEXT");
      expect(decoded).toContain("INCIDENT");
    });

    it("should include PREVIOUS and INCIDENT labels for prev-incident mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "prev-incident" }));

      expect(decoded).toContain("PREVIOUS");
      expect(decoded).toContain("INCIDENT");
    });

    it("should include BEGINNING and REPLAY labels for jump-to-beginning mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "jump-to-beginning" }));

      expect(decoded).toContain("BEGINNING");
      expect(decoded).toContain("REPLAY");
    });

    it("should include LIVE and REPLAY labels for jump-to-live mode", () => {
      const decoded = decodeURIComponent(generateReplayControlSvg({ mode: "jump-to-live" }));

      expect(decoded).toContain("LIVE");
      expect(decoded).toContain("REPLAY");
    });
  });
});
```

- [ ] **Step 2:** Run the tests to verify they fail (the action source doesn't exist yet).

```bash
cd packages/stream-deck-plugin && pnpm test -- src/actions/replay-control.test.ts
```

Expected: FAIL — `Cannot find module './replay-control.js'`

- [ ] **Step 3:** Commit the failing tests.

```bash
git add packages/stream-deck-plugin/src/actions/replay-control.test.ts
git commit -m "test(stream-deck-plugin): add Replay Control unit tests (red phase)

Tests for all 17 modes: data URI generation, label verification, and
icon uniqueness. Tests will pass once the action implementation is added."
```

---

## Task 3: Implement the Replay Control action (TDD — green phase)

**Files:**
- Create: `packages/stream-deck-plugin/src/actions/replay-control.ts`

- [ ] **Step 1:** Create the action source file `packages/stream-deck-plugin/src/actions/replay-control.ts`:

```typescript
import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import playPauseIconSvg from "@iracedeck/icons/replay-control/play-pause.svg";
import stopIconSvg from "@iracedeck/icons/replay-control/stop.svg";
import fastForwardIconSvg from "@iracedeck/icons/replay-control/fast-forward.svg";
import rewindIconSvg from "@iracedeck/icons/replay-control/rewind.svg";
import slowMotionIconSvg from "@iracedeck/icons/replay-control/slow-motion.svg";
import frameForwardIconSvg from "@iracedeck/icons/replay-control/frame-forward.svg";
import frameBackwardIconSvg from "@iracedeck/icons/replay-control/frame-backward.svg";
import speedIncreaseIconSvg from "@iracedeck/icons/replay-control/speed-increase.svg";
import speedDecreaseIconSvg from "@iracedeck/icons/replay-control/speed-decrease.svg";
import nextSessionIconSvg from "@iracedeck/icons/replay-control/next-session.svg";
import prevSessionIconSvg from "@iracedeck/icons/replay-control/prev-session.svg";
import nextLapIconSvg from "@iracedeck/icons/replay-control/next-lap.svg";
import prevLapIconSvg from "@iracedeck/icons/replay-control/prev-lap.svg";
import nextIncidentIconSvg from "@iracedeck/icons/replay-control/next-incident.svg";
import prevIncidentIconSvg from "@iracedeck/icons/replay-control/prev-incident.svg";
import jumpToBeginningIconSvg from "@iracedeck/icons/replay-control/jump-to-beginning.svg";
import jumpToLiveIconSvg from "@iracedeck/icons/replay-control/jump-to-live.svg";
import z from "zod";

import {
  CommonSettings,
  ConnectionStateAwareAction,
  createSDLogger,
  getCommands,
  LogLevel,
  renderIconTemplate,
  svgToDataUri,
} from "../shared/index.js";

import type { TelemetryData } from "@iracedeck/iracing-sdk";

const REPLAY_CONTROL_MODES = [
  "play-pause",
  "stop",
  "fast-forward",
  "rewind",
  "slow-motion",
  "frame-forward",
  "frame-backward",
  "speed-increase",
  "speed-decrease",
  "next-session",
  "prev-session",
  "next-lap",
  "prev-lap",
  "next-incident",
  "prev-incident",
  "jump-to-beginning",
  "jump-to-live",
] as const;

type ReplayControlMode = (typeof REPLAY_CONTROL_MODES)[number];

const REPLAY_CONTROL_ICONS: Record<ReplayControlMode, string> = {
  "play-pause": playPauseIconSvg,
  stop: stopIconSvg,
  "fast-forward": fastForwardIconSvg,
  rewind: rewindIconSvg,
  "slow-motion": slowMotionIconSvg,
  "frame-forward": frameForwardIconSvg,
  "frame-backward": frameBackwardIconSvg,
  "speed-increase": speedIncreaseIconSvg,
  "speed-decrease": speedDecreaseIconSvg,
  "next-session": nextSessionIconSvg,
  "prev-session": prevSessionIconSvg,
  "next-lap": nextLapIconSvg,
  "prev-lap": prevLapIconSvg,
  "next-incident": nextIncidentIconSvg,
  "prev-incident": prevIncidentIconSvg,
  "jump-to-beginning": jumpToBeginningIconSvg,
  "jump-to-live": jumpToLiveIconSvg,
};

const REPLAY_CONTROL_LABELS: Record<ReplayControlMode, { mainLabel: string; subLabel: string }> = {
  "play-pause": { mainLabel: "PLAY", subLabel: "REPLAY" },
  stop: { mainLabel: "STOP", subLabel: "REPLAY" },
  "fast-forward": { mainLabel: "FWD", subLabel: "REPLAY" },
  rewind: { mainLabel: "REWIND", subLabel: "REPLAY" },
  "slow-motion": { mainLabel: "SLOW MO", subLabel: "REPLAY" },
  "frame-forward": { mainLabel: "FRAME FWD", subLabel: "REPLAY" },
  "frame-backward": { mainLabel: "FRAME BACK", subLabel: "REPLAY" },
  "speed-increase": { mainLabel: "SPEED UP", subLabel: "REPLAY" },
  "speed-decrease": { mainLabel: "SLOW DOWN", subLabel: "REPLAY" },
  "next-session": { mainLabel: "NEXT", subLabel: "SESSION" },
  "prev-session": { mainLabel: "PREVIOUS", subLabel: "SESSION" },
  "next-lap": { mainLabel: "NEXT", subLabel: "LAP" },
  "prev-lap": { mainLabel: "PREVIOUS", subLabel: "LAP" },
  "next-incident": { mainLabel: "NEXT", subLabel: "INCIDENT" },
  "prev-incident": { mainLabel: "PREVIOUS", subLabel: "INCIDENT" },
  "jump-to-beginning": { mainLabel: "BEGINNING", subLabel: "REPLAY" },
  "jump-to-live": { mainLabel: "LIVE", subLabel: "REPLAY" },
};

/**
 * Directional pairs for encoder rotation support.
 * Modes in this map support clockwise=next / counter-clockwise=prev.
 */
const DIRECTIONAL_PAIRS: Partial<Record<ReplayControlMode, { next: ReplayControlMode; prev: ReplayControlMode }>> = {
  "next-session": { next: "next-session", prev: "prev-session" },
  "prev-session": { next: "next-session", prev: "prev-session" },
  "next-lap": { next: "next-lap", prev: "prev-lap" },
  "prev-lap": { next: "next-lap", prev: "prev-lap" },
  "next-incident": { next: "next-incident", prev: "prev-incident" },
  "prev-incident": { next: "next-incident", prev: "prev-incident" },
};

const ReplayControlSettings = CommonSettings.extend({
  mode: z.enum(REPLAY_CONTROL_MODES).default("play-pause"),
});

type ReplayControlSettings = z.infer<typeof ReplayControlSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the replay control action.
 */
export function generateReplayControlSvg(settings: { mode: ReplayControlMode }): string {
  const { mode } = settings;

  const iconSvg = REPLAY_CONTROL_ICONS[mode] || REPLAY_CONTROL_ICONS["play-pause"];
  const labels = REPLAY_CONTROL_LABELS[mode] || REPLAY_CONTROL_LABELS["play-pause"];

  const svg = renderIconTemplate(iconSvg, {
    mainLabel: labels.mainLabel,
    subLabel: labels.subLabel,
  });

  return svgToDataUri(svg);
}

/**
 * Replay Control
 * Unified replay action combining transport, speed, and navigation controls.
 * Provides 17 modes covering play/pause toggle, speed adjustment, and replay
 * navigation via iRacing SDK commands.
 */
@action({ UUID: "com.iracedeck.sd.core.replay-control" })
export class ReplayControl extends ConnectionStateAwareAction<ReplayControlSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("ReplayControl"), LogLevel.Info);

  /** Cached telemetry for play/pause toggle */
  private isReplayPlaying = new Map<string, boolean>();

  override async onWillAppear(ev: WillAppearEvent<ReplayControlSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry: TelemetryData | null) => {
      this.updateConnectionState();
      this.updateTelemetryState(ev.action.id, telemetry);
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<ReplayControlSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.isReplayPlaying.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ReplayControlSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<ReplayControlSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeMode(ev.action.id, settings.mode);
  }

  override async onDialDown(ev: DialDownEvent<ReplayControlSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeDialDown(settings.mode);
  }

  override async onDialRotate(ev: DialRotateEvent<ReplayControlSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);
    this.executeDialRotate(settings.mode, ev.payload.ticks);
  }

  private parseSettings(settings: unknown): ReplayControlSettings {
    const parsed = ReplayControlSettings.safeParse(settings);

    return parsed.success ? parsed.data : ReplayControlSettings.parse({});
  }

  private updateTelemetryState(contextId: string, telemetry: TelemetryData | null): void {
    if (telemetry && telemetry.IsReplayPlaying !== undefined) {
      this.isReplayPlaying.set(contextId, telemetry.IsReplayPlaying as boolean);
    }
  }

  private executeMode(contextId: string, mode: ReplayControlMode): void {
    const replay = getCommands().replay;

    switch (mode) {
      case "play-pause": {
        const isPlaying = this.isReplayPlaying.get(contextId) ?? false;
        const success = isPlaying ? replay.pause() : replay.play();
        this.logger.info(isPlaying ? "Pause executed" : "Play executed");
        this.logger.debug(`Result: ${success}, wasPlaying: ${isPlaying}`);
        break;
      }
      case "stop": {
        const success = replay.pause();
        this.logger.info("Stop executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "fast-forward": {
        const success = replay.fastForward();
        this.logger.info("Fast forward executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "rewind": {
        const success = replay.rewind();
        this.logger.info("Rewind executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "slow-motion": {
        const success = replay.slowMotion();
        this.logger.info("Slow motion executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "frame-forward": {
        const success = replay.nextFrame();
        this.logger.info("Frame forward executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "frame-backward": {
        const success = replay.prevFrame();
        this.logger.info("Frame backward executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "speed-increase": {
        const success = replay.fastForward();
        this.logger.info("Speed increase executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "speed-decrease": {
        const success = replay.rewind();
        this.logger.info("Speed decrease executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "next-session": {
        const success = replay.nextSession();
        this.logger.info("Next session executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "prev-session": {
        const success = replay.prevSession();
        this.logger.info("Previous session executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "next-lap": {
        const success = replay.nextLap();
        this.logger.info("Next lap executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "prev-lap": {
        const success = replay.prevLap();
        this.logger.info("Previous lap executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "next-incident": {
        const success = replay.nextIncident();
        this.logger.info("Next incident executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "prev-incident": {
        const success = replay.prevIncident();
        this.logger.info("Previous incident executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "jump-to-beginning": {
        const success = replay.goToStart();
        this.logger.info("Jump to beginning executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
      case "jump-to-live": {
        const success = replay.goToEnd();
        this.logger.info("Jump to live executed");
        this.logger.debug(`Result: ${success}`);
        break;
      }
    }
  }

  private executeDialDown(mode: ReplayControlMode): void {
    const replay = getCommands().replay;

    if (mode === "speed-increase" || mode === "speed-decrease") {
      // Speed modes: encoder push resets to normal speed
      const success = replay.play();
      this.logger.info("Speed reset to normal");
      this.logger.debug(`Result: ${success}`);
    } else if (DIRECTIONAL_PAIRS[mode]) {
      // Navigation directional pairs: encoder push executes the selected action
      this.executeMode("__dial__", mode);
    } else if (mode === "jump-to-beginning" || mode === "jump-to-live") {
      // Navigation non-directional: encoder push executes the action
      this.executeMode("__dial__", mode);
    } else {
      // Transport modes: encoder push plays
      const success = replay.play();
      this.logger.info("Play executed (dial)");
      this.logger.debug(`Result: ${success}`);
    }
  }

  private executeDialRotate(mode: ReplayControlMode, ticks: number): void {
    const replay = getCommands().replay;

    if (mode === "speed-increase" || mode === "speed-decrease") {
      // Speed modes: rotate adjusts speed
      if (ticks > 0) {
        replay.fastForward();
        this.logger.info("Speed increase (dial)");
      } else {
        replay.rewind();
        this.logger.info("Speed decrease (dial)");
      }
    } else if (DIRECTIONAL_PAIRS[mode]) {
      // Navigation directional pairs: rotate cycles next/prev
      const pair = DIRECTIONAL_PAIRS[mode]!;
      const nav = ticks > 0 ? pair.next : pair.prev;
      this.executeMode("__dial__", nav);
    } else if (mode === "jump-to-beginning" || mode === "jump-to-live") {
      // Navigation non-directional: rotate does next/prev incident
      if (ticks > 0) {
        replay.nextIncident();
        this.logger.info("Next incident (dial)");
      } else {
        replay.prevIncident();
        this.logger.info("Previous incident (dial)");
      }
    } else {
      // Transport modes: rotate does frame step
      if (ticks > 0) {
        replay.nextFrame();
        this.logger.info("Frame forward (dial)");
      } else {
        replay.prevFrame();
        this.logger.info("Frame backward (dial)");
      }
    }
  }

  private async updateDisplay(
    ev: WillAppearEvent<ReplayControlSettings> | DidReceiveSettingsEvent<ReplayControlSettings>,
    settings: ReplayControlSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateReplayControlSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
  }
}
```

- [ ] **Step 2:** Run the tests to verify they pass.

```bash
cd packages/stream-deck-plugin && pnpm test -- src/actions/replay-control.test.ts
```

Expected: All tests PASS.

- [ ] **Step 3:** Commit.

```bash
git add packages/stream-deck-plugin/src/actions/replay-control.ts
git commit -m "feat(stream-deck-plugin): implement Replay Control action

Unified replay action with 17 modes: transport (play/pause toggle, stop,
fast-forward, rewind, slow-motion, frame step), speed (increase/decrease),
and navigation (session, lap, incident, jump to beginning/live).

Play/pause mode uses IsReplayPlaying telemetry for intelligent toggling.
Full encoder support with contextual rotation and push behavior.

Closes #110"
```

---

## Task 4: Create the Property Inspector template

**Files:**
- Create: `packages/stream-deck-plugin/src/pi/replay-control.ejs`

- [ ] **Step 1:** Create the PI template `packages/stream-deck-plugin/src/pi/replay-control.ejs`:

```ejs
<!doctype html>
<html lang="en">
	<head>
		<%- include('head-common') %>
	</head>
	<body>
		<sdpi-item label="Control">
			<sdpi-select setting="mode" default="play-pause">
				<optgroup label="Transport">
					<option value="play-pause">Play / Pause</option>
					<option value="stop">Stop</option>
					<option value="fast-forward">Fast Forward</option>
					<option value="rewind">Rewind</option>
					<option value="slow-motion">Slow Motion</option>
					<option value="frame-forward">Frame Forward</option>
					<option value="frame-backward">Frame Backward</option>
				</optgroup>
				<optgroup label="Speed">
					<option value="speed-increase">Increase Speed</option>
					<option value="speed-decrease">Decrease Speed</option>
				</optgroup>
				<optgroup label="Navigation">
					<option value="next-session">Next Session</option>
					<option value="prev-session">Previous Session</option>
					<option value="next-lap">Next Lap</option>
					<option value="prev-lap">Previous Lap</option>
					<option value="next-incident">Next Incident</option>
					<option value="prev-incident">Previous Incident</option>
					<option value="jump-to-beginning">Jump to Beginning</option>
					<option value="jump-to-live">Jump to Live</option>
				</optgroup>
			</sdpi-select>
		</sdpi-item>

		<%- include('common-settings') %>
	</body>
</html>
```

- [ ] **Step 2:** Commit.

```bash
git add packages/stream-deck-plugin/src/pi/replay-control.ejs
git commit -m "feat(stream-deck-plugin): add Replay Control Property Inspector

EJS template with optgroup-organized dropdown for all 17 replay modes."
```

---

## Task 5: Register the action and update manifest

**Files:**
- Modify: `packages/stream-deck-plugin/src/plugin.ts`
- Modify: `packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/manifest.json`

- [ ] **Step 1:** Add the import and registration in `plugin.ts`.

Add this import line (alphabetically between `ReplayNavigation` and `ReplaySpeed`):
```typescript
import { ReplayControl } from "./actions/replay-control.js";
```

Add this registration line (alphabetically between `ReplayNavigation` and `ReplaySpeed`):
```typescript
streamDeck.actions.registerAction(new ReplayControl());
```

- [ ] **Step 2:** In `manifest.json`, add `"VisibleInActionsList": false` to the three existing replay action entries.

For each of the three existing replay actions (`replay-transport` at ~line 341, `replay-speed` at ~line 366, `replay-navigation` at ~line 512), add `"VisibleInActionsList": false` right after the `"Name"` field. Example for replay-transport:

```json
{
  "Name": "Replay Transport",
  "VisibleInActionsList": false,
  "UUID": "com.iracedeck.sd.core.replay-transport",
  ...
}
```

- [ ] **Step 3:** In `manifest.json`, add the new `replay-control` action entry. Place it near the other replay actions (after replay-speed, before camera-cycle):

```json
{
  "Name": "Replay Control",
  "UUID": "com.iracedeck.sd.core.replay-control",
  "Icon": "imgs/actions/replay-control/icon",
  "Tooltip": "Unified replay controls: transport, speed, and navigation",
  "PropertyInspectorPath": "ui/replay-control.html",
  "Controllers": [
    "Keypad",
    "Encoder"
  ],
  "Encoder": {
    "layout": "$B1",
    "TriggerDescription": {
      "Rotate": "Contextual: frame step, speed, or navigation",
      "Push": "Contextual: play or execute action"
    }
  },
  "States": [
    {
      "Image": "imgs/actions/replay-control/key",
      "TitleAlignment": "bottom",
      "FontSize": 14
    }
  ]
}
```

- [ ] **Step 4:** Run lint, format, tests, and build.

```bash
cd packages/stream-deck-plugin
pnpm lint:fix
pnpm format:fix
pnpm test
pnpm build
```

All must pass. Check build output for `TS[0-9]+:` patterns — these indicate TypeScript errors that must be fixed.

- [ ] **Step 5:** Commit.

```bash
git add packages/stream-deck-plugin/src/plugin.ts packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/manifest.json
git commit -m "feat(stream-deck-plugin): register Replay Control and hide legacy actions

BREAKING CHANGE: The three legacy replay actions (Replay Transport,
Replay Speed, Replay Navigation) are hidden from the Stream Deck action
picker. Existing configurations continue to work. The new unified Replay
Control action replaces them with 17 modes."
```

---

## Task 6: Update actions reference

**Files:**
- Modify: `docs/reference/actions.json`

- [ ] **Step 1:** In `docs/reference/actions.json`, find the "View & Camera" category and update:

1. Add `"hidden": true` to the `replay-transport`, `replay-speed`, and `replay-navigation` entries.
2. Add a new `replay-control` entry:

```json
{
  "id": "com.iracedeck.sd.core.replay-control",
  "name": "Replay Control",
  "file": "replay-control.ts",
  "encoder": true,
  "settings": ["mode"],
  "modes": {
    "mode": [
      { "value": "play-pause", "label": "Play / Pause" },
      { "value": "stop", "label": "Stop" },
      { "value": "fast-forward", "label": "Fast Forward" },
      { "value": "rewind", "label": "Rewind" },
      { "value": "slow-motion", "label": "Slow Motion" },
      { "value": "frame-forward", "label": "Frame Forward" },
      { "value": "frame-backward", "label": "Frame Backward" },
      { "value": "speed-increase", "label": "Increase Speed" },
      { "value": "speed-decrease", "label": "Decrease Speed" },
      { "value": "next-session", "label": "Next Session" },
      { "value": "prev-session", "label": "Previous Session" },
      { "value": "next-lap", "label": "Next Lap" },
      { "value": "prev-lap", "label": "Previous Lap" },
      { "value": "next-incident", "label": "Next Incident" },
      { "value": "prev-incident", "label": "Previous Incident" },
      { "value": "jump-to-beginning", "label": "Jump to Beginning" },
      { "value": "jump-to-live", "label": "Jump to Live" }
    ]
  }
}
```

- [ ] **Step 2:** Commit.

```bash
git add docs/reference/actions.json
git commit -m "docs: update actions reference for Replay Control

Add new Replay Control action with 17 modes. Mark legacy replay actions
as hidden."
```

---

## Task 7: Final verification

- [ ] **Step 1:** Run full verification from the repo root.

```bash
pnpm lint:fix
pnpm format:fix
pnpm test
pnpm build
```

All must pass with no TypeScript warnings (ignore `Circular dependency` from zod and `npm warn Unknown env config`).

- [ ] **Step 2:** Verify all expected files exist.

```bash
# 17 mode icons
ls packages/icons/replay-control/ | wc -l

# Category + key icons
ls packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/imgs/actions/replay-control/

# Action source + tests
ls packages/stream-deck-plugin/src/actions/replay-control.ts
ls packages/stream-deck-plugin/src/actions/replay-control.test.ts

# PI template
ls packages/stream-deck-plugin/src/pi/replay-control.ejs
```
