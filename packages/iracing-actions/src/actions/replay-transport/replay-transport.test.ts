import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cursorTestEvent,
  type ReplayCursorProbe,
  stageReplayCursorProbe,
} from "../../shared/replay-cursor.test-support.js";
import { generateReplayTransportSvg, ReplayTransport, ReplayTransportSettings } from "./replay-transport.js";

vi.mock("@iracedeck/icons/replay-transport/play.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-transport/pause.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-transport/stop.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-transport/fast-forward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-transport/rewind.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-transport/slow-motion.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-transport/frame-forward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/replay-transport/frame-backward.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">{{mainLabel}} {{subLabel}}</svg>',
}));

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getCommands: vi.fn(() => ({
    replay: {
      play: vi.fn(() => true),
      pause: vi.fn(() => true),
      fastForward: vi.fn(() => true),
      rewind: vi.fn(() => true),
      slowMotion: vi.fn(() => true),
      nextFrame: vi.fn(() => true),
      prevFrame: vi.fn(() => true),
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

describe("ReplayTransport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateReplayTransportSvg", () => {
    const ALL_TRANSPORTS = [
      "play",
      "pause",
      "stop",
      "fast-forward",
      "rewind",
      "slow-motion",
      "frame-forward",
      "frame-backward",
    ] as const;

    it.each(ALL_TRANSPORTS)("should generate a valid data URI for %s", (transport) => {
      const result = generateReplayTransportSvg(ReplayTransportSettings.parse({ transport }));

      expect(result).toContain("data:image/svg+xml");
    });

    it("should produce different icons for different transport actions", () => {
      const results = ALL_TRANSPORTS.map((transport) =>
        generateReplayTransportSvg(ReplayTransportSettings.parse({ transport })),
      );

      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBe(ALL_TRANSPORTS.length);
    });

    it("should include PLAY label for play transport", () => {
      const result = generateReplayTransportSvg(ReplayTransportSettings.parse({ transport: "play" }));

      expect(decodeURIComponent(result)).toContain("PLAY");
    });

    it("should include PAUSE label for pause transport", () => {
      const result = generateReplayTransportSvg(ReplayTransportSettings.parse({ transport: "pause" }));

      expect(decodeURIComponent(result)).toContain("PAUSE");
    });

    it("should include STOP label for stop transport", () => {
      const result = generateReplayTransportSvg(ReplayTransportSettings.parse({ transport: "stop" }));

      expect(decodeURIComponent(result)).toContain("STOP");
    });

    it("should include FORWARD and FAST labels for fast-forward transport", () => {
      const decoded = decodeURIComponent(
        generateReplayTransportSvg(ReplayTransportSettings.parse({ transport: "fast-forward" })),
      );

      expect(decoded).toContain("FORWARD");
      expect(decoded).toContain("FAST");
    });

    it("should include REWIND label for rewind transport", () => {
      const result = generateReplayTransportSvg(ReplayTransportSettings.parse({ transport: "rewind" }));

      expect(decodeURIComponent(result)).toContain("REWIND");
    });

    it("should include MOTION and SLOW labels for slow-motion transport", () => {
      const decoded = decodeURIComponent(
        generateReplayTransportSvg(ReplayTransportSettings.parse({ transport: "slow-motion" })),
      );

      expect(decoded).toContain("MOTION");
      expect(decoded).toContain("SLOW");
    });

    it("should include FRAME FWD label for frame-forward", () => {
      const decoded = decodeURIComponent(
        generateReplayTransportSvg(ReplayTransportSettings.parse({ transport: "frame-forward" })),
      );

      expect(decoded).toContain("FRAME FWD");
    });

    it("should include FRAME BACK label for frame-backward", () => {
      const decoded = decodeURIComponent(
        generateReplayTransportSvg(ReplayTransportSettings.parse({ transport: "frame-backward" })),
      );

      expect(decoded).toContain("FRAME BACK");
    });
  });

  describe("every command takes the replay cursor first (#1334)", () => {
    const COMMANDS = ["play", "pause", "fastForward", "rewind", "slowMotion", "nextFrame", "prevFrame"] as const;
    let probe: ReplayCursorProbe<(typeof COMMANDS)[number]>;
    let action: ReplayTransport;

    beforeEach(async () => {
      probe = stageReplayCursorProbe(COMMANDS);
      const { getCommands } = await import("@iracedeck/deck-iracing");
      vi.mocked(getCommands).mockReturnValue({ replay: probe.replay } as any);
      action = new ReplayTransport();
    });

    it.each([
      ["play", "play"],
      ["pause", "pause"],
      ["stop", "pause"],
      ["fast-forward", "fastForward"],
      ["rewind", "rewind"],
      ["slow-motion", "slowMotion"],
      ["frame-forward", "nextFrame"],
      ["frame-backward", "prevFrame"],
    ] as const)("%s stops the walk and clears the landing before sending %s", async (mode, sentCommand) => {
      await action.onKeyDown(cursorTestEvent({ transport: mode }) as any);

      probe.expectTakenBefore(`replay-transport-${mode}`, sentCommand);
    });

    it("a dial press plays, taking the cursor first", async () => {
      await action.onDialDown(cursorTestEvent({}) as any);

      probe.expectTakenBefore("replay-transport-play", "play");
    });

    it("a dial turn takes the cursor as the frame step it resolved to", async () => {
      await action.onDialRotate(cursorTestEvent({}, -1) as any);

      probe.expectTakenBefore("replay-transport-frame-backward", "prevFrame");
    });

    it("a zero-tick dial turn carries no direction: nothing is sent and the walk stands", async () => {
      await action.onDialRotate(cursorTestEvent({}, 0) as any);

      probe.expectUntouched();
    });
  });
});
