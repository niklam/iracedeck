import type { ProfileSwitchSessionKind } from "@iracedeck/app-constants";
import type { ILogger } from "@iracedeck/logger";
import { describe, expect, it, vi } from "vitest";

import {
  createSessionProfileReactor,
  type ProfileAutoSwitchSettings,
  resolveProfileForKind,
  type SessionProfileDeck,
} from "./session-profile-reactor.js";

const SD = { id: "sd-1", type: 0 } as const;
const XL = { id: "xl-1", type: 2 } as const;
const MINI = { id: "mini-1", type: 1 } as const;

/** What profiles.json lists per device type, trimmed to what these tests touch. */
const AVAILABLE: Record<number, string[]> = {
  0: ["iRaceDeck Default SD", "iRaceDeck Practice SD", "iRaceDeck Qualifying SD", "iRaceDeck Race SD"],
  2: ["iRaceDeck Default XL", "iRaceDeck Practice XL", "iRaceDeck Qualifying XL", "iRaceDeck Race XL"],
};

function settingsWith(overrides: Partial<ProfileAutoSwitchSettings> = {}): ProfileAutoSwitchSettings {
  return {
    profileAutoSwitchEnabled: true,
    profileForSessionKindTest: "",
    profileForSessionKindPractice: "iRaceDeck Practice",
    profileForSessionKindQualifying: "iRaceDeck Qualifying",
    profileForSessionKindRace: "iRaceDeck Race",
    profileForSessionKindReplay: "",
    ...overrides,
  };
}

function fakeLogger() {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: vi.fn(),
    createScope: vi.fn(),
  };

  logger.withLevel.mockReturnValue(logger);
  logger.createScope.mockReturnValue(logger);

  return logger;
}

