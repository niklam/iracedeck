// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./warnings.js";

type SettingsCallback = (value: string) => void;
type SettingsHook = [() => Promise<string>, (value: string) => void];

interface MockSDPIState {
  callbacks: Map<string, SettingsCallback>;
}

function installMockSDPI(): MockSDPIState {
  const state: MockSDPIState = { callbacks: new Map() };
  const useGlobalSettings = (key: string, callback: SettingsCallback): SettingsHook => {
    state.callbacks.set(key, callback);

    return [async () => "", vi.fn()];
  };
  (window as unknown as Record<string, unknown>).SDPIComponents = { useGlobalSettings };

  return state;
}

describe("ird-warnings", () => {
  let el: HTMLElement;
  let mock: MockSDPIState;

  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    mock = installMockSDPI();
    el = document.createElement("ird-warnings");
    document.body.appendChild(el);
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
  });

  function emit(value: string): void {
    mock.callbacks.get("_warnings")!(value);
  }

  it("renders nothing when there are no warnings", () => {
    emit("");
    expect(el.querySelectorAll(".ird-warning").length).toBe(0);
  });

  it("renders one banner per warning record with its message", () => {
    emit(
      JSON.stringify([
        { id: "elevation-mismatch", level: "warning", message: "Run as admin" },
        { id: "x", level: "info", message: "Heads up" },
      ]),
    );
    const rows = el.querySelectorAll(".ird-warning");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("Run as admin");
    expect(rows[1].textContent).toContain("Heads up");
  });

  it("maps level to a CSS class and icon", () => {
    emit(JSON.stringify([{ id: "a", level: "warning", message: "m" }]));
    const row = el.querySelector(".ird-warning")!;
    expect(row.classList.contains("ird-warning-warning")).toBe(true);
    expect(row.textContent).toContain("⚠️");
  });

  it("ignores malformed JSON without throwing", () => {
    expect(() => emit("{not json")).not.toThrow();
    expect(el.querySelectorAll(".ird-warning").length).toBe(0);
  });

  it("ignores records with an unknown level", () => {
    emit(JSON.stringify([{ id: "a", level: "bogus", message: "m" }]));
    expect(el.querySelectorAll(".ird-warning").length).toBe(0);
  });
});

describe("ird-warnings — placement filters (#1005)", () => {
  let mock: MockSDPIState;

  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    mock = installMockSDPI();
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
  });

  function mount(attributes: Record<string, string>): HTMLElement {
    const el = document.createElement("ird-warnings");

    for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);

    document.body.appendChild(el);

    return el;
  }

  function emit(value: string): void {
    for (const callback of mock.callbacks.values()) callback(value);
  }

  const BOTH = JSON.stringify([
    { id: "elevation-mismatch", level: "warning", message: "Run as admin" },
    { id: "settings-window", level: "error", message: "Settings service is down" },
  ]);

  it("renders only the listed ids when `only` is set", () => {
    const el = mount({ only: "settings-window" });

    emit(BOTH);

    const rows = el.querySelectorAll(".ird-warning");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("Settings service is down");
  });

  it("drops the listed ids when `except` is set, so the page-top strip does not duplicate the button's banner", () => {
    const el = mount({ except: "settings-window" });

    emit(BOTH);

    const rows = el.querySelectorAll(".ird-warning");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("Run as admin");
  });

  it("accepts a comma-separated list of ids", () => {
    const el = mount({ except: "settings-window, elevation-mismatch" });

    emit(BOTH);

    expect(el.querySelectorAll(".ird-warning").length).toBe(0);
  });

  it("renders every warning when neither filter is set", () => {
    const el = mount({});

    emit(BOTH);

    expect(el.querySelectorAll(".ird-warning").length).toBe(2);
  });
});
