import type { SessionInfo } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import { describe, expect, it, vi } from "vitest";

import { createReplaySessionSubscriber, replaySessionHeaderFromSessionInfo } from "./replay-session-subscriber.js";

const sessionInfo = (weekend: Record<string, unknown>): SessionInfo => ({ WeekendInfo: weekend });

const talladega = sessionInfo({
  TrackName: "talladega",
  TrackDisplayName: "Talladega Superspeedway",
  TrackConfigName: "",
  SeriesID: 167,
  SubSessionID: 86697546,
});

describe("replaySessionHeaderFromSessionInfo", () => {
  it("reads the SubSessionID, the track display name and the series id", () => {
    expect(replaySessionHeaderFromSessionInfo(talladega)).toEqual({
      subSessionId: 86697546,
      track: "Talladega Superspeedway",
      series: "167",
    });
  });

  it("appends the track configuration when the track has one", () => {
    expect(
      replaySessionHeaderFromSessionInfo(
        sessionInfo({
          TrackDisplayName: "Watkins Glen International",
          TrackConfigName: "Boot",
          SubSessionID: 1,
          SeriesID: 5,
        }),
      )?.track,
    ).toBe("Watkins Glen International — Boot");
  });

  it("reads an offline session as SubSessionID 0 with no series", () => {
    expect(
      replaySessionHeaderFromSessionInfo(sessionInfo({ TrackDisplayName: "Suzuka", SubSessionID: 0, SeriesID: 0 })),
    ).toEqual({ subSessionId: 0, track: "Suzuka", series: "" });
  });

  it("falls back to TrackName and accepts a numeric string SubSessionID", () => {
    expect(replaySessionHeaderFromSessionInfo(sessionInfo({ TrackName: "suzuka", SubSessionID: "42" }))).toEqual({
      subSessionId: 42,
      track: "suzuka",
      series: "",
    });
  });

  it("is undefined while there is no readable SubSessionID", () => {
    expect(replaySessionHeaderFromSessionInfo(null)).toBeUndefined();
    expect(replaySessionHeaderFromSessionInfo({})).toBeUndefined();
    expect(replaySessionHeaderFromSessionInfo(sessionInfo({ TrackDisplayName: "x" }))).toBeUndefined();
    expect(replaySessionHeaderFromSessionInfo(sessionInfo({ SubSessionID: "abc" }))).toBeUndefined();
  });
});

describe("createReplaySessionSubscriber", () => {
  function setup(info: SessionInfo | null = talladega) {
    const store = { setActiveSession: vi.fn(), clearActiveSession: vi.fn() };
    const getSessionInfo = vi.fn(() => info);
    const tick = createReplaySessionSubscriber({ store, getSessionInfo, logger: silentLogger });

    return { store, getSessionInfo, tick };
  }

  it("opens the session's record once when its SubSessionID first appears, not per tick", () => {
    const { store, tick } = setup();

    tick(null, true);
    tick(null, true);
    tick(null, true);

    expect(store.setActiveSession).toHaveBeenCalledTimes(1);
    expect(store.setActiveSession).toHaveBeenCalledWith({
      subSessionId: 86697546,
      track: "Talladega Superspeedway",
      series: "167",
    });
  });

  it("does nothing while the session info carries no SubSessionID yet", () => {
    const { store, tick } = setup(null);

    tick(null, true);

    expect(store.setActiveSession).not.toHaveBeenCalled();
    expect(store.clearActiveSession).not.toHaveBeenCalled();
  });

  it("closes the record on disconnect — once — and re-opens it on reconnect", () => {
    const { store, tick } = setup();

    tick(null, true);
    tick(null, false);
    tick(null, false);
    tick(null, true);

    expect(store.clearActiveSession).toHaveBeenCalledTimes(1);
    expect(store.setActiveSession).toHaveBeenCalledTimes(2);
  });

  it("does not clear a store it never opened", () => {
    const { store, tick } = setup(null);

    tick(null, false);

    expect(store.clearActiveSession).not.toHaveBeenCalled();
  });

  it("follows a session change within one connection", () => {
    const { store, getSessionInfo, tick } = setup();

    tick(null, true);
    getSessionInfo.mockReturnValue(sessionInfo({ TrackDisplayName: "Suzuka", SubSessionID: 0 }));
    tick(null, true);

    expect(store.setActiveSession).toHaveBeenLastCalledWith({ subSessionId: 0, track: "Suzuka", series: "" });
    expect(store.setActiveSession).toHaveBeenCalledTimes(2);
  });

  it("swallows a store failure so the controller's other subscribers still run", () => {
    const { store, tick } = setup();

    store.setActiveSession.mockImplementation(() => {
      throw new Error("disk on fire");
    });

    expect(() => tick(null, true)).not.toThrow();
  });
});
