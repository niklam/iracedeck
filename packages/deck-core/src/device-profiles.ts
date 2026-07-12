/**
 * Stream Deck device + profile reference (issue #736).
 *
 * Canonical, platform-agnostic source of truth for:
 * - the Elgato SDK device-type IDs (`manifest Profiles[].DeviceType`, the value
 *   reported by `device.type`) and each device's hardware shape (keys, grid,
 *   dials, touch surfaces), and
 * - how iRaceDeck supports each device, and which devices it ships bundled
 *   profile templates for.
 *
 * This module deliberately contains NO profile-file generation: a distributed
 * `.streamDeckProfile` is authored in the Stream Deck app and exported (it is a
 * ZIP whose internal layout is app-managed). The authoritative description of
 * that bundle format, the manifest `Profiles` wiring, and the `switchToProfile`
 * API live in `.claude/rules/profiles-and-devices.md`. Keep the two in sync.
 *
 * The support/template classification encodes the decisions recorded in #736.
 */

/**
 * Elgato SDK device-type IDs. Matches the `DeviceType` enumeration used by the
 * manifest `Profiles[].DeviceType` field and the runtime `device.type`.
 *
 * `StreamDeck` (0) also covers the Stream Deck "Scissor Keys" variant — both
 * report type 0 and share the 15-key 5×3 layout.
 */
export enum DeviceType {
  StreamDeck = 0,
  StreamDeckMini = 1,
  StreamDeckXL = 2,
  StreamDeckMobile = 3,
  CorsairGKeys = 4,
  StreamDeckPedal = 5,
  CorsairVoyager = 6,
  StreamDeckPlus = 7,
  ScufController = 8,
  StreamDeckNeo = 9,
  StreamDeckStudio = 10,
  VirtualStreamDeck = 11,
  Galleon100SD = 12,
  StreamDeckPlusXL = 13,
}

/** Hardware shape of a device. */
export interface DeviceSpec {
  readonly type: DeviceType;
  /** Device name as Elgato lists it. */
  readonly name: string;
  /**
   * Number of LCD keys. For devices with a variable key count (Mobile, Voyager)
   * this is the documented maximum and `grid` is `null`.
   */
  readonly keys: number;
  /**
   * Fixed key grid as `[columns, rows]`, or `null` when the device has no fixed
   * keypad grid (macro-key, pedal-as-keys, virtual, or variable-size devices).
   * When non-null, `columns * rows === keys`.
   */
  readonly grid: readonly [columns: number, rows: number] | null;
  /** Number of rotary dials / encoders. */
  readonly dials: number;
  /** Description of any touch surface (strip, touch points, LCD), or `null`. */
  readonly touch: string | null;
}

/** How iRaceDeck supports a device's controls. */
export type DeviceControlSupport =
  /** Keys and dials are both supported. */
  | "keys-and-dials"
  /** Keys are supported (any other surfaces, e.g. Neo touch points, are not). */
  | "keys"
  /** iRaceDeck does not support the device at all. */
  | "unsupported";

/** Whether iRaceDeck ships bundled profile templates for a device. */
export type ProfileTemplateStatus =
  /** Templates are shipped for this device (this issue's target set). */
  | "target"
  /** Supported device that could get templates later; none shipped yet. */
  | "candidate"
  /** No templates — unsupported device, or a deliberate decision to skip it. */
  | "excluded";

/** iRaceDeck support classification for a device. */
export interface DeviceSupport {
  readonly type: DeviceType;
  readonly controls: DeviceControlSupport;
  readonly profileTemplates: ProfileTemplateStatus;
  /** Short rationale, grounded in the #736 support decisions. */
  readonly note?: string;
}

