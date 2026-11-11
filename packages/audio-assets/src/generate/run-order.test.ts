import { describe, expect, it } from "vitest";

import { type VoiceConfig, VoiceConfigSchema } from "./config.ts";
import { entryReferences, orderVoices, topologicalEntryOrder } from "./run-order.ts";

function buildVoice(groups: Record<string, Array<Record<string, unknown>>>): VoiceConfig {
  return VoiceConfigSchema.parse({
    id: "voice-id",
    label: "Test",
    model_id: "eleven_test_model",
    voice_settings: { stability: 1, similarity_boost: 1 },
    groups,
  });
}

const keys = (voice: VoiceConfig): string[] => topologicalEntryOrder(voice).map((node) => node.key);

describe("orderVoices", () => {
  it("puts default first and sorts the rest by id", () => {
    expect(orderVoices(["titan", "shawn", "default", "alpha"])).toEqual(["default", "alpha", "shawn", "titan"]);
  });

  it("sorts every voice by id when there is no default", () => {
    expect(orderVoices(["titan", "alpha"])).toEqual(["alpha", "titan"]);
  });
});

describe("entryReferences", () => {
  it("returns the slash references of both fields, deduplicated, raw ids left out", () => {
    const voice = buildVoice({
      a: [{ name: "x", text: "x" }],
      b: [{ name: "y", text: "y" }],
      c: [
        {
          name: "z",
          text: "z",
          previous_request_ids: ["a/x", "raw-request-id"],
          next_request_ids: ["b/y", "a/x"],
        },
      ],
    });

    expect(entryReferences(voice.groups.c![0]!)).toEqual(["a/x", "b/y"]);
  });
});

describe("topologicalEntryOrder", () => {
  it("keeps config order — groups, then entries — when nothing references anything", () => {
    const voice = buildVoice({
      b: [
        { name: "2", text: "two" },
        { name: "1", text: "one" },
      ],
      a: [{ name: "x", text: "x" }],
    });

    expect(keys(voice)).toEqual(["b/2", "b/1", "a/x"]);
  });

  it("moves a dependent listed before its dependency in the same group after it", () => {
    const voice = buildVoice({
      g: [
        { name: "dependent", text: "d", previous_request_ids: ["g/dependency"] },
        { name: "other", text: "o" },
        { name: "dependency", text: "p" },
      ],
    });

    // The dependent waits for its dependency; the unrelated entry keeps its place.
    expect(keys(voice)).toEqual(["g/other", "g/dependency", "g/dependent"]);
  });

  it("orders across groups, a whole chain, with config order as the tie-break", () => {
    const voice = buildVoice({
      tail: [
        { name: "1", text: "point one", previous_request_ids: ["time/a"] },
        { name: "2", text: "point two", previous_request_ids: ["time/a"] },
      ],
      time: [
        { name: "a", text: "one twenty", previous_request_ids: ["intro/x"] },
        { name: "b", text: "one thirty" },
      ],
      intro: [{ name: "x", text: "Last lap was." }],
    });

    expect(keys(voice)).toEqual(["time/b", "intro/x", "time/a", "tail/1", "tail/2"]);
  });

  it("waits for every dependency, previous and next alike", () => {
    const voice = buildVoice({
      mid: [{ name: "x", text: "mid", previous_request_ids: ["late/a"], next_request_ids: ["late/b"] }],
      late: [
        { name: "a", text: "a" },
        { name: "filler", text: "f" },
        { name: "b", text: "b" },
      ],
    });

    expect(keys(voice)).toEqual(["late/a", "late/filler", "late/b", "mid/x"]);
  });

  it("places every entry exactly once", () => {
    const voice = buildVoice({
      a: [
        { name: "1", text: "1", previous_request_ids: ["b/1", "b/2"] },
        { name: "2", text: "2", previous_request_ids: ["b/1"], next_request_ids: ["b/1"] },
      ],
      b: [
        { name: "1", text: "1" },
        { name: "2", text: "2", previous_request_ids: ["b/1"] },
      ],
    });

    const order = keys(voice);

    expect(order).toHaveLength(4);
    expect(new Set(order).size).toBe(4);
    expect(order.indexOf("b/1")).toBeLessThan(order.indexOf("b/2"));
    expect(order.indexOf("b/2")).toBeLessThan(order.indexOf("a/1"));
    expect(order.indexOf("b/1")).toBeLessThan(order.indexOf("a/2"));
  });

  it("throws on a cycle rather than dropping its entries", () => {
    const voice = buildVoice({
      a: [{ name: "x", text: "x", previous_request_ids: ["b/y"] }],
      b: [{ name: "y", text: "y", previous_request_ids: ["a/x"] }],
    });

    expect(() => topologicalEntryOrder(voice)).toThrow(/Reference cycle among a\/x, b\/y/);
  });
});
