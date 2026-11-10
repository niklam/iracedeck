// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * #1585: the Black Box dial's rotation-resolved gesture defaults rely on the
 * vendored `sdpi-select` treating `default` as render-only (documented in
 * `.claude/rules/sdpi-components.md`): the attribute picks what the dropdown
 * shows when the setting is unset, it never writes the setting, and only a user
 * pick stores a value, and only that key. `black-box-selector.ejs` changes
 * `default` from script when the rotation changes, so a bundle that stored it
 * would turn every unset slot into a stored choice the plugin could no longer
 * resolve. Pinned against the REAL bundle, not a stand-in.
 */

type Frame = { event: string; payload?: unknown };

const sent: Frame[] = [];

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

type SdpiSelect = HTMLElement & { value?: unknown; updateComplete: Promise<unknown> };

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

async function settle(): Promise<void> {
  for (let i = 0; i < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function pushSettings(settings: Record<string, unknown>): Promise<void> {
  FakeSocket.last?.onmessage?.({
    data: JSON.stringify({ ...ACTION, event: "didReceiveSettings", payload: { settings } }),
  });
  await settle();
}

function saves(): Frame[] {
  return sent.filter((frame) => frame.event === "setSettings");
}

function inner(el: SdpiSelect): HTMLSelectElement {
  const select = el.shadowRoot?.querySelector("select");

  if (!select) throw new Error("the sdpi-select rendered no select");

  return select;
}

function makeSelect(setting: string, fallback: string): SdpiSelect {
  const el = document.createElement("sdpi-select") as SdpiSelect;

  el.setAttribute("setting", setting);
  el.setAttribute("label", setting);
  el.setAttribute("default", fallback);

  for (const value of ["alpha", "beta", "gamma"]) {
    const option = document.createElement("option");

    option.value = value;
    option.textContent = value;
    el.appendChild(option);
  }

  return el;
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

describe("sdpi-select default is render-only (#1585)", () => {
  it("shows a default, and a changed default, without storing either", async () => {
    const el = makeSelect("dial.press", "alpha");

    document.body.appendChild(el);
    await el.updateComplete;
    await pushSettings({});

    expect(inner(el).value).toBe("alpha");

    el.setAttribute("default", "gamma");
    await el.updateComplete;
    await settle();

    expect(inner(el).value).toBe("gamma");
    expect(saves()).toHaveLength(0);
  });

  it("stores only the picked key, once, on a user pick", async () => {
    const press = makeSelect("dial.press", "alpha");
    const long = makeSelect("dial.longPress", "alpha");

    document.body.append(press, long);
    await Promise.all([press.updateComplete, long.updateComplete]);
    await pushSettings({});

    const select = inner(press);

    select.value = "beta";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    expect(saves()).toHaveLength(1);
    expect(saves()[0].payload).toEqual({ dial: { press: "beta" } });
  });
});
