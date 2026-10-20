import { describe, expect, it } from "vitest";

import { findControlBytes, hex } from "./control-bytes.mjs";

describe("findControlBytes", () => {
  it("allows tab, LF and CR", () => {
    expect(findControlBytes(Buffer.from("a\tb\r\nc\n"))).toEqual([]);
  });

  it("reports NUL, the other C0 bytes and DEL with their position", () => {
    const buffer = Buffer.from([0x61, 0x00, 0x0a, 0x62, 0x63, 0x03, 0x1f, 0x0a, 0x7f]);

    expect(findControlBytes(buffer)).toEqual([
      { line: 1, column: 2, byte: 0x00 },
      { line: 2, column: 3, byte: 0x03 },
      { line: 2, column: 4, byte: 0x1f },
      { line: 3, column: 1, byte: 0x7f },
    ]);
  });

  it("does not report the bytes of a multi-byte UTF-8 character", () => {
    expect(findControlBytes(Buffer.from("– “é” ✓", "utf8"))).toEqual([]);
  });

  it("counts a multi-byte character as one column", () => {
    const buffer = Buffer.concat([Buffer.from("“é”", "utf8"), Buffer.from([0x00])]);

    expect(findControlBytes(buffer)).toEqual([{ line: 1, column: 4, byte: 0x00 }]);
  });
});

describe("hex", () => {
  it("pads to two digits", () => {
    expect(hex(0x03)).toBe("0x03");
    expect(hex(0x7f)).toBe("0x7f");
  });
});
