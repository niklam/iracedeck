import { describe, expect, it } from "vitest";

import { statusBarNA, statusBarOff, statusBarOn } from "./status-bar.js";

describe("statusBarOn", () => {
  it("should return SVG with green fill and ON text", () => {
    const result = statusBarOn();
    expect(result).toContain('fill="#2ecc71"');
    expect(result).toContain(">ON</text>");
  });

  it("should have correct position and dimensions", () => {
    const result = statusBarOn();
    expect(result).toContain('x="0" y="100" width="144" height="44"');
  });
});

describe("statusBarOff", () => {
  it("should return SVG with red fill and OFF text", () => {
    const result = statusBarOff();
    expect(result).toContain('fill="#e74c3c"');
    expect(result).toContain(">OFF</text>");
  });

  it("should have correct position and dimensions", () => {
    const result = statusBarOff();
    expect(result).toContain('x="0" y="100" width="144" height="44"');
  });
});

describe("statusBarNA", () => {
  it("should return SVG with gray fill and N/A text", () => {
    const result = statusBarNA();
    expect(result).toContain('fill="#888888"');
    expect(result).toContain(">N/A</text>");
  });

  it("should have correct position and dimensions", () => {
    const result = statusBarNA();
    expect(result).toContain('x="0" y="100" width="144" height="44"');
  });
});
