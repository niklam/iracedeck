import { requestProfileSwitch } from "@iracedeck/deck-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  availableProfilesForDevice,
  generateSwitchProfileSvg,
  profileTitle,
  SWITCH_PROFILE_UUID,
  SwitchProfile,
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
    async onWillAppear(): Promise<void> {}
    async onDidReceiveSettings(): Promise<void> {}
  },
  assembleIcon: vi.fn(({ graphicSvg }: { graphicSvg: string }) => `assembled:${graphicSvg}`),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalGraphicSettings: vi.fn(() => ({})),
  getGlobalTitleSettings: vi.fn(() => ({})),
  PROFILE_NAMES: {
    default: "iRaceDeck Default",
    pitActions: "iRaceDeck Pit Actions",
    replay: "iRaceDeck Replay",
  },
  requestProfileSwitch: vi.fn(),
  requestProfileSwitchBack: vi.fn(),
  resolveBorderSettings: vi.fn(() => ({})),
  resolveGraphicSettings: vi.fn(() => ({})),
  resolveIconColors: vi.fn(() => ({})),
  resolveTitleSettings: vi.fn((_svg: string, _g: unknown, _o: unknown, def: string) => def),
}));

/** Build a settings object; the mocked schema keeps it loose. */
function settings(profile: string): Parameters<typeof generateSwitchProfileSvg>[0] {
  return { profile } as Parameters<typeof generateSwitchProfileSvg>[0];
}

/** A minimal mock action context (key). */
function keyAction(overrides: Record<string, unknown> = {}) {
  return {
    id: "ctx",
    deviceId: "dev-1",
    deviceType: 2,
    setTitle: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("SwitchProfile", () => {
  it("exposes the expected action UUID", () => {
    expect(SWITCH_PROFILE_UUID).toBe("com.iracedeck.sd.core.switch-profile");
  });

  describe("profileTitle", () => {
    it("drops the iRaceDeck prefix and upper-cases the rest", () => {
      expect(profileTitle("iRaceDeck Replay")).toBe("REPLAY");
    });

    it("wraps the long Race Admin profile titles onto two lines", () => {
      expect(profileTitle("iRaceDeck Race Admin Cars")).toBe("RACE ADMIN\nCARS");
      expect(profileTitle("iRaceDeck Race Admin Per Car")).toBe("RACE ADMIN\nPER CAR");
    });

    it("shows no title for the default profile — the logo speaks for itself (#755)", () => {
      expect(profileTitle("iRaceDeck Default")).toBe("");
    });

    it("shows no title for an empty selection (which behaves as the default profile)", () => {
      expect(profileTitle("")).toBe("");
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

  describe("class behaviour", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("pushes the device-filtered profile list on appear, then guards against re-push", async () => {
      const action = new SwitchProfile();
      const a = keyAction();

      await action.onWillAppear({ action: a, payload: { settings: {} } } as never);

      expect(a.setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ _deviceProfiles: ["iRaceDeck Default", "iRaceDeck Replay"] }),
      );

      // Already up to date → no redundant setSettings (avoids the ping-pong loop).
      a.setSettings.mockClear();
      await action.onDidReceiveSettings({
        action: a,
        payload: { settings: { _deviceProfiles: ["iRaceDeck Default", "iRaceDeck Replay"] } },
      } as never);

      expect(a.setSettings).not.toHaveBeenCalled();
    });

    it("switches to the selected profile on key down, targeting the button's device", async () => {
      const action = new SwitchProfile();

      await action.onKeyDown({
        action: keyAction({ deviceId: "dev-9" }),
        payload: { settings: { profile: "iRaceDeck Replay" } },
      } as never);

      expect(requestProfileSwitch).toHaveBeenCalledWith("dev-9", "iRaceDeck Replay");
    });

    it("switches to the default profile when no profile is selected (#755)", async () => {
      const action = new SwitchProfile();

      await action.onKeyDown({ action: keyAction(), payload: { settings: { profile: "" } } } as never);

      expect(requestProfileSwitch).toHaveBeenCalledWith("dev-1", "iRaceDeck Default");
    });
  });
});
