import { describe, expect, it } from "vitest";

import {
  classifyCarNumberTarget,
  getAllCarNumbers,
  getCameraGroupsFromSessionInfo,
  getCamerasInGroup,
  getCarNumberFromSessionInfo,
  getCarNumberRawFromSessionInfo,
  getPlayerCarNumberFromSessionInfo,
} from "./session-utils.js";

describe("getPlayerCarNumberFromSessionInfo", () => {
  it("resolves the player's own car number via DriverCarIdx", () => {
    const info = {
      DriverInfo: {
        DriverCarIdx: 2,
        Drivers: [
          { CarIdx: 1, CarNumber: "42", CarNumberRaw: 42 },
          { CarIdx: 2, CarNumber: "07", CarNumberRaw: 3007 },
        ],
      },
    };
    expect(getPlayerCarNumberFromSessionInfo(info)).toBe("07");
  });

  it("returns null when DriverCarIdx is missing, invalid, or unmatched", () => {
    expect(getPlayerCarNumberFromSessionInfo(null)).toBeNull();
    expect(getPlayerCarNumberFromSessionInfo({})).toBeNull();
    expect(getPlayerCarNumberFromSessionInfo({ DriverInfo: { DriverCarIdx: -1, Drivers: [] } })).toBeNull();
    expect(
      getPlayerCarNumberFromSessionInfo({
        DriverInfo: { DriverCarIdx: 9, Drivers: [{ CarIdx: 1, CarNumber: "42", CarNumberRaw: 42 }] },
      }),
    ).toBeNull();
  });
});

describe("classifyCarNumberTarget", () => {
  const sessionInfo = {
    DriverInfo: {
      Drivers: [
        { CarIdx: 0, CarNumber: "0", CarNumberRaw: 0, CarIsPaceCar: 1 },
        { CarIdx: 1, CarNumber: "42", CarNumberRaw: 42, UserName: "Jane Doe", CarIsAI: 0 },
        { CarIdx: 2, CarNumber: "7", CarNumberRaw: 7, UserName: "AI Driver", CarIsAI: 1 },
        { CarIdx: 3, CarNumber: "070", CarNumberRaw: 3070, UserName: "Zero Fan" },
      ],
    },
  };

  it("classifies a human driver's car as user", () => {
    expect(classifyCarNumberTarget(sessionInfo, "42")).toBe("user");
  });

  it("classifies an AI car as ai", () => {
    expect(classifyCarNumberTarget(sessionInfo, "7")).toBe("ai");
  });

  it("classifies the pace car as ai (not a user)", () => {
    expect(classifyCarNumberTarget(sessionInfo, "0")).toBe("ai");
  });

  it("classifies a number not in the session as unknown", () => {
    expect(classifyCarNumberTarget(sessionInfo, "99")).toBe("unknown");
  });

  it("matches leading-zero numbers exactly (04 and 4 are distinct)", () => {
    expect(classifyCarNumberTarget(sessionInfo, "070")).toBe("user");
    expect(classifyCarNumberTarget(sessionInfo, "70")).toBe("unknown");
  });

  it("cleans non-digits from the target before matching", () => {
    expect(classifyCarNumberTarget(sessionInfo, "#42")).toBe("user");
  });

  it("returns unknown for empty targets and missing session info", () => {
    expect(classifyCarNumberTarget(sessionInfo, "")).toBe("unknown");
    expect(classifyCarNumberTarget(sessionInfo, "#")).toBe("unknown");
    expect(classifyCarNumberTarget(null, "42")).toBe("unknown");
    expect(classifyCarNumberTarget({}, "42")).toBe("unknown");
  });
});

describe("getCarNumberFromSessionInfo", () => {
  const sessionInfo = {
    DriverInfo: {
      DriverCarIdx: 2,
      Drivers: [
        { CarIdx: 0, CarNumber: "0", CarNumberRaw: 0 },
        { CarIdx: 1, CarNumber: "42", CarNumberRaw: 42 },
        { CarIdx: 2, CarNumber: "4", CarNumberRaw: 4 },
        { CarIdx: 3, CarNumber: "99", CarNumberRaw: 99 },
      ],
    },
  };

  it("should return car number string for a valid car index", () => {
    expect(getCarNumberFromSessionInfo(sessionInfo, 2)).toBe("4");
    expect(getCarNumberFromSessionInfo(sessionInfo, 1)).toBe("42");
    expect(getCarNumberFromSessionInfo(sessionInfo, 0)).toBe("0");
  });

  it("should preserve leading zeros", () => {
    const info = {
      DriverInfo: {
        Drivers: [
          { CarIdx: 0, CarNumber: "070", CarNumberRaw: 3070 },
          { CarIdx: 1, CarNumber: "007", CarNumberRaw: 2007 },
        ],
      },
    };

    expect(getCarNumberFromSessionInfo(info, 0)).toBe("070");
    expect(getCarNumberFromSessionInfo(info, 1)).toBe("007");
  });

  it("should preserve leading zero for car number 042", () => {
    const info = {
      DriverInfo: {
        Drivers: [{ CarIdx: 0, CarNumber: "042", CarNumberRaw: 3042 }],
      },
    };

    expect(getCarNumberFromSessionInfo(info, 0)).toBe("042");
  });

  it("should return null for unknown car index", () => {
    expect(getCarNumberFromSessionInfo(sessionInfo, 99)).toBeNull();
  });

  it("should return null when session info is null", () => {
    expect(getCarNumberFromSessionInfo(null, 0)).toBeNull();
  });

  it("should return null when DriverInfo is missing", () => {
    expect(getCarNumberFromSessionInfo({}, 0)).toBeNull();
  });

  it("should return null when Drivers array is missing", () => {
    expect(getCarNumberFromSessionInfo({ DriverInfo: {} }, 0)).toBeNull();
  });

  it("should return null for non-numeric car number", () => {
    const info = { DriverInfo: { Drivers: [{ CarIdx: 0, CarNumber: "ABC", CarNumberRaw: 0 }] } };

    expect(getCarNumberFromSessionInfo(info, 0)).toBeNull();
  });
});