/** Hardware specs for every device type. `columns * rows === keys` where `grid` is set. */
export const DEVICE_SPECS: Record<DeviceType, DeviceSpec> = {
  [DeviceType.StreamDeck]: {
    type: DeviceType.StreamDeck,
    name: "Stream Deck",
    keys: 15,
    grid: [5, 3],
    dials: 0,
    touch: null,
  },
  [DeviceType.StreamDeckMini]: {
    type: DeviceType.StreamDeckMini,
    name: "Stream Deck Mini",
    keys: 6,
    grid: [3, 2],
    dials: 0,
    touch: null,
  },
  [DeviceType.StreamDeckXL]: {
    type: DeviceType.StreamDeckXL,
    name: "Stream Deck XL",
    keys: 32,
    grid: [8, 4],
    dials: 0,
    touch: null,
  },
  [DeviceType.StreamDeckMobile]: {
    type: DeviceType.StreamDeckMobile,
    name: "Stream Deck Mobile",
    keys: 64,
    grid: null,
    dials: 0,
    touch: "virtual (up to 64 keys, variable layout)",
  },
  [DeviceType.CorsairGKeys]: {
    type: DeviceType.CorsairGKeys,
    name: "Corsair G-Keys",
    keys: 6,
    grid: null,
    dials: 0,
    touch: null,
  },
  [DeviceType.StreamDeckPedal]: {
    type: DeviceType.StreamDeckPedal,
    name: "Stream Deck Pedal",
    keys: 3,
    grid: [1, 3],
    dials: 0,
    touch: null,
  },
  [DeviceType.CorsairVoyager]: {
    type: DeviceType.CorsairVoyager,
    name: "Corsair Voyager",
    keys: 10,
    grid: null,
    dials: 0,
    touch: "capacitive (up to 10 keys)",
  },
  [DeviceType.StreamDeckPlus]: {
    type: DeviceType.StreamDeckPlus,
    name: "Stream Deck +",
    keys: 8,
    grid: [4, 2],
    dials: 4,
    touch: "touch strip",
  },
  [DeviceType.ScufController]: {
    type: DeviceType.ScufController,
    name: "SCUF Controller",
    keys: 5,
    grid: null,
    dials: 0,
    touch: null,
  },
  [DeviceType.StreamDeckNeo]: {
    type: DeviceType.StreamDeckNeo,
    name: "Stream Deck Neo",
    keys: 8,
    grid: [4, 2],
    dials: 0,
    touch: "2 touch points",
  },
  [DeviceType.StreamDeckStudio]: {
    type: DeviceType.StreamDeckStudio,
    name: "Stream Deck Studio",
    keys: 32,
    grid: [8, 4],
    dials: 2,
    touch: null,
  },
  [DeviceType.VirtualStreamDeck]: {
    type: DeviceType.VirtualStreamDeck,
    name: "Virtual Stream Deck",
    keys: 0,
    grid: null,
    dials: 0,
    touch: "virtual / testing device",
  },
  [DeviceType.Galleon100SD]: {
    type: DeviceType.Galleon100SD,
    name: "Galleon 100 SD",
    keys: 12,
    grid: null,
    dials: 2,
    touch: "LCD screen",
  },
  [DeviceType.StreamDeckPlusXL]: {
    type: DeviceType.StreamDeckPlusXL,
    name: "Stream Deck + XL",
    keys: 36,
    grid: [6, 6],
    dials: 6,
    touch: "touch strip",
  },
};

/**
 * iRaceDeck support + profile-template classification per device (issue #736).
 *
 * - `controls`: which surfaces iRaceDeck supports. Neo is `keys` (its touch
 *   points are not supported). Galleon, Studio, and the dial-bearing Stream
 *   Decks are `keys-and-dials`.
 * - `profileTemplates`: `target` = the three devices this issue ships templates
 *   for (Stream Deck, XL, + XL); `candidate` = supported decks eligible later;
 *   `excluded` = unsupported devices plus the deliberate skips (Studio, Mobile).
 */
export const DEVICE_SUPPORT: Record<DeviceType, DeviceSupport> = {
  [DeviceType.StreamDeck]: { type: DeviceType.StreamDeck, controls: "keys", profileTemplates: "target" },
  [DeviceType.StreamDeckMini]: { type: DeviceType.StreamDeckMini, controls: "keys", profileTemplates: "candidate" },
  [DeviceType.StreamDeckXL]: { type: DeviceType.StreamDeckXL, controls: "keys", profileTemplates: "target" },
  [DeviceType.StreamDeckMobile]: {
    type: DeviceType.StreamDeckMobile,
    controls: "keys",
    profileTemplates: "excluded",
    note: "No profiles built for it right now.",
  },
  [DeviceType.CorsairGKeys]: { type: DeviceType.CorsairGKeys, controls: "unsupported", profileTemplates: "excluded" },
  [DeviceType.StreamDeckPedal]: {
    type: DeviceType.StreamDeckPedal,
    controls: "unsupported",
    profileTemplates: "excluded",
  },
  [DeviceType.CorsairVoyager]: {
    type: DeviceType.CorsairVoyager,
    controls: "unsupported",
    profileTemplates: "excluded",
  },
  [DeviceType.StreamDeckPlus]: {
    type: DeviceType.StreamDeckPlus,
    controls: "keys-and-dials",
    profileTemplates: "candidate",
  },
  [DeviceType.ScufController]: {
    type: DeviceType.ScufController,
    controls: "unsupported",
    profileTemplates: "excluded",
  },
  [DeviceType.StreamDeckNeo]: {
    type: DeviceType.StreamDeckNeo,
    controls: "keys",
    profileTemplates: "candidate",
    note: "Keys only — the two touch points are not supported.",
  },
  [DeviceType.StreamDeckStudio]: {
    type: DeviceType.StreamDeckStudio,
    controls: "keys-and-dials",
    profileTemplates: "excluded",
    note: "Supported device, but no profiles will be built for it.",
  },
  [DeviceType.VirtualStreamDeck]: {
    type: DeviceType.VirtualStreamDeck,
    controls: "keys",
    profileTemplates: "excluded",
    note: "Virtual / testing device; no bundled profiles.",
  },
  [DeviceType.Galleon100SD]: {
    type: DeviceType.Galleon100SD,
    controls: "keys-and-dials",
    profileTemplates: "candidate",
  },
  [DeviceType.StreamDeckPlusXL]: {
    type: DeviceType.StreamDeckPlusXL,
    controls: "keys-and-dials",
    profileTemplates: "target",
  },
};

