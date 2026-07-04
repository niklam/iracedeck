import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetProfileSwitcher,
  initProfileSwitcher,
  isProfileSwitcherInitialized,
  requestProfileSwitch,
  requestProfileSwitchBack,
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

  describe("requestProfileSwitchBack", () => {
    it("switches back BY NAME to the previously requested profile", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitch("dev-1", "iRaceDeck Default");
      await requestProfileSwitch("dev-1", "iRaceDeck Replay");
      await requestProfileSwitchBack("dev-1");

      expect(fn).toHaveBeenLastCalledWith("dev-1", "iRaceDeck Default", undefined);
    });

    it("toggles between the two most recent profiles on repeated presses", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitch("dev-1", "iRaceDeck Default");
      await requestProfileSwitch("dev-1", "iRaceDeck Replay");
      await requestProfileSwitchBack("dev-1");
      await requestProfileSwitchBack("dev-1");

      expect(fn).toHaveBeenLastCalledWith("dev-1", "iRaceDeck Replay", undefined);
    });

    it("falls back to the app-level pop (no profile) when there is no history", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitchBack("dev-1");

      expect(fn).toHaveBeenCalledWith("dev-1", undefined, undefined);
    });

    it("uses the app-level pop after a single named switch (no earlier profile known)", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitch("dev-1", "iRaceDeck Replay");
      await requestProfileSwitchBack("dev-1");

      expect(fn).toHaveBeenLastCalledWith("dev-1", undefined, undefined);
    });

    it("keeps history per device", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitch("dev-1", "iRaceDeck Default");
      await requestProfileSwitch("dev-1", "iRaceDeck Replay");
      await requestProfileSwitch("dev-2", "iRaceDeck Default");
      await requestProfileSwitchBack("dev-2");

      expect(fn).toHaveBeenLastCalledWith("dev-2", undefined, undefined);
    });

    it("ignores a repeated switch to the same profile when recording history", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitch("dev-1", "iRaceDeck Default");
      await requestProfileSwitch("dev-1", "iRaceDeck Replay");
      await requestProfileSwitch("dev-1", "iRaceDeck Replay");
      await requestProfileSwitchBack("dev-1");

      expect(fn).toHaveBeenLastCalledWith("dev-1", "iRaceDeck Default", undefined);
    });

    it("does not call the switcher when deviceId is missing", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitchBack(undefined);

      expect(fn).not.toHaveBeenCalled();
    });
  });
});
