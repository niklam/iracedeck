// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./black-box-caveat.js";

const CANDIDATES = ["blackBoxLapTiming", "blackBoxStandings", "blackBoxFuel"];
const MESSAGE = "Needs keyboard bindings.";

const keyboardBinding = (key: string, code: string) => JSON.stringify({ type: "keyboard", key, modifiers: [], code });
const simhubBinding = (role: string) => JSON.stringify({ type: "simhub", role });

let globalSettings: Record<string, unknown> = {};
let subscriber: ((ev: { payload: { settings: Record<string, unknown> } }) => void) | null = null;

function installSdpiStub(): void {
  (window as unknown as { SDPIComponents: unknown }).SDPIComponents = {
    streamDeckClient: {
      getGlobalSettings: () => Promise.resolve(globalSettings),
      didReceiveGlobalSettings: {
        subscribe: (fn: (ev: { payload: { settings: Record<string, unknown> } }) => void) => {
          subscriber = fn;

          return () => {
            subscriber = null;
          };
        },
      },
    },
  };
}

/** Mount the checkbox the component reads, then the component itself. */
async function mount(enabled: boolean): Promise<HTMLElement> {
  const checkbox = document.createElement("sdpi-checkbox");
  checkbox.setAttribute("setting", "showBlackBox");
  (checkbox as unknown as { value: boolean }).value = enabled;
  document.body.appendChild(checkbox);

  const el = document.createElement("ird-black-box-caveat");
  el.setAttribute("enabled-setting", "showBlackBox");
  el.setAttribute("target", "blackBoxFuel");
  el.setAttribute("candidates", JSON.stringify(CANDIDATES));
  el.setAttribute("message", MESSAGE);
  document.body.appendChild(el);

  // Let the getGlobalSettings() promise settle.
  await Promise.resolve();
  await Promise.resolve();

  return el;
}

const isVisible = (el: HTMLElement) => el.textContent!.includes(MESSAGE);

describe("ird-black-box-caveat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalSettings = {};
    subscriber = null;
    document.body.innerHTML = "";
    installSdpiStub();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should stay silent when the feature is disabled, even with no bindings", async () => {
    const el = await mount(false);

    expect(isVisible(el)).toBe(false);
  });

  it("should stay silent when target and a prime are keyboard-bound", async () => {
    globalSettings = {
      blackBoxLapTiming: keyboardBinding("f1", "F1"),
      blackBoxFuel: keyboardBinding("f4", "F4"),
    };
    const el = await mount(true);

    expect(isVisible(el)).toBe(false);
  });

  it("should warn when the target binding is missing", async () => {
    globalSettings = { blackBoxLapTiming: keyboardBinding("f1", "F1") };
    const el = await mount(true);

    expect(isVisible(el)).toBe(true);
  });

  it("should warn when the target is bound to a SimHub role", async () => {
    globalSettings = {
      blackBoxLapTiming: keyboardBinding("f1", "F1"),
      blackBoxFuel: simhubBinding("Fuel Box"),
    };
    const el = await mount(true);

    expect(isVisible(el)).toBe(true);
  });

  it("should warn when no other box is available to prime with", async () => {
    globalSettings = { blackBoxFuel: keyboardBinding("f4", "F4") };
    const el = await mount(true);

    expect(isVisible(el)).toBe(true);
  });

  it("should warn when the only other box is a SimHub role", async () => {
    globalSettings = {
      blackBoxLapTiming: simhubBinding("Lap Timing"),
      blackBoxFuel: keyboardBinding("f4", "F4"),
    };
    const el = await mount(true);

    expect(isVisible(el)).toBe(true);
  });

  it("should accept any other keyboard-bound box as the prime", async () => {
    globalSettings = {
      blackBoxStandings: keyboardBinding("f2", "F2"),
      blackBoxFuel: keyboardBinding("f4", "F4"),
    };
    const el = await mount(true);

    expect(isVisible(el)).toBe(false);
  });

  it("should clear the warning when a binding arrives later", async () => {
    globalSettings = { blackBoxFuel: keyboardBinding("f4", "F4") };
    const el = await mount(true);
    expect(isVisible(el)).toBe(true);

    subscriber!({
      payload: {
        settings: {
          blackBoxLapTiming: keyboardBinding("f1", "F1"),
          blackBoxFuel: keyboardBinding("f4", "F4"),
        },
      },
    });

    expect(isVisible(el)).toBe(false);
  });

  it("should react to the checkbox being ticked", async () => {
    globalSettings = {};
    const el = await mount(false);
    expect(isVisible(el)).toBe(false);

    const checkbox = document.querySelector('sdpi-checkbox[setting="showBlackBox"]')!;
    (checkbox as unknown as { value: boolean }).value = true;
    vi.advanceTimersByTime(300);

    expect(isVisible(el)).toBe(true);
  });
});
