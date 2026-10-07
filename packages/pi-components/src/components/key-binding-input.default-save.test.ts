// @vitest-environment jsdom
import { defaultBindingStoredValue } from "@iracedeck/app-constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _simHubProbe } from "./key-binding-input.js";

vi.mock("./simhub-probe.js", () => ({
  probeSimHub: vi.fn(async () => ({ reachable: false, roles: [] })),
  SETTINGS_WINDOW_FLAG: "__irdSettingsWindow",
}));

type Deliver = (value: string) => void;

/**
 * The plugin seeds a binding default at startup (#1277, deck-core
 * `seedBindingDefaultsIfAbsent`) as `defaultBindingStoredValue(default)`. That
 * value must be exactly what this field saves when it mounts over a setting
 * that holds nothing, or a seeded key and one set by opening its panel would
 * be two different stored strings for the same binding. The parser is shared;
 * this pins the field's own path from the `default` attribute to `save()`.
 */
describe("ird-key-binding — the default it saves on mount is the seeded value, byte for byte (#1277)", () => {
  const deliveries = new Map<string, Deliver>();
  const save = vi.fn<(value: string) => void>();

  beforeEach(() => {
    deliveries.clear();
    save.mockReset();
    _simHubProbe.reset();

    // sdpi's hook: registers the key's callback and returns [getter, save];
    // the stored value is delivered later, as sdpi does once settings arrive.
    const useGlobalSettings = vi.fn((key: string, onValue: Deliver) => {
      deliveries.set(key, onValue);

      return [async () => "", save] as const;
    });

    (window as unknown as Record<string, unknown>).SDPIComponents = {
      useGlobalSettings,
      useSettings: useGlobalSettings,
    };
  });

  afterEach(() => {
    document.body.replaceChildren();
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
    _simHubProbe.reset();
    vi.restoreAllMocks();
  });

  /** Mount a global binding field for `setting` with `defaultText`, then deliver an empty stored value. */
  function mountOverNothing(setting: string, defaultText: string): void {
    const field = document.createElement("ird-key-binding");
    field.setAttribute("setting", setting);
    field.setAttribute("default", defaultText);
    field.setAttribute("global", "");
    document.body.appendChild(field);

    const deliver = deliveries.get(setting);

    expect(deliver, "the field subscribed to its setting").toBeDefined();
    deliver?.("");
  }

  it.each([
    ["replayControlNextCar", "V"],
    ["replayControlPrevCar", "Shift+V"],
  ])("%s with default %s", (setting, defaultText) => {
    mountOverNothing(setting, defaultText);

    const expected = defaultBindingStoredValue(defaultText);

    expect(expected).toBeDefined();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expected);
  });

  it("saves an empty string for a default that names no key — which the seed deliberately never stores", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    mountOverNothing("someBinding", "Hyper+Q1");

    expect(defaultBindingStoredValue("Hyper+Q1")).toBeUndefined();
    expect(save).toHaveBeenCalledWith("");
  });
});
