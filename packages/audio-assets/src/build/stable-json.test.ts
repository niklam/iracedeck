import { describe, expect, it } from "vitest";

import { serializeSortedJson, sortKeysDeep } from "./stable-json.mjs";

describe("stable-json", () => {
  it("sorts keys at every depth and keeps arrays in order", () => {
    const sorted = sortKeysDeep({ b: { z: 1, a: [{ y: 2, x: 1 }, "k", 3] }, a: null, c: "s" });

    expect(JSON.stringify(sorted)).toBe('{"a":null,"b":{"a":[{"x":1,"y":2},"k",3],"z":1},"c":"s"}');
  });

  it("serializes two insertion orders of one object to the same bytes, two-space LF with a trailing newline", () => {
    const first = serializeSortedJson({ version: "1.0.0", id: "default", voices: [{ label: "D", id: "default" }] });
    const second = serializeSortedJson({ voices: [{ id: "default", label: "D" }], id: "default", version: "1.0.0" });

    expect(second).toBe(first);
    expect(first).toBe(
      '{\n  "id": "default",\n  "version": "1.0.0",\n  "voices": [\n    {\n      "id": "default",\n      "label": "D"\n    }\n  ]\n}\n',
    );
    expect(first).not.toContain("\r");
  });
});
