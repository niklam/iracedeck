// @vitest-environment jsdom
import { qualifiedVoiceId, qualifyVoiceId, splitVoiceId, VOICE_ID_SEPARATOR } from "@iracedeck/callout-script";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Importing the module also registers the custom element.
import { qualifyVoice, splitVoice, VOICE_SEPARATOR, voiceHalf } from "./voice-select.js";

type SettingsCallback = (value: string) => void;

interface MockSDPIState {
  callbacks: Map<string, SettingsCallback>;
  saves: Map<string, ReturnType<typeof vi.fn>>;
}

function installMockSDPI(): MockSDPIState {
  const state: MockSDPIState = { callbacks: new Map(), saves: new Map() };

  const useGlobalSettings = (key: string, callback: SettingsCallback): [() => Promise<string>, unknown] => {
    state.callbacks.set(key, callback);

    const save = vi.fn();
    state.saves.set(key, save);

    return [async () => "", save];
  };

  (window as unknown as Record<string, unknown>).SDPIComponents = { useGlobalSettings };

  return state;
}

describe("ird-voice-select", () => {
  let el: HTMLElement;
  let mock: MockSDPIState;

  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    mock = installMockSDPI();
    el = document.createElement("ird-voice-select");
    document.body.appendChild(el);
  });

  const publishVoices = (voices: string[]): void =>
    void mock.callbacks.get("_raceEngineerVoices")?.(JSON.stringify(voices));
  const publishChoice = (value: string): void => void mock.callbacks.get("raceEngineerVoice")?.(value);
  const publishLabels = (labels: unknown): void =>
    void mock.callbacks.get("_voiceLabels")?.(typeof labels === "string" ? labels : JSON.stringify(labels));
  const save = (): ReturnType<typeof vi.fn> => mock.saves.get("raceEngineerVoice")!;
  const selected = (): string => (el.querySelector("select") as HTMLSelectElement).value;
  const options = (): { value: string; text: string }[] =>
    Array.from((el.querySelector("select") as HTMLSelectElement).options).map((o) => ({
      value: o.value,
      text: o.textContent ?? "",
    }));

  it("selects the saved voice when it is in the list", () => {
    publishChoice("nina");
    publishVoices(["default", "nina"]);

    expect(selected()).toBe("nina");
    expect(save()).not.toHaveBeenCalled();
  });

  it("seeds a choice on a fresh install, where there is none to lose", () => {
    publishChoice("");
    publishVoices(["default"]);

    expect(selected()).toBe("default");
    expect(save()).toHaveBeenCalledWith("default");
  });

  describe("the default anchor (#1034)", () => {
    // The dropdown's half of `resolveActiveRaceEngineerVoice`'s anchor. Without
    // it both fell to the first option, which a pack named `aria` wins — and the
    // dropdown would then disagree with what the plugin actually plays. The ids
    // are composite, as the plugin publishes them since #1144, and the anchor
    // is the one `race-engineer-settings.ejs` sets.

    beforeEach(() => {
      el.setAttribute("default", "default::default");
    });

    it("shows the default voice rather than an alphabetically earlier pack", () => {
      publishChoice("");
      publishVoices(["aria::aria", "default::default"]);

      expect(selected()).toBe("default::default");
      expect(save()).toHaveBeenCalledWith("default::default");
    });

    it("falls through to the first entry when the anchor is not installed", () => {
      publishChoice("");
      publishVoices(["aria::aria", "zeta::zeta"]);

      expect(selected()).toBe("aria::aria");
    });

    it("never overrides a voice the user actually chose", () => {
      publishChoice("aria::aria");
      publishVoices(["aria::aria", "default::default"]);

      expect(selected()).toBe("aria::aria");
      expect(save()).not.toHaveBeenCalled();
    });

    it("shows the anchor for a pre-#1144 bare value without persisting over it — the plugin qualifies it", () => {
      publishChoice("default");
      publishVoices(["aria::aria", "default::default"]);

      expect(selected()).toBe("default::default");
      expect(save()).not.toHaveBeenCalled();
    });
  });

  describe("a pre-#1144 bare value, read as the plugin reads it (#1144)", () => {
    // `resolveActiveRaceEngineerVoice` qualifies a stored bare id before it
    // falls back, and the migration that writes the composite down waits for
    // the managed pack. Until then the dropdown must show the voice that
    // actually plays — never the first entry — and must write nothing.

    beforeEach(() => {
      el.setAttribute("default", "default::default");
    });

    it("shows the only pack that provides it, not the first entry, when the managed pack is absent", () => {
      publishChoice("luca");
      publishVoices(["aaa::x", "luca::luca"]);

      expect(selected()).toBe("luca::luca");
      expect(save()).not.toHaveBeenCalled();
    });

    it("prefers the managed pack's voice of that id over an alphabetically earlier pack", () => {
      publishChoice("matt");
      publishVoices(["aaa::matt", "default::matt", "zzz::matt"]);

      expect(selected()).toBe("default::matt");
      expect(save()).not.toHaveBeenCalled();
    });

    it("otherwise takes the alphabetically first PACK id, not the first composite string", () => {
      publishChoice("v");
      publishVoices(["a-b::v", "a::v"]);

      expect(selected()).toBe("a::v");
    });

    it("reads the managed pack from its own `default` attribute, never a hard-coded id", () => {
      el.setAttribute("default", "other::other");
      publishChoice("matt");
      publishVoices(["aaa::matt", "default::matt", "other::matt"]);

      expect(selected()).toBe("other::matt");
    });

    it("skips the managed step when the `default` attribute names no composite voice", () => {
      // `default::matt` is listed first, so neither the plain fallback nor a
      // hard-coded `default` managed pack can produce the alphabetical answer.
      el.removeAttribute("default");
      publishChoice("matt");
      publishVoices(["default::matt", "aaa::matt"]);

      expect(selected()).toBe("aaa::matt");
      expect(save()).not.toHaveBeenCalled();
    });

    it("keeps a bare value that is itself in the list, beside a pack's voice of the same id", () => {
      publishChoice("default");
      publishVoices(["default", "default::default"]);

      expect(selected()).toBe("default");
    });

    it("still falls back, without persisting, for a bare value no pack provides", () => {
      publishChoice("ghost");
      publishVoices(["aaa::x", "default::default"]);

      expect(selected()).toBe("default::default");
      expect(save()).not.toHaveBeenCalled();
    });
  });

  describe("a voice that leaves the list (#1034)", () => {
    // The list became a function of what is on disk. A pack folder locked by a
    // sync client or an AV scanner is reported as a problem while the scan
    // SUCCEEDS, so one press of Rescan can shrink the list without the user
    // having removed anything.

    it("shows the fallback but does NOT overwrite the saved voice", () => {
      publishChoice("nina");
      publishVoices(["default", "nina"]);
      publishVoices(["default"]);

      expect(selected()).toBe("default");
      expect(save()).not.toHaveBeenCalled();
    });

    it("restores the user's voice when the pack comes back", () => {
      publishChoice("nina");
      publishVoices(["default", "nina"]);
      publishVoices(["default"]);
      publishVoices(["default", "nina"]);

      expect(selected()).toBe("nina");
      expect(save()).not.toHaveBeenCalled();
    });
  });

  describe("voice labels (#1034)", () => {
    // A pack names its voices; the dropdown showed `titleCase(id)` before it
    // could, which rendered a hyphenated id as `Aaa-testvoice`.

    it("shows a pack's declared name instead of the capitalised id", () => {
      publishVoices(["aaa-test", "default"]);
      publishLabels({ "aaa-test": "AAA Test Voice" });

      expect(options()).toEqual([
        { value: "aaa-test", text: "AAA Test Voice" },
        { value: "default", text: "Default" },
      ]);
    });

    it("keeps the id as the option VALUE, so what is stored is unaffected", () => {
      // The label is presentation. `raceEngineerVoice` stores an id, the anchor
      // compares an id, and a renamed label must not look like a changed voice.
      publishChoice("aaa-test");
      publishVoices(["aaa-test"]);
      publishLabels({ "aaa-test": "AAA Test Voice" });

      expect(selected()).toBe("aaa-test");
      expect(save()).not.toHaveBeenCalled();
    });

    it("falls back to the capitalised id for a voice no pack named", () => {
      // A voice with no manifest has no entry — which is why it needs no
      // special case anywhere.
      publishVoices(["default"]);
      publishLabels({});

      expect(options()).toEqual([{ value: "default", text: "Default" }]);
    });

    it("capitalises only the voice half of a composite id no label names (#1144)", () => {
      // `default::default` is an identity, never something to read.
      publishVoices(["default::default", "luca::matt-two"]);
      publishLabels({});

      expect(options()).toEqual([
        { value: "default::default", text: "Default" },
        { value: "luca::matt-two", text: "Matt-two" },
      ]);
    });

    it("retitles the existing options when labels arrive after the list", () => {
      // Both are written in one call, but sdpi delivers per key and the order is
      // not ours to choose.
      publishVoices(["aaa-test"]);

      expect(options()).toEqual([{ value: "aaa-test", text: "Aaa-test" }]);

      publishLabels({ "aaa-test": "AAA Test Voice" });

      expect(options()).toEqual([{ value: "aaa-test", text: "AAA Test Voice" }]);
    });

    it("applies labels that arrived BEFORE any voice list", () => {
      // sdpi delivers per key, so this order is reachable — and it is the one
      // the labels callback's `voicesLoaded` guard exists for. Every other test
      // here publishes the list first, which only ever exercises the guard in
      // the true direction.
      publishLabels({ "aaa-test": "AAA Test Voice" });
      publishVoices(["aaa-test"]);

      expect(options()).toEqual([{ value: "aaa-test", text: "AAA Test Voice" }]);
    });

    it("cannot invent a voice — a label with no matching id adds no option", () => {
      publishVoices(["default"]);
      publishLabels({ ghost: "Ghost", default: "Default" });

      expect(options().map((o) => o.value)).toEqual(["default"]);
    });

    it.each([
      ["malformed JSON", "{not json"],
      ["an array", ["nope"]],
      ["a non-string label", { "aaa-test": 42 }],
    ])("ignores %s and still renders the voices", (_case, payload) => {
      // A pack manifest is a third party's file: a bad entry costs that entry
      // its label and nothing else.
      publishVoices(["aaa-test"]);
      publishLabels(payload);

      expect(options()).toEqual([{ value: "aaa-test", text: "Aaa-test" }]);
    });
  });
});

