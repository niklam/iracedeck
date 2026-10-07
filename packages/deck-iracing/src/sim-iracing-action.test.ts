import { describe, expect, it, vi } from "vitest";

import { SimIRacingAction } from "./sim-iracing-action.js";

vi.mock("@iracedeck/deck-core", () => ({
  ConnectionStateAwareAction: class {},
}));

const controller = { marker: "controller" };

vi.mock("./sdk-singleton.js", () => ({ getController: () => controller }));

class Probe extends SimIRacingAction {
  read(): unknown {
    return this.sdkController;
  }
}

describe("SimIRacingAction", () => {
  it("exposes the SDK singleton's controller", () => {
    expect(new Probe().read()).toBe(controller);
  });
});
