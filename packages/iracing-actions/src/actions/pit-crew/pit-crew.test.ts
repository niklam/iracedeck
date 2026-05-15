import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Imports appear above the `vi.mock(...)` blocks because the repo-wide
// prettier config (@elgato/prettier-config + @trivago/prettier-plugin-sort-imports)
// hoists every import to the top and won't leave them interleaved with other
// statements. Vitest transforms `vi.mock(...)` to run before any import at
// module init, so the mocks still apply to the action import below.
import {
  _setLastTelemetryConnectedForTests,
  _setRaceEngineerTestInFlightForTests,
  _setRaceEngineerToggleInFlightForTests,
  applyRaceEngineerAudio,
  applyRadarEnabled,
  applyRadarVolume,
  generatePitCrewSvg,
  PIT_CREW_UUID,
  PitCrew,
  playVoiceSequence,
  Settings,
} from "./pit-crew.js";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────
//
// Pit Crew is a multi-mode action (#413): Race Engineer (voice toggle),
// Radar (proximity-tick toggle), Radar Volume +/−. Race Engineer voice
// scenarios are deferred to follow-up PRs (#410) — the Race Engineer mode
// here just flips a global flag; no audio is attached yet.

const hoisted = vi.hoisted(() => {
  const setBusVolume = vi.fn();
  const playOnChannel = vi.fn<(...args: unknown[]) => boolean>().mockReturnValue(true);
  const onChannelComplete = vi.fn();
  const getAudio = vi.fn(() => ({ setBusVolume, playOnChannel, onChannelComplete }));

  const setRadarEnabled = vi.fn();
  const playRadarTest = vi.fn();
  const playBackgroundTest = vi.fn();
  const isBackgroundTestInFlight = vi.fn(() => false);

  let globalSettings: Record<string, unknown> = {};
  const updateGlobalSettings = vi.fn((partial: Record<string, unknown>) => {
    globalSettings = { ...globalSettings, ...partial };
  });
  const getGlobalSettings = vi.fn(() => globalSettings);
  const globalSettingsListeners = new Set<() => void>();
  const onGlobalSettingsChange = vi.fn((listener: () => void) => {
    globalSettingsListeners.add(listener);

    return () => {
      globalSettingsListeners.delete(listener);
    };
  });

  // Shared SDK controller mock — every PitCrew instance built by the
  // MockConnectionStateAwareAction class field points at these functions
  // (one shared subscriber map, one shared connection state). That lets
  // a test instantiate two actions, observe both subscriptions in the
  // same map, then fire a "tick" via `fireAllSdkTicks()` to drive the
  // radio-check dedup logic across instances. Default state is
  // `connected=true` so every existing pre-#554 test that doesn't care
  // about the SDK behaves the same as before.
  const sdkSubscribers = new Map<string, () => void>();
  let sdkConnected = true;
  const sdkSubscribe = vi.fn((id: string, cb: () => void) => {
    sdkSubscribers.set(id, cb);
  });
  const sdkUnsubscribe = vi.fn((id: string) => {
    sdkSubscribers.delete(id);
  });
  const sdkGetConnectionStatus = vi.fn(() => sdkConnected);

  return {
    setBusVolume,
    playOnChannel,
    onChannelComplete,
    getAudio,
    setRadarEnabled,
    playRadarTest,
    playBackgroundTest,
    isBackgroundTestInFlight,
    updateGlobalSettings,
    getGlobalSettings,
    globalSettingsListeners,
    onGlobalSettingsChange,
    setGlobalSettings: (next: Record<string, unknown>) => {
      globalSettings = next;
    },
    sdkSubscribers,
    sdkSubscribe,
    sdkUnsubscribe,
    sdkGetConnectionStatus,
    setSdkConnected: (val: boolean) => {
      sdkConnected = val;
    },
    fireAllSdkTicks: (): void => {
      for (const cb of sdkSubscribers.values()) {
        cb();
      }
    },
    resetSdk: (): void => {
      sdkSubscribers.clear();
      sdkConnected = true;
    },
  };
});

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock("../../../icons/pit-crew.svg", () => ({
  default:
    '<svg xmlns="http://www.w3.org/2000/svg"><desc>{"colors":{"backgroundColor":"#2c3e50","textColor":"#ffffff","graphic1Color":"#ffffff"}}</desc>{{iconContent}}</svg>',
}));

vi.mock("../../icons/status-bar.js", () => ({
  borderColorForState: vi.fn((state: string) => (state === "on" ? "#2ecc71" : "#e74c3c")),
  statusBarOn: vi.fn(() => '<rect class="status-bar-on"/>'),
  statusBarOff: vi.fn(() => '<rect class="status-bar-off"/>'),
}));

vi.mock("@iracedeck/audio-scenarios/pit-crew", () => ({
  isBackgroundTestInFlight: hoisted.isBackgroundTestInFlight,
  playBackgroundTest: hoisted.playBackgroundTest,
  playRadarTest: hoisted.playRadarTest,
  setRadarEnabled: hoisted.setRadarEnabled,
}));

vi.mock("@iracedeck/audio-service", () => ({
  AudioBus: { Voice: 0, Background: 1, Alerts: 2 },
  AudioChannel: { Ambient: 0, SFX: 1, Voice: 2, Radar: 3 },
  getAudio: hoisted.getAudio,
}));

