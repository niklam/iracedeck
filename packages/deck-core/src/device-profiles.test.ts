import { describe, expect, it } from "vitest";

import {
  DEVICE_SPECS,
  DEVICE_SUPPORT,
  DeviceType,
  getDeviceSpec,
  getDeviceSupport,
  isDeviceSupported,
  PROFILE_NAMES,
  PROFILE_NAV_ACTIONS,
  PROFILE_TARGET_DEVICES,
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