describe("VOICE_SEPARATOR — the browser copy of the composite voice id's separator (#1144)", () => {
  // The component cannot import `@iracedeck/callout-script` (see the constant's
  // comment), so it keeps a copy. A copy that drifted would show every
  // unlabelled pack voice as its whole composite id.

  it("is callout-script's VOICE_ID_SEPARATOR", () => {
    expect(VOICE_SEPARATOR).toBe(VOICE_ID_SEPARATOR);
  });

  it.each([
    ["a composite id", qualifiedVoiceId("luca", "matt")],
    ["the managed voice", qualifiedVoiceId("default", "default")],
    ["a bare id", "default"],
    ["an empty pack half", "::matt"],
    ["an empty voice half", "luca::"],
    ["more than one separator", "a::b::c"],
  ])("reads the voice half of %s exactly as splitVoiceId does", (_case, id) => {
    expect(voiceHalf(id)).toBe(splitVoiceId(id)?.voiceId ?? id);
  });

  it.each([
    ["a composite id", qualifiedVoiceId("luca", "matt")],
    ["a bare id", "default"],
    ["the empty string", ""],
    ["an empty pack half", "::matt"],
    ["an empty voice half", "luca::"],
    ["more than one separator", "a::b::c"],
  ])("splits %s exactly as splitVoiceId does", (_case, id) => {
    expect(splitVoice(id)).toEqual(splitVoiceId(id));
  });
});