/** Display names of the bundled profile templates (the manifest `Profiles[].Name` minus device suffix). */
export const PROFILE_NAMES = {
  default: "iRaceDeck Default",
  pitActions: "iRaceDeck Pit Actions",
  replay: "iRaceDeck Replay",
} as const;

/**
 * Display name of the generic car-selector profile (issue #790) — the renamed
 * `iRaceDeck Race Admin Cars`. Exported so consumers (Camera Controls' focus
 * entry mode, Switch Profile's marker check) share one source of truth.
 */
export const CAR_SELECTOR_PROFILE = "iRaceDeck Car Selector" as const;

/**
 * Legacy display name → current display name (issue #790). Consulted by
 * `resolveProfileNameForDevice` after suffix-stripping, so names persisted by
 * older installs (bare or suffixed for any device) keep resolving after a
 * bundled profile is renamed.
 */
const LEGACY_PROFILE_NAMES: Record<string, string> = {
  "iRaceDeck Race Admin Cars": CAR_SELECTOR_PROFILE,
};

/** A bundled profile template key. */
export type ProfileTemplate = keyof typeof PROFILE_NAMES;

/** Devices this issue ships profile templates for (the `target` set), in display order. */
export const PROFILE_TARGET_DEVICES: readonly DeviceType[] = [
  DeviceType.StreamDeck,
  DeviceType.StreamDeckXL,
  DeviceType.StreamDeckPlusXL,
];

/**
 * Device-name suffix used in bundled profile file / manifest names (issue #753).
 *
 * A bundled `.streamDeckProfile` is named `<display name> <suffix>` (e.g.
 * `iRaceDeck Default XL`) so one file can exist per (template × device), while
 * the user-facing name inside the bundle stays the clean display name. Rule:
 * devices named "Stream Deck …" use the latter part (`Plus` spelled out for
 * `+`); the classic Stream Deck, whose latter part is empty, uses `SD`. Only
 * devices that can ship profiles (`target` / `candidate`) get a suffix.
 */
export const PROFILE_DEVICE_SUFFIXES: Partial<Record<DeviceType, string>> = {
  [DeviceType.StreamDeck]: "SD",
  [DeviceType.StreamDeckMini]: "Mini",
  [DeviceType.StreamDeckXL]: "XL",
  [DeviceType.StreamDeckPlus]: "Plus",
  [DeviceType.StreamDeckNeo]: "Neo",
  [DeviceType.Galleon100SD]: "Corsair Galleon",
  [DeviceType.StreamDeckPlusXL]: "Plus XL",
};

/**
 * Known suffixes longest-first, so stripping `iRaceDeck Default Plus XL` takes
 * `Plus XL` — never the shorter `XL`.
 */
const SUFFIXES_LONGEST_FIRST: readonly string[] = Object.values(PROFILE_DEVICE_SUFFIXES).sort(
  (a, b) => b.length - a.length,
);

/** The profile-name device suffix for a device type, or `undefined` when it has none. */
export function profileDeviceSuffix(type: number): string | undefined {
  return PROFILE_DEVICE_SUFFIXES[type as DeviceType];
}

/**
 * Display name of a bundled profile: the manifest/file name with its trailing
 * device suffix stripped (longest suffix first). A name without a known suffix
 * — a display name, or a legacy pre-#753 manifest name — is returned unchanged.
 */
