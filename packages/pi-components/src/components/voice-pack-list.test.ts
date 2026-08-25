// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Import the module to trigger custom element registration
import "./voice-pack-list.js";

type SettingsCallback = (value: string) => void;

interface MockSDPIState {
  callbacks: Map<string, SettingsCallback>;
}

function installMockSDPI(): MockSDPIState {
  const state: MockSDPIState = { callbacks: new Map() };

  const useGlobalSettings = (key: string, callback: SettingsCallback): [() => Promise<string>, () => void] => {
    state.callbacks.set(key, callback);

    return [async () => "", vi.fn()];
  };

  (window as unknown as Record<string, unknown>).SDPIComponents = { useGlobalSettings };

  return state;
}

const PACKS = JSON.stringify([
  { id: "luca", label: "Luca", version: "1.2.0", voices: ["luca"] },
  { id: "nina", label: "Nina", version: "2.0.1", voices: ["nina"] },
]);

describe("ird-voice-pack-list", () => {
  let el: HTMLElement;
  let mock: MockSDPIState;

  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    mock = installMockSDPI();
    el = document.createElement("ird-voice-pack-list");
    document.body.appendChild(el);
  });

  function publish(value: string, key = "_voicePacks"): void {
    mock.callbacks.get(key)?.(value);
  }

  it("says so when nothing is installed", () => {
    expect(el.textContent).toContain("No voice packs installed");
  });

  it("renders a row per installed pack with its version", () => {
    publish(PACKS);

    const rows = el.querySelectorAll(".ird-vp-row");

    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Luca");
    expect(rows[0].textContent).toContain("1.2.0");
    expect(rows[1].textContent).toContain("Nina");
  });

  it("goes back to the empty state when the last pack is removed", () => {
    publish(PACKS);
    publish("[]");

    expect(el.querySelectorAll(".ird-vp-row")).toHaveLength(0);
    expect(el.textContent).toContain("No voice packs installed");
  });

  it("replaces rows rather than appending on every republish", () => {
    publish(PACKS);
    publish(PACKS);

    expect(el.querySelectorAll(".ird-vp-row")).toHaveLength(2);
  });

  it("survives malformed JSON without throwing or rendering junk", () => {
    expect(() => publish("{not json")).not.toThrow();
    expect(el.textContent).toContain("No voice packs installed");
  });

  it("drops entries missing the fields it renders instead of showing undefined", () => {
    publish(JSON.stringify([{ id: "broken" }, { id: "ok", label: "OK", version: "1.0.0", voices: ["ok"] }]));

    const rows = el.querySelectorAll(".ird-vp-row");

    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("OK");
    expect(el.textContent).not.toContain("undefined");
  });

  it("renders a pack label as text, never as markup — a sideloaded pack authors it", () => {
    publish(JSON.stringify([{ id: "x", label: "<img src=x onerror=alert(1)>", version: "1.0.0", voices: ["x"] }]));

    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("reads the key named by the packs attribute", () => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    mock = installMockSDPI();
    const custom = document.createElement("ird-voice-pack-list");
    custom.setAttribute("packs", "_customKey");
    document.body.appendChild(custom);

    mock.callbacks.get("_customKey")?.(PACKS);

    expect(custom.querySelectorAll(".ird-vp-row")).toHaveLength(2);
  });
});
