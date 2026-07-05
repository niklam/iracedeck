import { describe, expect, it } from "vitest";

import {
  DEVICE_SPECS,
  DEVICE_SUPPORT,
  deviceProfileName,
  DeviceType,
  getDeviceSpec,
  getDeviceSupport,
  isDeviceSupported,
  PROFILE_DEVICE_SUFFIXES,
  PROFILE_NAMES,
  PROFILE_NAV_ACTIONS,
  PROFILE_TARGET_DEVICES,
  profileDeviceSuffix,
  profileDisplayName,
  resolveProfileNameForDevice,
  shipsBundledProfiles,
} from "./device-profiles.js";

/** All numeric device-type ids declared in the enum (0–13). */
const ALL_TYPES = Object.values(DeviceType).filter((v): v is DeviceType => typeof v === "number");

describe("DEVICE_SPECS", () => {
  it("has an entry for every device type, keyed consistently", () => {
    expect(ALL_TYPES).toHaveLength(14);

    for (const type of ALL_TYPES) {
      const spec = DEVICE_SPECS[type];
      expect(spec, `spec for type ${type}`).toBeDefined();
      expect(spec.type).toBe(type);
      expect(spec.name.length).toBeGreaterThan(0);
    }
  });

  it("keeps columns × rows === keys for every fixed-grid device", () => {
    for (const type of ALL_TYPES) {
      const { grid, keys, name } = DEVICE_SPECS[type];

      if (grid) {
        expect(grid[0] * grid[1], `${name} grid ${grid[0]}×${grid[1]} vs keys ${keys}`).toBe(keys);
      }
    }
  });

  it("matches the documented hardware for the key devices", () => {
    expect(DEVICE_SPECS[DeviceType.StreamDeck]).toMatchObject({ keys: 15, grid: [5, 3], dials: 0 });
    expect(DEVICE_SPECS[DeviceType.StreamDeckMini]).toMatchObject({ keys: 6, grid: [3, 2], dials: 0 });
    expect(DEVICE_SPECS[DeviceType.StreamDeckXL]).toMatchObject({ keys: 32, grid: [8, 4], dials: 0 });
    expect(DEVICE_SPECS[DeviceType.StreamDeckPlus]).toMatchObject({ keys: 8, grid: [4, 2], dials: 4 });
    expect(DEVICE_SPECS[DeviceType.StreamDeckNeo]).toMatchObject({ keys: 8, grid: [4, 2], dials: 0 });
    expect(DEVICE_SPECS[DeviceType.StreamDeckStudio]).toMatchObject({ keys: 32, grid: [8, 4], dials: 2 });
    expect(DEVICE_SPECS[DeviceType.StreamDeckPlusXL]).toMatchObject({ keys: 36, grid: [6, 6], dials: 6 });
  });
});

describe("DEVICE_SUPPORT", () => {
  it("has an entry for every device type, keyed consistently", () => {
    for (const type of ALL_TYPES) {
      const support = DEVICE_SUPPORT[type];
      expect(support, `support for type ${type}`).toBeDefined();
      expect(support.type).toBe(type);
    }
  });

  it("treats exactly the non-Stream-Deck peripherals as unsupported", () => {
    const unsupported = ALL_TYPES.filter((t) => DEVICE_SUPPORT[t].controls === "unsupported");
    expect(new Set(unsupported)).toEqual(
      new Set([
        DeviceType.CorsairGKeys,
        DeviceType.StreamDeckPedal,
        DeviceType.CorsairVoyager,
        DeviceType.ScufController,
      ]),
    );
  });

  it("marks a device keys-and-dials iff it actually has dials", () => {
    for (const type of ALL_TYPES) {
      const hasDials = DEVICE_SPECS[type].dials > 0;
      const supportsDials = DEVICE_SUPPORT[type].controls === "keys-and-dials";
      expect(supportsDials, `${DEVICE_SPECS[type].name} dials vs support`).toBe(hasDials);
    }
  });
});

