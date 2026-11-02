/**
 * The step boundary of a translator tick (#1559): the spec's "boundary module" tests,
 * driven through a real #1558 boundary with a fake logger and a fake clock, so what a
 * throw costs is read from the log lines the reporter writes.
 */
import { createErrorBoundary, type ErrorPolicy, type ILogger } from "@iracedeck/logger";
import { describe, expect, it } from "vitest";

import type { EmitFn, PendingEvent } from "./diff/types.js";
import {
  type RequiredValue,
  runUnitsDirectly,
  TICK_STEP_KEYS_PER_ID,
  TickSteps,
  type UnitRunner,
  VALUE_UNAVAILABLE,
} from "./tick-steps.js";

type Line = { level: string; message: string };

function fakeLogger(): { logger: ILogger; lines: Line[] } {
  const lines: Line[] = [];
  const write = (level: string) => (message: string) => {
    lines.push({ level, message });
  };
  const logger: ILogger = {
    trace: write("trace"),
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    withLevel: () => logger,
    createScope: () => logger,
  };

  return { logger, lines };
}

const throwingLogger: ILogger = {
  trace: () => {
    throw new Error("logger trace");
  },
  debug: () => {
    throw new Error("logger debug");
  },
  info: () => {
    throw new Error("logger info");
  },
  warn: () => {
    throw new Error("logger warn");
  },
  error: () => {
    throw new Error("logger error");
  },
  withLevel: () => throwingLogger,
  createScope: () => throwingLogger,
};

function setup(options: { policy?: ErrorPolicy; logger?: ILogger; prefix?: string } = {}) {
  const fake = fakeLogger();
  let clock = 1_000;
  const boundary = createErrorBoundary({
    logger: options.logger ?? fake.logger,
    policy: options.policy,
    now: () => clock,
  });
  const steps = new TickSteps({ boundary, prefix: options.prefix ?? "translator:" });

  return {
    steps,
    lines: fake.lines,
    advance: (ms: number) => {
      clock += ms;
    },
    errorLines: () => fake.lines.filter((line) => line.level === "error"),
  };
}

const boom = (message = "boom"): never => {
  throw new Error(message);
};

describe("TICK_STEP_KEYS_PER_ID", () => {
  it("is #1558's per-id default, which the translator multiplies by its ids for its global cap", () => {
    expect(TICK_STEP_KEYS_PER_ID).toBe(4);
  });
});

describe("TickSteps.stepId", () => {
  it("prefixes the name and returns the same string on every call", () => {
    const { steps } = setup({ prefix: "replay-recorder:" });

    expect(steps.stepId("diffReplayLaps")).toBe("replay-recorder:diffReplayLaps");
    expect(steps.stepId("diffReplayLaps")).toBe(steps.stepId("diffReplayLaps"));
  });
});

describe("TickSteps.live", () => {
  it("commits the events of a step that returns", () => {
    const { steps, lines } = setup();
    const pending: string[] = ["earlier"];

    const completed = steps.live("diffLaps", pending, () => {
      pending.push("lap.completed", "race.finished");
    });

    expect(completed).toBe(true);
    expect(pending).toEqual(["earlier", "lap.completed", "race.finished"]);
    expect(lines).toEqual([]);
  });

  it("commits neither event of a step that emits two and then throws, truncating pending to its mark", () => {
    const { steps } = setup();
    const pending: string[] = ["earlier"];

    const completed = steps.live("diffIncidents", pending, () => {
      pending.push("incident.occurred", "incident.scored");
      boom();
    });

    expect(completed).toBe(false);
    expect(pending).toEqual(["earlier"]);
  });

  it("reports a throwing step once as translator:<name>, and the next step still runs", () => {
    const { steps, errorLines, advance } = setup();
    const pending: string[] = [];
    const tick = (): void => {
      steps.live("diffRadar", pending, () => boom("radar"));
      steps.live("diffPitSpeeding", pending, () => {
        pending.push("pitSpeeding.started");
      });
      steps.finish();
    };

    tick();
    advance(16);
    tick();

    expect(pending).toEqual(["pitSpeeding.started", "pitSpeeding.started"]);
    expect(errorLines()).toHaveLength(1);
    expect(errorLines()[0]?.message).toMatch(/^translator:diffRadar threw: Error: radar/);
  });

  it("truncates under rethrow too, and the step after it still commits", () => {
    const { steps } = setup({ policy: "rethrow" });
    const pending: string[] = [];

    steps.live("diffPitLane", pending, () => {
      pending.push("pitLane.entered");
      boom();
    });
    steps.live("diffToggles", pending, () => {
      pending.push("toggle");
    });

    expect(pending).toEqual(["toggle"]);
    expect(() => steps.finish()).toThrow("boom");
  });
});