/** Let the reactor's fire-and-forget switches run to completion. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function harness(initial: { kind?: ProfileSwitchSessionKind | null; decks?: SessionProfileDeck[] } = {}) {
  const state = {
    kind: initial.kind ?? null,
    rawType: "",
    settings: settingsWith(),
    decks: initial.decks ?? [SD],
    current: new Map<string, string>(),
  };
  let onTick: (() => void) | undefined;
  let onExit: (() => void) | undefined;
  const unsubscribeTicks = vi.fn();
  const unsubscribeExit = vi.fn();
  const switchProfile = vi.fn<(deviceId: string, profile: string, page?: number) => Promise<void>>(async () => {});
  const logger = fakeLogger();

  const reactor = createSessionProfileReactor({
    getSessionKind: () => state.kind,
    getRawSessionType: () => state.rawType,
    subscribeTicks: (listener) => {
      onTick = listener;

      return unsubscribeTicks;
    },
    onSimTerminated: (listener) => {
      onExit = listener;

      return unsubscribeExit;
    },
    getSettings: () => state.settings,
    listDecks: () => state.decks,
    availableProfiles: (type) => AVAILABLE[type] ?? [],
    getCurrentProfile: (deviceId) => state.current.get(deviceId),
    switchProfile,
    logger: logger as unknown as ILogger,
  });

  reactor.start();

  return {
    state,
    reactor,
    switchProfile,
    logger,
    unsubscribeTicks,
    unsubscribeExit,
    tick: async (times = 1) => {
      for (let i = 0; i < times; i++) onTick?.();

      await settle();
    },
    exit: async () => {
      onExit?.();
      await settle();
    },
  };
}

describe("resolveProfileForKind", () => {
  const settings = settingsWith();

  it("returns the display name mapped to the kind", () => {
    expect(resolveProfileForKind("practice", settings)).toBe("iRaceDeck Practice");
    expect(resolveProfileForKind("race", settings)).toBe("iRaceDeck Race");
  });

  it("returns undefined for a row set to not change the profile", () => {
    expect(resolveProfileForKind("test", settings)).toBeUndefined();
    expect(resolveProfileForKind("replay", settings)).toBeUndefined();
  });

  it("returns undefined for no kind or a kind no row exists for", () => {
    expect(resolveProfileForKind(null, settings)).toBeUndefined();
    expect(resolveProfileForKind(undefined, settings)).toBeUndefined();
    expect(resolveProfileForKind("garage", settings)).toBeUndefined();
    expect(resolveProfileForKind("toString", settings)).toBeUndefined();
  });

  it("returns undefined for a row holding something other than a string", () => {
    expect(resolveProfileForKind("race", { profileForSessionKindRace: 42 })).toBeUndefined();
    expect(resolveProfileForKind("race", {})).toBeUndefined();
  });
});

describe("createSessionProfileReactor", () => {
  it("does nothing until started, and subscribes to the ticks and the exit once", () => {
    const subscribeTicks = vi.fn(() => () => undefined);
    const onSimTerminated = vi.fn(() => () => undefined);
    const reactor = createSessionProfileReactor({
      getSessionKind: () => "race",
      subscribeTicks,
      onSimTerminated,
      getSettings: () => settingsWith(),
      listDecks: () => [SD],
      availableProfiles: () => [],
      getCurrentProfile: () => undefined,
      switchProfile: vi.fn(),
      logger: fakeLogger() as unknown as ILogger,
    });

    expect(subscribeTicks).not.toHaveBeenCalled();

    reactor.start();
    reactor.start();

    expect(subscribeTicks).toHaveBeenCalledOnce();
    expect(onSimTerminated).toHaveBeenCalledOnce();
  });

  it("acts on the first tick when started mid-session, landing on page 0", async () => {
    const h = harness({ kind: "practice" });

    await h.tick();

    expect(h.switchProfile).toHaveBeenCalledExactlyOnceWith("sd-1", "iRaceDeck Practice SD", 0);
  });

  it("switches again when the session's kind changes", async () => {
    const h = harness({ kind: "practice" });

    await h.tick();
    h.state.kind = "qualifying";
    await h.tick();

    expect(h.switchProfile.mock.calls).toEqual([
      ["sd-1", "iRaceDeck Practice SD", 0],
      ["sd-1", "iRaceDeck Qualifying SD", 0],
    ]);
  });

  it("does not switch again while the kind and its profile stay the same, so a manual switch is never fought", async () => {
    const h = harness({ kind: "race" });

    await h.tick(50);

    expect(h.switchProfile).toHaveBeenCalledOnce();
  });

  it("does nothing while the toggle is off, and applies at once when it is turned on", async () => {
    const h = harness({ kind: "race" });

    h.state.settings = settingsWith({ profileAutoSwitchEnabled: false });
    await h.tick(5);

    expect(h.switchProfile).not.toHaveBeenCalled();

    h.state.settings = settingsWith();
    await h.tick();

    expect(h.switchProfile).toHaveBeenCalledExactlyOnceWith("sd-1", "iRaceDeck Race SD", 0);
  });

  it("re-applies when the toggle is turned off and on again in the same session", async () => {
    const h = harness({ kind: "race" });

    await h.tick();
    h.state.settings = settingsWith({ profileAutoSwitchEnabled: false });
    await h.tick();
    h.state.settings = settingsWith();
    await h.tick();

    expect(h.switchProfile).toHaveBeenCalledTimes(2);
  });

  it("applies a mapping changed mid-session", async () => {
    const h = harness({ kind: "practice" });

    await h.tick();
    h.state.settings = settingsWith({ profileForSessionKindPractice: "iRaceDeck Race" });
    await h.tick();

    expect(h.switchProfile).toHaveBeenLastCalledWith("sd-1", "iRaceDeck Race SD", 0);
    expect(h.switchProfile).toHaveBeenCalledTimes(2);
  });

  it("switches nothing for a row set to not change the profile, and applies the row once it names one", async () => {
    const h = harness({ kind: "test" });

    await h.tick(3);

    expect(h.switchProfile).not.toHaveBeenCalled();

    h.state.settings = settingsWith({ profileForSessionKindTest: "iRaceDeck Practice" });
    await h.tick();

    expect(h.switchProfile).toHaveBeenCalledExactlyOnceWith("sd-1", "iRaceDeck Practice SD", 0);
  });

  it("switches nothing for a session with no kind, and names its type at debug once", async () => {
    const h = harness({ kind: null });

    h.state.rawType = "Heat Race";
    await h.tick(20);

    expect(h.switchProfile).not.toHaveBeenCalled();
    expect(h.logger.debug.mock.calls.filter(([line]) => String(line).includes("Heat Race"))).toHaveLength(1);
  });

  it("skips a deck without a variant of the profile and still switches the others", async () => {
    const h = harness({ kind: "race", decks: [MINI, SD] });

    await h.tick();

    expect(h.switchProfile).toHaveBeenCalledExactlyOnceWith("sd-1", "iRaceDeck Race SD", 0);
    expect(h.logger.debug).toHaveBeenCalledWith(expect.stringContaining("mini-1"));
  });

  it("switches every connected deck to its own variant, logging each switch at info", async () => {
    const h = harness({ kind: "qualifying", decks: [SD, XL] });

    await h.tick();

    expect(h.switchProfile.mock.calls).toEqual([
      ["sd-1", "iRaceDeck Qualifying SD", 0],
      ["xl-1", "iRaceDeck Qualifying XL", 0],
    ]);
    expect(h.logger.info.mock.calls.filter(([line]) => line === "Deck switched to the session's profile")).toHaveLength(
      2,
    );
  });

  it("on exit returns only the decks it switched, to the profile they were on before the first switch", async () => {
    const h = harness({ kind: "practice", decks: [SD, MINI] });

    h.state.current.set("sd-1", "iRaceDeck Car Selector SD");
    h.state.current.set("mini-1", "iRaceDeck Default Mini");
    await h.tick();
    // The plugin's own history now says practice; the second switch must not overwrite the memory.
    h.state.current.set("sd-1", "iRaceDeck Practice SD");
    h.state.kind = "race";
    await h.tick();
    h.switchProfile.mockClear();

    await h.exit();

    expect(h.switchProfile).toHaveBeenCalledExactlyOnceWith("sd-1", "iRaceDeck Car Selector SD");
    expect(h.logger.info).toHaveBeenCalledWith("Deck returned to its profile from before the session");
  });

  it("on exit returns a deck to its bundled Default when its profile before the switch was unknown", async () => {
    const h = harness({ kind: "race", decks: [XL] });

    await h.tick();
    h.switchProfile.mockClear();
    await h.exit();

    expect(h.switchProfile).toHaveBeenCalledExactlyOnceWith("xl-1", "iRaceDeck Default XL");
  });

  it("does not return a deck that has disconnected since", async () => {
    const h = harness({ kind: "race", decks: [SD, XL] });

    await h.tick();
    h.state.decks = [XL];
    h.switchProfile.mockClear();
    await h.exit();

    expect(h.switchProfile).toHaveBeenCalledExactlyOnceWith("xl-1", "iRaceDeck Default XL");
  });

  it("does nothing on exit when it switched no deck", async () => {
    const h = harness({ kind: "test" });

    await h.tick();
    await h.exit();

    expect(h.switchProfile).not.toHaveBeenCalled();
  });

  it("switches again in the next session after an exit, even to the same kind", async () => {
    const h = harness({ kind: "race" });

    await h.tick();
    h.state.kind = null;
    await h.exit();
    h.state.current.set("sd-1", "iRaceDeck Default SD");
    h.switchProfile.mockClear();

    h.state.kind = "race";
    await h.tick();
    await h.exit();

    expect(h.switchProfile.mock.calls).toEqual([
      ["sd-1", "iRaceDeck Race SD", 0],
      ["sd-1", "iRaceDeck Default SD"],
    ]);
  });

  it("logs a rejected switch instead of throwing, still switches the other decks, and does not return the failed one", async () => {
    const h = harness({ kind: "race", decks: [SD, XL] });

    h.switchProfile.mockImplementation(async (deviceId) => {
      if (deviceId === "sd-1") throw new Error("SDK refused");
    });

    await expect(h.tick()).resolves.toBeUndefined();

    expect(h.switchProfile).toHaveBeenCalledWith("xl-1", "iRaceDeck Race XL", 0);
    expect(h.logger.error).toHaveBeenCalledWith(expect.stringContaining("SDK refused"));

    h.switchProfile.mockClear();
    await h.exit();

    expect(h.switchProfile).toHaveBeenCalledExactlyOnceWith("xl-1", "iRaceDeck Default XL");
  });

  it("logs a failure reading the session instead of throwing into the tick loop", async () => {
    const h = harness({ kind: "race" });

    h.state.settings = undefined as unknown as ProfileAutoSwitchSettings;
    await expect(h.tick()).resolves.toBeUndefined();

    expect(h.logger.error).toHaveBeenCalledOnce();
    expect(h.switchProfile).not.toHaveBeenCalled();
  });

  it("does not read the session while the toggle is off", async () => {
    const h = harness();
    let reads = 0;

    Object.defineProperty(h.state, "kind", {
      get: () => {
        reads++;

        return "practice";
      },
    });
    h.state.settings = settingsWith({ profileAutoSwitchEnabled: false });
    await h.tick(3);

    expect(reads).toBe(0);
    expect(h.switchProfile).not.toHaveBeenCalled();
  });

  it("stops a switch still in flight once a newer mapping has been acted on", async () => {
    const h = harness({ kind: "practice", decks: [SD, XL] });
    let releaseFirst: (() => void) | undefined;

    h.switchProfile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    await h.tick();
    h.state.settings = settingsWith({ profileForSessionKindPractice: "iRaceDeck Race" });
    await h.tick();
    releaseFirst?.();
    await h.tick();

    expect(h.switchProfile.mock.calls).toEqual([
      ["sd-1", "iRaceDeck Practice SD", 0],
      ["sd-1", "iRaceDeck Race SD", 0],
      ["xl-1", "iRaceDeck Race XL", 0],
    ]);
  });

  it("stops listening when stopped", async () => {
    const h = harness({ kind: "race" });

    h.reactor.stop();

    expect(h.unsubscribeTicks).toHaveBeenCalledOnce();
    expect(h.unsubscribeExit).toHaveBeenCalledOnce();
  });
});