describe("profile templates", () => {
  it("targets exactly Stream Deck, XL, and + XL", () => {
    expect(PROFILE_TARGET_DEVICES).toEqual([
      DeviceType.StreamDeck,
      DeviceType.StreamDeckXL,
      DeviceType.StreamDeckPlusXL,
    ]);
  });

  it("keeps PROFILE_TARGET_DEVICES and the 'target' status in sync (both directions)", () => {
    const targets = ALL_TYPES.filter((t) => DEVICE_SUPPORT[t].profileTemplates === "target");
    expect(new Set(targets)).toEqual(new Set(PROFILE_TARGET_DEVICES));
  });

  it("ships bundled profiles only for the target devices", () => {
    for (const type of ALL_TYPES) {
      expect(shipsBundledProfiles(type)).toBe(PROFILE_TARGET_DEVICES.includes(type));
    }
  });

  it("exposes the three template names and the built-in nav actions", () => {
    expect(PROFILE_NAMES).toEqual({
      default: "iRaceDeck Default",
      pitActions: "iRaceDeck Pit Actions",
      replay: "iRaceDeck Replay",
    });
    expect(PROFILE_NAV_ACTIONS.openChild).toBe("com.elgato.streamdeck.profile.openchild");
    expect(PROFILE_NAV_ACTIONS.backToParent).toBe("com.elgato.streamdeck.profile.backtoparent");
  });
});

describe("profile device suffixes (#753)", () => {
  it("codifies the device-name suffix for every profile-capable device", () => {
    expect(profileDeviceSuffix(DeviceType.StreamDeck)).toBe("SD");
    expect(profileDeviceSuffix(DeviceType.StreamDeckMini)).toBe("Mini");
    expect(profileDeviceSuffix(DeviceType.StreamDeckXL)).toBe("XL");
    expect(profileDeviceSuffix(DeviceType.StreamDeckPlus)).toBe("Plus");
    expect(profileDeviceSuffix(DeviceType.StreamDeckNeo)).toBe("Neo");
    expect(profileDeviceSuffix(DeviceType.Galleon100SD)).toBe("Corsair Galleon");
    expect(profileDeviceSuffix(DeviceType.StreamDeckPlusXL)).toBe("Plus XL");
  });

  it("has a suffix for exactly the target and candidate devices", () => {
    for (const type of ALL_TYPES) {
      const status = DEVICE_SUPPORT[type].profileTemplates;
      const expectSuffix = status === "target" || status === "candidate";
      expect(profileDeviceSuffix(type) !== undefined, `${DEVICE_SPECS[type].name} suffix vs ${status}`).toBe(
        expectSuffix,
      );
    }
  });

  it("returns undefined for unknown device ids", () => {
    expect(profileDeviceSuffix(99)).toBeUndefined();
    expect(profileDeviceSuffix(-1)).toBeUndefined();
  });

  it("keeps the suffixes unique", () => {
    const suffixes = Object.values(PROFILE_DEVICE_SUFFIXES);
    expect(new Set(suffixes).size).toBe(suffixes.length);
  });
});

describe("deviceProfileName", () => {
  it("appends the device suffix to a display name", () => {
    expect(deviceProfileName("iRaceDeck Default", DeviceType.StreamDeckXL)).toBe("iRaceDeck Default XL");
    expect(deviceProfileName("iRaceDeck Default", DeviceType.StreamDeck)).toBe("iRaceDeck Default SD");
    expect(deviceProfileName("iRaceDeck Race Admin Per Car", DeviceType.StreamDeckPlusXL)).toBe(
      "iRaceDeck Race Admin Per Car Plus XL",
    );
  });

  it("keeps an already-suffixed name unchanged (idempotent)", () => {
    expect(deviceProfileName("iRaceDeck Default XL", DeviceType.StreamDeckXL)).toBe("iRaceDeck Default XL");
    expect(deviceProfileName("iRaceDeck Default XL", DeviceType.StreamDeck)).toBe("iRaceDeck Default XL");
  });

  it("returns the name unchanged when the device has no suffix", () => {
    expect(deviceProfileName("iRaceDeck Default", DeviceType.StreamDeckStudio)).toBe("iRaceDeck Default");
    expect(deviceProfileName("iRaceDeck Default", undefined)).toBe("iRaceDeck Default");
    expect(deviceProfileName("iRaceDeck Default", 99)).toBe("iRaceDeck Default");
  });
});