describe("TickSteps.run", () => {
  it("returns whether a step that emits nothing completed, and reports its throw", () => {
    const { steps, errorLines } = setup();

    expect(steps.run("diffTireTemps", () => {})).toBe(true);
    expect(steps.run("updatePositionTracking", () => boom())).toBe(false);
    expect(errorLines().map((line) => line.message.split(" threw")[0])).toEqual([
      "translator:updatePositionTracking",
    ]);
  });
});

describe("TickSteps.runUnit", () => {
  it("drops a throwing unit's own events while the step's other units commit, reported under the step's id", () => {
    const { steps, errorLines } = setup();
    const pending: string[] = [];
    const emit = (event: string): void => {
      pending.push(event);
    };
    const results: boolean[] = [];

    const completed = steps.live("diffOpponentPit", pending, () => {
      for (const car of [1, 2, 3]) {
        results.push(
          steps.runUnit(emit, (unitEmit) => {
            unitEmit(`car ${car} entered`);

            if (car === 2) boom("car 2");

            unitEmit(`car ${car} classified`);
          }),
        );
      }

      emit("field aggregate");
    });

    expect(completed).toBe(true);
    expect(results).toEqual([true, false, true]);
    expect(pending).toEqual([
      "car 1 entered",
      "car 1 classified",
      "car 3 entered",
      "car 3 classified",
      "field aggregate",
    ]);
    expect(errorLines()).toHaveLength(1);
    expect(errorLines()[0]?.message).toMatch(/^translator:diffOpponentPit threw: Error: car 2/);
  });

  it("drops a committed unit's events with its step when the step throws later", () => {
    const { steps } = setup();
    const pending: string[] = ["earlier"];
    const emit = (event: string): void => {
      pending.push(event);
    };

    steps.live("diffOpponentFlags", pending, () => {
      steps.runUnit(emit, (unitEmit) => unitEmit("car 1"));
      boom("aggregation");
    });

    expect(pending).toEqual(["earlier"]);
  });

  it("commits a nested unit's events into its outer unit, in order", () => {
    const { steps } = setup();
    const pending: string[] = [];
    const emit = (event: string): void => {
      pending.push(event);
    };

    steps.live("diffReplayIncidents", pending, () => {
      steps.runUnit(emit, (outer) => {
        outer("a");
        steps.runUnit(outer, (inner) => {
          inner("b");
          inner("c");
        });
        steps.runUnit(outer, (inner) => {
          inner("dropped");
          boom();
        });
        outer("d");
      });
    });

    expect(pending).toEqual(["a", "b", "c", "d"]);
  });

  it("buffers units inside a direct step, so they reach the sink only when the step returns", () => {
    const { steps } = setup({ prefix: "replay-recorder:" });
    const published: string[] = [];

    steps.direct(
      "diffReplayLaps",
      (event: string) => published.push(event),
      (emit) => {
        for (const car of [0, 1, 2]) {
          steps.runUnit(emit, (unitEmit) => {
            if (car === 1) boom("car 1");

            unitEmit(`crossing ${car}`);
          });
          expect(published).toEqual([]);
        }
      },
    );

    expect(published).toEqual(["crossing 0", "crossing 2"]);
  });

  it("under rethrow runs every unit and holds the first unit's error for finish", () => {
    const { steps, lines } = setup({ policy: "rethrow" });
    const pending: string[] = [];
    const emit = (event: string): void => {
      pending.push(event);
    };

    steps.live("diffOpponentPit", pending, () => {
      for (const car of [1, 2, 3]) {
        steps.runUnit(emit, (unitEmit) => {
          if (car !== 3) boom(`car ${car}`);

          unitEmit(`car ${car}`);
        });
      }
    });

    expect(pending).toEqual(["car 3"]);
    expect(lines).toEqual([]);
    expect(() => steps.finish()).toThrow("car 1");
  });

  it("outside any step runs the unit directly, and a throw escapes", () => {
    const { steps } = setup();
    const emitted: string[] = [];

    expect(
      steps.runUnit(
        (event: string) => emitted.push(event),
        (emit) => emit("direct"),
      ),
    ).toBe(true);
    expect(emitted).toEqual(["direct"]);
    expect(() =>
      steps.runUnit(
        (event: string) => emitted.push(event),
        () => boom("loud"),
      ),
    ).toThrow("loud");
  });

  it("types a per-car diff over EmitFn<…> with no cast", () => {
    const { steps } = setup();
    const pending: PendingEvent[] = [];

    // The shape a diff module takes: its own EmitFn, and a UnitRunner defaulting to the pass-through.
    const diffEachCar = (
      emit: EmitFn<"driver.firstOnTrack" | "pitSpeeding.ended">,
      cars: number[],
      runUnit: UnitRunner = runUnitsDirectly,
    ): void => {
      for (const car of cars) {
        runUnit(emit, (unitEmit) => {
          if (car < 0) boom();

          unitEmit({ event: "driver.firstOnTrack", data: {} });
        });
      }
    };

    steps.live("diffEachCar", pending, () => diffEachCar((event) => pending.push(event), [0, -1, 2], steps.runUnit));

    expect(pending.map((event) => event.event)).toEqual(["driver.firstOnTrack", "driver.firstOnTrack"]);
  });
});