// `resolveActiveRaceEngineerVoice` / `resolveActiveDriverName` are imported
// at module load time by pit-crew.ts. The toggle-ack and voice-test paths
// call them; every other path doesn't. Hoisted-by-default to `null` (no
// voice available) so the existing tests' "no _raceEngineerVoices set"
// shape continues to skip the ack as it did before issue #554. Individual
// tests override via `hoisted.resolveActiveRaceEngineerVoice.mockReturnValueOnce(...)`.
const voiceResolvers = vi.hoisted(() => ({
  resolveActiveRaceEngineerVoice: vi.fn<(voices: readonly string[]) => string | null>(() => null),
  resolveActiveDriverName: vi.fn<(names: readonly string[], def?: string) => string | null>(() => null),
}));

vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  const CommonSettings = z.object({
    colorOverrides: z.unknown().optional(),
    titleOverrides: z.unknown().optional(),
    borderOverrides: z.unknown().optional(),
    graphicOverrides: z.unknown().optional(),
  });

  class MockConnectionStateAwareAction {
    logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    sdkController = {
      subscribe: hoisted.sdkSubscribe,
      unsubscribe: hoisted.sdkUnsubscribe,
      getConnectionStatus: hoisted.sdkGetConnectionStatus,
    };
    updateConnectionState = vi.fn();
    setKeyImage = vi.fn().mockResolvedValue(undefined);
    updateKeyImage = vi.fn().mockResolvedValue(true);
    setRegenerateCallback = vi.fn();
    async onWillAppear(): Promise<void> {}
    async onWillDisappear(): Promise<void> {}
    async onDidReceiveSettings(): Promise<void> {}
  }

  return {
    CommonSettings,
    ConnectionStateAwareAction: MockConnectionStateAwareAction,
    applyGraphicTransform: vi.fn((content: string) => content),
    computeGraphicArea: vi.fn(() => ({ x: 8, y: 8, width: 128, height: 84 })),
    generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
    generateTitleText: vi.fn((opts: { text: string; fill: string }) =>
      opts.text ? `<text fill="${opts.fill}">${opts.text}</text>` : "",
    ),
    getGlobalBorderSettings: vi.fn(() => ({})),
    getGlobalColors: vi.fn(() => ({})),
    getGlobalGraphicSettings: vi.fn(() => ({})),
    getGlobalSettings: hoisted.getGlobalSettings,
    getGlobalTitleSettings: vi.fn(() => ({})),
    onGlobalSettingsChange: hoisted.onGlobalSettingsChange,
    renderIconTemplate: vi.fn((template: string, data: Record<string, string>) => {
      let result = template;

      for (const [key, val] of Object.entries(data)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), val);
      }

      return result;
    }),
    resolveBorderSettings: vi.fn(() => ({
      enabled: false,
      borderWidth: 7,
      borderColor: "#00aaff",
      glowEnabled: false,
      glowWidth: 18,
    })),
    resolveGraphicSettings: vi.fn(() => ({ scale: 1 })),
    resolveIconColors: vi.fn(() => ({
      backgroundColor: "#2c3e50",
      textColor: "#ffffff",
      graphic1Color: "#ffffff",
    })),
    resolveActiveDriverName: voiceResolvers.resolveActiveDriverName,
    resolveActiveRaceEngineerVoice: voiceResolvers.resolveActiveRaceEngineerVoice,
    resolveTitleSettings: vi.fn((_t: string, _g: unknown, _o: unknown, defaultText: string) => ({
      showTitle: true,
      showGraphics: true,
      titleText: defaultText,
      bold: true,
      fontSize: 18,
      position: "bottom" as const,
      customPosition: 0,
    })),
    svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
    updateGlobalSettings: hoisted.updateGlobalSettings,
  };
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

type TestInputs = {
  mode?: "race-engineer" | "radar" | "radar-volume";
  direction?: "up" | "down";
  /** `_testRadarVolume` arrives from the PI as `String(Date.now())` — tests
   *  accept both to exercise the coercion path. */
  _testRadarVolume?: number | string;
  /** Same shape for the engineer-voice and Background Volume Test buttons. */
  _testRaceEngineerVoice?: number | string;
  _testBackgroundVolume?: number | string;
};

function buildAppearEvent(settings: TestInputs = {}, actionId = "ctx-1"): unknown {
  return {
    action: { id: actionId },
    payload: { settings },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // `mockReturnValue` persists across `clearAllMocks` (vitest only resets
  // call/result history, not implementation overrides). Restore the
  // "playOnChannel succeeds by default" baseline that the hoisted setup
  // intends, otherwise a previous test that forced false to exercise the
  // missing-clip path poisons every test that mounts the action.
  hoisted.playOnChannel.mockReturnValue(true);
  hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, pitCrewRadarEnabled: true, radarVolume: 100 });
  hoisted.globalSettingsListeners.clear();
  hoisted.resetSdk();
  // Reset module-scope in-flight flags so a test that triggers the
  // toggle-ack or voice-test path (where the mocked playOnChannel returns
  // true and the channel-complete callback never fires in-test) doesn't
  // leak `raceEngineerToggleInFlight === true` into the next test and
  // keep `applyRaceEngineerAudio` from muting Voice when it should.
  _setRaceEngineerTestInFlightForTests(false);
  _setRaceEngineerToggleInFlightForTests(false);
  // Cold start for the telemetry-connect tracker — every radio-check test
  // can rely on null → first true firing the ack (no prior observation).
  _setLastTelemetryConnectedForTests(null);
});

describe("PIT_CREW_UUID", () => {
  it("has the correct action UUID", () => {
    expect(PIT_CREW_UUID).toBe("com.iracedeck.sd.core.pit-crew");
  });
});

