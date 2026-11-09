/**
 * ConnectionStateAwareAction over the REAL BaseAction and the REAL sim
 * presence: the disconnected look reaching the key image (#1599).
 * `connection-state-aware-action.test.ts` mocks BaseAction and the presence
 * signal, and `base-action.test.ts` stubs `showsDisconnected`, so this file is
 * the one place the halves run together — a change to any of them that breaks
 * how a key shows the look fails here. Presence arrives the way it does in the
 * plugin: the key appears, the sim's ticks go disconnected, and the look turns
 * on once the absent delay has passed.
 */
import { applyDisconnectedLook } from "@iracedeck/icon-composer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionStateAwareAction } from "./connection-state-aware-action.js";
import { createFakeSimConnection, type FakeSimConnection } from "./fake-sim-connection.test-support.js";
import { _resetSimConnection, initializeSimConnection, isSimAbsent } from "./sim-connection.js";
import type { IDeckActionContext, IDeckWillAppearEvent, IDeckWillDisappearEvent } from "./types.js";

const ABSENT_DELAY_MS = 1000;

const { mockGetGlobalSettings, settingsListeners } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn((): Record<string, unknown> => ({ showDisconnectedState: true })),
  settingsListeners: [] as Array<() => void>,
}));

vi.mock("./binding-dispatcher.js", () => ({
  getBindingDispatcher: () => ({
    tap: vi.fn().mockResolvedValue(true),
    hold: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    isConfigured: vi.fn(() => true),
    isKeyboardBound: vi.fn(() => true),
  }),
}));

vi.mock("@iracedeck/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/settings")>()),
  getGlobalSettings: mockGetGlobalSettings,
  onGlobalSettingsChange: vi.fn((listener: () => void) => {
    settingsListeners.push(listener);

    return () => {};
  }),
}));

type KeyEvent = IDeckWillAppearEvent<Record<string, unknown>>;

/** Audio Controls' shape: the Radar category steps the plugin's own bus and needs no sim; Master does. */
type Category = "radar" | "master";

function categoryNeedsSim(settings: unknown): boolean {
  return (settings as { category?: Category } | undefined)?.category !== "radar";
}

class AudioLikeAction extends ConnectionStateAwareAction {
  protected override needsSim(settings: unknown): boolean {
    return categoryNeedsSim(settings);
  }

  async showImage(ev: KeyEvent, svg: string): Promise<void> {
    await this.setKeyImage(ev, svg);
  }
}

/**
 * POSITIVE CONTROL ONLY — the shape #1599 removed, rebuilt as a stand-in: the
 * mode decision held in one field per action instance (as `lastReadyStatus`
 * and `activeBindingKeys` were), set by whichever key appeared last. One
 * instance serves every key of the action, so its keys cannot tell their
 * modes apart. The two-key test runs against it to prove the assertion it
 * makes on the real class would catch that bleed.
 */
class PerInstanceStandIn extends ConnectionStateAwareAction {
  private instanceNeedsSim = true;

  override async onWillAppear(ev: KeyEvent): Promise<void> {
    await super.onWillAppear(ev);
    this.instanceNeedsSim = categoryNeedsSim(ev.payload.settings);
  }

  protected override needsSim(): boolean {
    return this.instanceNeedsSim;
  }

  async showImage(ev: KeyEvent, svg: string): Promise<void> {
    await this.setKeyImage(ev, svg);
  }
}

function keyEvent(contextId: string, settings: Record<string, unknown> = {}): KeyEvent {
  const action: IDeckActionContext = {
    id: contextId,
    isKey: vi.fn(() => true),
    isDial: () => false,
    setImage: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
    setFeedback: vi.fn().mockResolvedValue(undefined),
    setFeedbackLayout: vi.fn().mockResolvedValue(undefined),
    setTriggerDescription: vi.fn().mockResolvedValue(undefined),
    dialCanvas: () => null,
    setDialCanvas: vi.fn().mockResolvedValue(undefined),
  };

  return { action, payload: { settings } } as KeyEvent;
}

function lastImage(ev: KeyEvent): unknown {
  return vi.mocked(ev.action.setImage).mock.lastCall?.[0];
}

const RADAR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect id="radar"/></svg>';
const MASTER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"><rect id="master"/></svg>';