describe("runUnitsDirectly", () => {
  it("hands the unit the outer emit itself and lets a throw escape", () => {
    const emitted: string[] = [];
    const emit = (event: string): void => {
      emitted.push(event);
    };
    let received: unknown;

    expect(
      runUnitsDirectly(emit, (unitEmit) => {
        received = unitEmit;
        unitEmit("x");
      }),
    ).toBe(true);
    expect(received).toBe(emit);
    expect(emitted).toEqual(["x"]);
    expect(() => runUnitsDirectly(emit, () => boom("unit"))).toThrow("unit");
  });
});

describe("TickSteps.direct", () => {
  it("passes a step's events to the sink in order when it returns", () => {
    const { steps } = setup();
    const published: string[] = [];

    const completed = steps.direct(
      "diffStartCountdown",
      (event: string) => published.push(event),
      (emit) => {
        emit("first");
        emit("second");
        expect(published).toEqual([]);
      },
    );

    expect(completed).toBe(true);
    expect(published).toEqual(["first", "second"]);
  });

  it("publishes nothing from a step that throws, and the next direct step publishes only its own events", () => {
    const { steps, errorLines } = setup();
    const published: string[] = [];
    const sink = (event: string): void => {
      published.push(event);
    };

    expect(
      steps.direct("diffFirstOnTrack", sink, (emit) => {
        emit("driver.firstOnTrack");
        boom("first on track");
      }),
    ).toBe(false);
    expect(published).toEqual([]);

    expect(steps.direct("readTireTempsLeavingCar", sink, (emit) => emit("next"))).toBe(true);
    expect(published).toEqual(["next"]);
    expect(errorLines()[0]?.message).toMatch(/^translator:diffFirstOnTrack threw/);
  });

  it("reports a throwing sink under the step's id and drops the events after it", () => {
    const { steps, errorLines } = setup();
    const published: string[] = [];

    const completed = steps.direct(
      "diffStartCountdown",
      (event: string) => {
        if (event === "second") boom("sink");

        published.push(event);
      },
      (emit) => {
        emit("first");
        emit("second");
        emit("third");
      },
    );

    expect(completed).toBe(false);
    expect(published).toEqual(["first"]);
    expect(errorLines()[0]?.message).toMatch(/^translator:diffStartCountdown threw: Error: sink/);
    expect(
      steps.direct(
        "diffStartCountdown",
        (event: string) => published.push(event),
        (emit) => emit("later"),
      ),
    ).toBe(true);
    expect(published).toEqual(["first", "later"]);
  });
});

describe("TickSteps.value", () => {
  it("stores a good answer under the value's name and returns it", () => {
    const { steps } = setup();
    const store = new Map<string, unknown>();

    expect(steps.value("resolveIsMultiClass", store, null, () => true)).toBe(true);
    expect(store.get("resolveIsMultiClass")).toBe(true);
  });

  it("returns the last value this session when the resolver throws, and reports the throw", () => {
    const { steps, errorLines } = setup();
    const store = new Map<string, unknown>();

    steps.value<boolean | null>("resolveIsMultiClass", store, null, () => true);

    expect(steps.value<boolean | null>("resolveIsMultiClass", store, null, () => boom("null driver"))).toBe(true);
    expect(errorLines()[0]?.message).toMatch(/^translator:resolveIsMultiClass threw: Error: null driver/);
  });

  it("returns the absent answer when the resolver throws with no last value", () => {
    const { steps } = setup();
    const store = new Map<string, unknown>();

    expect(steps.value("resolveSessionType", store, "", () => boom())).toBe("");
    expect(store.has("resolveSessionType")).toBe(false);
  });

  it("keeps a stored undefined as a last value rather than the absent answer", () => {
    const { steps } = setup();
    const store = new Map<string, unknown>();

    steps.value<string | undefined>("v", store, "absent", () => undefined);

    expect(steps.value<string | undefined>("v", store, "absent", () => boom())).toBeUndefined();
  });

  it("returns the fallback once the caller has cleared the store", () => {
    const { steps } = setup();
    const store = new Map<string, unknown>();

    steps.value("resolvePlayerCarIdx", store, -1, () => 7);
    store.clear();

    expect(steps.value("resolvePlayerCarIdx", store, -1, () => boom())).toBe(-1);
  });
});

