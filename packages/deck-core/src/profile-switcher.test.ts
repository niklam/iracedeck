import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetProfileSwitcher,
  initProfileSwitcher,
  isProfileSwitcherInitialized,
  notifyProfileVisible,
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
    expect(() => notifyProfileVisible("dev-1", "iRaceDeck Default")).not.toThrow();
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

    it("walks back through multiple levels instead of toggling", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitch("dev-1", "iRaceDeck Default");
      await requestProfileSwitch("dev-1", "iRaceDeck Race Admin Cars");
      await requestProfileSwitch("dev-1", "iRaceDeck Race Admin Per Car");
      await requestProfileSwitchBack("dev-1");

      expect(fn).toHaveBeenLastCalledWith("dev-1", "iRaceDeck Race Admin Cars", undefined);

      await requestProfileSwitchBack("dev-1");

      expect(fn).toHaveBeenLastCalledWith("dev-1", "iRaceDeck Default", undefined);
    });

    it("switches to the fallback profile when there is no history", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitchBack("dev-1", "iRaceDeck Default");

      expect(fn).toHaveBeenCalledWith("dev-1", "iRaceDeck Default", undefined);
    });

    it("falls back to the app-level pop (no profile) when there is no history and no fallback", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitchBack("dev-1");

      expect(fn).toHaveBeenCalledWith("dev-1", undefined, undefined);
    });

    it("uses the fallback profile after a single named switch (no earlier profile known)", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitch("dev-1", "iRaceDeck Replay");
      await requestProfileSwitchBack("dev-1", "iRaceDeck Default");

      expect(fn).toHaveBeenLastCalledWith("dev-1", "iRaceDeck Default", undefined);
    });

    it("resets the history to the fallback profile when falling back", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitch("dev-1", "iRaceDeck Replay");
      await requestProfileSwitchBack("dev-1", "iRaceDeck Default");
      await requestProfileSwitchBack("dev-1", "iRaceDeck Default");

      // The second back must not return to Replay — the fallback became the root.
      expect(fn).toHaveBeenLastCalledWith("dev-1", "iRaceDeck Default", undefined);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("keeps history per device", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitch("dev-1", "iRaceDeck Default");
      await requestProfileSwitch("dev-1", "iRaceDeck Replay");
      await requestProfileSwitch("dev-2", "iRaceDeck Replay");
      await requestProfileSwitchBack("dev-2", "iRaceDeck Default");

      expect(fn).toHaveBeenLastCalledWith("dev-2", "iRaceDeck Default", undefined);
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

    it("unwinds the history when switching to a profile already in it", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitch("dev-1", "iRaceDeck Default");
      await requestProfileSwitch("dev-1", "iRaceDeck Race Admin Cars");
      await requestProfileSwitch("dev-1", "iRaceDeck Race Admin Per Car");
      // A named "back to default" key unwinds rather than pushing a 4th entry.
      await requestProfileSwitch("dev-1", "iRaceDeck Default");
      await requestProfileSwitchBack("dev-1", "fallback-profile");

      expect(fn).toHaveBeenLastCalledWith("dev-1", "fallback-profile", undefined);
    });

    it("caps the history depth and drops the oldest entries", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      for (let i = 1; i <= 12; i++) {
        await requestProfileSwitch("dev-1", `P${i}`);
      }

      // Only the back-switches matter below, not the forward switches above.
      fn.mockClear();

      // Cap is 10: P1 and P2 fell off. Nine backs walk P12 → P3 ...
      for (let i = 0; i < 9; i++) {
        await requestProfileSwitchBack("dev-1", "fallback-profile");
      }

      expect(fn).toHaveBeenLastCalledWith("dev-1", "P3", undefined);

      // ... and the tenth back hits the bottom and uses the fallback.
      await requestProfileSwitchBack("dev-1", "fallback-profile");

      expect(fn).toHaveBeenLastCalledWith("dev-1", "fallback-profile", undefined);
      expect(fn).not.toHaveBeenCalledWith("dev-1", "P2", undefined);
      expect(fn).not.toHaveBeenCalledWith("dev-1", "P1", undefined);
    });

    it("does not call the switcher when deviceId is missing", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      await requestProfileSwitchBack(undefined);

      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("notifyProfileVisible", () => {
    it("seeds the starting profile so the first back switches to it by name", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      notifyProfileVisible("dev-1", "iRaceDeck Default");
      await requestProfileSwitch("dev-1", "iRaceDeck Replay");
      await requestProfileSwitchBack("dev-1");

      expect(fn).toHaveBeenLastCalledWith("dev-1", "iRaceDeck Default", undefined);
    });

    it("does not duplicate the entry when the profile is already current", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      notifyProfileVisible("dev-1", "iRaceDeck Default");
      notifyProfileVisible("dev-1", "iRaceDeck Default");
      await requestProfileSwitch("dev-1", "iRaceDeck Replay");
      await requestProfileSwitchBack("dev-1");
      await requestProfileSwitchBack("dev-1", "fallback-profile");

      // Only one Default entry existed, so the second back needs the fallback.
      expect(fn).toHaveBeenLastCalledWith("dev-1", "fallback-profile", undefined);
    });

    it("unwinds the history when the user manually navigated back to an earlier profile", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      notifyProfileVisible("dev-1", "iRaceDeck Default");
      await requestProfileSwitch("dev-1", "iRaceDeck Replay");
      await requestProfileSwitch("dev-1", "iRaceDeck Race Admin Cars");
      // The user navigated back to Replay via the Stream Deck app; a marked key
      // in Replay reports it.
      notifyProfileVisible("dev-1", "iRaceDeck Replay");
      await requestProfileSwitchBack("dev-1");

      expect(fn).toHaveBeenLastCalledWith("dev-1", "iRaceDeck Default", undefined);
    });

    it("ignores a missing deviceId or empty profile name", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      initProfileSwitcher(fn);

      notifyProfileVisible(undefined, "iRaceDeck Default");
      notifyProfileVisible("dev-1", "");
      await requestProfileSwitchBack("dev-1");

      // Nothing was recorded, so back falls through to the app-level pop.
      expect(fn).toHaveBeenCalledWith("dev-1", undefined, undefined);
    });
  });
});
