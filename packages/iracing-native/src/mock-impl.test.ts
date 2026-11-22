import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VarType } from "./defines.js";
import { FocusResult, PointerMoveResult } from "./index.js";
import {
  MOCK_CUSTOM_CAMERA_GROUP_NAMES,
  MOCK_CUSTOM_CAMERAS_TRACK_ID,
  MOCK_SESSION_INFO_YAML_CUSTOM_CAMERAS,
} from "./mock-data/session-info-custom-cameras.js";
import { MOCK_SESSION_INFO_YAML } from "./mock-data/session-info.js";
import { MOCK_SNAPSHOTS } from "./mock-data/snapshots.js";
import { MOCK_VAR_HEADERS } from "./mock-data/telemetry.js";
import { IRacingNativeMock } from "./mock-impl.js";

describe("IRacingNativeMock", () => {
  let mock: IRacingNativeMock;

  beforeEach(() => {
    mock = new IRacingNativeMock();
  });

  describe("connection lifecycle", () => {
    it("should not be connected initially", () => {
      expect(mock.isConnected()).toBe(false);
    });

    it("should connect on startup", () => {
      expect(mock.startup()).toBe(true);
      expect(mock.isConnected()).toBe(true);
    });

    it("should disconnect on shutdown", () => {
      mock.startup();
      mock.shutdown();
      expect(mock.isConnected()).toBe(false);
    });

    it("should return null from data methods when not connected", () => {
      expect(mock.getHeader()).toBeNull();
      expect(mock.getData(0)).toBeNull();
      expect(mock.waitForData()).toBeNull();
      expect(mock.getSessionInfoStr()).toBeNull();
    });
  });

  describe("getHeader", () => {
    beforeEach(() => {
      mock.startup();
    });

    it("should return a valid header", () => {
      const header = mock.getHeader();
      expect(header).not.toBeNull();
      expect(header!.ver).toBe(2);
      expect(header!.numVars).toBe(MOCK_VAR_HEADERS.length);
      expect(header!.numBuf).toBe(4);
      expect(header!.bufLen).toBeGreaterThan(0);
    });

    it("should have sessionInfoUpdate > 0", () => {
      const header = mock.getHeader();
      expect(header!.sessionInfoUpdate).toBeGreaterThan(0);
    });
  });

  describe("data access", () => {
    beforeEach(() => {
      mock.startup();
    });

    it("should return a buffer from getData", () => {
      const buf = mock.getData(0);
      expect(buf).not.toBeNull();
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf!.length).toBeGreaterThan(0);
    });

    it("should return a buffer from waitForData", () => {
      const buf = mock.waitForData(16);
      expect(buf).not.toBeNull();
      expect(buf).toBeInstanceOf(Buffer);
    });

    it("should return session info YAML string", () => {
      const info = mock.getSessionInfoStr();
      expect(info).not.toBeNull();
      expect(info).toContain("WeekendInfo");
      expect(info).toContain("Spa");
      expect(info).toContain("DriverInfo");
    });
  });

  describe("var headers", () => {
    it("should return var headers by index", () => {
      const header = mock.getVarHeaderEntry(0);
      expect(header).not.toBeNull();
      expect(header!.name).toBeDefined();
      expect(header!.type).toBeDefined();
      expect(typeof header!.offset).toBe("number");
    });

    it("should return null for out-of-range index", () => {
      expect(mock.getVarHeaderEntry(-1)).toBeNull();
      expect(mock.getVarHeaderEntry(9999)).toBeNull();
    });

    it("should resolve variable names to indices", () => {
      const speedIndex = mock.varNameToIndex("Speed");
      expect(speedIndex).toBeGreaterThanOrEqual(0);

      const header = mock.getVarHeaderEntry(speedIndex);
      expect(header!.name).toBe("Speed");
      expect(header!.type).toBe(VarType.Float);
    });

    it("should return -1 for unknown variable names", () => {
      expect(mock.varNameToIndex("NonExistentVar")).toBe(-1);
    });
  });

  describe("no-op methods", () => {
    beforeEach(() => {
      vi.spyOn(console, "debug").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("broadcastMsg should log and not throw", () => {
      expect(() => mock.broadcastMsg(0, 1, 2, 3)).not.toThrow();
      expect(console.debug).toHaveBeenCalled();
    });

    it("sendChatMessage should resolve to true", async () => {
      await expect(mock.sendChatMessage("test")).resolves.toBe(true);
      expect(console.debug).toHaveBeenCalled();
    });

    it("sendChatMessage should accept timing delays and resolve to true", async () => {
      await expect(mock.sendChatMessage("test", 300, 450, 600)).resolves.toBe(true);
      expect(console.debug).toHaveBeenCalledWith(expect.stringContaining("600"));
    });

    it("sendScanKeys should not throw", () => {
      expect(() => mock.sendScanKeys([0x1e])).not.toThrow();
      expect(console.debug).toHaveBeenCalled();
    });

    it("sendScanKeyDown should not throw", () => {
      expect(() => mock.sendScanKeyDown([0x1e])).not.toThrow();
      expect(console.debug).toHaveBeenCalled();
    });

    it("sendScanKeyUp should not throw", () => {
      expect(() => mock.sendScanKeyUp([0x1e])).not.toThrow();
      expect(console.debug).toHaveBeenCalled();
    });

    it("sendScanKeySequence should not throw", () => {
      expect(() => mock.sendScanKeySequence([[0x3b], [0x3e]])).not.toThrow();
      expect(console.debug).toHaveBeenCalled();
    });

    it("sendScanKeySequence should accept an explicit holdMs", () => {
      expect(() => mock.sendScanKeySequence([[0x3b], [0x3e]], 16)).not.toThrow();
      expect(console.debug).toHaveBeenCalledWith(expect.stringContaining("16"));
    });
  });

  describe("session info variants (#1653)", () => {
    /** The section of `yaml` from `start` up to the next top-level key. */
    const section = (yaml: string, start: string): string => {
      const from = yaml.indexOf(`\n${start}:\n`);

      // A missing section would slice from the start, and two such slices
      // would compare equal without comparing anything (#1653 review).
      if (from === -1) throw new Error(`section ${start} is missing from the fixture`);

      const rest = yaml.slice(from + 1);
      const next = rest.slice(start.length + 2).search(/^[A-Za-z]/m);

      return next === -1 ? rest : rest.slice(0, start.length + 2 + next);
    };

    it("serves the default Spa session unless told otherwise", () => {
      mock.startup();

      expect(mock.getSessionInfoStr()).toBe(MOCK_SESSION_INFO_YAML);
      expect(mock.getHeader()?.sessionInfoLen).toBe(MOCK_SESSION_INFO_YAML.length);
    });

    it("serves the custom-camera variant when constructed with it", () => {
      const custom = new IRacingNativeMock(undefined, { sessionInfoYaml: MOCK_SESSION_INFO_YAML_CUSTOM_CAMERAS });

      custom.startup();

      expect(custom.getSessionInfoStr()).toBe(MOCK_SESSION_INFO_YAML_CUSTOM_CAMERAS);
      expect(custom.getHeader()?.sessionInfoLen).toBe(MOCK_SESSION_INFO_YAML_CUSTOM_CAMERAS.length);
    });

    it("switches the session info and advances sessionInfoUpdate, as a camera file loaded mid-session does", () => {
      mock.startup();
      const before = mock.getHeader()?.sessionInfoUpdate ?? 0;

      mock.setSessionInfoYaml(MOCK_SESSION_INFO_YAML_CUSTOM_CAMERAS);

      expect(mock.getSessionInfoStr()).toBe(MOCK_SESSION_INFO_YAML_CUSTOM_CAMERAS);
      expect(mock.getHeader()?.sessionInfoUpdate).toBe(before + 1);
    });

    it("puts the variant at another track with broadcaster-style groups, every other section the default's", () => {
      const yaml = MOCK_SESSION_INFO_YAML_CUSTOM_CAMERAS;

      expect(yaml).toContain(`\n TrackID: ${MOCK_CUSTOM_CAMERAS_TRACK_ID}\n`);
      expect(MOCK_CUSTOM_CAMERAS_TRACK_ID).not.toBe(13);
      expect(MOCK_SESSION_INFO_YAML).toContain("\n TrackID: 13\n");

      const names = [...section(yaml, "CameraInfo").matchAll(/^ {3}GroupName: (.*)$/gm)].map((m) => m[1]);

      expect(names).toEqual(MOCK_CUSTOM_CAMERA_GROUP_NAMES);
      expect(names).toEqual(
        expect.arrayContaining(["DynamicTV", "Grid_Pole", "SpeedCam", "Drone", "Pit Lane2", "TV1"]),
      );

      for (const key of ["SessionInfo", "RadioInfo", "DriverInfo", "SplitTimeInfo"]) {
        expect(section(yaml, key), key).toBe(section(MOCK_SESSION_INFO_YAML, key));
      }
    });
  });

  describe("getElevationStatus (mock)", () => {
    it("reports no mismatch", () => {
      const mock = new IRacingNativeMock();
      expect(mock.getElevationStatus()).toEqual({
        selfElevated: false,
        iracingFound: false,
        iracingQueryDenied: false,
        iracingElevated: false,
        mismatch: false,
      });
    });
  });

  describe("window management (mock)", () => {
    beforeEach(() => {
      vi.spyOn(console, "debug").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("focusIRacingWindow should report AlreadyFocused", () => {
      expect(mock.focusIRacingWindow()).toBe(0);
    });

    it("moveMouseToIRacingWindow should report a successful move", () => {
      expect(mock.moveMouseToIRacingWindow(0.5, 0.125)).toBe(0);
    });

    it("moveMouseToIRacingWindow should log the requested fractions", () => {
      mock.moveMouseToIRacingWindow(0.25, 0.75);
      expect(console.debug).toHaveBeenCalledWith(expect.stringContaining("0.25"));
    });
  });

  // The numbering is a cross-package contract: addon.cc's FOCUS_*/POINTER_*
  // constants, these enums, and deck-core's WindowFocusResult/PointerMoveResult
  // (window-service.ts, #926) must agree. deck-core asserts its own copy; these
  // assertions are the other side of that pair, so a rename or reorder here
  // breaks a test rather than a user.
  describe("result code contract", () => {
    it("numbers FocusResult as the addon does", () => {
      expect(FocusResult.AlreadyFocused).toBe(0);
      expect(FocusResult.Focused).toBe(1);
      expect(FocusResult.WindowNotFound).toBe(2);
      expect(FocusResult.FocusTimedOut).toBe(3);
    });

    it("numbers PointerMoveResult as the addon does", () => {
      expect(PointerMoveResult.Moved).toBe(0);
      expect(PointerMoveResult.WindowNotFound).toBe(1);
      expect(PointerMoveResult.Failed).toBe(2);
    });
  });

  describe("snapshot rotation", () => {
    it("should rotate snapshots after the configured interval", () => {
      // Use a very short rotation interval for testing
      const fastMock = new IRacingNativeMock(50);
      fastMock.startup();

      const buf1 = fastMock.waitForData();
      expect(buf1).not.toBeNull();

      // Wait for rotation
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const buf2 = fastMock.waitForData();
          expect(buf2).not.toBeNull();
          // Buffers should differ after rotation (different snapshot data)
          expect(buf1!.equals(buf2!)).toBe(false);
          resolve();
        }, 60);
      });
    });

    it("should cycle through all snapshots", () => {
      const fastMock = new IRacingNativeMock(10);
      fastMock.startup();

      const snapshots = new Set<string>();

      return new Promise<void>((resolve) => {
        const collect = () => {
          const buf = fastMock.waitForData();

          if (buf) snapshots.add(buf.toString("hex"));

          if (snapshots.size >= MOCK_SNAPSHOTS.length) {
            resolve();
          } else {
            setTimeout(collect, 15);
          }
        };
        collect();
      });
    });
  });
});
