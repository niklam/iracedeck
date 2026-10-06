import { initAudio } from "./phases/audio.js";
import { initCore } from "./phases/core.js";
import { initInput } from "./phases/input.js";
import { initRaceEngineer } from "./phases/race-engineer.js";
import { registerActions } from "./phases/register-actions.js";
import { initSettings } from "./phases/settings.js";
import { initSim } from "./phases/sim.js";
import { startServices } from "./phases/start-services.js";
import { initVoicePacks } from "./phases/voice-packs.js";
import type { PluginHost } from "./types.js";

/**
 * Start a deck plugin (#1349). Synchronous like the module scope it replaced:
 * the fire-and-forget work (the first catalog ask, the settings server, the
 * voice-pack launch step, the 15 s notices timer) stays fire-and-forget.
 * Each phase takes what it needs as arguments, so it cannot run before that
 * exists; `start-plugin.test.ts` pins the rest of the order.
 */
export function startPlugin(host: PluginHost): void {
  const core = initCore(host);
  const sim = initSim(core);
  const input = initInput(core);
  const audio = initAudio(core);
  const voicePacks = initVoicePacks(core, audio);

  initRaceEngineer(core, sim, audio, voicePacks);

  const settings = initSettings(core, audio, voicePacks);

  registerActions(core, input);
  startServices(core, input, settings, voicePacks);

  // Always last: every handler is registered before the host can deliver an event.
  core.adapter.connect();
}