describe("Settings (persisted legacy field stripping)", () => {
  it("defaults mode to race-engineer and direction to up", () => {
    const parsed = Settings.parse({});

    expect(parsed.mode).toBe("race-engineer");
    expect(parsed.direction).toBe("up");
  });

  it("still accepts persisted race-engineer mode for backward compat", () => {
    const parsed = Settings.parse({ mode: "race-engineer" });

    expect(parsed.mode).toBe("race-engineer");
  });

  it("silently drops pre-#413 action-level fields via Zod's default strip mode", () => {
    const raw = {
      mode: "radar" as const,
      direction: "down" as const,
      pitCrewRadarEnabled: true,
      radarVolume: 75,
      pitEngineerEnabled: true,
      spotterEnabled: true,
      spotterVolume: 50,
      volume: 45,
      driverName: "niklas",
    };

    const parsed = Settings.parse(raw) as Record<string, unknown>;

    expect(parsed.mode).toBe("radar");
    expect(parsed.direction).toBe("down");

    for (const legacy of [
      "pitCrewRadarEnabled",
      "radarVolume",
      "pitEngineerEnabled",
      "spotterEnabled",
      "spotterVolume",
      "volume",
      "driverName",
    ]) {
      expect(parsed).not.toHaveProperty(legacy);
    }
  });
});

describe("applyRadarVolume", () => {
  it("copies the global radarVolume onto AudioBus.Alerts", () => {
    hoisted.setGlobalSettings({ radarVolume: 50 });
    applyRadarVolume();

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.5);
  });

  it("defaults to 100% when the global value is missing", () => {
    hoisted.setGlobalSettings({});
    applyRadarVolume();

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 1);
  });

  it("clamps out-of-range persisted values", () => {
    hoisted.setGlobalSettings({ radarVolume: 250 });
    applyRadarVolume();

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 1);
  });
});

describe("applyRadarEnabled", () => {
  it("pushes the current global pitCrewRadarEnabled into the engine", () => {
    hoisted.setGlobalSettings({ pitCrewRadarEnabled: false });
    applyRadarEnabled();
    expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(false);

    vi.clearAllMocks();
    hoisted.setGlobalSettings({ pitCrewRadarEnabled: true });
    applyRadarEnabled();
    expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(true);
  });
});

describe("applyRaceEngineerAudio", () => {
  it("copies raceEngineerVolume onto AudioBus.Voice and Background defaults to 100% when enabled", () => {
    hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 60 });
    applyRaceEngineerAudio();

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.6);
    expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 1);
  });

  it("zeroes both Voice and Background when disabled, regardless of raceEngineerVolume", () => {
    hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, raceEngineerVolume: 90 });
    applyRaceEngineerAudio();

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0);
    expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0);
  });

  it("never touches AudioBus.Alerts (radar has its own gate)", () => {
    hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, raceEngineerVolume: 75 });
    applyRaceEngineerAudio();

    const alertsCalls = hoisted.setBusVolume.mock.calls.filter(([bus]) => bus === 2);
    expect(alertsCalls).toHaveLength(0);
  });

  it("defaults raceEngineerVolume to 100% when the global is missing", () => {
    hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });
    applyRaceEngineerAudio();

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 1);
  });

  it("copies backgroundVolume onto AudioBus.Background when enabled (#471)", () => {
    hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 100, backgroundVolume: 40 });
    applyRaceEngineerAudio();

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0.4);
  });

  it("zeroes Background when Race Engineer is disabled, regardless of backgroundVolume (#471)", () => {
    hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, backgroundVolume: 80 });
    applyRaceEngineerAudio();

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0);
  });

  it("falls back to 100% when backgroundVolume is missing from the live settings cache (#471)", () => {
    // The Zod schema default is 25 (so a fresh install starts at 25 — issue
    // #522), but readBackgroundVolume's defensive runtime fallback is
    // VOLUME_MAX so an unparsed/empty cache during very early startup
    // doesn't accidentally mute the bus. Same shape as
    // readRaceEngineerVolume / readRadarVolume.
    hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });
    applyRaceEngineerAudio();

    expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 1);
  });

  it("keeps Background at backgroundVolume/100 while a Background test is in flight, even with RE off (#471)", () => {
    hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, backgroundVolume: 60 });
    hoisted.isBackgroundTestInFlight.mockReturnValueOnce(true);

    applyRaceEngineerAudio();

    // Without the bypass, RE-off would push Background to 0 mid-preview
    // when the global-settings listener fires (e.g. user dragging the
    // Background slider). The in-flight signal keeps the bus tracking the
    // slider value so the preview stays audible and live-updates.
    expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0.6);
  });

  it("keeps Voice at raceEngineerVolume/100 while a Race Engineer test is in flight, even with RE off (#471)", () => {
    hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, raceEngineerVolume: 70 });
    _setRaceEngineerTestInFlightForTests(true);

    try {
      applyRaceEngineerAudio();
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.7);
    } finally {
      _setRaceEngineerTestInFlightForTests(false);
    }
  });

  it("keeps Voice audible at raceEngineerVolume/100 while a toggle ack is in flight, even with RE off (#554)", () => {
    // Toggling off plays "going silent" on Voice after the gate flips to
    // false. The flag bypass keeps Voice audible just for the duration of
    // the ack — Background still mutes immediately because only Voice has
    // the bypass.
    hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, raceEngineerVolume: 70, backgroundVolume: 80 });
    _setRaceEngineerToggleInFlightForTests(true);

    try {
      applyRaceEngineerAudio();
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.7);
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0);
    } finally {
      _setRaceEngineerToggleInFlightForTests(false);
    }
  });
});

