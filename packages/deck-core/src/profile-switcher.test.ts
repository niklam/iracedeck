import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetProfileSwitcher,
  initProfileSwitcher,
  isProfileSwitcherInitialized,
  requestProfileSwitch,
} from "./profile-switcher.js";

describe("profile-switcher", () => {
  afterEach(() => {
    _resetProfileSwitcher();
  });

  it("is uninitialized by default and no-ops safely", async () => {
    expect(isProfileSwitcherInitialized()).toBe(false);
    await expect(requestProfileSwitch("dev-1", "iRaceDeck Default")).resolves.toBeUndefined();
  });

  it("routes to the registered switcher with device, profile, and page", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    initProfileSwitcher(fn);

    expect(isProfileSwitcherInitialized()).toBe(true);

    await requestProfileSwitch("dev-9", "iRaceDeck Replay", 2);

    expect(fn).toHaveBeenCalledWith("dev-9", "iRaceDeck Replay", 2);
  });

  it("does not call the switcher when deviceId is missing", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    initProfileSwitcher(fn);

    await requestProfileSwitch(undefined, "iRaceDeck Default");

    expect(fn).not.toHaveBeenCalled();
  });
});
