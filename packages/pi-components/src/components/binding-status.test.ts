// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./binding-status.js";

const { mockFetchReachable } = vi.hoisted(() => ({ mockFetchReachable: vi.fn() }));

vi.mock("./simhub-probe.js", () => ({
  fetchSimHubReachable: mockFetchReachable,
  // Large so the poll interval never fires during a test; the immediate probe
  // on render is what we assert.
  SIMHUB_POLL_INTERVAL_MS: 1_000_000,
}));

type SettingsCallback = (value: string) => void;

interface MockSDPIState {
  /** Action-settings subscriptions (mode + secondary keyBy settings). */
  settings: Map<string, SettingsCallback>;
  /** The live global-settings object the component reads. */
  global: Record<string, unknown>;
  /** Merge a partial into global settings and notify the component (any source). */
  emitGlobal: (partial: Record<string, unknown>) => void;
}

function installMockSDPI(): MockSDPIState {
  const settings = new Map<string, SettingsCallback>();
  const global: Record<string, unknown> = {};
  const listeners: Array<(ev: { payload: { settings: Record<string, unknown> } }) => void> = [];

  const emitGlobal = (partial: Record<string, unknown>) => {
    Object.assign(global, partial);

    for (const cb of listeners) cb({ payload: { settings: global } });
  };

  const useSettings = (key: string, cb: SettingsCallback) => {
    settings.set(key, cb);

    return [async () => "", vi.fn()] as [() => Promise<string>, (v: string) => void];
  };

  const streamDeckClient = {
    getGlobalSettings: () => Promise.resolve(global),
    didReceiveGlobalSettings: {
      subscribe: (cb: (ev: { payload: { settings: Record<string, unknown> } }) => void) => {
        listeners.push(cb);

        return () => {
          const i = listeners.indexOf(cb);

          if (i >= 0) listeners.splice(i, 1);
        };
      },
    },
  };

  (window as unknown as Record<string, unknown>).SDPIComponents = { useSettings, streamDeckClient };

  return { settings, global, emitGlobal };
}

const keyboardBinding = (key: string) => JSON.stringify({ type: "keyboard", key, modifiers: ["ctrl"], code: key });
const simhubBinding = (role: string) => JSON.stringify({ type: "simhub", role });

// fuel-service: api + chat + keybind in one action.
const FUEL_COMMS = {
  "toggle-fuel-fill": { method: "api" },
  "add-fuel": { method: "chat" },
  "toggle-autofuel": { method: "keybind", binding: { scope: "global", key: "fuelServiceToggleAutofuel" } },
};

// view-adjustment: dynamic key resolved from the `direction` secondary setting.
const VIEW_COMMS = {
  fov: {
    method: "keybind",
    binding: {
      scope: "global",
      keyBy: { setting: "direction", map: { increase: "viewFovInc", decrease: "viewFovDec" } },
    },
  },
};

