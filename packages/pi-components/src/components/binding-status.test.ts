// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./binding-status.js";

type SettingsCallback = (value: string) => void;

interface MockSDPIState {
  settings: Map<string, SettingsCallback>;
  global: Map<string, SettingsCallback>;
}

function installMockSDPI(): MockSDPIState {
  const state: MockSDPIState = { settings: new Map(), global: new Map() };
  const useSettings = (key: string, cb: SettingsCallback) => {
    state.settings.set(key, cb);

    return [async () => "", vi.fn()] as [() => Promise<string>, (v: string) => void];
  };
  const useGlobalSettings = (key: string, cb: SettingsCallback) => {
    state.global.set(key, cb);

    return [async () => "", vi.fn()] as [() => Promise<string>, (v: string) => void];
  };
  (window as unknown as Record<string, unknown>).SDPIComponents = { useSettings, useGlobalSettings };

  return state;
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
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
  });

  function mount(comms: object, attrs: Record<string, string> = {}): HTMLElement {
    const node = document.createElement("ird-binding-status");
    node.setAttribute("comms", JSON.stringify(comms));
    node.setAttribute("mode-setting", "mode");

    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);

    document.body.appendChild(node);

    return node;
  }

  const text = () => el.textContent ?? "";

  it("shows the API method with no binding needed", () => {
    el = mount(FUEL_COMMS);
    mock.settings.get("mode")!("toggle-fuel-fill");
    expect(text()).toContain("iRacing API");
    expect(text()).toContain("no binding needed");
  });

  it("shows the chat method with no binding needed", () => {
    el = mount(FUEL_COMMS);
    mock.settings.get("mode")!("add-fuel");
    expect(text()).toContain("Chat command");
  });

  it("shows the keyboard binding value when configured", () => {
    el = mount(FUEL_COMMS);
    mock.settings.get("mode")!("toggle-autofuel");
    mock.global.get("fuelServiceToggleAutofuel")!(keyboardBinding("f1"));
    expect(text()).toContain("currently set");
    expect(text()).toContain("Ctrl+F1");
  });

  it("shows nothing (no 'No binding set' flash) until the binding value has loaded", () => {
    el = mount(FUEL_COMMS);
    mock.settings.get("mode")!("toggle-autofuel");
    // Binding value has NOT arrived yet → render nothing, not "No binding set".
    expect(text()).toBe("");
    // Once it loads as empty, the missing state shows.
    mock.global.get("fuelServiceToggleAutofuel")!("");
    expect(text()).toContain("No binding set");
  });

  it("waits for the secondary setting before judging a dynamic-key mode", () => {
    el = mount(VIEW_COMMS);
    mock.settings.get("mode")!("fov");
    // direction not loaded yet → nothing.
    expect(text()).toBe("");
  });

  it("warns with a 'set it here' link when no binding is set", () => {
    el = mount(FUEL_COMMS);
    mock.settings.get("mode")!("toggle-autofuel");
    mock.global.get("fuelServiceToggleAutofuel")!("");
    expect(text()).toContain("No binding set");
    expect(el.querySelector("a.ird-binding-status-link")).not.toBeNull();
  });

  it("treats a SimHub role as configured (never the missing state) with a running caveat", () => {
    el = mount(FUEL_COMMS);
    mock.settings.get("mode")!("toggle-autofuel");
    mock.global.get("fuelServiceToggleAutofuel")!(simhubBinding("My Role"));
    expect(text()).toContain("SimHub role: My Role");
    expect(text()).not.toContain("No binding set");
    expect(text()).toContain("Requires SimHub to be running");
  });

  it("escalates the SimHub caveat when SimHub is not reachable", () => {
    el = mount(FUEL_COMMS);
    mock.settings.get("mode")!("toggle-autofuel");
    mock.global.get("fuelServiceToggleAutofuel")!(simhubBinding("My Role"));
    mock.global.get("_simHubReachable")!("false");
    expect(text()).toContain("SimHub isn't running");
  });

  it("updates live when switching keyboard ↔ SimHub without changing mode", () => {
    el = mount(FUEL_COMMS);
    mock.settings.get("mode")!("toggle-autofuel");
    mock.global.get("fuelServiceToggleAutofuel")!(keyboardBinding("f1"));
    expect(text()).toContain("Ctrl+F1");
    mock.global.get("fuelServiceToggleAutofuel")!(simhubBinding("Role X"));
    expect(text()).toContain("SimHub role: Role X");
    expect(text()).not.toContain("Ctrl+F1");
  });

  it("resolves a dynamic key from the secondary setting (full resolution)", () => {
    el = mount(VIEW_COMMS);
    mock.settings.get("mode")!("fov");
    mock.settings.get("direction")!("increase");
    mock.global.get("viewFovInc")!(keyboardBinding("a"));
    expect(text()).toContain("currently set");
    expect(text()).toContain("Ctrl+A");
    // Switching the secondary setting re-resolves to the other key.
    mock.settings.get("direction")!("decrease");
    mock.global.get("viewFovDec")!("");
    expect(text()).toContain("No binding set");
  });

  it("opens the key-bindings accordion and scrolls when 'set it here' is clicked", () => {
    const details = document.createElement("details");
    details.setAttribute("data-accordion-id", "Related Key Bindings");
    const scrollSpy = vi.fn();
    (details as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollSpy;
    document.body.appendChild(details);

    el = mount(FUEL_COMMS);
    mock.settings.get("mode")!("toggle-autofuel");
    mock.global.get("fuelServiceToggleAutofuel")!("");
    (el.querySelector("a.ird-binding-status-link") as HTMLAnchorElement).click();

    expect(details.open).toBe(true);
    expect(scrollSpy).toHaveBeenCalled();
  });

  it("renders nothing for an unknown mode", () => {
    el = mount(FUEL_COMMS);
    mock.settings.get("mode")!("does-not-exist");
    expect(text()).toBe("");
  });

  it("shows 'no binding needed' for a fixed keybind (no binding ref) and never warns", () => {
    el = mount({ escape: { method: "keybind" } });
    mock.settings.get("mode")!("escape");
    expect(text()).toContain("No binding needed");
    expect(el.querySelector("a.ird-binding-status-link")).toBeNull();
  });

  it("lists all keys when a multi-key mode has them all set", () => {
    el = mount({ "view-fov": { method: "keybind", binding: { scope: "global", keys: ["incKey", "decKey"] } } });
    mock.settings.get("mode")!("view-fov");
    mock.global.get("incKey")!(keyboardBinding("a"));
    mock.global.get("decKey")!(keyboardBinding("b"));
    expect(text()).toContain("Ctrl+A");
    expect(text()).toContain("Ctrl+B");
    expect(text()).not.toContain("No binding set");
  });

  it("warns when a multi-key mode has any key unset", () => {
    el = mount({ "view-fov": { method: "keybind", binding: { scope: "global", keys: ["incKey", "decKey"] } } });
    mock.settings.get("mode")!("view-fov");
    mock.global.get("incKey")!(keyboardBinding("a"));
    mock.global.get("decKey")!("");
    expect(text()).toContain("No binding set");
  });
});
