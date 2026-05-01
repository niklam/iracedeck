/**
 * Local development server for the scenario harness.
 *
 * HTTP for state writes, WebSocket for the live event/state/audio stream.
 * No auth — bound to 127.0.0.1, intended only for local development. The
 * single Fastify instance owns route registration, the WS bridge, and the
 * static UI handler.
 */
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { AudioBus, IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, PitReadbackSnapshot, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { SessionInfo, TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { fastify, type FastifyInstance } from "fastify";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ALL_EVENT_NAMES, EVENT_TEMPLATES } from "./event-names.js";
import type { MockPlatformAdapter } from "./mock-platform-adapter.js";
import type { MockSDKController } from "./mock-sdk-controller.js";
import { snapshotToTelemetryPatch } from "./pit-readback-telemetry.js";
import { SCENARIO_SHORTCUTS } from "./scenario-shortcuts.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 5750;

export type HarnessContext = {
  controller: MockSDKController;
  adapter: MockPlatformAdapter;
  bus: IEventBus;
  audio: IAudioService;
  /** Absolute path to the package root. UI + presets resolved relative to this. */
  packageRoot: string;
  logger: ILogger;
  /**
   * Re-run the audio-assets processor against the harness's audio dest dir.
   * Lets the user generate fresh TTS clips and audition them without
   * restarting the harness. Closure (rather than a path) keeps the boot-
   * time wiring in main.ts and the server agnostic to dest layout.
   */
  refreshAudioAssets: () => Promise<void>;
};

type ClientMessage =
  | { kind: "event"; payload: SimEventOf<SimEventName> }
  | {
      kind: "state";
      section: "controller" | "settings" | "audioDevices";
      value: unknown;
    }
  | {
      kind: "audio";
      channel: AudioChannel;
      status: "started" | "completed";
      filePath?: string;
    };

type Preset = { name: string; data: Record<string, unknown> };

function loadPresets(dir: string): Preset[] {
  let entries: string[];

  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const presets: Preset[] = [];

  for (const file of entries) {
    if (!file.endsWith(".json")) continue;

    const name = file.slice(0, -".json".length);

    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf-8")) as Record<string, unknown>;
      presets.push({ name, data });
    } catch {
      // Skip malformed presets — log at the boundary to keep the server contract clean.
    }
  }

  return presets;
}

/**
 * Shape-check an incoming `/api/readback/snapshot` body. Returns the snapshot
 * on success or a user-facing error string on the first failed field — the
 * same lightweight validation style the other endpoints in this file use.
 */
function validatePitReadbackSnapshot(body: unknown): PitReadbackSnapshot | string {
  if (typeof body !== "object" || body === null) return "body must be an object";

  const b = body as Record<string, unknown>;

  const fuel = b.fuel as Record<string, unknown> | undefined;

  if (!fuel || typeof fuel.queued !== "boolean") return "fuel.queued must be a boolean";

  const tires = b.tires as Record<string, unknown> | undefined;

  if (
    !tires ||
    typeof tires.lf !== "boolean" ||
    typeof tires.rf !== "boolean" ||
    typeof tires.lr !== "boolean" ||
    typeof tires.rr !== "boolean"
  ) {
    return "tires must have boolean lf/rf/lr/rr";
  }

  const compoundChange = b.compoundChange as Record<string, unknown> | null | undefined;

  if (compoundChange !== null) {
    if (!compoundChange || typeof compoundChange.from !== "number" || typeof compoundChange.to !== "number") {
      return "compoundChange must be null or { from: number, to: number }";
    }
  }

  const fastRepair = b.fastRepair as Record<string, unknown> | undefined;

  if (!fastRepair || typeof fastRepair.queued !== "boolean" || typeof fastRepair.available !== "boolean") {
    return "fastRepair must have boolean queued/available";
  }

  const windshield = b.windshield as Record<string, unknown> | undefined;

  if (!windshield || typeof windshield.queued !== "boolean" || typeof windshield.available !== "boolean") {
    return "windshield must have boolean queued/available";
  }

  if (typeof b.limiterEngaged !== "boolean") return "limiterEngaged must be a boolean";

  return body as PitReadbackSnapshot;
}

function audioBusVolumeMap(audio: IAudioService): Record<number, number> {
  const out: Record<number, number> = {};

  for (let bus = 0 as AudioBus; bus < 3; bus = (bus + 1) as AudioBus) {
    out[bus] = audio.getBusVolume(bus);
  }

  return out;
}