describe("getCarNumberRawFromSessionInfo", () => {
  it("should return the raw car number", () => {
    const info = {
      DriverInfo: {
        Drivers: [
          { CarIdx: 0, CarNumber: "42", CarNumberRaw: 42 },
          { CarIdx: 1, CarNumber: "070", CarNumberRaw: 3070 },
        ],
      },
    };

    expect(getCarNumberRawFromSessionInfo(info, 0)).toBe(42);
    expect(getCarNumberRawFromSessionInfo(info, 1)).toBe(3070);
  });

  it("should return 3042 for car number 042", () => {
    const info = {
      DriverInfo: {
        Drivers: [{ CarIdx: 0, CarNumber: "042", CarNumberRaw: 3042 }],
      },
    };

    expect(getCarNumberRawFromSessionInfo(info, 0)).toBe(3042);
  });

  it("should return null for unknown car index", () => {
    const info = {
      DriverInfo: {
        Drivers: [{ CarIdx: 0, CarNumber: "42", CarNumberRaw: 42 }],
      },
    };

    expect(getCarNumberRawFromSessionInfo(info, 99)).toBeNull();
  });

  it("should return null when session info is null", () => {
    expect(getCarNumberRawFromSessionInfo(null, 0)).toBeNull();
  });
});

describe("getAllCarNumbers", () => {
  const sessionInfo = {
    DriverInfo: {
      Drivers: [
        { CarIdx: 0, CarNumber: "0", CarNumberRaw: 0, CarIsPaceCar: 1 },
        { CarIdx: 1, CarNumber: "42", CarNumberRaw: 42 },
        { CarIdx: 2, CarNumber: "4", CarNumberRaw: 4 },
        { CarIdx: 3, CarNumber: "99", CarNumberRaw: 99 },
        { CarIdx: 4, CarNumber: "7", CarNumberRaw: 7 },
      ],
    },
  };

  it("should return all car numbers sorted ascending by numeric value", () => {
    const result = getAllCarNumbers(sessionInfo);
    expect(result).toEqual([
      { carIdx: 0, carNumber: "0", carNumberRaw: 0, userName: "" },
      { carIdx: 2, carNumber: "4", carNumberRaw: 4, userName: "" },
      { carIdx: 4, carNumber: "7", carNumberRaw: 7, userName: "" },
      { carIdx: 1, carNumber: "42", carNumberRaw: 42, userName: "" },
      { carIdx: 3, carNumber: "99", carNumberRaw: 99, userName: "" },
    ]);
  });

  it("should exclude pace car when requested", () => {
    const result = getAllCarNumbers(sessionInfo, true);
    expect(result).toEqual([
      { carIdx: 2, carNumber: "4", carNumberRaw: 4, userName: "" },
      { carIdx: 4, carNumber: "7", carNumberRaw: 7, userName: "" },
      { carIdx: 1, carNumber: "42", carNumberRaw: 42, userName: "" },
      { carIdx: 3, carNumber: "99", carNumberRaw: 99, userName: "" },
    ]);
  });

  it("should exclude spectators when requested", () => {
    const info = {
      DriverInfo: {
        Drivers: [
          { CarIdx: 0, CarNumber: "0", CarNumberRaw: 0, CarIsPaceCar: 1 },
          { CarIdx: 1, CarNumber: "42", CarNumberRaw: 42, UserName: "Jane Doe" },
          { CarIdx: 2, CarNumber: "4", CarNumberRaw: 4, IsSpectator: 1 },
          { CarIdx: 3, CarNumber: "7", CarNumberRaw: 7, IsSpectator: 0, UserName: "Max Power" },
        ],
      },
    };

    expect(getAllCarNumbers(info, true, true)).toEqual([
      { carIdx: 3, carNumber: "7", carNumberRaw: 7, userName: "Max Power" },
      { carIdx: 1, carNumber: "42", carNumberRaw: 42, userName: "Jane Doe" },
    ]);

    // Spectators stay included unless explicitly excluded (existing callers).
    expect(getAllCarNumbers(info, true)).toEqual([
      { carIdx: 2, carNumber: "4", carNumberRaw: 4, userName: "" },
      { carIdx: 3, carNumber: "7", carNumberRaw: 7, userName: "Max Power" },
      { carIdx: 1, carNumber: "42", carNumberRaw: 42, userName: "Jane Doe" },
    ]);
  });

  it("should preserve leading zeros and sort numerically", () => {
    const info = {
      DriverInfo: {
        Drivers: [
          { CarIdx: 0, CarNumber: "070", CarNumberRaw: 3070 },
          { CarIdx: 1, CarNumber: "9", CarNumberRaw: 9 },
          { CarIdx: 2, CarNumber: "100", CarNumberRaw: 100 },
        ],
      },
    };
    expect(getAllCarNumbers(info)).toEqual([
      { carIdx: 1, carNumber: "9", carNumberRaw: 9, userName: "" },
      { carIdx: 0, carNumber: "070", carNumberRaw: 3070, userName: "" },
      { carIdx: 2, carNumber: "100", carNumberRaw: 100, userName: "" },
    ]);
  });

  it("should return empty array when session info is null", () => {
    expect(getAllCarNumbers(null)).toEqual([]);
  });

  it("should return empty array when DriverInfo is missing", () => {
    expect(getAllCarNumbers({})).toEqual([]);
  });

  it("should skip non-numeric car numbers", () => {
    const info = {
      DriverInfo: {
        Drivers: [
          { CarIdx: 0, CarNumber: "10", CarNumberRaw: 10 },
          { CarIdx: 1, CarNumber: "ABC", CarNumberRaw: 0 },
          { CarIdx: 2, CarNumber: "5", CarNumberRaw: 5 },
        ],
      },
    };
    expect(getAllCarNumbers(info)).toEqual([
      { carIdx: 2, carNumber: "5", carNumberRaw: 5, userName: "" },
      { carIdx: 0, carNumber: "10", carNumberRaw: 10, userName: "" },
    ]);
  });
});

