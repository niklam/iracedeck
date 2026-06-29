import { describe, expect, it } from "vitest";

import {
  getActiveSessionCars,
  getAllCarNumbers,
  getCameraGroupsFromSessionInfo,
  getCarNumberFromSessionInfo,
  getCarNumberRawFromSessionInfo,
} from "./session-utils.js";

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
      { carIdx: 0, carNumber: "0", carNumberRaw: 0 },
      { carIdx: 2, carNumber: "4", carNumberRaw: 4 },
      { carIdx: 4, carNumber: "7", carNumberRaw: 7 },
      { carIdx: 1, carNumber: "42", carNumberRaw: 42 },
      { carIdx: 3, carNumber: "99", carNumberRaw: 99 },
    ]);
  });

  it("should exclude pace car when requested", () => {
    const result = getAllCarNumbers(sessionInfo, true);
    expect(result).toEqual([
      { carIdx: 2, carNumber: "4", carNumberRaw: 4 },
      { carIdx: 4, carNumber: "7", carNumberRaw: 7 },
      { carIdx: 1, carNumber: "42", carNumberRaw: 42 },
      { carIdx: 3, carNumber: "99", carNumberRaw: 99 },
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
      { carIdx: 1, carNumber: "9", carNumberRaw: 9 },
      { carIdx: 0, carNumber: "070", carNumberRaw: 3070 },
      { carIdx: 2, carNumber: "100", carNumberRaw: 100 },
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
      { carIdx: 2, carNumber: "5", carNumberRaw: 5 },
      { carIdx: 0, carNumber: "10", carNumberRaw: 10 },
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

describe("getActiveSessionCars", () => {
  it("should return cars sorted by car number numerically, excluding pace car and spectators", () => {
    const sessionInfo = {
      DriverInfo: {
        Drivers: [
          {
            CarIdx: 0,
            CarNumber: "99",
            CarNumberRaw: 99,
            CarIsPaceCar: 0,
            IsSpectator: 0,
            UserName: "Alice",
            CarClassShortName: "GT3",
          },
          {
            CarIdx: 1,
            CarNumber: "0",
            CarNumberRaw: 0,
            CarIsPaceCar: 1,
            IsSpectator: 0,
            UserName: "Pace",
            CarClassShortName: "",
          },
          {
            CarIdx: 2,
            CarNumber: "4",
            CarNumberRaw: 4,
            CarIsPaceCar: 0,
            IsSpectator: 0,
            UserName: "Bob",
            CarClassShortName: "GT4",
          },
          {
            CarIdx: 3,
            CarNumber: "42",
            CarNumberRaw: 42,
            CarIsPaceCar: 0,
            IsSpectator: 1,
            UserName: "Spectator",
            CarClassShortName: "",
          },
          {
            CarIdx: 4,
            CarNumber: "7",
            CarNumberRaw: 7,
            CarIsPaceCar: 0,
            IsSpectator: 0,
            UserName: "Carol",
            CarClassShortName: "GT3",
          },
        ],
      },
    };
    expect(getActiveSessionCars(sessionInfo)).toEqual([
      { carIdx: 2, carNumber: "4", carNumberRaw: 4, driverName: "Bob", carClass: "GT4" },
      { carIdx: 4, carNumber: "7", carNumberRaw: 7, driverName: "Carol", carClass: "GT3" },
      { carIdx: 0, carNumber: "99", carNumberRaw: 99, driverName: "Alice", carClass: "GT3" },
    ]);
  });

  it("should preserve leading zeros in car number", () => {
    const sessionInfo = {
      DriverInfo: {
        Drivers: [
          {
            CarIdx: 0,
            CarNumber: "070",
            CarNumberRaw: 3070,
            CarIsPaceCar: 0,
            IsSpectator: 0,
            UserName: "A",
            CarClassShortName: "",
          },
          {
            CarIdx: 1,
            CarNumber: "9",
            CarNumberRaw: 9,
            CarIsPaceCar: 0,
            IsSpectator: 0,
            UserName: "B",
            CarClassShortName: "",
          },
        ],
      },
    };
    const result = getActiveSessionCars(sessionInfo);
    expect(result[0].carNumber).toBe("9");
    expect(result[1].carNumber).toBe("070");
  });

  it("should place non-numeric car numbers after all numeric ones, sorted alphabetically", () => {
    const sessionInfo = {
      DriverInfo: {
        Drivers: [
          {
            CarIdx: 0,
            CarNumber: "ABC",
            CarNumberRaw: 0,
            CarIsPaceCar: 0,
            IsSpectator: 0,
            UserName: "X",
            CarClassShortName: "",
          },
          {
            CarIdx: 1,
            CarNumber: "10",
            CarNumberRaw: 10,
            CarIsPaceCar: 0,
            IsSpectator: 0,
            UserName: "Y",
            CarClassShortName: "",
          },
          {
            CarIdx: 2,
            CarNumber: "AAA",
            CarNumberRaw: 0,
            CarIsPaceCar: 0,
            IsSpectator: 0,
            UserName: "Z",
            CarClassShortName: "",
          },
          {
            CarIdx: 3,
            CarNumber: "5",
            CarNumberRaw: 5,
            CarIsPaceCar: 0,
            IsSpectator: 0,
            UserName: "W",
            CarClassShortName: "",
          },
        ],
      },
    };
    const result = getActiveSessionCars(sessionInfo);
    expect(result.map((c) => c.carIdx)).toEqual([3, 1, 2, 0]); // 5, 10, AAA, ABC
  });

  it("should populate driverName and carClass fields", () => {
    const sessionInfo = {
      DriverInfo: {
        Drivers: [
          {
            CarIdx: 0,
            CarNumber: "1",
            CarNumberRaw: 1,
            CarIsPaceCar: 0,
            IsSpectator: 0,
            UserName: "Test Driver",
            CarClassShortName: "GTP",
          },
        ],
      },
    };
    const result = getActiveSessionCars(sessionInfo);
    expect(result[0].driverName).toBe("Test Driver");
    expect(result[0].carClass).toBe("GTP");
  });

  it("should use empty strings for missing driverName and carClass", () => {
    const sessionInfo = {
      DriverInfo: {
        Drivers: [
          { CarIdx: 0, CarNumber: "1", CarNumberRaw: 1, CarIsPaceCar: 0 },
        ],
      },
    };
    const result = getActiveSessionCars(sessionInfo);
    expect(result[0].driverName).toBe("");
    expect(result[0].carClass).toBe("");
  });

  it("should exclude pace cars", () => {
    const sessionInfo = {
      DriverInfo: {
        Drivers: [
          {
            CarIdx: 0,
            CarNumber: "1",
            CarNumberRaw: 1,
            CarIsPaceCar: 1,
            IsSpectator: 0,
            UserName: "Pace",
            CarClassShortName: "",
          },
          {
            CarIdx: 1,
            CarNumber: "2",
            CarNumberRaw: 2,
            CarIsPaceCar: 0,
            IsSpectator: 0,
            UserName: "Driver",
            CarClassShortName: "",
          },
        ],
      },
    };
    const result = getActiveSessionCars(sessionInfo);
    expect(result).toHaveLength(1);
    expect(result[0].carIdx).toBe(1);
  });

  it("should exclude spectators", () => {
    const sessionInfo = {
      DriverInfo: {
        Drivers: [
          {
            CarIdx: 0,
            CarNumber: "1",
            CarNumberRaw: 1,
            CarIsPaceCar: 0,
            IsSpectator: 1,
            UserName: "Spec",
            CarClassShortName: "",
          },
          {
            CarIdx: 1,
            CarNumber: "2",
            CarNumberRaw: 2,
            CarIsPaceCar: 0,
            IsSpectator: 0,
            UserName: "Driver",
            CarClassShortName: "",
          },
        ],
      },
    };
    const result = getActiveSessionCars(sessionInfo);
    expect(result).toHaveLength(1);
    expect(result[0].carIdx).toBe(1);
  });

  it("should return empty array when session info is null", () => {
    expect(getActiveSessionCars(null)).toEqual([]);
  });

  it("should return empty array when DriverInfo is missing", () => {
    expect(getActiveSessionCars({})).toEqual([]);
  });

  it("should include cars with empty car number after cleaning (non-numeric)", () => {
    const sessionInfo = {
      DriverInfo: {
        Drivers: [
          {
            CarIdx: 0,
            CarNumber: "ABC",
            CarNumberRaw: 0,
            CarIsPaceCar: 0,
            IsSpectator: 0,
            UserName: "A",
            CarClassShortName: "",
          },
          {
            CarIdx: 1,
            CarNumber: "5",
            CarNumberRaw: 5,
            CarIsPaceCar: 0,
            IsSpectator: 0,
            UserName: "B",
            CarClassShortName: "",
          },
        ],
      },
    };
    // Both should be included — non-numeric sorted after numeric
    const result = getActiveSessionCars(sessionInfo);
    expect(result).toHaveLength(2);
    expect(result[0].carIdx).toBe(1); // "5" first
    expect(result[1].carIdx).toBe(0); // "ABC" second
  });
});
