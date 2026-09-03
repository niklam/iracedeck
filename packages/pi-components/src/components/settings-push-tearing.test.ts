// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import "./key-binding-input.js";
import "./voice-pack-catalog.js";
import "./voice-pack-list.js";
import "./voice-select.js";
import "./warnings.js";

/**
 * How much of the settings window redoes its work when ONE unrelated key
 * changes (#1100).
 *
 * This is a measurement, not a behavioural assertion, and it exists because the
 * thing being fixed is work NOT happening — which no ordinary green test can
 * show. The fake hook below deliberately reproduces sdpi's real behaviour
 * rather than an idealised one: its `use()` subscribes to the raw
 * `didReceiveGlobalSettings` event and re-invokes EVERY registered callback
 * with its key's current value on EVERY push, with no comparison against what
 * it last delivered. That is verifiable in `browser/sdpi-components.js`.
 *
 * Before the shared `skipUnchanged` filter, a `_voicePackStatus` push — which
 * lands about once a second for the whole of a voice download — therefore
 * rebuilt option lists, re-parsed 236 key bindings and rewrote their icons, and
 * re-rendered the warnings banner, every second, because one key nothing on
 * screen was watching had moved.
 */

type Settings = Record<string, string>;

const registered: { key: string; callback: (value: string) => void }[] = [];

function installFakeSdpi(): void {
  const use = (key: string, callback?: (value: string) => void) => {
    if (callback) registered.push({ key, callback });

    return [async () => "", vi.fn()];
  };

  (window as unknown as { SDPIComponents: unknown }).SDPIComponents = {
    useGlobalSettings: use,
    useSettings: use,
    streamDeckClient: { send: vi.fn(), getGlobalSettings: vi.fn() },
  };
}

/** One push, delivered the way sdpi delivers: to every subscription. */
function push(settings: Settings): void {
  for (const { key, callback } of registered) callback(settings[key] ?? "");
}

const BASE: Settings = {
  blackBoxLapTiming: JSON.stringify({ type: "keyboard", key: "f1", modifiers: [] }),
  raceEngineerVoice: "default",
  _raceEngineerVoices: JSON.stringify(["default", "luca"]),
  _voiceLabels: JSON.stringify({ luca: "Luca" }),
  _warnings: JSON.stringify([{ id: "x", level: "info", message: "hello" }]),
  _voicePacks: JSON.stringify({
    packs: [{ id: "luca", label: "Luca", version: "1.2.0", voices: [{ id: "luca", label: "Luca" }] }],
    problems: [],
  }),
  _voicePackStatus: JSON.stringify({ catalog: { state: "unknown" }, installs: {} }),
};

/** Only the download-progress key moves, exactly as it does once a second. */
const PROGRESS_MOVED: Settings = {
  ...BASE,
  _voicePackStatus: JSON.stringify({
    catalog: { state: "unknown" },
    installs: { luca: { phase: "downloading", receivedBytes: 4_000_000, totalBytes: 8_000_000 } },
  }),
};

describe("an unrelated settings push does not tear the settings window (#1100)", () => {
  beforeEach(() => {
    registered.length = 0;
    document.body.replaceChildren();
    installFakeSdpi();
  });

  it("touches only the component whose key changed", async () => {
    const host = document.createElement("div");

    // A representative slice of the real page. Twenty key bindings rather than
    // the real 236 — the point is the ratio, and 236 would make this slow for
    // no extra information.
    for (let i = 0; i < 20; i += 1) {
      const binding = document.createElement("ird-key-binding");

      binding.setAttribute("setting", "blackBoxLapTiming");
      binding.setAttribute("global", "");
      host.appendChild(binding);
    }

    for (const tag of ["ird-warnings", "ird-voice-select", "ird-voice-pack-list", "ird-voice-pack-catalog"]) {
      host.appendChild(document.createElement(tag));
    }

    document.body.appendChild(host);
    await Promise.resolve();

    // Settle everything at the base state first.
    push(BASE);
    await Promise.resolve();

    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));

    observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });

    push(PROGRESS_MOVED);
    await Promise.resolve();
    observer.takeRecords().forEach((r) => mutations.push(r));
    observer.disconnect();

    const touched = new Set(
      mutations.map((m) => {
        const node = m.target.nodeType === Node.TEXT_NODE ? m.target.parentElement : (m.target as Element);

        return node
          ?.closest("ird-key-binding, ird-warnings, ird-voice-select, ird-voice-pack-list, ird-voice-pack-catalog")
          ?.tagName.toLowerCase();
      }),
    );

    touched.delete(undefined);

    console.log(`unrelated push touched: ${[...touched].join(", ") || "nothing"} (${mutations.length} mutations)`);

    // The catalog owns `_voicePackStatus`, so it SHOULD react. Nothing else may.
    expect([...touched]).toEqual(["ird-voice-pack-catalog"]);
  });
});
