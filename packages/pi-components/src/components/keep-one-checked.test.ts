// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { installKeepOneChecked, isTicked, keepOneChecked } from "./keep-one-checked.js";

/**
 * The guard is tested against the REAL `sdpi-checkbox`, loaded from the
 * vendored bundle, rather than a stand-in. Two things here are properties of
 * that component and nothing else: which events a click on it produces (the
 * guard works by cancelling one), and what it then stores. The second is a
 * contract of its own (#1316): Replay Control's dial binds one box per speed to
 * `dial.speedStops.<token>`, where a token can be all digits (`"2"`), and its
 * schema accepts a plain token → boolean object and nothing else. A bundle
 * that wrote an array index, or the string `"false"`, would silently reset the
 * whole ladder to its defaults.
 */

type Frame = { event: string; payload?: unknown };

/** What the page sent to the deck host, in order. */
const sent: Frame[] = [];

/** The socket sdpi opens to the host; it only needs to open and to record. */
class FakeSocket {
  static last: FakeSocket | undefined;

  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;

  constructor() {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    sent.push(JSON.parse(data) as Frame);
  }
}

type SdpiCheckbox = HTMLElement & { value?: unknown; updateComplete: Promise<unknown> };

type SdpiWindow = Window & {
  connectElgatoStreamDeckSocket: (
    port: number,
    uuid: string,
    registerEvent: string,
    info: string,
    actionInfo: string,
  ) => void;
};

const ACTION = { action: "com.example.action", context: "ctx", device: "dev" };

/** The settings every checkbox on the page is told the action holds, as the host pushes them. */
async function pushSettings(settings: Record<string, unknown>): Promise<void> {
  FakeSocket.last?.onmessage?.({
    data: JSON.stringify({ ...ACTION, event: "didReceiveSettings", payload: { settings } }),
  });
  await settle();
}

/** Lets sdpi's promise chains (its settings load, then the save) and Lit's render run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function box(setting: string, ticked: boolean): SdpiCheckbox {
  const el = document.createElement("sdpi-checkbox") as SdpiCheckbox;

  el.setAttribute("setting", setting);
  el.setAttribute("label", setting);

  // An unticked default OMITS the attribute: `default="false"` renders ticked.
  if (ticked) el.setAttribute("default", "true");

  return el;
}

function inner(el: SdpiCheckbox): HTMLInputElement {
  const input = el.shadowRoot?.querySelector("input");

  if (!input) throw new Error("the sdpi-checkbox rendered no input");

  return input;
}

/** A click where the user makes it: on the label text, which forwards it to the hidden input. */
function clickLabel(el: SdpiCheckbox): void {
  const text = el.shadowRoot?.querySelector<HTMLElement>(".checkable-text");

  if (!text) throw new Error("the sdpi-checkbox rendered no label text");

  text.click();
}

/** The settings of the last save, or undefined when nothing was saved. */
function lastSaved(): Record<string, unknown> | undefined {
  return sent.filter((frame) => frame.event === "setSettings").at(-1)?.payload as Record<string, unknown> | undefined;
}

function saves(): number {
  return sent.filter((frame) => frame.event === "setSettings").length;
}

async function mount(...boxes: SdpiCheckbox[]): Promise<HTMLElement> {
  const group = document.createElement("div");

  group.append(...boxes);
  document.body.appendChild(group);
  await Promise.all(boxes.map((el) => el.updateComplete));

  return group;
}

beforeAll(async () => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

  // A path, not a `new URL(…)`: under jsdom the global URL is not the one `fileURLToPath` accepts.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundle = readFileSync(path.join(here, "../../browser/sdpi-components.js"), "utf-8");

  new Function(bundle)();

  (window as unknown as SdpiWindow).connectElgatoStreamDeckSocket(
    1,
    "pi",
    "registerPropertyInspector",
    "{}",
    JSON.stringify({ ...ACTION, payload: { settings: {} } }),
  );
  await settle();
});

beforeEach(async () => {
  document.body.replaceChildren();
  await pushSettings({});
  sent.length = 0;
});