export function profileDisplayName(name: string): string {
  for (const suffix of SUFFIXES_LONGEST_FIRST) {
    if (name.endsWith(` ${suffix}`)) {
      return name.slice(0, -(suffix.length + 1));
    }
  }

  return name;
}

/**
 * Device-suffixed manifest/file name for a profile on a device: `<name>
 * <suffix>`. Idempotent — a name already carrying a known device suffix is
 * returned unchanged (even for a different device), and so is the name when
 * the device type is unknown or has no suffix.
 */
export function deviceProfileName(name: string, deviceType: number | undefined): string {
  if (profileDisplayName(name) !== name) {
    return name;
  }

  const suffix = deviceType === undefined ? undefined : profileDeviceSuffix(deviceType);

  return suffix ? `${name} ${suffix}` : name;
}

/**
 * Resolve a stored profile name against a device's available manifest names
 * (issue #753). An exact match wins; otherwise the name is normalized to its
 * display name and re-suffixed for this device — which maps both legacy
 * pre-#753 names (`iRaceDeck Default`) and names persisted on another device
 * (`iRaceDeck Default SD`) to this device's variant. Legacy display names
 * renamed since the value was persisted are mapped through `LEGACY_PROFILE_NAMES`
 * (#790). Returns `undefined` when the profile has no variant among
 * `availableNames`; the caller picks the fallback (typically the device's
 * Default profile).
 */
export function resolveProfileNameForDevice(
  name: string,
  deviceType: number | undefined,
  availableNames: readonly string[],
): string | undefined {
  if (availableNames.includes(name)) {
    return name;
  }

  const display = profileDisplayName(name);
  const canonical = LEGACY_PROFILE_NAMES[display] ?? display;
  const suffixed = deviceProfileName(canonical, deviceType);

  return availableNames.includes(suffixed) ? suffixed : undefined;
}

/** Built-in Elgato navigation actions used inside profiles (folder pages). See the profiles rule. */
export const PROFILE_NAV_ACTIONS = {
  /** Enter a child folder page; `Settings.ProfileUUID` points at the child page. */
  openChild: "com.elgato.streamdeck.profile.openchild",
  /** Return to the parent page. */
  backToParent: "com.elgato.streamdeck.profile.backtoparent",
} as const;

/** Look up a device's hardware spec, or `undefined` for an unknown type id. */
export function getDeviceSpec(type: number): DeviceSpec | undefined {
  return DEVICE_SPECS[type as DeviceType];
}

/** Look up a device's iRaceDeck support, or `undefined` for an unknown type id. */
export function getDeviceSupport(type: number): DeviceSupport | undefined {
  return DEVICE_SUPPORT[type as DeviceType];
}

/** Whether iRaceDeck supports the device's controls at all (false for unknown/unsupported). */
export function isDeviceSupported(type: number): boolean {
  return getDeviceSupport(type)?.controls !== "unsupported" && getDeviceSupport(type) !== undefined;
}

/** Whether iRaceDeck ships bundled profile templates for the device (the `target` set). */
export function shipsBundledProfiles(type: number): boolean {
  return getDeviceSupport(type)?.profileTemplates === "target";
}

/** Fallback PNG raster size (px) for key images when the device type is unknown or non-Elgato. */
export const DEFAULT_KEY_IMAGE_SIZE = 144;

/**
 * PNG raster size (px) for key images, per Elgato device type — the physical
 * key LCD size at @2x (Elgato's recommended image scale). Non-Elgato devices
 * (Mirabox/Ulanzi contexts carry no deviceType) and unknown types use
 * DEFAULT_KEY_IMAGE_SIZE; refine per-model once measured on hardware
 * (#642 decision doc §6 checklist).
 */
const KEY_IMAGE_SIZES: Partial<Record<DeviceType, number>> = {
  [DeviceType.StreamDeck]: 144, // 72×72 keys
  [DeviceType.StreamDeckMini]: 160, // 80×80 keys
  [DeviceType.StreamDeckXL]: 192, // 96×96 keys
  [DeviceType.StreamDeckPlus]: 240, // 120×120 keys
  [DeviceType.StreamDeckNeo]: 192, // 96×96 keys
};

export function keyImageSizeForDevice(deviceType?: number): number {
  if (deviceType === undefined) return DEFAULT_KEY_IMAGE_SIZE;

  return KEY_IMAGE_SIZES[deviceType as DeviceType] ?? DEFAULT_KEY_IMAGE_SIZE;
}
