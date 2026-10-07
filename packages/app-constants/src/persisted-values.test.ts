import { describe, expect, it } from "vitest";

import {
  CHANGELOG_NOTIFICATION_POLICIES,
  DEFAULT_CHANGELOG_NOTIFICATION_POLICY,
  DEFAULT_FOCUS_IRACING_MODE,
  DEFAULT_POINTER_ANCHOR_X,
  DEFAULT_POINTER_ANCHOR_Y,
  DEFAULT_POINTER_OFFSET_X,
  DEFAULT_POINTER_OFFSET_Y,
  ENSURED_VOICE_PACK_ID,
  FOCUS_IRACING_MODES,
  PI_WARNINGS_KEY,
  POINTER_ANCHORS_X,
  POINTER_ANCHORS_Y,
  POINTER_OFFSET_LIMIT,
  PROFILE_CAPTURE_STATUS_KEY,
  SETTINGS_WINDOW_HTML,
  SETTINGS_WINDOW_OPEN_WARNING_ID,
  SETTINGS_WINDOW_SERVER_WARNING_ID,
  VOICE_LABELS_KEY,
  VOICE_PACK_CATALOG_DEFAULT_BASE,
  VOICE_PACK_CATALOG_FILENAME,
  VOICE_PACK_DEV_BASE_URL_KEY,
  VOICE_PACK_INSTALL_PHASES,
  VOICE_PACK_OFFER_VERDICTS,
  VOICE_PACK_STATUS_KEY,
  VOICE_PACKS_KEY,
} from "./index.js";

/**
 * Every value here is a contract outside this package: a key in the user's
 * settings file, a value stored under one, a key the run-scoped enrolment
 * strips, an id a Property Inspector filters on, or a file name the build
 * writes. None may change — the literals below are written out rather than
 * derived so that a change shows up as a red test and a deliberate decision
 * (spec #1351: "No setting key, default or schema changes").
 */
describe("app-constants persisted and run-scoped values (spec #1351)", () => {
  it("keeps the run-scoped and passthrough setting keys", () => {
    expect(PI_WARNINGS_KEY).toBe("_warnings");
    expect(PROFILE_CAPTURE_STATUS_KEY).toBe("_profileCaptureStatus");
    expect(VOICE_PACKS_KEY).toBe("_voicePacks");
    expect(VOICE_LABELS_KEY).toBe("_voiceLabels");
    expect(VOICE_PACK_STATUS_KEY).toBe("_voicePackStatus");
    expect(VOICE_PACK_DEV_BASE_URL_KEY).toBe("_devBaseUrl");
  });

  it("keeps the managed voice pack's id", () => {
    expect(ENSURED_VOICE_PACK_ID).toBe("default");
  });

  it("keeps the voice-pack catalog's published location", () => {
    expect(VOICE_PACK_CATALOG_DEFAULT_BASE).toBe("https://iracedeck.com");
    expect(VOICE_PACK_CATALOG_FILENAME).toBe("voice-catalog.json");
  });

  it("keeps the settings-window page name and warning ids", () => {
    expect(SETTINGS_WINDOW_HTML).toBe("settings-window.html");
    expect(SETTINGS_WINDOW_SERVER_WARNING_ID).toBe("settings-window-server");
    expect(SETTINGS_WINDOW_OPEN_WARNING_ID).toBe("settings-window-open");
  });

  it("keeps the changelog notification policies and their default", () => {
    expect(CHANGELOG_NOTIFICATION_POLICIES).toEqual(["always", "features", "monthly", "never"]);
    expect(DEFAULT_CHANGELOG_NOTIFICATION_POLICY).toBe("never");
  });

  it("keeps the Focus iRacing Window modes and their default", () => {
    expect(FOCUS_IRACING_MODES).toEqual(["always", "required", "never"]);
    expect(DEFAULT_FOCUS_IRACING_MODE).toBe("always");
  });

  it("keeps the Mouse to Sim anchors, defaults and offset limit", () => {
    expect(POINTER_ANCHORS_X).toEqual(["left", "center", "right"]);
    expect(POINTER_ANCHORS_Y).toEqual(["top", "middle", "bottom"]);
    expect(DEFAULT_POINTER_ANCHOR_X).toBe("center");
    expect(DEFAULT_POINTER_ANCHOR_Y).toBe("top");
    expect(DEFAULT_POINTER_OFFSET_X).toBe(0);
    expect(DEFAULT_POINTER_OFFSET_Y).toBe(12.5);
    expect(POINTER_OFFSET_LIMIT).toBe(50);
  });

  it("keeps the voice-pack install phases and offer verdicts", () => {
    expect(VOICE_PACK_INSTALL_PHASES).toEqual(["downloading", "extracting", "swapping", "failed"]);
    expect(VOICE_PACK_OFFER_VERDICTS).toEqual(["install", "update", "installed", "unsupported"]);
  });
});