describe("profileDisplayName", () => {
  it("strips a trailing device suffix from a manifest name", () => {
    expect(profileDisplayName("iRaceDeck Default XL")).toBe("iRaceDeck Default");
    expect(profileDisplayName("iRaceDeck Default SD")).toBe("iRaceDeck Default");
    expect(profileDisplayName("iRaceDeck Replay Corsair Galleon")).toBe("iRaceDeck Replay");
  });

  it("strips the longest matching suffix ('Plus XL', not 'XL')", () => {
    expect(profileDisplayName("iRaceDeck Race Admin Cars Plus XL")).toBe("iRaceDeck Race Admin Cars");
  });

  it("returns a display (legacy, unsuffixed) name unchanged", () => {
    expect(profileDisplayName("iRaceDeck Default")).toBe("iRaceDeck Default");
    expect(profileDisplayName("iRaceDeck Race Admin Per Car")).toBe("iRaceDeck Race Admin Per Car");
  });
});

describe("resolveProfileNameForDevice", () => {
  const available = ["iRaceDeck Default XL", "iRaceDeck Replay XL"];

  it("returns an exact manifest-name match as-is", () => {
    expect(resolveProfileNameForDevice("iRaceDeck Replay XL", DeviceType.StreamDeckXL, available)).toBe(
      "iRaceDeck Replay XL",
    );
  });

  it("resolves a legacy/display name to the device-suffixed variant", () => {
    expect(resolveProfileNameForDevice("iRaceDeck Default", DeviceType.StreamDeckXL, available)).toBe(
      "iRaceDeck Default XL",
    );
  });

  it("resolves a name suffixed for another device to this device's variant", () => {
    expect(resolveProfileNameForDevice("iRaceDeck Default SD", DeviceType.StreamDeckXL, available)).toBe(
      "iRaceDeck Default XL",
    );
  });

  it("returns undefined when the profile has no variant for this device", () => {
    expect(resolveProfileNameForDevice("iRaceDeck Chat", DeviceType.StreamDeckXL, available)).toBeUndefined();
    expect(resolveProfileNameForDevice("iRaceDeck Default", DeviceType.StreamDeck, available)).toBeUndefined();
    expect(resolveProfileNameForDevice("iRaceDeck Default", undefined, available)).toBeUndefined();
    expect(resolveProfileNameForDevice("", DeviceType.StreamDeckXL, available)).toBeUndefined();
  });
});

describe("lookup helpers", () => {
  it("resolves known types and returns undefined for unknown ids", () => {
    expect(getDeviceSpec(DeviceType.StreamDeckXL)?.name).toBe("Stream Deck XL");
    expect(getDeviceSupport(DeviceType.StreamDeckXL)?.profileTemplates).toBe("target");

    for (const unknown of [14, 99, -1]) {
      expect(getDeviceSpec(unknown)).toBeUndefined();
      expect(getDeviceSupport(unknown)).toBeUndefined();
      expect(isDeviceSupported(unknown)).toBe(false);
      expect(shipsBundledProfiles(unknown)).toBe(false);
    }
  });

  it("reports support correctly per device", () => {
    expect(isDeviceSupported(DeviceType.StreamDeck)).toBe(true);
    expect(isDeviceSupported(DeviceType.StreamDeckPlusXL)).toBe(true);
    expect(isDeviceSupported(DeviceType.StreamDeckPedal)).toBe(false);
    expect(isDeviceSupported(DeviceType.CorsairVoyager)).toBe(false);
  });
});
