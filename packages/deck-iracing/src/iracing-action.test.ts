import { describe, expect, it, vi } from "vitest";

import { IRacingAction } from "./iracing-action.js";

vi.mock("@iracedeck/deck-core", () => ({
  ConnectionStateAwareAction: class {},
}));

const controller = { marker: "controller" };

vi.mock("./sdk-singleton.js", () => ({ getController: () => controller }));

class Probe extends IRacingAction {
  read(): unknown {
    return this.sdkController;
  }
}

describe("IRacingAction", () => {
  it("exposes the SDK singleton's controller", () => {
    expect(new Probe().read()).toBe(controller);
  });
});
