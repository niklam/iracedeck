import { describe, expect, it } from "vitest";

import { getAllCarNumbers, getCarNumberFromSessionInfo } from "./session-utils.js";

describe("getCarNumberFromSessionInfo", () => {
  const sessionInfo = {
    DriverInfo: {
      DriverCarIdx: 2,
      Drivers: [
        { CarIdx: 0, CarNumber: "0" },
        { CarIdx: 1, CarNumber: "42" },
        { CarIdx: 2, CarNumber: "4" },
        { CarIdx: 3, CarNumber: "99" },
      ],
    },
  };

  it("should return car number for a valid car index", () => {
    expect(getCarNumberFromSessionInfo(sessionInfo, 2)).toBe(4);
    expect(getCarNumberFromSessionInfo(sessionInfo, 1)).toBe(42);
    expect(getCarNumberFromSessionInfo(sessionInfo, 0)).toBe(0);
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
    const info = { DriverInfo: { Drivers: [{ CarIdx: 0, CarNumber: "ABC" }] } };

    expect(getCarNumberFromSessionInfo(info, 0)).toBeNull();
  });
});

describe("getAllCarNumbers", () => {
  const sessionInfo = {
    DriverInfo: {
      Drivers: [
        { CarIdx: 0, CarNumber: "0", CarIsPaceCar: 1 },
        { CarIdx: 1, CarNumber: "42" },
        { CarIdx: 2, CarNumber: "4" },
        { CarIdx: 3, CarNumber: "99" },
        { CarIdx: 4, CarNumber: "7" },
      ],
    },
  };

  it("should return all car numbers sorted ascending", () => {
    const result = getAllCarNumbers(sessionInfo);
    expect(result).toEqual([
      { carIdx: 0, carNumber: 0 },
      { carIdx: 2, carNumber: 4 },
      { carIdx: 4, carNumber: 7 },
      { carIdx: 1, carNumber: 42 },
      { carIdx: 3, carNumber: 99 },
    ]);
  });

  it("should exclude pace car when requested", () => {
    const result = getAllCarNumbers(sessionInfo, true);
    expect(result).toEqual([
      { carIdx: 2, carNumber: 4 },
      { carIdx: 4, carNumber: 7 },
      { carIdx: 1, carNumber: 42 },
      { carIdx: 3, carNumber: 99 },
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
          { CarIdx: 0, CarNumber: "10" },
          { CarIdx: 1, CarNumber: "ABC" },
          { CarIdx: 2, CarNumber: "5" },
        ],
      },
    };
    expect(getAllCarNumbers(info)).toEqual([
      { carIdx: 2, carNumber: 5 },
      { carIdx: 0, carNumber: 10 },
    ]);
  });
});
