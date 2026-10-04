import { describe, expect, it } from "vitest";

import { PROFILE_CAPTURE_STATUS_KEY as LEAF_KEY } from "./cpu-profile-capture-constants.js";
import { PROFILE_CAPTURE_STATUS_KEY } from "./cpu-profile-capture.js";

describe("cpu-profile-capture-constants (#1338)", () => {
  it("is the key the capture module re-exports", () => {
    expect(LEAF_KEY).toBe("_profileCaptureStatus");
    expect(PROFILE_CAPTURE_STATUS_KEY).toBe(LEAF_KEY);
  });
});
