// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isKeyboardBinding, isSimHubBinding } from "./black-box-caveat.js";

const CANDIDATES = ["blackBoxLapTiming", "blackBoxStandings", "blackBoxFuel"];
const MESSAGE = "Needs black-box bindings.";
const SIMHUB_MESSAGE = "Bound to a SimHub role, so the priming box may flash.";

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
  el.setAttribute("simhub-message", SIMHUB_MESSAGE);
  document.body.appendChild(el);

  // Let the getGlobalSettings() promise settle.
  await Promise.resolve();
  await Promise.resolve();

  return el;
}

/** The warning line is showing. */
const isVisible = (el: HTMLElement) => el.textContent!.includes(MESSAGE);
/** The SimHub info line is showing. */
const isInfoVisible = (el: HTMLElement) => el.textContent!.includes(SIMHUB_MESSAGE);
/** The line's rendered container, for the severity it is styled with. */
const line = (el: HTMLElement) => el.querySelector("div")!;

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

  it("should show the SimHub info line when the target is bound to a SimHub role", async () => {
    globalSettings = {
      blackBoxLapTiming: keyboardBinding("f1", "F1"),
      blackBoxFuel: simhubBinding("Fuel Box"),
    };
    const el = await mount(true);

    expect(isVisible(el)).toBe(false);
    expect(isInfoVisible(el)).toBe(true);
  });

  it("should warn when the target is a SimHub role but no other box is bound", async () => {
    globalSettings = { blackBoxFuel: simhubBinding("Fuel Box") };
    const el = await mount(true);

    expect(isVisible(el)).toBe(true);
    expect(isInfoVisible(el)).toBe(false);
  });

  it("should warn when no other box is available to prime with", async () => {
    globalSettings = { blackBoxFuel: keyboardBinding("f4", "F4") };
    const el = await mount(true);

    expect(isVisible(el)).toBe(true);
  });

  it("should show the SimHub info line when the only other bound boxes are SimHub roles", async () => {
    globalSettings = {
      blackBoxLapTiming: simhubBinding("Lap Timing"),
      blackBoxStandings: simhubBinding("Standings"),
      blackBoxFuel: keyboardBinding("f4", "F4"),
    };
    const el = await mount(true);

    expect(isVisible(el)).toBe(false);
    expect(isInfoVisible(el)).toBe(true);
  });

  // #962: the runtime primes keyboard-first, so a SimHub Lap Timing beside a
  // keyboard Standings is the atomic path — no flash, so nothing to say.
  it("should stay silent when a SimHub box sits beside a keyboard-bound prime (#962)", async () => {
    globalSettings = {
      blackBoxLapTiming: simhubBinding("Lap Timing"),
      blackBoxStandings: keyboardBinding("f2", "F2"),
      blackBoxFuel: keyboardBinding("f4", "F4"),
    };
    const el = await mount(true);

    expect(isVisible(el)).toBe(false);
    expect(isInfoVisible(el)).toBe(false);
  });

  it("should warn, not inform, when the target is unbound even if SimHub boxes exist", async () => {
    globalSettings = { blackBoxLapTiming: simhubBinding("Lap Timing") };
    const el = await mount(true);

    expect(isVisible(el)).toBe(true);
    expect(isInfoVisible(el)).toBe(false);
  });

  it("should warn when no black box is bound at all", async () => {
    const el = await mount(true);

    expect(isVisible(el)).toBe(true);
    expect(isInfoVisible(el)).toBe(false);
  });

  it("should stay silent with SimHub bindings when the feature is disabled", async () => {
    globalSettings = {
      blackBoxLapTiming: simhubBinding("Lap Timing"),
      blackBoxFuel: simhubBinding("Fuel Box"),
    };
    const el = await mount(false);

    expect(isVisible(el)).toBe(false);
    expect(isInfoVisible(el)).toBe(false);
  });

  it("should style the warning and the info line differently", async () => {
    const el = await mount(true);
    expect(line(el).classList.contains("ird-black-box-caveat-warning")).toBe(true);
    expect(line(el).classList.contains("ird-black-box-caveat-info")).toBe(false);

    notify({ blackBoxLapTiming: keyboardBinding("f1", "F1"), blackBoxFuel: simhubBinding("Fuel Box") });

    expect(isInfoVisible(el)).toBe(true);
    expect(line(el).classList.contains("ird-black-box-caveat-info")).toBe(true);
    expect(line(el).classList.contains("ird-black-box-caveat-warning")).toBe(false);
    // Both keep the shared supporting-text layout.
    expect(line(el).classList.contains("ird-supporting-text")).toBe(true);
  });

  it("should move from the info line to silence when a keyboard prime is bound", async () => {
    globalSettings = {
      blackBoxLapTiming: simhubBinding("Lap Timing"),
      blackBoxFuel: keyboardBinding("f4", "F4"),
    };
    const el = await mount(true);
    expect(isInfoVisible(el)).toBe(true);

    notify({
      blackBoxLapTiming: simhubBinding("Lap Timing"),
      blackBoxStandings: keyboardBinding("f2", "F2"),
      blackBoxFuel: keyboardBinding("f4", "F4"),
    });

    expect(isInfoVisible(el)).toBe(false);
    expect(isVisible(el)).toBe(false);
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

describe("binding classifiers", () => {
  it("should classify a keyboard binding", () => {
    const raw = keyboardBinding("f1", "F1");

    expect(isKeyboardBinding(raw)).toBe(true);
    expect(isSimHubBinding(raw)).toBe(false);
  });

  it("should classify a SimHub role", () => {
    const raw = simhubBinding("Fuel Box");

    expect(isSimHubBinding(raw)).toBe(true);
    expect(isKeyboardBinding(raw)).toBe(false);
  });

  it("should reject a SimHub value with no role", () => {
    expect(isSimHubBinding(JSON.stringify({ type: "simhub", role: "" }))).toBe(false);
    expect(isSimHubBinding(JSON.stringify({ type: "simhub" }))).toBe(false);
  });

  it("should accept already-parsed object values, like the runtime's parseBinding", () => {
    const keyboard = JSON.parse(keyboardBinding("f1", "F1")) as unknown;
    const simhub = JSON.parse(simhubBinding("Fuel Box")) as unknown;

    expect(isKeyboardBinding(keyboard)).toBe(true);
    expect(isSimHubBinding(keyboard)).toBe(false);
    expect(isSimHubBinding(simhub)).toBe(true);
    expect(isKeyboardBinding(simhub)).toBe(false);
    expect(isSimHubBinding({ type: "simhub", role: "" })).toBe(false);
    expect(isKeyboardBinding({ key: "f1" })).toBe(false);
  });

  it("should reject empty, corrupt and non-binding values", () => {
    for (const raw of ["", "not json", "{", "42", "null", undefined, null, 42, true, [], {}]) {
      expect(isSimHubBinding(raw)).toBe(false);
      expect(isKeyboardBinding(raw)).toBe(false);
    }
  });
});