describe("getCameraGroupsFromSessionInfo", () => {
  it("should extract camera groups from valid session info", () => {
    const sessionInfo = {
      CameraInfo: {
        Groups: [
          { GroupNum: 1, GroupName: "Nose", Cameras: [] },
          { GroupNum: 2, GroupName: "Gearbox", Cameras: [] },
          { GroupNum: 3, GroupName: "Cockpit", Cameras: [] },
        ],
      },
    };

    expect(getCameraGroupsFromSessionInfo(sessionInfo)).toEqual([
      { groupNum: 1, groupName: "Nose" },
      { groupNum: 2, groupName: "Gearbox" },
      { groupNum: 3, groupName: "Cockpit" },
    ]);
  });

  it("should return empty array when CameraInfo is missing", () => {
    expect(getCameraGroupsFromSessionInfo({})).toEqual([]);
    expect(getCameraGroupsFromSessionInfo(null)).toEqual([]);
    expect(getCameraGroupsFromSessionInfo(undefined)).toEqual([]);
  });

  it("should return empty array when Groups is missing", () => {
    expect(getCameraGroupsFromSessionInfo({ CameraInfo: {} })).toEqual([]);
  });

  it("should return empty array when Groups is empty", () => {
    expect(getCameraGroupsFromSessionInfo({ CameraInfo: { Groups: [] } })).toEqual([]);
  });
});

describe("getCamerasInGroup", () => {
  const sessionInfo = {
    CameraInfo: {
      Groups: [
        {
          GroupNum: 1,
          GroupName: "Nose",
          Cameras: [{ CameraNum: 1, CameraName: "CamNose" }],
        },
        {
          GroupNum: 9,
          GroupName: "Cockpit",
          Cameras: [
            { CameraNum: 1, CameraName: "Cockpit" },
            { CameraNum: 2, CameraName: "Roll Bar" },
            { CameraNum: 3, CameraName: "Gyro" },
          ],
        },
      ],
    },
  };

  it("should extract the cameras of the matching group", () => {
    expect(getCamerasInGroup(sessionInfo, 9)).toEqual([
      { cameraNum: 1, cameraName: "Cockpit" },
      { cameraNum: 2, cameraName: "Roll Bar" },
      { cameraNum: 3, cameraName: "Gyro" },
    ]);
  });

  it("should return a single-camera group", () => {
    expect(getCamerasInGroup(sessionInfo, 1)).toEqual([{ cameraNum: 1, cameraName: "CamNose" }]);
  });

  it("should return empty array when the group number is not present", () => {
    expect(getCamerasInGroup(sessionInfo, 99)).toEqual([]);
  });

  it("should return empty array when the group has no Cameras list", () => {
    expect(getCamerasInGroup({ CameraInfo: { Groups: [{ GroupNum: 3, GroupName: "Chase" }] } }, 3)).toEqual([]);
  });

  it("should return empty array when CameraInfo or Groups is missing", () => {
    expect(getCamerasInGroup({}, 1)).toEqual([]);
    expect(getCamerasInGroup(null, 1)).toEqual([]);
    expect(getCamerasInGroup(undefined, 1)).toEqual([]);
    expect(getCamerasInGroup({ CameraInfo: {} }, 1)).toEqual([]);
  });
});