describe("sdpi-checkbox on a nested setting whose last segment is numeric (#1316)", () => {
  it("stores a real boolean as a property of a plain object, never an array index", async () => {
    const two = box("dial.speedStops.2", true);
    const quarter = box("dial.speedStops.s4", false);

    await mount(two, quarter);
    await pushSettings({});

    clickLabel(two);
    await settle();
    clickLabel(quarter);
    await settle();

    const saved = lastSaved() as { dial: { speedStops: unknown } };

    expect(saved).toEqual({ dial: { speedStops: { "2": false, s4: true } } });
    expect(Array.isArray(saved.dial.speedStops)).toBe(false);
    expect(Object.getPrototypeOf(saved.dial.speedStops)).toBe(Object.prototype);
  });

  it("shows a default as ticked without storing it", async () => {
    const two = box("dial.speedStops.2", true);
    const three = box("dial.speedStops.3", false);

    await mount(two, three);
    await pushSettings({});

    expect(inner(two).checked).toBe(true);
    expect(inner(three).checked).toBe(false);
    expect(isTicked(two)).toBe(true);
    expect(isTicked(three)).toBe(false);
    expect(saves()).toBe(0);
  });

  it("shows the stored value over the default", async () => {
    const two = box("dial.speedStops.2", true);
    const three = box("dial.speedStops.3", false);

    await mount(two, three);
    await pushSettings({ dial: { speedStops: { "2": false, "3": true } } });
    await Promise.all([two.updateComplete, three.updateComplete]);

    expect(inner(two).checked).toBe(false);
    expect(inner(three).checked).toBe(true);
    expect(isTicked(two)).toBe(false);
    expect(isTicked(three)).toBe(true);
  });
});

describe("keepOneChecked (#1316)", () => {
  it("lets a box clear while another is still ticked", async () => {
    const one = box("stops.1", true);
    const two = box("stops.2", true);

    keepOneChecked(await mount(one, two));
    await pushSettings({});

    clickLabel(one);
    await settle();

    expect(inner(one).checked).toBe(false);
    expect(lastSaved()).toEqual({ stops: { "1": false } });
  });

  it("refuses to clear the last ticked box, and saves nothing", async () => {
    const one = box("stops.1", true);
    const two = box("stops.2", false);

    keepOneChecked(await mount(one, two));
    await pushSettings({});

    clickLabel(one);
    await settle();

    expect(inner(one).checked).toBe(true);
    expect(isTicked(one)).toBe(true);
    expect(saves()).toBe(0);
  });

  it("refuses a click that lands on the input itself", async () => {
    const one = box("stops.1", true);

    keepOneChecked(await mount(one));
    await pushSettings({});

    inner(one).click();
    await settle();

    expect(inner(one).checked).toBe(true);
    expect(saves()).toBe(0);
  });

  it("refuses the second of two clears, once the first has left one box ticked", async () => {
    const one = box("stops.1", true);
    const two = box("stops.2", true);

    keepOneChecked(await mount(one, two));
    await pushSettings({});

    clickLabel(one);
    clickLabel(two);
    await settle();

    expect(inner(one).checked).toBe(false);
    expect(inner(two).checked).toBe(true);
    expect(lastSaved()).toEqual({ stops: { "1": false } });
  });

  it("lets the last ticked box clear once another has been ticked", async () => {
    const one = box("stops.1", true);
    const two = box("stops.2", false);

    keepOneChecked(await mount(one, two));
    await pushSettings({});

    clickLabel(two);
    await settle();
    clickLabel(one);
    await settle();

    expect(inner(one).checked).toBe(false);
    expect(inner(two).checked).toBe(true);
    expect(lastSaved()).toEqual({ stops: { "1": false, "2": true } });
  });

  it("counts a stored tick the same as a default one", async () => {
    const one = box("stops.1", false);
    const two = box("stops.2", true);

    keepOneChecked(await mount(one, two));
    await pushSettings({ stops: { "1": true, "2": false } });

    clickLabel(one);
    await settle();

    expect(inner(one).checked).toBe(true);
    expect(saves()).toBe(0);
  });

  it("always lets a box be ticked", async () => {
    const one = box("stops.1", true);
    const two = box("stops.2", false);

    keepOneChecked(await mount(one, two));
    await pushSettings({});

    clickLabel(two);
    await settle();

    expect(inner(two).checked).toBe(true);
    expect(lastSaved()).toEqual({ stops: { "2": true } });
  });

  it("leaves a box outside the group alone", async () => {
    const inside = box("stops.1", true);
    const outside = box("other.1", true);

    keepOneChecked(await mount(inside));
    await mount(outside);
    await pushSettings({});

    clickLabel(outside);
    await settle();

    expect(inner(outside).checked).toBe(false);
    expect(lastSaved()).toEqual({ other: { "1": false } });
  });

  it("without the guard, the last box does clear: the refusal is the guard's", async () => {
    const one = box("stops.1", true);

    await mount(one);
    await pushSettings({});

    clickLabel(one);
    await settle();

    expect(inner(one).checked).toBe(false);
    expect(lastSaved()).toEqual({ stops: { "1": false } });
  });
});

describe("installKeepOneChecked (#1316)", () => {
  it("exposes the guard on the target window", () => {
    const target: { irdKeepOneChecked?: (group: HTMLElement, selector?: string) => void } = {};

    installKeepOneChecked(target);

    expect(target.irdKeepOneChecked).toBe(keepOneChecked);
  });

  it("keeps an existing guard on a second install", () => {
    const existing = (): void => {};
    const target = { irdKeepOneChecked: existing };

    installKeepOneChecked(target);

    expect(target.irdKeepOneChecked).toBe(existing);
  });
});