describe("playVoiceSequence", () => {
  it("fires onComplete after the chain ends naturally", () => {
    const onComplete = vi.fn();
    hoisted.playOnChannel.mockReturnValue(true);

    expect(playVoiceSequence(["a.mp3", "b.mp3"], onComplete)).toBe(true);

    // Simulate native engine firing channel-complete after each clip.
    // Each step registers the NEXT step's callback before playing, so we
    // pull the latest registration after each invocation.
    const fireLastRegistered = (): void => {
      const calls = hoisted.onChannelComplete.mock.calls;
      const cb = calls[calls.length - 1][1] as () => void;
      cb();
    };

    fireLastRegistered(); // first clip ends → playStep runs second clip
    fireLastRegistered(); // second clip ends → playStep hits idx>=length, fires onComplete

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("fires onComplete and stops chaining when playOnChannel returns false mid-sequence (#471)", () => {
    // CodeRabbit-flagged scenario: a missing clip mid-chain would otherwise
    // leave raceEngineerTestInFlight stuck true forever (the native callback
    // never fires for a failed play, so the chain hangs).
    const onComplete = vi.fn();
    hoisted.playOnChannel
      .mockReturnValueOnce(true) // first clip plays
      .mockReturnValueOnce(false); // second clip fails

    expect(playVoiceSequence(["a.mp3", "b.mp3"], onComplete)).toBe(true);

    // Simulate native engine firing channel-complete for the first clip.
    const completionCallbacks = hoisted.onChannelComplete.mock.calls.map(([, cb]) => cb as () => void);
    completionCallbacks[0]();

    // The second clip's playOnChannel returned false; onComplete must fire
    // synchronously so any in-flight flag the caller is tracking gets cleared.
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("does not fire onComplete a second time if a stale playStep callback is re-entered (#471)", () => {
    // CodeRabbit follow-up: after a mid-chain failure we still left the
    // `onChannelComplete(playStep)` registration live in the audio service.
    // If a later, unrelated Voice clip plays through the engine, the engine
    // re-fires playStep — which would either resume the abandoned sequence
    // or fire onComplete a second time. The `finished` guard makes playStep
    // idempotent.
    const onComplete = vi.fn();
    hoisted.playOnChannel.mockReturnValueOnce(true).mockReturnValueOnce(false);

    playVoiceSequence(["a.mp3", "b.mp3"], onComplete);

    // First registration happens at this point (before first clip plays).
    const firstCb = hoisted.onChannelComplete.mock.calls[0][1] as () => void;

    // First clip ends → playStep tries clip 2, which fails → onComplete fires once
    // (and a SECOND registration happens just before the failed play).
    firstCb();
    expect(onComplete).toHaveBeenCalledTimes(1);

    // Simulate the stale re-entry: the second registration is fired later by
    // the engine when some unrelated Voice clip completes. The `finished`
    // guard must make this a no-op — onComplete must NOT fire again.
    const staleCb = hoisted.onChannelComplete.mock.calls[1][1] as () => void;
    staleCb();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("PitCrew action", () => {
  describe("onWillAppear", () => {
    it("subscribes to global-settings changes so icons re-render on any feature flip", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);

      expect(hoisted.onGlobalSettingsChange).toHaveBeenCalledTimes(1);
    });

    it("asserts current global radar state into the engine + audio bus on mount", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, pitCrewRadarEnabled: true, radarVolume: 40 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.4);
      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(true);
    });
  });

  describe("onDidReceiveSettings", () => {
    it("invokes playRadarTest when the hidden _testRadarVolume timestamp changes", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ _testRadarVolume: 0 }) as never);

      await action.onDidReceiveSettings(buildAppearEvent({ _testRadarVolume: 7 }) as never);

      expect(hoisted.playRadarTest).toHaveBeenCalledTimes(1);
    });

    it("does not re-fire on unrelated settings echoes", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ _testRadarVolume: 100 }) as never);

      await action.onDidReceiveSettings(buildAppearEvent({ _testRadarVolume: 100 }) as never);

      expect(hoisted.playRadarTest).not.toHaveBeenCalled();
    });

    it("tracks the test baseline per context so two instances don't interfere", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ _testRadarVolume: 100 }, "ctx-A") as never);
      await action.onWillAppear(buildAppearEvent({ _testRadarVolume: 200 }, "ctx-B") as never);
      vi.clearAllMocks();

      await action.onDidReceiveSettings(buildAppearEvent({ _testRadarVolume: 100 }, "ctx-A") as never);
      expect(hoisted.playRadarTest).not.toHaveBeenCalled();

      await action.onDidReceiveSettings(buildAppearEvent({ _testRadarVolume: 999 }, "ctx-A") as never);
      expect(hoisted.playRadarTest).toHaveBeenCalledTimes(1);
    });

    it("coerces the string _testRadarVolume from the PI before comparing (no spurious replays)", async () => {
      // `pit-crew.ejs` writes `String(Date.now())`, so the SDK round-trip
      // delivers a string payload. Without coercion, every PI rehydrate
      // would `"1710..." !== 1710...` and spuriously replay.
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ _testRadarVolume: "1710000000000" }) as never);

      // Same timestamp, now as a number — must NOT trigger another play.
      await action.onDidReceiveSettings(buildAppearEvent({ _testRadarVolume: 1710000000000 }) as never);
      expect(hoisted.playRadarTest).not.toHaveBeenCalled();

      // Different timestamp string — must trigger.
      await action.onDidReceiveSettings(buildAppearEvent({ _testRadarVolume: "1710000000500" }) as never);
      expect(hoisted.playRadarTest).toHaveBeenCalledTimes(1);
    });

    it("invokes playBackgroundTest when _testBackgroundVolume timestamp changes (#471)", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, backgroundVolume: 70 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ _testBackgroundVolume: 0 }) as never);
      vi.clearAllMocks();

      await action.onDidReceiveSettings(buildAppearEvent({ _testBackgroundVolume: 42 }) as never);

      expect(hoisted.playBackgroundTest).toHaveBeenCalledTimes(1);
      // Background bus is forced to backgroundVolume/100 so the preview is
      // audible even when the Race Engineer master gate would otherwise
      // hold it at 0.
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0.7);
    });

    it("does not re-fire playBackgroundTest on unrelated settings echoes (#471)", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ _testBackgroundVolume: 100 }) as never);
      vi.clearAllMocks();

      await action.onDidReceiveSettings(buildAppearEvent({ _testBackgroundVolume: 100 }) as never);

      expect(hoisted.playBackgroundTest).not.toHaveBeenCalled();
    });

    it("restores the Race Engineer audio gate after the background test completes (#471)", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, backgroundVolume: 80 });
      hoisted.playBackgroundTest.mockImplementation((onComplete?: () => void) => {
        onComplete?.();
      });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ _testBackgroundVolume: 0 }) as never);
      vi.clearAllMocks();

      await action.onDidReceiveSettings(buildAppearEvent({ _testBackgroundVolume: 1 }) as never);

      // The forced-audible push (backgroundVolume/100) plus the post-test
      // applyRaceEngineerAudio() restore (Voice=0, Background=0 because
      // Race Engineer is off) must both have run.
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0.8);
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0);
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0);
    });
  });

  describe("global-settings listener re-syncs live audio", () => {
    it("pushes radarVolume + pitCrewRadarEnabled into the audio layer when any global changes (not just on re-mount)", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);
      vi.clearAllMocks();

      // Simulate another Pit Crew instance (or the PI's global slider) writing
      // a new radarVolume + pitCrewRadarEnabled.
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, pitCrewRadarEnabled: false, radarVolume: 25 });

      for (const listener of hoisted.globalSettingsListeners) listener();

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.25);
      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(false);
    });

    it("pushes a backgroundVolume change onto AudioBus.Background live (#471)", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 100, backgroundVolume: 100 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);
      vi.clearAllMocks();

      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 100, backgroundVolume: 30 });

      for (const listener of hoisted.globalSettingsListeners) listener();

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0.3);
    });
  });

  describe("onKeyDown — race-engineer mode", () => {
    it("toggles pitCrewRaceEngineerEnabled without touching radar state", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRaceEngineerEnabled: false });
      expect(hoisted.setRadarEnabled).not.toHaveBeenCalled();
    });

    it("flips back on when already off", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, pitCrewRadarEnabled: true, radarVolume: 100 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRaceEngineerEnabled: true });
    });

    it("does not touch pitCrewRadarEnabled when toggling race engineer (independent feature gates)", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      const updates = hoisted.updateGlobalSettings.mock.calls.flatMap(([partial]) => Object.keys(partial));
      expect(updates).not.toContain("pitCrewRadarEnabled");
      expect(updates).not.toContain("radarVolume");
    });

    it("synchronously silences Voice and Background buses when disabling (#457)", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 80, radarVolume: 100 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0);
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0);
    });

    it("leaves AudioBus.Alerts (radar) audible when Race Engineer is disabled (#457)", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 80, radarVolume: 75 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      // The toggle must not zero the radar bus. `applyRadarVolume` is
      // unrelated and is not called from `toggleRaceEngineer`, so no
      // Alerts-bus write is expected on this code path.
      const alertsCalls = hoisted.setBusVolume.mock.calls.filter(([bus]) => bus === 2);
      expect(alertsCalls).toHaveLength(0);
    });

    it("restores Voice volume and unmutes Background when re-enabling (#457)", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, raceEngineerVolume: 65, radarVolume: 100 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.65);
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 1);
    });
  });

  describe("onKeyDown — race-engineer toggle acknowledgement (#554)", () => {
    function setVoice(voice: string | null): void {
      voiceResolvers.resolveActiveRaceEngineerVoice.mockReturnValue(voice);
    }

    afterEach(() => {
      // Reset to the hoisted default (no voice available) so other tests
      // in the file keep their pre-#554 "ack is a no-op" baseline.
      voiceResolvers.resolveActiveRaceEngineerVoice.mockReturnValue(null);
    });

    it("plays going-silent-01 on the Voice channel when toggling off (default opt-in is on)", async () => {
      setVoice("default");
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 80 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      expect(hoisted.playOnChannel).toHaveBeenCalledWith(2, "voice/default/toggle/going-silent-01.mp3");
      // Voice forced to slider value so the ack is audible regardless of
      // the master gate having just flipped off.
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.8);
    });

    it("plays resuming-01 on the Voice channel when toggling on (default opt-in is on)", async () => {
      setVoice("default");
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, raceEngineerVolume: 65 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      expect(hoisted.playOnChannel).toHaveBeenCalledWith(2, "voice/default/toggle/resuming-01.mp3");
    });

    it("respects the active voice selection for the clip path", async () => {
      setVoice("luca");
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 50 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      expect(hoisted.playOnChannel).toHaveBeenCalledWith(2, "voice/luca/toggle/going-silent-01.mp3");
    });

    it("skips the ack silently when no voice is available but still flips the gate", async () => {
      setVoice(null);
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 80 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      // Gate still flips (Voice + Background mute) so the toggle is honored.
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRaceEngineerEnabled: false });
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0);
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(1, 0);
      // …but no ack clip is played.
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("does not play the ack when calloutEnabledToggleRaceEngineer is false", async () => {
      setVoice("default");
      hoisted.setGlobalSettings({
        pitCrewRaceEngineerEnabled: true,
        raceEngineerVolume: 80,
        calloutEnabledToggleRaceEngineer: false,
      });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      // Gate flips, audio mutes — but no ack clip plays.
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRaceEngineerEnabled: false });
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0);
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("still plays the ack when the setting is explicitly true (parity with default)", async () => {
      setVoice("default");
      hoisted.setGlobalSettings({
        pitCrewRaceEngineerEnabled: false,
        raceEngineerVolume: 60,
        calloutEnabledToggleRaceEngineer: true,
      });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      expect(hoisted.playOnChannel).toHaveBeenCalledWith(2, "voice/default/toggle/resuming-01.mp3");
    });

    it("clears the in-flight flag and re-applies audio when the ack clip finishes (RE off → Voice mutes after the ack)", async () => {
      setVoice("default");
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 80 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      // While the clip is playing the bypass kept Voice at the slider value.
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0.8);

      // Simulate the native engine firing channel-complete; the
      // playVoiceSequence onComplete clears the toggle flag and re-applies
      // audio — and because the gate is now off, Voice mutes to 0.
      const lastCompletionCb = hoisted.onChannelComplete.mock.calls.at(-1)?.[1] as () => void;
      vi.clearAllMocks();
      lastCompletionCb();

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(0, 0);
    });

    it("clears the flag synchronously when the ack clip fails to start (no native callback would ever fire)", async () => {
      setVoice("default");
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, raceEngineerVolume: 80 });
      hoisted.playOnChannel.mockReturnValue(false); // ack clip missing
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "race-engineer" }) as never);
      vi.clearAllMocks();
      hoisted.playOnChannel.mockReturnValue(false);

      await action.onKeyDown(buildAppearEvent({ mode: "race-engineer" }) as never);

      // playVoiceSequence fires onComplete synchronously on a missing-clip
      // failure → flag cleared → applyRaceEngineerAudio runs → Voice = 0.
      // The final setBusVolume call for the Voice bus must be 0, not 0.8.
      const voiceCalls = hoisted.setBusVolume.mock.calls.filter(([bus]) => bus === 0);
      expect(voiceCalls.at(-1)).toEqual([0, 0]);
    });
  });

  describe("telemetry-connect radio check (#554 follow-up)", () => {
    function setVoice(voice: string | null): void {
      voiceResolvers.resolveActiveRaceEngineerVoice.mockReturnValue(voice);
    }

    function setName(name: string | null): void {
      voiceResolvers.resolveActiveDriverName.mockReturnValue(name);
    }

    afterEach(() => {
      voiceResolvers.resolveActiveRaceEngineerVoice.mockReturnValue(null);
      voiceResolvers.resolveActiveDriverName.mockReturnValue(null);
    });

    it("plays the name + radio-check sequence on the first false→true tick when both gates allow", async () => {
      setVoice("default");
      setName("niklas");
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });
      hoisted.setSdkConnected(false);

      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);
      vi.clearAllMocks();

      // Tick 1 — still disconnected, no fire.
      hoisted.fireAllSdkTicks();
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();

      // Tick 2 — connected (first false → true), should fire.
      hoisted.setSdkConnected(true);
      hoisted.fireAllSdkTicks();

      // First clip in the sequence — playVoiceSequence plays the second
      // clip on the channel-complete callback, which we don't simulate here.
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(2, "voice/default/names/niklas.mp3");
    });

    it("plays the full name → radio-check chain when the channel-complete callback fires", async () => {
      setVoice("default");
      setName("niklas");
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });
      hoisted.setSdkConnected(true);

      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);
      vi.clearAllMocks();

      hoisted.fireAllSdkTicks();

      // First clip queued.
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(2, "voice/default/names/niklas.mp3");

      // Simulate the native engine firing channel-complete after the
      // name clip. The next playStep registration runs and queues the
      // radio-check clip.
      const firstCompletionCb = hoisted.onChannelComplete.mock.calls.at(-1)?.[1] as () => void;
      firstCompletionCb();

      expect(hoisted.playOnChannel).toHaveBeenCalledWith(2, "voice/default/toggle/radio-check-01.mp3");
    });

    it("does not fire again on subsequent connected ticks (module-level dedup)", async () => {
      setVoice("default");
      setName("niklas");
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });
      hoisted.setSdkConnected(true);

      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);
      vi.clearAllMocks();

      hoisted.fireAllSdkTicks(); // first true tick — fires
      const callsAfterFirstTick = hoisted.playOnChannel.mock.calls.length;
      hoisted.fireAllSdkTicks(); // second true tick — no-op
      hoisted.fireAllSdkTicks(); // third true tick — no-op

      expect(hoisted.playOnChannel.mock.calls.length).toBe(callsAfterFirstTick);
    });

    it("dedups across multiple Pit Crew instances — only the first observer fires", async () => {
      setVoice("default");
      setName("niklas");
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });
      hoisted.setSdkConnected(true);

      const a = new PitCrew();
      const b = new PitCrew();
      await a.onWillAppear(buildAppearEvent({}, "ctx-A") as never);
      await b.onWillAppear(buildAppearEvent({}, "ctx-B") as never);
      vi.clearAllMocks();

      // One tick — both subscribers receive the callback in turn. The
      // module-level `lastTelemetryConnected` flag flips on the first
      // observation, so the second observer's branch is a no-op.
      hoisted.fireAllSdkTicks();

      // First clip in the sequence is queued exactly once.
      const namePathCalls = hoisted.playOnChannel.mock.calls.filter(
        ([, path]) => path === "voice/default/names/niklas.mp3",
      );
      expect(namePathCalls).toHaveLength(1);
    });

    it("re-fires after a disconnect/reconnect (true→false→true)", async () => {
      setVoice("default");
      setName("niklas");
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });
      hoisted.setSdkConnected(true);

      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);
      vi.clearAllMocks();

      hoisted.fireAllSdkTicks(); // first connect → fires
      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);

      hoisted.setSdkConnected(false);
      hoisted.fireAllSdkTicks(); // disconnect tick — tracker flips back

      hoisted.setSdkConnected(true);
      vi.clearAllMocks();
      hoisted.fireAllSdkTicks(); // reconnect → fires again

      expect(hoisted.playOnChannel).toHaveBeenCalledWith(2, "voice/default/names/niklas.mp3");
    });

    it("skips when Race Engineer is disabled but still updates the tracker", async () => {
      setVoice("default");
      setName("niklas");
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false });
      hoisted.setSdkConnected(true);

      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);
      vi.clearAllMocks();

      hoisted.fireAllSdkTicks();
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();

      // Tracker still flipped — re-enabling RE without a real disconnect
      // doesn't retroactively fire the radio check.
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });
      hoisted.fireAllSdkTicks();
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("skips when the radio-check opt-in is disabled but still updates the tracker", async () => {
      setVoice("default");
      setName("niklas");
      hoisted.setGlobalSettings({
        pitCrewRaceEngineerEnabled: true,
        calloutEnabledTelemetryConnectRadioCheck: false,
      });
      hoisted.setSdkConnected(true);

      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);
      vi.clearAllMocks();

      hoisted.fireAllSdkTicks();
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("skips silently when no voice is available (fresh install)", async () => {
      setVoice(null);
      setName("niklas");
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });
      hoisted.setSdkConnected(true);

      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);
      vi.clearAllMocks();

      hoisted.fireAllSdkTicks();
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("skips silently when no driver name is available", async () => {
      setVoice("default");
      setName(null);
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });
      hoisted.setSdkConnected(true);

      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);
      vi.clearAllMocks();

      hoisted.fireAllSdkTicks();
      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("unsubscribes the radio-check listener on onWillDisappear", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({}, "ctx-disappear") as never);
      const sizeBeforeDisappear = hoisted.sdkSubscribers.size;

      await action.onWillDisappear(buildAppearEvent({}, "ctx-disappear") as never);

      expect(hoisted.sdkSubscribers.size).toBe(sizeBeforeDisappear - 1);
      expect(hoisted.sdkUnsubscribe).toHaveBeenCalledWith("pitCrewRadioCheck:ctx-disappear");
    });
  });

  describe("onKeyDown — radar mode", () => {
    it("flips pitCrewRadarEnabled synchronously via setRadarEnabled and updates the global", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "radar" }) as never);

      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(false);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRadarEnabled: false });
    });

    it("does not touch pitCrewRaceEngineerEnabled when toggling radar (independent feature gates)", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "radar" }) as never);

      const updates = hoisted.updateGlobalSettings.mock.calls.flatMap(([partial]) => Object.keys(partial));
      expect(updates).not.toContain("pitCrewRaceEngineerEnabled");
    });

    it("alternates pitCrewRadarEnabled across three consecutive presses without a host echo (#419)", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, pitCrewRadarEnabled: true, radarVolume: 100 });
      const action = new PitCrew();
      const event = buildAppearEvent({ mode: "radar" }) as never;
      await action.onWillAppear(event);

      // Press 1 — on → off
      await action.onKeyDown(event);
      expect(hoisted.updateGlobalSettings).toHaveBeenLastCalledWith({ pitCrewRadarEnabled: false });
      expect(hoisted.setRadarEnabled).toHaveBeenLastCalledWith(false);

      // Press 2 — off → on (the #419 bug: previously stayed at false)
      await action.onKeyDown(event);
      expect(hoisted.updateGlobalSettings).toHaveBeenLastCalledWith({ pitCrewRadarEnabled: true });
      expect(hoisted.setRadarEnabled).toHaveBeenLastCalledWith(true);

      // Press 3 — on → off
      await action.onKeyDown(event);
      expect(hoisted.updateGlobalSettings).toHaveBeenLastCalledWith({ pitCrewRadarEnabled: false });
      expect(hoisted.setRadarEnabled).toHaveBeenLastCalledWith(false);
    });
  });

  describe("onKeyDown — radar-volume mode", () => {
    it("steps radarVolume up by 5 on direction=up", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, pitCrewRadarEnabled: true, radarVolume: 70 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar-volume", direction: "up" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "radar-volume", direction: "up" }) as never);

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.75);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ radarVolume: 75 });
    });

    it("steps down by 5 on direction=down", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, pitCrewRadarEnabled: true, radarVolume: 70 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar-volume", direction: "down" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "radar-volume", direction: "down" }) as never);

      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0.65);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ radarVolume: 65 });
    });

    it("clamps at 100 (no-op when already at max)", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, pitCrewRadarEnabled: true, radarVolume: 100 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar-volume", direction: "up" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "radar-volume", direction: "up" }) as never);

      expect(hoisted.updateGlobalSettings).not.toHaveBeenCalled();
      expect(hoisted.setBusVolume).not.toHaveBeenCalled();
    });

    it("clamps at 0 (no-op when already at min)", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, pitCrewRadarEnabled: true, radarVolume: 0 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar-volume", direction: "down" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "radar-volume", direction: "down" }) as never);

      expect(hoisted.updateGlobalSettings).not.toHaveBeenCalled();
      expect(hoisted.setBusVolume).not.toHaveBeenCalled();
    });

    it("auto-repeat at upper boundary (5x onKeyDown at 100) is fully a no-op", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, pitCrewRadarEnabled: true, radarVolume: 100 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar-volume", direction: "up" }) as never);
      vi.clearAllMocks();

      for (let i = 0; i < 5; i += 1) {
        await action.onKeyDown(buildAppearEvent({ mode: "radar-volume", direction: "up" }) as never);
      }

      expect(hoisted.updateGlobalSettings).not.toHaveBeenCalled();
      expect(hoisted.setBusVolume).not.toHaveBeenCalled();
    });

    it("auto-repeat at lower boundary (5x onKeyDown at 0) is fully a no-op", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, pitCrewRadarEnabled: true, radarVolume: 0 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar-volume", direction: "down" }) as never);
      vi.clearAllMocks();

      for (let i = 0; i < 5; i += 1) {
        await action.onKeyDown(buildAppearEvent({ mode: "radar-volume", direction: "down" }) as never);
      }

      expect(hoisted.updateGlobalSettings).not.toHaveBeenCalled();
      expect(hoisted.setBusVolume).not.toHaveBeenCalled();
    });

    it("steps to 0 on direction=down when current volume is VOLUME_STEP", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, pitCrewRadarEnabled: true, radarVolume: 5 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent({ mode: "radar-volume", direction: "down" }) as never);
      vi.clearAllMocks();

      await action.onKeyDown(buildAppearEvent({ mode: "radar-volume", direction: "down" }) as never);

      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ radarVolume: 0 });
      expect(hoisted.setBusVolume).toHaveBeenCalledWith(2, 0);
    });
  });

  describe("independent feature gates (#413 core requirement)", () => {
    it("race-engineer off + radar on: radar tick loop still runs", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false, pitCrewRadarEnabled: true, radarVolume: 100 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);

      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(true);
    });

    it("race-engineer on + radar off: radar tick loop is silenced", async () => {
      hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true, pitCrewRadarEnabled: false, radarVolume: 100 });
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);

      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(false);
    });
  });

  describe("onWillDisappear", () => {
    it("unsubscribes the global-settings listener", async () => {
      const action = new PitCrew();
      await action.onWillAppear(buildAppearEvent() as never);
      const before = hoisted.globalSettingsListeners.size;
      expect(before).toBeGreaterThan(0);

      await action.onWillDisappear(buildAppearEvent() as never);

      expect(hoisted.globalSettingsListeners.size).toBe(before - 1);
    });
  });
});

