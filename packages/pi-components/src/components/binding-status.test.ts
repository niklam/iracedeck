// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import "./binding-status.js";

const { mockFetchReachable } = vi.hoisted(() => ({ mockFetchReachable: vi.fn() }));

vi.mock("./simhub-probe.js", () => ({
  fetchSimHubReachable: mockFetchReachable,
  // Large so the poll interval never fires during a test; the immediate probe
  // on a SimHub-bound render / host change is what we assert.
  SIMHUB_POLL_INTERVAL_MS: 1_000_000,
}));

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

/** Notify the component (it listens for input/change on the document). */
function tick(): void {
  document.dispatchEvent(new Event("input"));
}

/** Set (creating if needed) a generic sdpi-style control's value, then notify. */
function setControl(tag: string, setting: string, value: string): void {
  let el = document.querySelector(`${tag}[setting="${setting}"]`) as (Element & { value?: unknown }) | null;

  if (!el) {
    el = document.createElement(tag);
    el.setAttribute("setting", setting);
    document.body.appendChild(el);
  }

  (el as { value?: unknown }).value = value;
  tick();
}

const setMode = (m: string) => setControl("sdpi-select", "mode", m);
const setSecondary = (name: string, v: string) => setControl("sdpi-select", name, v);
const setBinding = (key: string, v: string) => setControl("ird-key-binding", key, v);

describe("ird-binding-status", () => {
  let el: HTMLElement;

  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    mockFetchReachable.mockReset();
    mockFetchReachable.mockResolvedValue(true); // SimHub connected by default
  });

  function mount(comms: object): HTMLElement {
    const node = document.createElement("ird-binding-status");
    node.setAttribute("comms", JSON.stringify(comms));
    node.setAttribute("mode-setting", "mode");
    document.body.appendChild(node);

    return node;
  }

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
    setBinding("fuelServiceToggleAutofuel", keyboardBinding("f1"));
    expect(text()).toContain("Key binding:");
    expect(text()).toContain("Ctrl+F1");
  });

  it("updates the text live when the binding is changed", () => {
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    setBinding("fuelServiceToggleAutofuel", keyboardBinding("f1"));
    expect(text()).toContain("Ctrl+F1");
    setBinding("fuelServiceToggleAutofuel", keyboardBinding("f2"));
    expect(text()).toContain("Ctrl+F2");
    expect(text()).not.toContain("Ctrl+F1");
    setBinding("fuelServiceToggleAutofuel", "");
    expect(text()).toContain("No binding set");
  });

  it("shows nothing until the binding input exists (no premature warning)", () => {
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    // No ird-key-binding for the key yet → render nothing, not "No binding set".
    expect(text()).toBe("");
    setBinding("fuelServiceToggleAutofuel", "");
    expect(text()).toContain("No binding set");
  });

  it("warns with a 'set it here' link when no binding is set", () => {
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    setBinding("fuelServiceToggleAutofuel", "");
    expect(text()).toContain("No binding set");
    expect(el.querySelector("a.ird-binding-status-link")).not.toBeNull();
  });

  it("treats a SimHub role as configured; no warning when connected", async () => {
    mockFetchReachable.mockResolvedValue(true);
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    setBinding("fuelServiceToggleAutofuel", simhubBinding("My Role"));
    expect(text()).toContain("SimHub binding: My Role");
    expect(text()).not.toContain("No binding set");
    await vi.waitFor(() => expect(mockFetchReachable).toHaveBeenCalled());
    expect(text()).not.toContain("SimHub not connected");
  });

  it("shows a red 'SimHub not connected' line when the probe finds SimHub down", async () => {
    mockFetchReachable.mockResolvedValue(false);
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    setBinding("fuelServiceToggleAutofuel", simhubBinding("My Role"));
    await vi.waitFor(() => expect(text()).toContain("SimHub not connected"));
    expect(el.querySelector(".ird-binding-status-danger")).not.toBeNull();
  });

  it("clears the not-connected warning live once SimHub becomes reachable", async () => {
    mockFetchReachable.mockResolvedValue(false);
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    setBinding("fuelServiceToggleAutofuel", simhubBinding("My Role"));
    await vi.waitFor(() => expect(text()).toContain("SimHub not connected"));
    mockFetchReachable.mockResolvedValue(true);
    setControl("sdpi-textfield", "simHubHost", "localhost"); // host change forces a re-probe
    await vi.waitFor(() => expect(text()).not.toContain("SimHub not connected"));
    expect(text()).toContain("SimHub binding: My Role");
  });

  it("updates live when switching keyboard ↔ SimHub without changing mode", () => {
    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    setBinding("fuelServiceToggleAutofuel", keyboardBinding("f1"));
    expect(text()).toContain("Ctrl+F1");
    setBinding("fuelServiceToggleAutofuel", simhubBinding("Role X"));
    expect(text()).toContain("SimHub binding: Role X");
    expect(text()).not.toContain("Ctrl+F1");
  });

  it("resolves a dynamic key from the secondary setting (full resolution)", () => {
    el = mount(VIEW_COMMS);
    setBinding("viewFovInc", keyboardBinding("a"));
    setBinding("viewFovDec", "");
    setSecondary("direction", "increase");
    setMode("fov");
    expect(text()).toContain("Key binding:");
    expect(text()).toContain("Ctrl+A");
    // Switching the secondary setting re-resolves to the other (unset) key.
    setSecondary("direction", "decrease");
    expect(text()).toContain("No binding set");
  });

  it("falls back to a secondary select's default when its value is empty (untouched control)", () => {
    el = mount(VIEW_COMMS);
    setBinding("viewFovInc", keyboardBinding("a"));
    // Direction select left at its default: empty value but default="increase".
    const dirSel = document.createElement("sdpi-select");
    dirSel.setAttribute("setting", "direction");
    dirSel.setAttribute("default", "increase");
    (dirSel as unknown as { value: string }).value = "";
    document.body.appendChild(dirSel);
    setMode("fov");
    // Must resolve via the default → viewFovInc, not go blank / "No binding set".
    expect(text()).toContain("Ctrl+A");
    expect(text()).not.toContain("No binding set");
  });

  it("opens the key-bindings accordion and scrolls when 'set it here' is clicked", () => {
    const details = document.createElement("details");
    details.setAttribute("data-accordion-id", "Related Key Bindings");
    const scrollSpy = vi.fn();
    (details as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollSpy;
    document.body.appendChild(details);

    el = mount(FUEL_COMMS);
    setMode("toggle-autofuel");
    setBinding("fuelServiceToggleAutofuel", "");
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
    setBinding("incKey", keyboardBinding("a"));
    setBinding("decKey", keyboardBinding("b"));
    setMode("view-fov");
    expect(text()).toContain("Ctrl+A");
    expect(text()).toContain("Ctrl+B");
    expect(text()).not.toContain("No binding set");
  });

  it("warns when a multi-key mode has any key unset", () => {
    el = mount({ "view-fov": { method: "keybind", binding: { scope: "global", keys: ["incKey", "decKey"] } } });
    setBinding("incKey", keyboardBinding("a"));
    setBinding("decKey", "");
    setMode("view-fov");
    expect(text()).toContain("No binding set");
  });
});
