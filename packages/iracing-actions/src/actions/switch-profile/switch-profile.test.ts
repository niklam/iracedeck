import { notifyProfileVisible, requestProfileSwitch, requestProfileSwitchBack } from "@iracedeck/deck-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  availableProfilesForDevice,
  defaultProfileForDevice,
  deviceProfileEntries,
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
    { name: "iRaceDeck Default XL", deviceType: 2, displayName: "iRaceDeck Default" },
    { name: "iRaceDeck Replay XL", deviceType: 2, displayName: "iRaceDeck Replay" },
    { name: "iRaceDeck Pit Actions Mini", deviceType: 1, displayName: "iRaceDeck Pit Actions" },
  ],
}));

vi.mock("@iracedeck/deck-core", () => {
  // Minimal reimplementation of the #753 profile-name helpers (the real ones
  // are covered by deck-core's own device-profiles tests).
  const SUFFIXES_LONGEST_FIRST = ["Corsair Galleon", "Plus XL", "Mini", "Plus", "Neo", "XL", "SD"];
  const SUFFIX_BY_TYPE: Record<number, string> = {
    0: "SD",
    1: "Mini",
    2: "XL",
    7: "Plus",
    9: "Neo",
    12: "Corsair Galleon",
    13: "Plus XL",
  };

  const profileDisplayName = (name: string): string => {
    for (const suffix of SUFFIXES_LONGEST_FIRST) {
      if (name.endsWith(` ${suffix}`)) return name.slice(0, -(suffix.length + 1));
    }

    return name;
  };

  const deviceProfileName = (name: string, deviceType: number | undefined): string => {
    if (profileDisplayName(name) !== name) return name;

    const suffix = deviceType === undefined ? undefined : SUFFIX_BY_TYPE[deviceType];

    return suffix ? `${name} ${suffix}` : name;
  };

  const resolveProfileNameForDevice = (
    name: string,
    deviceType: number | undefined,
    availableNames: readonly string[],
  ): string | undefined => {
    if (availableNames.includes(name)) return name;

    const suffixed = deviceProfileName(profileDisplayName(name), deviceType);

    return availableNames.includes(suffixed) ? suffixed : undefined;
  };

  return {
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
    PROFILE_NAMES: {
      default: "iRaceDeck Default",
      pitActions: "iRaceDeck Pit Actions",
      replay: "iRaceDeck Replay",
    },
    assembleIcon: vi.fn(({ graphicSvg }: { graphicSvg: string }) => `assembled:${graphicSvg}`),
    deviceProfileName,
    getGlobalBorderSettings: vi.fn(() => ({})),
    getGlobalColors: vi.fn(() => ({})),
    getGlobalGraphicSettings: vi.fn(() => ({})),
    getGlobalTitleSettings: vi.fn(() => ({})),
    notifyProfileVisible: vi.fn(),
    profileDisplayName,
    requestProfileSwitch: vi.fn(),
    requestProfileSwitchBack: vi.fn(),
    resolveBorderSettings: vi.fn(() => ({})),
    resolveGraphicSettings: vi.fn(() => ({})),
    resolveIconColors: vi.fn(() => ({})),
    resolveProfileNameForDevice,
    resolveTitleSettings: vi.fn((_svg: string, _g: unknown, _o: unknown, def: string) => def),
  };
});

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

    it("never renders the device suffix (#753)", () => {
      expect(profileTitle("iRaceDeck Replay XL")).toBe("REPLAY");
      expect(profileTitle("iRaceDeck Replay Plus XL")).toBe("REPLAY");
    });

    it("wraps the long Race Admin profile titles onto two lines, suffixed or not", () => {
      expect(profileTitle("iRaceDeck Race Admin Cars")).toBe("RACE ADMIN\nCARS");
      expect(profileTitle("iRaceDeck Race Admin Per Car")).toBe("RACE ADMIN\nPER CAR");
      expect(profileTitle("iRaceDeck Race Admin Cars XL")).toBe("RACE ADMIN\nCARS");
      expect(profileTitle("iRaceDeck Race Admin Per Car Plus XL")).toBe("RACE ADMIN\nPER CAR");
    });

    it("shows no title for the default profile — the logo speaks for itself (#755)", () => {
      expect(profileTitle("iRaceDeck Default")).toBe("");
      expect(profileTitle("iRaceDeck Default XL")).toBe("");
    });

    it("shows no title for an empty selection (which behaves as the default profile)", () => {
      expect(profileTitle("")).toBe("");
    });
  });

  describe("availableProfilesForDevice", () => {
    it("filters the generated profiles by device type, returning manifest names", () => {
      expect(availableProfilesForDevice(2)).toEqual(["iRaceDeck Default XL", "iRaceDeck Replay XL"]);
      expect(availableProfilesForDevice(1)).toEqual(["iRaceDeck Pit Actions Mini"]);
      expect(availableProfilesForDevice(99)).toEqual([]);
    });

    it("returns empty when the device type is unknown", () => {
      expect(availableProfilesForDevice(undefined)).toEqual([]);
    });
  });

  describe("deviceProfileEntries", () => {
    it("pairs each manifest name with its clean display label (#753)", () => {
      expect(deviceProfileEntries(2)).toEqual([
        { name: "iRaceDeck Default XL", label: "iRaceDeck Default" },
        { name: "iRaceDeck Replay XL", label: "iRaceDeck Replay" },
      ]);
      expect(deviceProfileEntries(undefined)).toEqual([]);
    });
  });

  describe("defaultProfileForDevice", () => {
    it("returns the device-suffixed Default profile name when the device ships one", () => {
      expect(defaultProfileForDevice(2)).toBe("iRaceDeck Default XL");
    });

    it("returns undefined when the device has no bundled Default profile", () => {
      expect(defaultProfileForDevice(1)).toBeUndefined();
      expect(defaultProfileForDevice(undefined)).toBeUndefined();
    });
  });

  describe("generateSwitchProfileSvg", () => {
    it("uses the clapper icon for the Replay profile, with or without a device suffix", () => {
      expect(generateSwitchProfileSvg(settings("iRaceDeck Replay"))).toBe("assembled:<svg>REPLAY</svg>");
      expect(generateSwitchProfileSvg(settings("iRaceDeck Replay XL"))).toBe("assembled:<svg>REPLAY</svg>");
    });

    it("uses the chat icon for a Chat profile", () => {
      expect(generateSwitchProfileSvg(settings("iRaceDeck Chat"))).toBe("assembled:<svg>CHAT</svg>");
    });

    it("falls back to the iRaceDeck icon for Default, unknown, or no selection", () => {
      expect(generateSwitchProfileSvg(settings("iRaceDeck Default"))).toBe("assembled:<svg>DEFAULT</svg>");
      expect(generateSwitchProfileSvg(settings("iRaceDeck Default XL"))).toBe("assembled:<svg>DEFAULT</svg>");
      expect(generateSwitchProfileSvg(settings("Something Else"))).toBe("assembled:<svg>DEFAULT</svg>");
      expect(generateSwitchProfileSvg(settings(""))).toBe("assembled:<svg>DEFAULT</svg>");
    });
  });

  describe("class behaviour", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("pushes the device-filtered profile entries on appear, then guards against re-push", async () => {
      const action = new SwitchProfile();
      const a = keyAction();

      await action.onWillAppear({ action: a, payload: { settings: {} } } as never);

      expect(a.setSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          _deviceProfiles: [
            { name: "iRaceDeck Default XL", label: "iRaceDeck Default" },
            { name: "iRaceDeck Replay XL", label: "iRaceDeck Replay" },
          ],
        }),
      );

      // Already up to date → no redundant setSettings (avoids the ping-pong loop).
      a.setSettings.mockClear();
      await action.onDidReceiveSettings({
        action: a,
        payload: {
          settings: {
            _deviceProfiles: [
              { name: "iRaceDeck Default XL", label: "iRaceDeck Default" },
              { name: "iRaceDeck Replay XL", label: "iRaceDeck Replay" },
            ],
          },
        },
      } as never);

      expect(a.setSettings).not.toHaveBeenCalled();
    });

    it("re-pushes when the persisted list still has the legacy string shape", async () => {
      const action = new SwitchProfile();
      const a = keyAction();

      await action.onDidReceiveSettings({
        action: a,
        payload: { settings: { _deviceProfiles: ["iRaceDeck Default", "iRaceDeck Replay"] } },
      } as never);

      expect(a.setSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          _deviceProfiles: [
            { name: "iRaceDeck Default XL", label: "iRaceDeck Default" },
            { name: "iRaceDeck Replay XL", label: "iRaceDeck Replay" },
          ],
        }),
      );
    });

    it("switches to the selected profile on key down, targeting the button's device and its first page", async () => {
      const action = new SwitchProfile();

      await action.onKeyDown({
        action: keyAction({ deviceId: "dev-9" }),
        payload: { settings: { profile: "iRaceDeck Replay XL" } },
      } as never);

      // Page 0: named switches always open the profile on its first page (#754).
      expect(requestProfileSwitch).toHaveBeenCalledWith("dev-9", "iRaceDeck Replay XL", 0);
    });

    it("resolves a legacy unsuffixed profile name to the device's variant (#753)", async () => {
      const action = new SwitchProfile();

      await action.onKeyDown({
        action: keyAction({ deviceId: "dev-9" }),
        payload: { settings: { profile: "iRaceDeck Replay" } },
      } as never);

      expect(requestProfileSwitch).toHaveBeenCalledWith("dev-9", "iRaceDeck Replay XL", 0);
    });

    it("switches to the device's Default profile when no profile is selected (#755)", async () => {
      const action = new SwitchProfile();

      await action.onKeyDown({ action: keyAction(), payload: { settings: { profile: "" } } } as never);

      expect(requestProfileSwitch).toHaveBeenCalledWith("dev-1", "iRaceDeck Default XL", 0);
    });

    it("falls back to the device's Default profile when the stored name has no variant here (#753)", async () => {
      const action = new SwitchProfile();

      await action.onKeyDown({
        action: keyAction(),
        payload: { settings: { profile: "iRaceDeck Chat" } },
      } as never);

      expect(requestProfileSwitch).toHaveBeenCalledWith("dev-1", "iRaceDeck Default XL", 0);
    });

    it("walks back with the device's Default profile as fallback in Back-to-previous mode (#762)", async () => {
      const action = new SwitchProfile();

      await action.onKeyDown({
        action: keyAction({ deviceId: "dev-9", deviceType: 2 }),
        payload: { settings: { profile: "__previous" } },
      } as never);

      expect(requestProfileSwitchBack).toHaveBeenCalledWith("dev-9", "iRaceDeck Default XL");
      expect(requestProfileSwitch).not.toHaveBeenCalled();
    });

    it("reports the host profile on appear, resolved to the device's manifest name (#753)", async () => {
      const action = new SwitchProfile();
      const a = keyAction();

      await action.onWillAppear({
        action: a,
        payload: { settings: { hostProfile: "iRaceDeck Replay" } },
      } as never);

      expect(notifyProfileVisible).toHaveBeenCalledWith("dev-1", "iRaceDeck Replay XL");
    });

    it("reports the host profile again when settings change", async () => {
      const action = new SwitchProfile();
      const a = keyAction();

      await action.onDidReceiveSettings({
        action: a,
        payload: { settings: { hostProfile: "iRaceDeck Default XL" } },
      } as never);

      expect(notifyProfileVisible).toHaveBeenCalledWith("dev-1", "iRaceDeck Default XL");
    });

    it("reports an unresolvable host profile as stored rather than dropping it", async () => {
      const action = new SwitchProfile();

      await action.onWillAppear({
        action: keyAction(),
        payload: { settings: { hostProfile: "iRaceDeck Chat" } },
      } as never);

      expect(notifyProfileVisible).toHaveBeenCalledWith("dev-1", "iRaceDeck Chat");
    });

    it("does not report a host profile when the marker is empty", async () => {
      const action = new SwitchProfile();

      await action.onWillAppear({ action: keyAction(), payload: { settings: {} } } as never);

      expect(notifyProfileVisible).not.toHaveBeenCalled();
    });
  });
});