describe("generatePitCrewSvg", () => {
  it("returns a data URI", () => {
    const result = generatePitCrewSvg(Settings.parse({ mode: "race-engineer" }));
    expect(result).toContain("data:image/svg+xml");
  });

  it("paints the status bar ON for race-engineer mode when pitCrewRaceEngineerEnabled is true", () => {
    hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });
    const result = decodeURIComponent(generatePitCrewSvg(Settings.parse({ mode: "race-engineer" })));
    expect(result).toContain("status-bar-on");
  });

  it("paints the status bar OFF for race-engineer mode when pitCrewRaceEngineerEnabled is false", () => {
    hoisted.setGlobalSettings({ pitCrewRaceEngineerEnabled: false });
    const result = decodeURIComponent(generatePitCrewSvg(Settings.parse({ mode: "race-engineer" })));
    expect(result).toContain("status-bar-off");
  });

  it("paints the status bar ON for radar mode when pitCrewRadarEnabled is true", () => {
    hoisted.setGlobalSettings({ pitCrewRadarEnabled: true });
    const result = decodeURIComponent(generatePitCrewSvg(Settings.parse({ mode: "radar" })));
    expect(result).toContain("status-bar-on");
  });

  it("paints the status bar OFF for radar mode when pitCrewRadarEnabled is false", () => {
    hoisted.setGlobalSettings({ pitCrewRadarEnabled: false });
    const result = decodeURIComponent(generatePitCrewSvg(Settings.parse({ mode: "radar" })));
    expect(result).toContain("status-bar-off");
  });

  it("omits the status bar entirely for radar-volume mode (no on/off state)", () => {
    const result = decodeURIComponent(generatePitCrewSvg(Settings.parse({ mode: "radar-volume", direction: "up" })));
    expect(result).not.toContain("status-bar-on");
    expect(result).not.toContain("status-bar-off");
  });

  it("includes the current radarVolume in the title for radar-volume mode", () => {
    hoisted.setGlobalSettings({ radarVolume: 65 });
    const result = decodeURIComponent(generatePitCrewSvg(Settings.parse({ mode: "radar-volume", direction: "up" })));
    expect(result).toContain("65%");
  });
});