describe("ird-binding-status", () => {
  let el: HTMLElement;
  let mock: MockSDPIState;

  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    mock = installMockSDPI();
    mockFetchReachable.mockReset();
    mockFetchReachable.mockResolvedValue(true); // SimHub connected by default
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
  });

  function mount(comms: object): HTMLElement {
    const node = document.createElement("ird-binding-status");
    node.setAttribute("comms", JSON.stringify(comms));
    node.setAttribute("mode-setting", "mode");
    document.body.appendChild(node);

    return node;
  }

  const setMode = (m: string) => mock.settings.get("mode")!(m);
  const text = () => el.textContent ?? "";

  it("shows the API method", () => {
    el = mount(FUEL_COMMS);
    setMode("toggle-fuel-fill");
    expect(text()).toContain("iRacing API");
  });

  it("shows the chat method", () => {
    el = mount(FUEL_COMMS);
    setMode("add-fuel");
    expect(text()).toContain("Chat command");
  });

  it("shows the keyboard binding value when configured", () => {
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    mock.emitGlobal({ fuelServiceToggleAutofuel: keyboardBinding("f1") });
    expect(text()).toContain("Key binding:");
    expect(text()).toContain("Ctrl+F1");
  });

  it("updates the text live when the binding is changed", () => {
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    mock.emitGlobal({ fuelServiceToggleAutofuel: keyboardBinding("f1") });
    expect(text()).toContain("Ctrl+F1");
    // A sibling ird-key-binding rebinds it → component reflects the new value.
    mock.emitGlobal({ fuelServiceToggleAutofuel: keyboardBinding("f2") });
    expect(text()).toContain("Ctrl+F2");
    expect(text()).not.toContain("Ctrl+F1");
    // ...and clearing it shows the missing state live.
    mock.emitGlobal({ fuelServiceToggleAutofuel: "" });
    expect(text()).toContain("No binding set");
  });

  it("shows nothing (no 'No binding set' flash) until the binding value has loaded", () => {
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    // Global settings have NOT arrived yet → render nothing, not "No binding set".
    expect(text()).toBe("");
    mock.emitGlobal({ fuelServiceToggleAutofuel: "" });
    expect(text()).toContain("No binding set");
  });

  it("waits for the secondary setting before judging a dynamic-key mode", () => {
    el = mount(VIEW_COMMS);
    setMode("fov");
    mock.emitGlobal({ viewFovInc: keyboardBinding("a") });
    // direction not loaded yet → nothing.
    expect(text()).toBe("");
  });

  it("warns with a 'set it here' link when no binding is set", () => {
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    mock.emitGlobal({ fuelServiceToggleAutofuel: "" });
    expect(text()).toContain("No binding set");
    expect(el.querySelector("a.ird-binding-status-link")).not.toBeNull();
  });

  it("treats a SimHub role as configured (never the missing state); no warning when connected", async () => {
    mockFetchReachable.mockResolvedValue(true);
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    mock.emitGlobal({ fuelServiceToggleAutofuel: simhubBinding("My Role") });
    expect(text()).toContain("SimHub binding: My Role");
    expect(text()).not.toContain("No binding set");
    await vi.waitFor(() => expect(mockFetchReachable).toHaveBeenCalled());
    expect(text()).not.toContain("SimHub not connected");
  });

  it("shows a red 'SimHub not connected' line when the probe finds SimHub down", async () => {
    mockFetchReachable.mockResolvedValue(false);
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    mock.emitGlobal({ fuelServiceToggleAutofuel: simhubBinding("My Role") });
    await vi.waitFor(() => expect(text()).toContain("SimHub not connected"));
    expect(el.querySelector(".ird-binding-status-danger")).not.toBeNull();
  });

  it("clears the not-connected warning live once SimHub becomes reachable", async () => {
    mockFetchReachable.mockResolvedValue(false);
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    mock.emitGlobal({ fuelServiceToggleAutofuel: simhubBinding("My Role") });
    await vi.waitFor(() => expect(text()).toContain("SimHub not connected"));
    // SimHub comes up; a host change forces a re-probe (stands in for the poll).
    mockFetchReachable.mockResolvedValue(true);
    mock.emitGlobal({ simHubHost: "localhost" });
    await vi.waitFor(() => expect(text()).not.toContain("SimHub not connected"));
    expect(text()).toContain("SimHub binding: My Role");
  });

  it("updates live when switching keyboard ↔ SimHub without changing mode", () => {
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    mock.emitGlobal({ fuelServiceToggleAutofuel: keyboardBinding("f1") });
    expect(text()).toContain("Ctrl+F1");
    mock.emitGlobal({ fuelServiceToggleAutofuel: simhubBinding("Role X") });
    expect(text()).toContain("SimHub binding: Role X");
    expect(text()).not.toContain("Ctrl+F1");
  });

  it("resolves a dynamic key from the secondary setting (full resolution)", () => {
    el = mount(VIEW_COMMS);
    setMode("fov");
    mock.settings.get("direction")!("increase");
    mock.emitGlobal({ viewFovInc: keyboardBinding("a") });
    expect(text()).toContain("Key binding:");
    expect(text()).toContain("Ctrl+A");
    // Switching the secondary setting re-resolves to the other (unset) key.
    mock.settings.get("direction")!("decrease");
    expect(text()).toContain("No binding set");
  });

  it("opens the key-bindings accordion and scrolls when 'set it here' is clicked", () => {
    const details = document.createElement("details");
    details.setAttribute("data-accordion-id", "Related Key Bindings");
    const scrollSpy = vi.fn();
    (details as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollSpy;
    document.body.appendChild(details);

    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    mock.emitGlobal({ fuelServiceToggleAutofuel: "" });
    (el.querySelector("a.ird-binding-status-link") as HTMLAnchorElement).click();

    expect(details.open).toBe(true);
    expect(scrollSpy).toHaveBeenCalled();
  });

  it("renders nothing for an unknown mode", () => {
    el = mount(FUEL_COMMS);
    setMode("does-not-exist");
    expect(text()).toBe("");
  });

  it("shows 'no binding needed' for a fixed keybind (no binding ref) and never warns", () => {
    el = mount({ escape: { method: "keybind" } });
    setMode("escape");
    expect(text()).toContain("No binding needed");
    expect(el.querySelector("a.ird-binding-status-link")).toBeNull();
  });

  it("lists all keys when a multi-key mode has them all set", () => {
    el = mount({ "view-fov": { method: "keybind", binding: { scope: "global", keys: ["incKey", "decKey"] } } });
    setMode("view-fov");
    mock.emitGlobal({ incKey: keyboardBinding("a"), decKey: keyboardBinding("b") });
    expect(text()).toContain("Ctrl+A");
    expect(text()).toContain("Ctrl+B");
    expect(text()).not.toContain("No binding set");
  });

  it("warns when a multi-key mode has any key unset", () => {
    el = mount({ "view-fov": { method: "keybind", binding: { scope: "global", keys: ["incKey", "decKey"] } } });
    setMode("view-fov");
    mock.emitGlobal({ incKey: keyboardBinding("a"), decKey: "" });
    expect(text()).toContain("No binding set");
  });
});
