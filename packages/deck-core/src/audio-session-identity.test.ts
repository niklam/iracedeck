import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AUDIO_SESSION_DISPLAY_NAME,
  AUDIO_SESSION_ICON_FILE,
  pluginAudioSessionIdentity,
} from "./audio-session-identity.js";

describe("pluginAudioSessionIdentity (#1253)", () => {
  const pluginDir = resolve("/plugins/com.example.sdPlugin");
  const binDir = join(pluginDir, "bin");

  it("names the session iRaceDeck", () => {
    expect(AUDIO_SESSION_DISPLAY_NAME).toBe("iRaceDeck");
    expect(pluginAudioSessionIdentity(binDir).displayName).toBe("iRaceDeck");
  });

  it("points at imgs/plugin/iracedeck.ico beside bin/, as an absolute path", () => {
    const { iconPath } = pluginAudioSessionIdentity(binDir);

    expect(AUDIO_SESSION_ICON_FILE).toBe("iracedeck.ico");
    expect(iconPath).toBe(join(pluginDir, "imgs", "plugin", "iracedeck.ico"));
    expect(isAbsolute(iconPath)).toBe(true);
  });
});
