/**
 * Tests for user-entered title template resolution (issue #899).
 *
 * The sim connection is a fake, so these tests pin what title-template.ts
 * itself decides: the `{{` gate and the fallback when the connection throws.
 * How a sim renders a template (iRacing's empty context included) is tested
 * with its connection, in iracing-sim-connection.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSimConnection, type FakeSimConnection } from "./fake-sim-connection.js";
import { resolveTitleTemplate, titleHasTemplate } from "./title-template.js";

const sim = vi.hoisted(() => ({ fake: null as FakeSimConnection | null, initialized: true }));

vi.mock("./sim-connection.js", () => ({
  getSimConnection: () => sim.fake!.connection,
  isSimConnectionInitialized: () => sim.initialized,
}));

beforeEach(() => {
  sim.fake = createFakeSimConnection();
  sim.initialized = true;
});

describe("titleHasTemplate", () => {
  it("returns false for undefined", () => {
    expect(titleHasTemplate(undefined)).toBe(false);
  });

  it("returns false for plain text", () => {
    expect(titleHasTemplate("NEXT CAR")).toBe(false);
  });

  it("returns true for text containing a placeholder", () => {
    expect(titleHasTemplate("CAR {{track_ahead.car_number}}")).toBe(true);
  });
});

describe("resolveTitleTemplate", () => {
  it("does not consult the connection for text without {{", () => {
    const resolve = vi.spyOn(sim.fake!.connection, "resolveTitleTemplate");

    expect(resolveTitleTemplate("Plain")).toBe("Plain");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolves templated text through the sim connection", () => {
    sim.fake!.state.resolve = (text) => text.replace("{{track_ahead.car_number}}", "34");

    expect(resolveTitleTemplate("CAR {{track_ahead.car_number}}")).toBe("CAR 34");
  });

  it("falls back to the raw text when the connection throws", () => {
    sim.fake!.state.resolve = () => {
      throw new Error("boom");
    };

    expect(resolveTitleTemplate("v={{x}}")).toBe("v={{x}}");
  });
});
