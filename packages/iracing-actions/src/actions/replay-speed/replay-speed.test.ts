import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetReplayCursor,
  claimReplayCursor,
  currentReplayCursorOwner,
  pendingReplayLanding,
  recordReplayLanding,
} from "../../shared/replay-cursor.js";
import { generateReplaySpeedSvg, ReplaySpeed, ReplaySpeedSettings } from "./replay-speed.js";

vi.mock("@iracedeck/icons/replay-speed/increase.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-speed/decrease.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getCommands: vi.fn(() => ({
    replay: {
      play: vi.fn(() => true),
      fastForward: vi.fn(() => true),
      rewind: vi.fn(() => true),
    },
  })),
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: (_fields: unknown) => {
      // Return a mock Zod-like schema
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
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
  },
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  LogLevel: { Info: 2 },
  getGlobalTitleSettings: vi.fn(() => ({})),
  resolveIconColors: vi.fn((_svg, _global, _overrides) => ({})),
  resolveBorderSettings: vi.fn((_svg: unknown, _global: unknown, _overrides?: unknown, _stateColor?: string) => ({
    enabled: false,
    borderWidth: 7,
    borderColor: "#00aaff",
    glowEnabled: true,
    glowWidth: 18,
  })),
  resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
  resolveTitleSettings: vi.fn((_svg: unknown, _global: unknown, _overrides: unknown, defaultTitle?: string) => ({
    showTitle: true,
    showGraphics: true,
    titleText: defaultTitle ?? "",
    bold: true,
    fontSize: 18,
    position: "bottom" as const,
    customPosition: 0,
  })),
  assembleIcon: vi.fn(
    ({ graphicSvg, title }: { graphicSvg: string; colors: unknown; title: { titleText: string } }) => {
      const encoded = encodeURIComponent(`<svg>${graphicSvg}${title?.titleText ?? ""}</svg>`);

      return `data:image/svg+xml,${encoded}`;
    },
  ),
}));

vi.mock("@iracedeck/settings", () => ({
  getGlobalColors: vi.fn(() => ({})),
}));

describe("ReplaySpeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateReplaySpeedSvg", () => {
    const ALL_DIRECTIONS = ["increase", "decrease"] as const;

    it.each(ALL_DIRECTIONS)("should generate a valid data URI for %s", (direction) => {
      const result = generateReplaySpeedSvg(ReplaySpeedSettings.parse({ direction }));

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for increase vs decrease", () => {
      const results = ALL_DIRECTIONS.map((direction) =>
        generateReplaySpeedSvg(ReplaySpeedSettings.parse({ direction })),
      );

      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(ALL_DIRECTIONS.length);
    });

    it("should include FASTER label for increase direction", () => {
      const result = generateReplaySpeedSvg(ReplaySpeedSettings.parse({ direction: "increase" }));

      expect(decodeURIComponent(result)).toContain("FASTER");
    });

    it("should include SLOWER label for decrease direction", () => {
      const result = generateReplaySpeedSvg(ReplaySpeedSettings.parse({ direction: "decrease" }));

      expect(decodeURIComponent(result)).toContain("SLOWER");
    });

    it("should include REPLAY secondary label for both directions", () => {
      for (const direction of ALL_DIRECTIONS) {
        const result = generateReplaySpeedSvg(ReplaySpeedSettings.parse({ direction }));
        expect(decodeURIComponent(result)).toContain("REPLAY");
      }
    });
  });

  describe("every command takes the replay cursor first (#1334)", () => {
    const sent: string[] = [];
    const command = (name: string) =>
      vi.fn(() => {
        sent.push(name);

        return true;
      });
    const mockReplay = {
      play: command("play"),
      fastForward: command("fastForward"),
      rewind: command("rewind"),
    };
    let action: ReplaySpeed;
    let cancelledBy: string | null;
    let sentAtCancel: number | null;

    function fakeEvent(settings: Record<string, unknown>, ticks = 0) {
      return { action: { id: "ctx-cursor", setTitle: vi.fn(), setImage: vi.fn() }, payload: { settings, ticks } };
    }

    beforeEach(async () => {
      _resetReplayCursor();
      sent.length = 0;
      cancelledBy = null;
      sentAtCancel = null;
      const { getCommands } = await import("@iracedeck/deck-iracing");
      vi.mocked(getCommands).mockReturnValue({ replay: mockReplay } as any);
      action = new ReplaySpeed();
      // A Jump to Fastest Lap walk in flight, and a marker landing still pending.
      claimReplayCursor("jump-to-fastest-lap", (by) => {
        cancelledBy = by;
        sentAtCancel = sent.length;
      });
      recordReplayLanding(4_000, 10_000);
    });

    function expectCursorTakenBefore(owner: string, sentCommand: string): void {
      expect(cancelledBy).toBe(owner);
      expect(sentAtCancel).toBe(0);
      expect(sent).toEqual([sentCommand]);
      expect(currentReplayCursorOwner()).toBeNull();
      expect(pendingReplayLanding()).toBeNull();
    }

    it.each([
      ["increase", "fastForward"],
      ["decrease", "rewind"],
    ])("%s stops the walk and clears the landing before sending %s", async (mode, sentCommand) => {
      await action.onKeyDown(fakeEvent({ direction: mode }) as any);

      expectCursorTakenBefore(`replay-speed-${mode}`, sentCommand);
    });

    it("a dial press resets the speed, taking the cursor first", async () => {
      await action.onDialDown(fakeEvent({}) as any);

      expectCursorTakenBefore("replay-speed-reset", "play");
    });

    it("a dial turn takes the cursor as the direction it resolved to", async () => {
      await action.onDialRotate(fakeEvent({}, 1) as any);

      expectCursorTakenBefore("replay-speed-increase", "fastForward");
    });
  });
});