export async function createServer(ctx: HarnessContext): Promise<FastifyInstance> {
  const app = fastify({ logger: false });

  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, {
    root: join(ctx.packageRoot, "ui"),
    prefix: "/",
    index: ["index.html"],
  });

  // ── Connected WS clients ────────────────────────────────────────────────
  const sockets = new Set<{ send: (raw: string) => void }>();

  function broadcast(message: ClientMessage): void {
    if (sockets.size === 0) return;

    const raw = JSON.stringify(message);

    for (const socket of sockets) {
      try {
        socket.send(raw);
      } catch {
        // Client likely disconnected — let close handler clean it up.
      }
    }
  }

  // ── Forward bus events to WS ────────────────────────────────────────────
  // No wildcard subscribe API on the bus, so subscribe to each catalog name.
  for (const name of ALL_EVENT_NAMES) {
    ctx.bus.subscribe(name, (event) => {
      broadcast({ kind: "event", payload: event });
    });
  }

  // ── Forward controller / settings / audio device state to WS ────────────
  ctx.controller.onStateChange((state) => {
    broadcast({ kind: "state", section: "controller", value: state });
  });
  ctx.adapter.onDidReceiveGlobalSettings((settings) => {
    broadcast({ kind: "state", section: "settings", value: settings });
  });

  // ── Forward audio playback start/complete to WS ─────────────────────────
  ctx.audio.setPlaybackObserver({
    onStart: (channel, filePath) => broadcast({ kind: "audio", channel, status: "started", filePath }),
    onComplete: (channel) => broadcast({ kind: "audio", channel, status: "completed" }),
  });

  // ── Preset loading ──────────────────────────────────────────────────────
  const telemetryPresets = loadPresets(join(ctx.packageRoot, "presets", "telemetry"));
  const sessionPresets = loadPresets(join(ctx.packageRoot, "presets", "session"));
  const presetByName = (presets: Preset[], name: string): Preset | undefined => presets.find((p) => p.name === name);

  // ── Routes ──────────────────────────────────────────────────────────────

  app.get("/api/state", () => {
    return {
      controller: ctx.controller.getState(),
      settings: ctx.adapter.readSettings(),
      audio: {
        devices: ctx.audio.getAudioDevices(),
        busVolumes: audioBusVolumeMap(ctx.audio),
      },
      eventTemplates: EVENT_TEMPLATES,
      shortcuts: SCENARIO_SHORTCUTS,
      presets: {
        telemetry: telemetryPresets.map((p) => p.name),
        session: sessionPresets.map((p) => p.name),
      },
    };
  });

  app.post("/api/connection", async (req, reply) => {
    const body = req.body as { connected?: unknown };

    if (typeof body.connected !== "boolean") return reply.code(400).send({ error: "connected must be a boolean" });

    ctx.controller.setConnected(body.connected);

    return ctx.controller.getState();
  });

  app.post("/api/tick", async (req, reply) => {
    const body = req.body as { intervalMs?: unknown; paused?: unknown };

    if (body.intervalMs !== undefined) {
      if (typeof body.intervalMs !== "number" || body.intervalMs < 50 || body.intervalMs > 5000) {
        return reply.code(400).send({ error: "intervalMs must be a number between 50 and 5000" });
      }

      ctx.controller.setTickInterval(body.intervalMs);
    }

    if (body.paused !== undefined) {
      if (typeof body.paused !== "boolean") return reply.code(400).send({ error: "paused must be a boolean" });

      if (body.paused) ctx.controller.stop();
      else ctx.controller.start();
    }

    return ctx.controller.getState();
  });

  app.post("/api/tick/once", () => {
    ctx.controller.tickOnce();

    return ctx.controller.getState();
  });

  app.post("/api/telemetry", async (req, reply) => {
    const body = req.body as { patch?: unknown; snapshot?: unknown };

    if (body.snapshot !== undefined) {
      if (typeof body.snapshot !== "object" || body.snapshot === null) {
        return reply.code(400).send({ error: "snapshot must be an object" });
      }

      ctx.controller.setTelemetry(body.snapshot as TelemetryData);
    } else if (body.patch !== undefined) {
      if (typeof body.patch !== "object" || body.patch === null) {
        return reply.code(400).send({ error: "patch must be an object" });
      }

      ctx.controller.mutateTelemetry(body.patch as Partial<TelemetryData>);
    } else {
      return reply.code(400).send({ error: "expected `patch` or `snapshot`" });
    }

    return ctx.controller.getState();
  });

  app.post("/api/telemetry/preset", async (req, reply) => {
    const body = req.body as { name?: unknown };

    if (typeof body.name !== "string") return reply.code(400).send({ error: "name must be a string" });

    const preset = presetByName(telemetryPresets, body.name);

    if (!preset) return reply.code(404).send({ error: `unknown preset: ${body.name}` });

    ctx.controller.mutateTelemetry(preset.data as Partial<TelemetryData>);

    return ctx.controller.getState();
  });

  app.post("/api/session", async (req, reply) => {
    const body = req.body as { snapshot?: unknown };

    if (body.snapshot !== undefined && body.snapshot !== null && typeof body.snapshot !== "object") {
      return reply.code(400).send({ error: "snapshot must be an object or null" });
    }

    ctx.controller.setSessionInfo((body.snapshot ?? null) as SessionInfo | null);

    return ctx.controller.getState();
  });

  app.post("/api/session/preset", async (req, reply) => {
    const body = req.body as { name?: unknown };

    if (typeof body.name !== "string") return reply.code(400).send({ error: "name must be a string" });

    const preset = presetByName(sessionPresets, body.name);

    if (!preset) return reply.code(404).send({ error: `unknown preset: ${body.name}` });

    ctx.controller.setSessionInfo(preset.data as unknown as SessionInfo);

    return ctx.controller.getState();
  });

  app.post("/api/settings", async (req, reply) => {
    const body = req.body as { patch?: unknown };

    if (typeof body.patch !== "object" || body.patch === null) {
      return reply.code(400).send({ error: "patch must be an object" });
    }

    const merged = { ...ctx.adapter.readSettings(), ...(body.patch as Record<string, unknown>) };
    ctx.adapter.setGlobalSettings(merged);

    return ctx.adapter.readSettings();
  });

  app.post("/api/audio/device", async (req, reply) => {
    const body = req.body as { deviceId?: unknown };
    const id = body.deviceId;

    if (id !== null && id !== "" && typeof id !== "string") {
      return reply.code(400).send({ error: "deviceId must be a string or empty" });
    }

    if (id === "" || id === null) {
      ctx.audio.setAudioDevice(-1);
    } else {
      const ok = ctx.audio.setAudioDeviceById(id);

      if (!ok) return reply.code(400).send({ error: `unknown device id: ${id}` });
    }

    // Persist the selection in the in-memory settings so a re-reading scenario sees it.
    const merged = { ...ctx.adapter.readSettings(), audioOutputDevice: id ?? "" };
    ctx.adapter.setGlobalSettings(merged);

    broadcast({ kind: "state", section: "audioDevices", value: ctx.audio.getAudioDevices() });

    return { audioOutputDevice: id ?? "" };
  });

  app.post("/api/audio/refresh", async (_req, reply) => {
    try {
      await ctx.refreshAudioAssets();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`Audio refresh failed: ${message}`);

      return reply.code(500).send({ error: message });
    }

    return reply.code(204).send();
  });

  app.post("/api/readback/snapshot", async (req, reply) => {
    const snapshot = validatePitReadbackSnapshot(req.body);

    if (typeof snapshot === "string") return reply.code(400).send({ error: snapshot });

    const current = ctx.controller.getState().telemetry;
    ctx.controller.mutateTelemetry(snapshotToTelemetryPatch(snapshot, current));
    // Synchronous tick so the translator's `latestTelemetry` updates before
    // the response returns — eliminates the publish-vs-tick race when the
    // UI fires the readback right after a control change.
    ctx.controller.tickOnce();

    return reply.code(204).send();
  });

  app.post("/api/bus/publish", async (req, reply) => {
    const body = req.body as { event?: unknown; data?: unknown };

    if (typeof body.event !== "string" || !ALL_EVENT_NAMES.includes(body.event as SimEventName)) {
      return reply.code(400).send({ error: `event must be one of: ${ALL_EVENT_NAMES.join(", ")}` });
    }

    if (typeof body.data !== "object" || body.data === null) {
      return reply.code(400).send({ error: "data must be an object" });
    }

    ctx.bus.publish({
      event: body.event as SimEventName,
      timestamp: Date.now(),
      telemetry: ctx.controller.getState().telemetry,
      data: body.data as Record<string, unknown>,
    } as SimEventOf<SimEventName>);

    return reply.code(204).send();
  });

  // ── WebSocket bridge ────────────────────────────────────────────────────
  app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (socket) => {
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
      });
      // No client-to-server messages in v1 — all writes go through HTTP.
    });
  });

  return app;
}

export async function startServer(
  ctx: HarnessContext,
  options: { host?: string; port?: number } = {},
): Promise<{ app: FastifyInstance; address: string }> {
  const app = await createServer(ctx);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const address = await app.listen({ host, port });
  ctx.logger.info(`Scenario harness listening at ${address}`);

  return { app, address };
}
