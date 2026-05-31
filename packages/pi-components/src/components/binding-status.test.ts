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

type SettingsEvent = { payload: { settings: Record<string, unknown> } };
type Listener = (ev: SettingsEvent) => void;

interface MockSDPIState {
  /** Merge a partial into the current action settings and notify the component. */
  emitAction: (partial: Record<string, unknown>) => void;
  /** Merge a partial into global settings and notify the component (any source). */
  emitGlobal: (partial: Record<string, unknown>) => void;
}

function installMockSDPI(): MockSDPIState {
  const action: Record<string, unknown> = {};
  const global: Record<string, unknown> = {};
  const actionListeners: Listener[] = [];
  const globalListeners: Listener[] = [];

  const emitAction = (partial: Record<string, unknown>) => {
    Object.assign(action, partial);

    for (const cb of actionListeners) cb({ payload: { settings: action } });
  };
  const emitGlobal = (partial: Record<string, unknown>) => {
    Object.assign(global, partial);

    for (const cb of globalListeners) cb({ payload: { settings: global } });
  };

  const subscribe = (list: Listener[]) => (cb: Listener) => {
    list.push(cb);

    return () => {
      const i = list.indexOf(cb);

      if (i >= 0) list.splice(i, 1);
    };
  };

  const streamDeckClient = {
    getSettings: () => Promise.resolve({ settings: action }),
    getGlobalSettings: () => Promise.resolve(global),
    didReceiveSettings: { subscribe: subscribe(actionListeners) },
    didReceiveGlobalSettings: { subscribe: subscribe(globalListeners) },
  };

  (window as unknown as Record<string, unknown>).SDPIComponents = { streamDeckClient };

  return { emitAction, emitGlobal };
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

  const setMode = (m: string) => mock.emitAction({ mode: m });
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

  it("updates live when the Mode changes", () => {
    el = mount(FUEL_COMMS);
    setMode("toggle-fuel-fill");
    expect(text()).toContain("iRacing API");
    setMode("add-fuel");
    expect(text()).toContain("Chat command");
    expect(text()).not.toContain("iRacing API");
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
    mock.emitGlobal({ fuelServiceToggleAutofuel: keyboardBinding("f2") });
    expect(text()).toContain("Ctrl+F2");
    expect(text()).not.toContain("Ctrl+F1");
    mock.emitGlobal({ fuelServiceToggleAutofuel: "" });
    expect(text()).toContain("No binding set");
  });

  it("shows nothing until settings have loaded", () => {
    el = mount(FUEL_COMMS);
    // No settings yet → nothing.
    expect(text()).toBe("");
    setMode("toggle-autofuel");
    // Mode known but binding value not loaded → still nothing (no premature warning).
    expect(text()).toBe("");
    mock.emitGlobal({ fuelServiceToggleAutofuel: "" });
    expect(text()).toContain("No binding set");
  });

  it("warns with a 'set it here' link when no binding is set", () => {
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    mock.emitGlobal({ fuelServiceToggleAutofuel: "" });
    expect(text()).toContain("No binding set");
    expect(el.querySelector("a.ird-binding-status-link")).not.toBeNull();
  });

  it("treats a SimHub role as configured; no warning when connected", async () => {
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
    mockFetchReachable.mockResolvedValue(true);
    mock.emitGlobal({ simHubHost: "localhost" }); // host change forces a re-probe
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
    mock.emitGlobal({ viewFovInc: keyboardBinding("a") });
    mock.emitAction({ mode: "fov", direction: "increase" });
    expect(text()).toContain("Key binding:");
    expect(text()).toContain("Ctrl+A");
    // Switching the secondary setting re-resolves to the other (unset) key.
    mock.emitAction({ mode: "fov", direction: "decrease" });
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
