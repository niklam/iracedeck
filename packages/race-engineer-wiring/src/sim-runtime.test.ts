import * as translator from "@iracedeck/sim-events-iracing";
import { describe, expect, it } from "vitest";

import { createIracingSimRuntime } from "./sim-runtime.js";

describe("createIracingSimRuntime", () => {
  it("hands out the translator's own query functions, unwrapped", () => {
    const sim = createIracingSimRuntime();

    for (const [name, fn] of Object.entries(sim)) {
      expect(fn, name).toBe((translator as Record<string, unknown>)[name]);
    }

    expect(Object.keys(sim)).toHaveLength(17);
  });
});
