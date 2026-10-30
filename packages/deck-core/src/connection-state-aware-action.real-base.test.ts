/**
 * ConnectionStateAwareAction over the REAL BaseAction: the sim's readiness
 * reaching the key image. `connection-state-aware-action.test.ts` mocks
 * BaseAction for the whole file and asserts on a mocked `setActive`, and
 * `base-action.test.ts` drives `setActive` directly, so this file is the one
 * place the two halves run together — a change to either that breaks how a
 * disconnected key greys out fails here. Readiness arrives the way it does in
 * the plugin: the key appears, subscribes, and each sim tick re-evaluates it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionStateAwareAction } from "./connection-state-aware-action.js";
import { createFakeSimConnection, type FakeSimConnection } from "./fake-sim-connection.js";
import { applyInactiveOverlay, overlayConfig } from "./overlay-utils.js";
import { _resetSimConnection, initializeSimConnection } from "./sim-connection.js";
import type { IDeckActionContext, IDeckWillAppearEvent } from "./types.js";

vi.mock("./binding-dispatcher.js", () => ({
  getBindingDispatcher: () => ({
    tap: vi.fn().mockResolvedValue(true),
    hold: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
    isConfigured: vi.fn(() => true),
    isKeyboardBound: vi.fn(() => true),
  }),
}));

vi.mock("./simhub-service.js", () => ({
  onSimHubReachabilityChange: vi.fn(() => vi.fn()),
}));

// The setting's schema default: an inactive action gets the overlay.
vi.mock("@iracedeck/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/settings")>()),
  getGlobalSettings: vi.fn(() => ({ disableWhenDisconnected: true })),
  onGlobalSettingsChange: vi.fn(() => vi.fn()),
}));

type KeyEvent = IDeckWillAppearEvent<Record<string, unknown>>;

class TestAction extends ConnectionStateAwareAction {
  async showImage(ev: KeyEvent, svg: string): Promise<void> {
    await this.setKeyImage(ev, svg);
  }
}

function keyEvent(contextId: string): KeyEvent {
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

  return { action, payload: { settings: {} } } as KeyEvent;
}

describe("ConnectionStateAwareAction over the real BaseAction", () => {
  let sim: FakeSimConnection;
  let action: TestAction;

  /** A key that has appeared, shows `svg`, and has its write spy cleared. */
  async function shownKey(contextId: string, svg: string): Promise<KeyEvent> {
    const ev = keyEvent(contextId);

    await action.onWillAppear(ev);
    await action.showImage(ev, svg);
    vi.mocked(ev.action.setImage).mockClear();

    return ev;
  }

  beforeEach(() => {
    _resetSimConnection();
    sim = createFakeSimConnection();
    initializeSimConnection(sim.connection);
    action = new TestAction();
    // Enabled for the test; off by default in production.
    overlayConfig.inactiveOverlayEnabled = true;
  });

  afterEach(() => {
    overlayConfig.inactiveOverlayEnabled = false;
  });

  it("greys out every key when the sim disconnects, and restores the originals when it reconnects", async () => {
    const svg1 = '<svg id="1" fill="#ff0000"></svg>';
    const svg2 = '<svg id="2" fill="#00ff00"></svg>';
    const ev1 = await shownKey("context-1", svg1);
    const ev2 = await shownKey("context-2", svg2);

    // The overlay must change the image, or the assertions below could not tell the two states apart.
    expect(applyInactiveOverlay(svg1)).not.toBe(svg1);

    sim.state.connected = false;
    sim.tick();

    expect(ev1.action.setImage).toHaveBeenLastCalledWith(applyInactiveOverlay(svg1));
    expect(ev2.action.setImage).toHaveBeenLastCalledWith(applyInactiveOverlay(svg2));

    sim.state.connected = true;
    sim.tick();

    expect(ev1.action.setImage).toHaveBeenLastCalledWith(svg1);
    expect(ev2.action.setImage).toHaveBeenLastCalledWith(svg2);
  });

  it("repaints nothing on a tick that leaves the readiness unchanged", async () => {
    const ev = await shownKey("context-1", "<svg></svg>");

    sim.state.connected = false;
    sim.tick();
    vi.mocked(ev.action.setImage).mockClear();

    sim.tick();

    expect(ev.action.setImage).not.toHaveBeenCalled();
  });

  it("shows a key set while disconnected with the overlay, and its original once connected", async () => {
    const svg = '<svg fill="#ff0000"></svg>';
    const ev = keyEvent("context-1");

    await action.onWillAppear(ev);
    sim.state.connected = false;
    sim.tick();
    await action.showImage(ev, svg);

    expect(ev.action.setImage).toHaveBeenLastCalledWith(applyInactiveOverlay(svg));

    sim.state.connected = true;
    sim.tick();

    expect(ev.action.setImage).toHaveBeenLastCalledWith(svg);
  });
});
