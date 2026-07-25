import { describe, expect, it } from "vitest";

import { buildCornerSnapshot } from "./refresh.js";

describe("buildCornerSnapshot", () => {
  it("keeps named turns with a start position, sorted by start", () => {
    const snapshot = buildCornerSnapshot([
      {
        trackId: "bathurst",
        turn: [
          { start: 0.22, end: 0.267, name: "Quarry Bend" },
          { start: 0.046, end: 0.075, name: "Hell Corner" },
        ],
      },
    ]);

    expect(snapshot).toEqual({
      bathurst: [
        { start: 0.046, name: "Hell Corner" },
        { start: 0.22, name: "Quarry Bend" },
      ],
    });
  });

  it("falls back to the apex marker when start is absent", () => {
    const snapshot = buildCornerSnapshot([{ trackId: "x", turn: [{ marker: 0.5, name: "Apex Only" }] }]);

    expect(snapshot).toEqual({ x: [{ start: 0.5, name: "Apex Only" }] });
  });

  it("drops unnamed turns, turns without a position, and tracks left empty", () => {
    const snapshot = buildCornerSnapshot([
      { trackId: "empty", turn: [{ start: 0.1, end: 0.2 }, { name: "No Position" }] },
    ]);

    expect(snapshot).toEqual({});
  });

  it("normalizes names (T-shorthand, naem typo, whitespace)", () => {
    const snapshot = buildCornerSnapshot([
      {
        trackId: "x",
        turn: [
          { start: 0.1, naem: "T5" },
          { start: 0.2, name: "  Eau   Rouge " },
        ],
      },
    ]);

    expect(snapshot.x).toEqual([
      { start: 0.1, name: "Turn 5" },
      { start: 0.2, name: "Eau Rouge" },
    ]);
  });

  it("drops out-of-range positions", () => {
    const snapshot = buildCornerSnapshot([
      {
        trackId: "x",
        turn: [
          { start: 1.2, name: "Bad" },
          { start: -0.1, name: "Worse" },
          { start: 0.3, name: "Ok" },
        ],
      },
    ]);

    expect(snapshot.x).toEqual([{ start: 0.3, name: "Ok" }]);
  });
});