describe("TickSteps.fallbackValue", () => {
  it("returns the fallback on a throw even after good answers", () => {
    const { steps, errorLines } = setup();

    expect(steps.fallbackValue("resolvePlayerIsLeader", false, () => true)).toBe(true);
    expect(steps.fallbackValue("resolvePlayerIsLeader", false, () => true)).toBe(true);
    expect(steps.fallbackValue("resolvePlayerIsLeader", false, () => boom())).toBe(false);
    expect(errorLines()[0]?.message).toMatch(/^translator:resolvePlayerIsLeader threw/);
  });
});

describe("TickSteps.requiredValue", () => {
  it("returns the answer when the resolver completes", () => {
    const { steps } = setup();
    const order = [3, 1, 2];

    expect(steps.requiredValue("resolveCanonicalOrder", () => order)).toEqual({ ok: true, value: order });
  });

  it("answers a failure with the one frozen VALUE_UNAVAILABLE", () => {
    const { steps } = setup();

    expect(steps.requiredValue("resolveCanonicalOrder", (): number[] => boom())).toBe(VALUE_UNAVAILABLE);
    expect(Object.isFrozen(VALUE_UNAVAILABLE)).toBe(true);
    expect(VALUE_UNAVAILABLE).toEqual({ ok: false });
  });

  it("reports a value with no fallback as failed when the resolver throws", () => {
    const { steps, errorLines } = setup();

    const result: RequiredValue<number[]> = steps.requiredValue("resolveCanonicalOrder", (): number[] => boom());

    expect(result).toEqual({ ok: false });
    expect(errorLines()[0]?.message).toMatch(/^translator:resolveCanonicalOrder threw/);
  });
});

describe("a logger that throws", () => {
  it("costs nothing: the step is still truncated, reported into the void, and the tick completes", () => {
    const { steps } = setup({ logger: throwingLogger });
    const pending: string[] = [];
    const store = new Map<string, unknown>();

    const tick = (): void => {
      steps.live("diffRadar", pending, () => {
        pending.push("radar.changed");
        boom();
      });
      steps.live("diffPitSpeeding", pending, () => {
        pending.push("pitSpeeding.started");
      });
      expect(steps.value("resolveTrackType", store, "unknown", () => boom())).toBe("unknown");
      steps.finish();
    };

    expect(tick).not.toThrow();
    expect(tick).not.toThrow();
    expect(pending).toEqual(["pitSpeeding.started", "pitSpeeding.started"]);
  });
});

describe('under "rethrow"', () => {
  it("runs every step, reports nothing and throws the first error from finish after the last step", () => {
    const { steps, lines } = setup({ policy: "rethrow" });
    const pending: string[] = [];
    const ran: string[] = [];
    const first = new Error("first");

    steps.live("diffLifecycle", pending, () => {
      ran.push("diffLifecycle");
      throw first;
    });
    expect(
      steps.fallbackValue("resolvePlayerIsLeader", false, () => {
        ran.push("resolvePlayerIsLeader");

        return boom("second");
      }),
    ).toBe(false);
    steps.live("diffFlags", pending, () => {
      ran.push("diffFlags");
      pending.push("flag");
    });

    expect(ran).toEqual(["diffLifecycle", "resolvePlayerIsLeader", "diffFlags"]);
    expect(pending).toEqual(["flag"]);
    expect(lines).toEqual([]);

    let thrown: unknown;

    try {
      steps.finish();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(first);
    expect(() => steps.finish()).not.toThrow();
  });

  it("finish does nothing on a clean tick", () => {
    const { steps } = setup({ policy: "rethrow" });

    steps.run("diffTrackGaps", () => {});

    expect(() => steps.finish()).not.toThrow();
  });
});

describe('under "report"', () => {
  it("never throws out of the runner, finish included", () => {
    const { steps } = setup();
    const pending: string[] = [];

    expect(() => {
      steps.live("diffGaps", pending, () => boom());
      steps.direct(
        "diffStartCountdown",
        () => boom(),
        (emit) => emit("x"),
      );
      steps.run("updateStallVisit", () => boom());
      steps.requiredValue("updateStallVisit", () => boom());
      steps.finish();
    }).not.toThrow();
  });
});