describe("ConnectionStateAwareAction over the real BaseAction (#1599)", () => {
  let sim: FakeSimConnection;

  /** A key that has appeared on `action` with `settings` and shows `svg`. */
  async function shownKey(
    action: AudioLikeAction | PerInstanceStandIn,
    contextId: string,
    settings: Record<string, unknown>,
    svg: string,
  ): Promise<KeyEvent> {
    const ev = keyEvent(contextId, settings);

    await action.onWillAppear(ev);
    await action.showImage(ev, svg);

    return ev;
  }

  /** The sim goes away and stays away past the absent delay. */
  function simGone(): void {
    sim.state.connected = false;
    sim.tick();
    vi.advanceTimersByTime(ABSENT_DELAY_MS);
  }

  function simBack(): void {
    sim.state.connected = true;
    sim.tick();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    settingsListeners.length = 0;
    mockGetGlobalSettings.mockReturnValue({ showDisconnectedState: true });
    _resetSimConnection();
    sim = createFakeSimConnection();
    initializeSimConnection(sim.connection, { absentDelayMs: ABSENT_DELAY_MS });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("the look changes the image, so the assertions below can tell the two states apart", () => {
    expect(applyDisconnectedLook(MASTER_SVG)).not.toBe(MASTER_SVG);
  });

  it("decorates only the key whose mode needs the sim: Radar and Master keys of one action", async () => {
    const action = new AudioLikeAction();
    const radar = await shownKey(action, "ctx-radar", { category: "radar" }, RADAR_SVG);
    const master = await shownKey(action, "ctx-master", { category: "master" }, MASTER_SVG);

    simGone();

    expect(isSimAbsent()).toBe(true);
    expect(lastImage(master)).toBe(applyDisconnectedLook(MASTER_SVG));
    expect(lastImage(radar)).toBe(RADAR_SVG);
  });

  it("POSITIVE CONTROL: the old per-instance shape gives both keys one state", async () => {
    const standIn = new PerInstanceStandIn();
    const radar = await shownKey(standIn, "ctx-radar", { category: "radar" }, RADAR_SVG);
    const master = await shownKey(standIn, "ctx-master", { category: "master" }, MASTER_SVG);

    simGone();

    const radarDecorated = lastImage(radar) === applyDisconnectedLook(RADAR_SVG);
    const masterDecorated = lastImage(master) === applyDisconnectedLook(MASTER_SVG);

    // Both keys share the last-appeared key's decision, so the per-key
    // assertion of the test above (Master decorated, Radar not) fails here.
    expect(radarDecorated).toBe(masterDecorated);
    expect([radarDecorated, masterDecorated]).not.toEqual([false, true]);
  });

  it("does not show the look before the absent delay has passed, nor after a reconnect inside it", async () => {
    const action = new AudioLikeAction();
    const master = await shownKey(action, "ctx-master", { category: "master" }, MASTER_SVG);

    sim.state.connected = false;
    sim.tick();
    vi.advanceTimersByTime(ABSENT_DELAY_MS - 1);
    simBack();
    vi.advanceTimersByTime(ABSENT_DELAY_MS * 2);

    expect(lastImage(master)).toBe(MASTER_SVG);
  });

  it("clears the look on the first connected tick", async () => {
    const action = new AudioLikeAction();
    const master = await shownKey(action, "ctx-master", { category: "master" }, MASTER_SVG);

    simGone();
    expect(lastImage(master)).toBe(applyDisconnectedLook(MASTER_SVG));

    simBack();
    expect(lastImage(master)).toBe(MASTER_SVG);
  });

  it("draws a key that appears while the sim is absent with the look at once", async () => {
    const action = new AudioLikeAction();
    await shownKey(action, "ctx-first", { category: "master" }, MASTER_SVG);
    simGone();

    const late = await shownKey(action, "ctx-late", { category: "master" }, MASTER_SVG);

    expect(lastImage(late)).toBe(applyDisconnectedLook(MASTER_SVG));
  });

  it("keeps updating the other key when one disappears", async () => {
    const action = new AudioLikeAction();
    const leaving = await shownKey(action, "ctx-leaving", { category: "master" }, MASTER_SVG);
    const staying = await shownKey(action, "ctx-staying", { category: "master" }, MASTER_SVG);

    await action.onWillDisappear(leaving as unknown as IDeckWillDisappearEvent<Record<string, unknown>>);
    vi.mocked(leaving.action.setImage).mockClear();

    simGone();

    expect(lastImage(staying)).toBe(applyDisconnectedLook(MASTER_SVG));
    expect(leaving.action.setImage).not.toHaveBeenCalled();
  });

  it("follows a mode change: the new settings decide the next image", async () => {
    const action = new AudioLikeAction();
    const key = await shownKey(action, "ctx-1", { category: "master" }, MASTER_SVG);
    simGone();

    await action.onDidReceiveSettings(keyEvent("ctx-1", { category: "radar" }) as never);
    await action.showImage(key, RADAR_SVG);

    expect(lastImage(key)).toBe(RADAR_SVG);
  });

  it("shows nothing with the setting off, and the look as soon as the setting turns on", async () => {
    mockGetGlobalSettings.mockReturnValue({ showDisconnectedState: false });
    const action = new AudioLikeAction();
    const master = await shownKey(action, "ctx-master", { category: "master" }, MASTER_SVG);

    simGone();
    expect(lastImage(master)).toBe(MASTER_SVG);

    mockGetGlobalSettings.mockReturnValue({ showDisconnectedState: true });

    for (const listener of settingsListeners) listener();

    expect(lastImage(master)).toBe(applyDisconnectedLook(MASTER_SVG));
  });
});
