// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./black-box-caveat.js";

const CANDIDATES = ["blackBoxLapTiming", "blackBoxStandings", "blackBoxFuel"];
const MESSAGE = "Needs keyboard bindings.";

const keyboardBinding = (key: string, code: string) => JSON.stringify({ type: "keyboard", key, modifiers: [], code });
const simhubBinding = (role: string) => JSON.stringify({ type: "simhub", role });

type Handler = (ev: { payload: { settings: Record<string, unknown> } }) => void;

let globalSettings: Record<string, unknown> = {};
/** Mirrors sdpi's real event object: a handler list, subscribe/unsubscribe, no return value. */
let handlers: Handler[] = [];

const notify = (settings: Record<string, unknown>) => handlers.forEach((h) => h({ payload: { settings } }));

function installSdpiStub(): void {
  (window as unknown as { SDPIComponents: unknown }).SDPIComponents = {
    streamDeckClient: {
      getGlobalSettings: () => Promise.resolve(globalSettings),
      didReceiveGlobalSettings: {
        // sdpi's subscribe() pushes onto a list and returns undefined.
        subscribe: (fn: Handler): void => {
          handlers.push(fn);
        },
        unsubscribe: (fn: Handler): void => {
          handlers = handlers.filter((h) => h !== fn);
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
    handlers = [];
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

    notify({
      blackBoxLapTiming: keyboardBinding("f1", "F1"),
      blackBoxFuel: keyboardBinding("f4", "F4"),
    });

    expect(isVisible(el)).toBe(false);
  });

  it("should unsubscribe and stop polling on disconnect", async () => {
    const el = await mount(true);
    expect(handlers).toHaveLength(1);

    el.remove();

    expect(handlers).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should wire back up when removed and re-added to the DOM", async () => {
    globalSettings = { blackBoxFuel: keyboardBinding("f4", "F4") };
    const el = await mount(true);
    expect(isVisible(el)).toBe(true);

    el.remove();
    expect(isVisible(el)).toBe(false); // torn down: container removed

    document.body.appendChild(el);
    await Promise.resolve();
    await Promise.resolve();

    // Live again: still warns (no prime bound), and a later binding clears it.
    expect(handlers).toHaveLength(1);
    expect(isVisible(el)).toBe(true);

    notify({
      blackBoxLapTiming: keyboardBinding("f1", "F1"),
      blackBoxFuel: keyboardBinding("f4", "F4"),
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

  // On hosts that retain navigated-away PI pages, disconnectedCallback never
  // fires — pagehide is the only teardown signal the component gets (#903).
  it("should stop the checkbox poll on pagehide and resume it on pageshow", async () => {
    const el = await mount(false);

    window.dispatchEvent(new Event("pagehide"));
    // Flip the checkbox WITHOUT dispatching events, so only the poll could notice.
    const checkbox = document.querySelector(`[setting="showBlackBox"]`) as Element & { value?: unknown };
    checkbox.value = true;
    vi.advanceTimersByTime(1000);

    expect(isVisible(el)).toBe(false);

    window.dispatchEvent(new Event("pageshow"));
    vi.advanceTimersByTime(300);

    expect(isVisible(el)).toBe(true);
  });

  it("should poll again when re-added after a pageshow it missed while detached", async () => {
    const el = await mount(false);

    window.dispatchEvent(new Event("pagehide"));
    el.remove();
    // pageshow fires while the element is detached — its listener is gone.
    window.dispatchEvent(new Event("pageshow"));
    document.body.appendChild(el);

    // Flip the checkbox WITHOUT dispatching events, so only the poll could notice.
    const checkbox = document.querySelector(`[setting="showBlackBox"]`) as Element & { value?: unknown };
    checkbox.value = true;
    vi.advanceTimersByTime(300);

    expect(isVisible(el)).toBe(true);
  });

  it("should not render after a late getGlobalSettings resolve on a detached element", async () => {
    let resolveSettings!: (v: Record<string, unknown>) => void;
    (
      window as unknown as { SDPIComponents: { streamDeckClient: { getGlobalSettings: () => Promise<unknown> } } }
    ).SDPIComponents.streamDeckClient.getGlobalSettings = () =>
      new Promise((res) => {
        resolveSettings = res as (v: Record<string, unknown>) => void;
      });

    const el = await mount(true);
    el.remove();

    resolveSettings({});
    await Promise.resolve();
    await Promise.resolve();

    expect(isVisible(el)).toBe(false);
  });
});
