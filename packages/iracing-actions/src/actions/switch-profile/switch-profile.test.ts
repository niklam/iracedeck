import { describe, expect, it, vi } from "vitest";

import {
  availableProfilesForDevice,
  generateSwitchProfileSvg,
  profileTitle,
  SWITCH_PROFILE_UUID,
} from "./switch-profile.js";

vi.mock("@iracedeck/icons/switch-profile/replay.svg", () => ({ default: "<svg>REPLAY</svg>" }));
vi.mock("@iracedeck/icons/switch-profile/chat.svg", () => ({ default: "<svg>CHAT</svg>" }));
vi.mock("@iracedeck/icons/switch-profile/default.svg", () => ({ default: "<svg>DEFAULT</svg>" }));

vi.mock("../data/profiles.json", () => ({
  default: [
    { name: "iRaceDeck Default", deviceType: 2 },
    { name: "iRaceDeck Replay", deviceType: 2 },
    { name: "iRaceDeck Mini", deviceType: 1 },
  ],
}));

vi.mock("@iracedeck/deck-core", () => ({
  CommonSettings: {
    extend: () => ({
      parse: (d: Record<string, unknown>) => ({ ...d }),
      safeParse: (d: Record<string, unknown>) => ({ success: true, data: { ...d } }),
    }),
    parse: (d: Record<string, unknown>) => ({ ...d }),
    safeParse: (d: Record<string, unknown>) => ({ success: true, data: { ...d } }),
  },
  ConnectionStateAwareAction: class {
    logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    setKeyImage = vi.fn();
    setRegenerateCallback = vi.fn();
  },
  assembleIcon: vi.fn(({ graphicSvg }: { graphicSvg: string }) => `assembled:${graphicSvg}`),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getGlobalTitleSettings: vi.fn(() => ({})),
  requestProfileSwitch: vi.fn(),
  resolveBorderSettings: vi.fn(() => ({})),
  resolveGraphicSettings: vi.fn(() => ({})),
  resolveIconColors: vi.fn(() => ({})),
  resolveTitleSettings: vi.fn((_svg: string, _g: unknown, _o: unknown, def: string) => def),
}));

/** Build a settings object; the mocked schema keeps it loose. */
function settings(profile: string): Parameters<typeof generateSwitchProfileSvg>[0] {
  return { profile } as Parameters<typeof generateSwitchProfileSvg>[0];
}

describe("SwitchProfile", () => {
  it("exposes the expected action UUID", () => {
    expect(SWITCH_PROFILE_UUID).toBe("com.iracedeck.sd.core.switch-profile");
  });

  describe("profileTitle", () => {
    it("drops the iRaceDeck prefix and upper-cases the rest", () => {
      expect(profileTitle("iRaceDeck Replay")).toBe("REPLAY");
      expect(profileTitle("iRaceDeck Default")).toBe("DEFAULT");
    });

    it("returns a generic two-line label when nothing is selected", () => {
      expect(profileTitle("")).toBe("SWITCH\nPROFILE");
    });
  });

  describe("availableProfilesForDevice", () => {
    it("filters the generated profiles by device type", () => {
      expect(availableProfilesForDevice(2)).toEqual(["iRaceDeck Default", "iRaceDeck Replay"]);
      expect(availableProfilesForDevice(1)).toEqual(["iRaceDeck Mini"]);
      expect(availableProfilesForDevice(99)).toEqual([]);
    });

    it("returns empty when the device type is unknown", () => {
      expect(availableProfilesForDevice(undefined)).toEqual([]);
    });
  });

  describe("generateSwitchProfileSvg", () => {
    it("uses the clapper icon for the Replay profile", () => {
      expect(generateSwitchProfileSvg(settings("iRaceDeck Replay"))).toBe("assembled:<svg>REPLAY</svg>");
    });

    it("uses the chat icon for a Chat profile", () => {
      expect(generateSwitchProfileSvg(settings("iRaceDeck Chat"))).toBe("assembled:<svg>CHAT</svg>");
    });

    it("falls back to the iRaceDeck icon for Default, unknown, or no selection", () => {
      expect(generateSwitchProfileSvg(settings("iRaceDeck Default"))).toBe("assembled:<svg>DEFAULT</svg>");
      expect(generateSwitchProfileSvg(settings("Something Else"))).toBe("assembled:<svg>DEFAULT</svg>");
      expect(generateSwitchProfileSvg(settings(""))).toBe("assembled:<svg>DEFAULT</svg>");
    });
  });
});