describe("qualifyVoice — the browser copy of callout-script's qualifyVoiceId (#1144)", () => {
  // The dropdown reads a stored bare id through the same rule the plugin's
  // resolver does, so the two show and play the same voice. A copy for the
  // reason `VOICE_SEPARATOR` is one; this table is what keeps it the same rule.

  const MANAGED = "default";

  it.each<[string, string, string[], string]>([
    ["an empty value", "", ["default::default"], MANAGED],
    ["a composite value", "luca::matt", ["default::matt"], MANAGED],
    ["a composite whose pack is absent", "gone::matt", ["default::default"], MANAGED],
    ["a bare value that is itself available", "default", ["default", "default::default"], MANAGED],
    ["a bare value the managed pack provides", "matt", ["aaa::matt", "default::matt"], MANAGED],
    ["a bare value only another pack provides", "luca", ["aaa::x", "luca::luca"], MANAGED],
    ["a bare value several other packs provide", "matt", ["zzz::matt", "bbb::matt"], MANAGED],
    ["pack ids that sort apart from their composites", "v", ["a-b::v", "a::v"], MANAGED],
    ["a bare value no pack provides", "ghost", ["default::default", "aaa::matt"], MANAGED],
    ["an empty list", "matt", [], MANAGED],
    ["malformed available entries", "matt", ["::matt", "a::matt::b", "b-pack::matt"], MANAGED],
    ["another managed pack", "matt", ["aaa::matt", "default::matt", "other::matt"], "other"],
    ["no managed pack at all", "matt", ["default::matt", "aaa::matt"], ""],
  ])("qualifies %s exactly as qualifyVoiceId does", (_case, stored, available, managed) => {
    expect(qualifyVoice(stored, available, managed)).toBe(qualifyVoiceId(stored, available, managed));
  });
});
