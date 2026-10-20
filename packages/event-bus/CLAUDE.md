# @iracedeck/event-bus

Typed pub/sub with the canonical sim-event catalog. Sim- and audio-agnostic: the envelope's telemetry field is generic, so the package depends on no simulator SDK.

## Shape

- The singleton trio `initializeEventBus` / `getEventBus` / `isEventBusInitialized` (`src/event-bus.ts`), plus `_resetEventBus` for tests.
- The catalog types (`SimEventMap`, `SimEventName`, `SimEventOf` and the payloads) live in `src/event-catalog.ts` and are re-exported from `src/index.ts`. Publishers and subscribers both index into `SimEventMap` by event name and receive a fully typed envelope.

## Rules

- The catalog is a published contract (reviewed at `xhigh`, `.claude/rules/code-review.md`).
- Its publisher is the sim's translator (`@iracedeck/sim-events-iracing` for iRacing); a second sim gets a parallel translator emitting the same catalog. `telemetryReadout.requested` is the exception: the deck layer publishes it.
- Every new event needs an `src/event-names.ts` entry in `@iracedeck/scenario-harness`.
