/* eslint-env browser */
// iRaceDeck Scenario Harness — single-file vanilla UI.
//
// All state writes go through HTTP. The WebSocket only carries server →
// client updates: bus events, controller / settings state changes, audio
// playback start/complete. Multiple browser tabs stay in sync because the
// server fans out every state change.

const $ = (id) => document.getElementById(id);
const MAX_LOG_ENTRIES = 500;
const SETTINGS_STORAGE_KEY = "iracedeck-harness-settings-v1";

const state = {
  controller: null,
  settings: {},
  eventTemplates: [],
  shortcuts: [],
  presets: { telemetry: [], session: [] },
  audioDevices: [],
  eventCount: 0,
};

// ── Settings persistence (localStorage) ───────────────────────────────────
// User-tunable global settings persist across browser reloads AND harness
// restarts. The harness server is in-memory only — it re-seeds defaults on
// every boot. We bridge that gap by:
//   1. On page load, before the first /api/state, posting the persisted
//      settings to /api/settings so the seeded values get overwritten.
//   2. On every settings update broadcast (WS or HTTP response), writing
//      the latest server-truth back to localStorage.
//
// `_`-prefixed keys are server-derived (voice/driver name lists, audio
// device list) and never persisted — they're refreshed from the manifest
// every boot, and forcing stale values back would break the UI.

function loadPersistedSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persistSettings(settings) {
  if (!settings || typeof settings !== "object") return;
  const filtered = Object.fromEntries(
    Object.entries(settings).filter(([key]) => !key.startsWith("_")),
  );
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(filtered));
  } catch {
    // Quota exceeded or storage unavailable — fail open; the harness
    // still works, just without persistence in this browser.
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────

async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `POST ${path} failed: ${res.status}`);
  }
  if (res.status === 204) return undefined;
  return res.json();
}

// ── Render ────────────────────────────────────────────────────────────────

function renderTopbar() {
  if (!state.controller) return;
  $("connected-toggle").checked = state.controller.isConnected;
  $("tick-rate").value = state.controller.tickIntervalMs;
  $("tick-rate-value").textContent = `${state.controller.tickIntervalMs} ms`;
  $("tick-pause").textContent = state.controller.running ? "Pause" : "Resume";
}

function renderTelemetry() {
  if (!state.controller) return;
  $("telemetry-json").value = JSON.stringify(state.controller.telemetry, null, 2);
}

function renderSession() {
  if (!state.controller) return;
  $("session-json").value = state.controller.sessionInfo
    ? JSON.stringify(state.controller.sessionInfo, null, 2)
    : "null";
}

function renderPresets() {
  $("telemetry-presets").innerHTML = "";
  for (const name of state.presets.telemetry) {
    const btn = document.createElement("button");
    btn.textContent = name;
    btn.addEventListener("click", async () => {
      try {
        await post("/api/telemetry/preset", { name });
      } catch (e) {
        alert(`Failed: ${e.message}`);
      }
    });
    $("telemetry-presets").appendChild(btn);
  }

  $("session-presets").innerHTML = "";
  for (const name of state.presets.session) {
    const btn = document.createElement("button");
    btn.textContent = name;
    btn.addEventListener("click", async () => {
      try {
        await post("/api/session/preset", { name });
      } catch (e) {
        alert(`Failed: ${e.message}`);
      }
    });
    $("session-presets").appendChild(btn);
  }
}

function renderSettings() {
  const grid = $("settings-grid");
  grid.innerHTML = "";

  const lines = [
    {
      key: "pitCrewRaceEngineerEnabled",
      label: "Race Engineer Enabled",
      type: "checkbox",
    },
    {
      key: "raceEngineerVolume",
      label: "Race Engineer Volume",
      type: "range",
      min: 0,
      max: 100,
      step: 1,
    },
    {
      key: "raceEngineerVoice",
      label: "Voice",
      type: "select",
      options: parseJsonList(state.settings._raceEngineerVoices),
    },
    {
      key: "driverName",
      label: "Driver Name",
      type: "select",
      options: parseJsonList(state.settings._driverNames),
    },
    {
      key: "pitCrewRadarEnabled",
      label: "Radar Enabled",
      type: "checkbox",
    },
    {
      key: "radarVolume",
      label: "Radar Volume",
      type: "range",
      min: 0,
      max: 100,
      step: 1,
    },
    {
      key: "audioOutputDevice",
      label: "Audio Device",
      type: "select",
      options: [{ value: "", label: "System Default" }, ...state.audioDevices.map((d) => ({
        value: d.id,
        label: d.isDefault ? `${d.name} (default)` : d.name,
      }))],
      route: "/api/audio/device",
      param: "deviceId",
    },
  ];

  for (const line of lines) {
    const labelEl = document.createElement("label");
    labelEl.textContent = line.label;
    grid.appendChild(labelEl);

    const inputEl = makeSettingInput(line);
    grid.appendChild(inputEl);
  }
}

function parseJsonList(raw) {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => ({ value: String(v), label: String(v) })) : [];
  } catch {
    return [];
  }
}

function makeSettingInput(line) {
  const value = state.settings[line.key];
  const apply = async (newValue) => {
    if (line.route) {
      await post(line.route, { [line.param || "value"]: newValue });
    } else {
      await post("/api/settings", { patch: { [line.key]: newValue } });
    }
  };

  if (line.type === "checkbox") {
    const wrap = document.createElement("div");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value === true || value === "true";
    input.addEventListener("change", () => apply(input.checked).catch((e) => alert(e.message)));
    wrap.appendChild(input);
    return wrap;
  }

  if (line.type === "range") {
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.gap = "8px";
    wrap.style.alignItems = "center";

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(line.min);
    input.max = String(line.max);
    input.step = String(line.step);
    input.value = String(value ?? 0);

    const out = document.createElement("span");
    out.textContent = String(value ?? 0);
    out.style.fontFamily = "var(--mono)";
    out.style.color = "var(--text-dim)";
    out.style.minWidth = "32px";

    input.addEventListener("input", () => {
      out.textContent = input.value;
    });
    input.addEventListener("change", () => {
      apply(Number(input.value)).catch((e) => alert(e.message));
    });

    wrap.appendChild(input);
    wrap.appendChild(out);
    return wrap;
  }

  if (line.type === "select") {
    const select = document.createElement("select");
    for (const opt of line.options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      if (String(value ?? "") === opt.value) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener("change", () => apply(select.value).catch((e) => alert(e.message)));
    return select;
  }

  // Fallback for unknown types
  const input = document.createElement("input");
  input.type = "text";
  input.value = String(value ?? "");
  input.addEventListener("change", () => apply(input.value).catch((e) => alert(e.message)));
  return input;
}

function renderInjector() {
  const select = $("injector-event");
  select.innerHTML = "";
  for (const tmpl of state.eventTemplates) {
    const opt = document.createElement("option");
    opt.value = tmpl.name;
    opt.textContent = tmpl.name;
    select.appendChild(opt);
  }
  syncInjectorPayload();
}

function renderShortcuts() {
  const container = $("shortcuts");
  container.innerHTML = "";

  // Group shortcuts by category, preserving the original ordering of both
  // categories and items within them.
  const order = [];
  const grouped = new Map();
  for (const s of state.shortcuts) {
    if (!grouped.has(s.category)) {
      grouped.set(s.category, []);
      order.push(s.category);
    }
    grouped.get(s.category).push(s);
  }

  for (const category of order) {
    const wrap = document.createElement("div");
    wrap.className = "shortcut-category";

    const h3 = document.createElement("h3");
    h3.textContent = category;
    wrap.appendChild(h3);

    const buttons = document.createElement("div");
    buttons.className = "shortcut-buttons";

    for (const s of grouped.get(category)) {
      const btn = document.createElement("button");
      btn.textContent = s.label;
      if (s.description) btn.title = s.description;
      btn.addEventListener("click", async () => {
        try {
          // Issue #567 — qualifying-invalidation shortcuts carry an embedded
          // snapshot the scenario reads at fire time. Push it first so the
          // resolver returns the intended snapshot when the trigger event
          // arrives. `/api/qualifying-invalidation/snapshot` awaits a 204
          // before we publish, so there's no push-vs-fire race.
          if (s.qualifyingInvalidationSnapshot) {
            await post("/api/qualifying-invalidation/snapshot", s.qualifyingInvalidationSnapshot);
          }
          await post("/api/bus/publish", { event: s.event, data: s.data });
        } catch (e) {
          alert(`Shortcut "${s.label}" failed: ${e.message}`);
        }
      });
      buttons.appendChild(btn);
    }

    wrap.appendChild(buttons);
    container.appendChild(wrap);
  }
}

function syncInjectorPayload() {
  const name = $("injector-event").value;
  const tmpl = state.eventTemplates.find((t) => t.name === name);
  if (!tmpl) return;
  $("injector-payload").value = JSON.stringify(tmpl.data, null, 2);
  $("injector-description").textContent = tmpl.description;
}

// ── Event log ─────────────────────────────────────────────────────────────

function appendLogEntry(event) {
  const container = $("event-log");
  const entry = document.createElement("div");
  entry.className = "log-entry";

  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = new Date(event.timestamp).toISOString().slice(11, 23);

  const name = document.createElement("span");
  name.className = `name ${categoryOf(event.event)}`;
  name.textContent = event.event;

  const data = document.createElement("span");
  data.className = "data";
  data.textContent = JSON.stringify(event.data);

  entry.appendChild(ts);
  entry.appendChild(name);
  entry.appendChild(data);
  container.appendChild(entry);

  while (container.childElementCount > MAX_LOG_ENTRIES) {
    container.removeChild(container.firstChild);
  }
  container.scrollTop = container.scrollHeight;

  state.eventCount++;
  $("event-count").textContent = state.eventCount;
}

function categoryOf(name) {
  return name.split(".")[0] ?? "";
}

// ── Audio activity ────────────────────────────────────────────────────────

function updateAudio(message) {
  const row = document.querySelector(`.audio-row[data-channel="${message.channel}"]`);
  if (!row) return;
  const clipEl = row.querySelector(".audio-clip");
  if (message.status === "started") {
    row.classList.add("active");
    clipEl.textContent = shorten(message.filePath || "(unknown)");
  } else {
    row.classList.remove("active");
    clipEl.textContent = "idle";
  }
}

function shorten(path) {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

// ── WS ────────────────────────────────────────────────────────────────────

function connectWebSocket() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.addEventListener("message", (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }

    if (msg.kind === "event") {
      appendLogEntry(msg.payload);
    } else if (msg.kind === "audio") {
      updateAudio(msg);
    } else if (msg.kind === "state") {
      if (msg.section === "controller") {
        state.controller = msg.value;
        renderTopbar();
        renderTelemetry();
        renderSession();
        // Skip the EngineWarnings sync while a local PATCH is still in
        // flight — an older echo could otherwise resurrect a stale mask
        // and overwrite a more recent click. wireEngineWarnings()'s
        // .finally handler reconciles once the last write settles.
        if (engineWarningsPendingWrites === 0) syncEngineWarningsCheckboxes();
      } else if (msg.section === "settings") {
        state.settings = msg.value;
        persistSettings(msg.value);
        renderSettings();
      } else if (msg.section === "audioDevices") {
        state.audioDevices = msg.value;
        renderSettings();
      }
    }
  });
  ws.addEventListener("close", () => setTimeout(connectWebSocket, 1000));
}

// ── Engine Warnings panel ─────────────────────────────────────────────────
//
// One checkbox per bit in `telemetry.EngineWarnings`. The mock controller
// owns the bitfield; on every checkbox flip we recompute the full mask
// from the current UI state via `readEngineWarningsMaskFromUi()` and PATCH
// the new value via /api/telemetry. Reading from the UI rather than from
// the cached telemetry avoids racing the WS echo from the previous click,
// and naturally preserves bits set by the readback composer's limiter
// checkbox (the user's intent for those is reflected in their own
// checkbox state).
//
// Bit values mirror `@iracedeck/iracing-native/src/defines.ts`. Treat this
// as a small fixed set; if a new bit is added there, add it here too.

const ENGINE_WARNINGS = [
  { id: "ew-water-temp",     label: "Water Temp",        bit: 0x0001 },
  { id: "ew-fuel-pressure",  label: "Fuel Pressure",     bit: 0x0002 },
  { id: "ew-oil-pressure",   label: "Oil Pressure",      bit: 0x0004 },
  { id: "ew-engine-stalled", label: "Engine Stalled",    bit: 0x0008 },
  { id: "ew-pit-limiter",    label: "Pit Speed Limiter", bit: 0x0010 },
  { id: "ew-rev-limiter",    label: "Rev Limiter",       bit: 0x0020 },
  { id: "ew-oil-temp",       label: "Oil Temp",          bit: 0x0040 },
  { id: "ew-mand-rep",       label: "Mandatory Repair",  bit: 0x0080 },
  { id: "ew-opt-rep",        label: "Optional Repair",   bit: 0x0100 },
];

const ENGINE_WARNINGS_DAMAGE_MASK = 0x0080 | 0x0100;

function renderEngineWarningsPanel() {
  const container = $("engine-warnings");
  if (!container) return;

  // Render once; subsequent state changes only flip `checked`.
  if (container.childElementCount === 0) {
    for (const { id, label } of ENGINE_WARNINGS) {
      const wrap = document.createElement("label");
      wrap.className = "ew-checkbox";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;

      const span = document.createElement("span");
      span.textContent = label;

      wrap.appendChild(input);
      wrap.appendChild(span);
      container.appendChild(wrap);
    }
  }

  syncEngineWarningsCheckboxes();
}

function syncEngineWarningsCheckboxes() {
  const current = state.controller?.telemetry?.EngineWarnings ?? 0;
  for (const { id, bit } of ENGINE_WARNINGS) {
    const cb = $(id);
    if (cb) cb.checked = (current & bit) !== 0;
  }
}

// Derive the EngineWarnings bitmask from the current checkbox states.
// This is the source-of-truth read for any code path that needs to
// reason about EngineWarnings between a checkbox click and the
// matching WS echo — the alternative (`state.controller.telemetry.EngineWarnings`)
// is one round-trip behind, so two quick clicks would race and the
// later POST would drop the earlier bit.
function readEngineWarningsMaskFromUi() {
  let mask = 0;
  for (const { id, bit } of ENGINE_WARNINGS) {
    if ($(id)?.checked) mask |= bit;
  }
  return mask;
}

// Monotonic counter incremented on every PATCH attempt. The catch handler
// only rolls back if its captured `seq` is still the latest write — so a
// late failure from an older POST can't clobber newer user edits made
// while it was in flight.
let engineWarningsWriteSeq = 0;

// Number of EngineWarnings PATCHes currently in flight. While > 0, the WS
// `state.controller` broadcast handler skips `syncEngineWarningsCheckboxes()`
// — server echoes from older writes would otherwise stomp on a newer
// optimistic click. Reconciliation happens once in the `.finally` of the
// last in-flight PATCH below.
let engineWarningsPendingWrites = 0;

function wireEngineWarnings() {
  for (const { id } of ENGINE_WARNINGS) {
    const cb = $(id);
    if (!cb) continue;
    cb.addEventListener("change", () => {
      const prev = state.controller?.telemetry?.EngineWarnings ?? 0;
      const next = readEngineWarningsMaskFromUi();
      const seq = ++engineWarningsWriteSeq;
      engineWarningsPendingWrites++;
      // Optimistic local update so subsequent reads (this function on a
      // rapid second click, `readReadbackSnapshot()` on a readback fire)
      // see the new value immediately. The WS echo arriving later is a
      // no-op confirmation. Guard against the controller state not being
      // populated yet on first boot.
      if (state.controller?.telemetry) state.controller.telemetry.EngineWarnings = next;
      post("/api/telemetry", { patch: { EngineWarnings: next } })
        .catch((err) => {
          // Only roll back if this failed write is still the latest user
          // intent. Otherwise the user has already typed past us — keep
          // the newer optimistic state.
          if (seq === engineWarningsWriteSeq) {
            if (state.controller?.telemetry) state.controller.telemetry.EngineWarnings = prev;
            syncEngineWarningsCheckboxes();
          }
          alert(err.message);
        })
        .finally(() => {
          engineWarningsPendingWrites--;
          // Reconcile against the current cached telemetry once the last
          // in-flight write settles, so any external change that arrived
          // during the in-flight window lands now.
          if (engineWarningsPendingWrites === 0) syncEngineWarningsCheckboxes();
        });
    });
  }
}

// ── Pit Service Readback composer ─────────────────────────────────────────
//
// Lets the user assemble a `pitService.readbackRequested` payload by
// twiddling per-corner tire toggles, fuel/FR/windshield queue+availability
// flags, and the player vs queued tire compound. The composed snapshot
// fires through the same `/api/bus/publish` endpoint the shortcut buttons
// use, so the production audio scenarios receive it identically.

const TIRE_PRESETS = {
  all: { lf: true, rf: true, lr: true, rr: true },
  fronts: { lf: true, rf: true, lr: false, rr: false },
  rears: { lf: false, rf: false, lr: true, rr: true },
  lefts: { lf: true, rf: false, lr: true, rr: false },
  rights: { lf: false, rf: true, lr: false, rr: true },
  none: { lf: false, rf: false, lr: false, rr: false },
};

function readReadbackSnapshot() {
  const tires = {
    lf: $("readback-tire-lf").checked,
    rf: $("readback-tire-rf").checked,
    lr: $("readback-tire-lr").checked,
    rr: $("readback-tire-rr").checked,
  };
  const currentCompound = Number(
    document.querySelector('input[name="readback-compound-current"]:checked')?.value ?? "0",
  );
  const queuedCompoundRaw = document.querySelector('input[name="readback-compound-queued"]:checked')?.value ?? "";
  const compoundChange =
    queuedCompoundRaw === "" || Number(queuedCompoundRaw) === currentCompound
      ? null
      : { from: currentCompound, to: Number(queuedCompoundRaw) };

  // hasDamage is owned by the Engine Warnings panel, not the composer.
  // Derive it from the live checkbox states (NOT
  // state.controller.telemetry.EngineWarnings) so a readback fired
  // immediately after a checkbox toggle sees the user's intent rather
  // than the last WS echo from the server.
  const ew = readEngineWarningsMaskFromUi();
  const damageMask = ENGINE_WARNINGS_DAMAGE_MASK;

  return {
    fuel: { queued: $("readback-fuel-queued").checked },
    tires,
    compoundChange,
    fastRepair: {
      queued: $("readback-fr-queued").checked,
      available: $("readback-fr-available").checked,
    },
    windshield: {
      queued: $("readback-ws-queued").checked,
      available: $("readback-ws-available").checked,
    },
    limiterEngaged: $("readback-limiter").checked,
    hasDamage: (ew & damageMask) !== 0,
  };
}

// Server-side translator turns the snapshot into a telemetry patch and
// `tickOnce`s the mock controller, so the production readback resolver
// (`getReadbackSnapshot()` from sim-events-iracing) sees the user's
// selections when the readback fires. Per-control change listeners call
// this on every edit so iRacing's per-toggle confirmations also fire as
// the user composes — disconnect the controller if you want silence.
//
// `throwOnError` defaults to false so per-change listeners log + carry on
// if the harness server hiccups. The readback-fire button passes `true`
// so a failed snapshot push aborts before publishing the
// `readbackRequested` event with stale state.
async function pushReadbackSnapshot({ throwOnError = false } = {}) {
  try {
    await post("/api/readback/snapshot", readReadbackSnapshot());
  } catch (e) {
    console.error("Readback snapshot push failed:", e);
    if (throwOnError) throw e;
  }
}

function applyTirePreset(presetId) {
  const preset = TIRE_PRESETS[presetId];
  if (!preset) return;
  $("readback-tire-lf").checked = preset.lf;
  $("readback-tire-rf").checked = preset.rf;
  $("readback-tire-lr").checked = preset.lr;
  $("readback-tire-rr").checked = preset.rr;
}

const READBACK_SYNC_IDS = [
  "readback-fuel-queued",
  "readback-tire-lf",
  "readback-tire-rf",
  "readback-tire-lr",
  "readback-tire-rr",
  "readback-fr-queued",
  "readback-fr-available",
  "readback-ws-queued",
  "readback-ws-available",
  "readback-limiter",
];

function wireReadbackComposer() {
  for (const btn of document.querySelectorAll("[data-readback-preset]")) {
    btn.addEventListener("click", () => {
      applyTirePreset(btn.dataset.readbackPreset);
      // Programmatic .checked changes don't fire `change` — push manually.
      pushReadbackSnapshot();
    });
  }

  for (const id of READBACK_SYNC_IDS) {
    $(id)?.addEventListener("change", pushReadbackSnapshot);
  }
  for (const radio of document.querySelectorAll(
    'input[name="readback-compound-current"], input[name="readback-compound-queued"]',
  )) {
    radio.addEventListener("change", pushReadbackSnapshot);
  }

  const amount = $("readback-fuel-amount");
  const amountValue = $("readback-fuel-amount-value");
  amount.addEventListener("input", () => {
    amountValue.textContent = `${amount.value} L`;
  });

  $("readback-fire").addEventListener("click", async () => {
    const reason = $("readback-reason").value;
    try {
      // Push current snapshot first so the readback fires against the
      // selections visible on screen, even if a per-change push is still
      // in flight. The endpoint is idempotent and fast. `throwOnError`
      // aborts before the publish below if the snapshot push fails — we
      // must not fire `readbackRequested` against possibly-stale state.
      await pushReadbackSnapshot({ throwOnError: true });
      await post("/api/bus/publish", {
        event: "pitService.readbackRequested",
        data: { reason },
      });
    } catch (e) {
      alert(`Readback fire failed: ${e.message}`);
    }
  });

  $("readback-black-flag").addEventListener("click", async () => {
    try {
      await post("/api/bus/publish", { event: "flag.black.raised", data: {} });
    } catch (e) {
      alert(`Black-flag publish failed: ${e.message}`);
    }
  });

  // Initial sync — reconciles the mock controller's telemetry with the
  // composer's default-rendered state (and any state restored by the
  // browser on reload).
  pushReadbackSnapshot();
}

// ── Session Start composer ────────────────────────────────────────────────
//
// Unlike the readback composer (which round-trips through telemetry), the
// session-start snapshot carries a non-telemetry `driverName`, so it's held
// directly on the server. Fire = push the composed snapshot to
// `/api/session-start/snapshot`, then publish `driver.firstOnTrack`.

function readSessionStartSnapshot() {
  const driverName = ($("session-start-driver").value || "").trim().toLowerCase() || "driver";

  return {
    driverName,
    sessionType: $("session-start-session-type").value,
    pitSpeedLimit: Math.round(Number($("session-start-pit-speed").value)),
    speedUnit: $("session-start-speed-unit").value,
    trackTemp: Math.round(Number($("session-start-track-temp").value)),
    airTemp: Math.round(Number($("session-start-air-temp").value)),
    tempUnit: $("session-start-temp-unit").value,
    wetness: Number($("session-start-wetness").value),
  };
}

function wireSessionStartComposer() {
  $("session-start-fire").addEventListener("click", async () => {
    try {
      // Push the composed snapshot first so the scenario's resolver sees it,
      // then publish the trigger event. `/api/session-start/snapshot` awaits
      // a 204 before we publish, so there's no push-vs-fire race.
      await post("/api/session-start/snapshot", readSessionStartSnapshot());
      await post("/api/bus/publish", { event: "driver.firstOnTrack", data: {} });
    } catch (e) {
      alert(`Session start fire failed: ${e.message}`);
    }
  });
}

// ── Wire up controls ──────────────────────────────────────────────────────

function wire() {
  $("connected-toggle").addEventListener("change", (e) => {
    post("/api/connection", { connected: e.target.checked }).catch((err) => alert(err.message));
  });

  $("tick-rate").addEventListener("change", (e) => {
    const ms = Number(e.target.value);
    post("/api/tick", { intervalMs: ms }).catch((err) => alert(err.message));
  });
  $("tick-rate").addEventListener("input", (e) => {
    $("tick-rate-value").textContent = `${e.target.value} ms`;
  });

  $("tick-pause").addEventListener("click", () => {
    post("/api/tick", { paused: state.controller?.running !== false ? true : false }).catch((err) =>
      alert(err.message),
    );
  });

  $("tick-once").addEventListener("click", () => {
    post("/api/tick/once", {}).catch((err) => alert(err.message));
  });

  $("clear-log").addEventListener("click", () => {
    $("event-log").innerHTML = "";
    state.eventCount = 0;
    $("event-count").textContent = "0";
  });

  const wireAudioActionButton = (id, endpoint, busyLabel, doneLabel, errorPrefix) => {
    const btn = $(id);
    if (!btn) return;
    // Capture the resting label ONCE at wireup. If we re-read it per-click,
    // a click during the 1500 ms "doneLabel" window would capture that
    // success label as the new "resting" text and the button stays stuck.
    const original = btn.textContent;
    // Track the active restore timer so a click during the 1500 ms
    // success window cancels the in-flight reset — otherwise the prior
    // timer fires mid-way through the new request and flips the label
    // back to `original` while "Reloading…" should still be showing.
    let restoreTimer = null;
    btn.addEventListener("click", async () => {
      if (restoreTimer !== null) {
        clearTimeout(restoreTimer);
        restoreTimer = null;
      }
      btn.textContent = busyLabel;
      btn.disabled = true;
      try {
        await post(endpoint, {});
        btn.textContent = doneLabel;
        restoreTimer = setTimeout(() => {
          btn.textContent = original;
          restoreTimer = null;
        }, 1500);
      } catch (e) {
        btn.textContent = original;
        alert(`${errorPrefix}: ${e.message}`);
      } finally {
        btn.disabled = false;
      }
    });
  };

  wireAudioActionButton("audio-refresh", "/api/audio/refresh", "Reloading…", "Reloaded", "Audio refresh failed");
  wireAudioActionButton("audio-wipe-cache", "/api/audio/wipe-cache", "Wiping…", "Wiped", "Audio cache wipe failed");

  $("telemetry-apply-patch").addEventListener("click", async () => {
    try {
      const patch = JSON.parse($("telemetry-json").value);
      await post("/api/telemetry", { patch });
    } catch (e) {
      alert(`Invalid JSON or request: ${e.message}`);
    }
  });
  $("telemetry-apply-snapshot").addEventListener("click", async () => {
    try {
      const snapshot = JSON.parse($("telemetry-json").value);
      await post("/api/telemetry", { snapshot });
    } catch (e) {
      alert(`Invalid JSON or request: ${e.message}`);
    }
  });
  $("telemetry-refresh").addEventListener("click", () => {
    renderTelemetry();
  });

  $("session-apply").addEventListener("click", async () => {
    const raw = $("session-json").value.trim();
    try {
      const snapshot = raw === "" || raw === "null" ? null : JSON.parse(raw);
      await post("/api/session", { snapshot });
    } catch (e) {
      alert(`Invalid JSON or request: ${e.message}`);
    }
  });
  $("session-clear").addEventListener("click", () => {
    post("/api/session", { snapshot: null }).catch((err) => alert(err.message));
  });

  $("settings-refresh").addEventListener("click", () => renderSettings());

  $("injector-event").addEventListener("change", syncInjectorPayload);
  $("injector-fire").addEventListener("click", async () => {
    const event = $("injector-event").value;
    let data;
    try {
      data = JSON.parse($("injector-payload").value);
    } catch (e) {
      alert(`Invalid payload JSON: ${e.message}`);
      return;
    }
    try {
      await post("/api/bus/publish", { event, data });
    } catch (e) {
      alert(e.message);
    }
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────

(async function boot() {
  try {
    // Push any persisted settings BEFORE the first /api/state, so the
    // initial render reflects them rather than the harness's seeded
    // defaults. Failures here (e.g., a stale localStorage shape) fall
    // through to defaults rather than blocking boot.
    const persisted = loadPersistedSettings();
    if (persisted && Object.keys(persisted).length > 0) {
      try {
        await post("/api/settings", { patch: persisted });
      } catch (e) {
        console.warn("Failed to apply persisted settings; falling back to defaults:", e.message);
      }
    }

    const initial = await get("/api/state");
    state.controller = initial.controller;
    state.settings = initial.settings;
    state.eventTemplates = initial.eventTemplates;
    state.shortcuts = initial.shortcuts ?? [];
    state.presets = initial.presets;
    state.audioDevices = initial.audio.devices;
    persistSettings(initial.settings);

    renderTopbar();
    renderTelemetry();
    renderSession();
    renderPresets();
    renderSettings();
    renderInjector();
    renderShortcuts();
    renderEngineWarningsPanel();
    wire();
    wireReadbackComposer();
    wireSessionStartComposer();
    wireEngineWarnings();
    connectWebSocket();
  } catch (e) {
    document.body.innerHTML = `<pre style="padding:20px;color:#ff6b6b;">Failed to load harness: ${e.message}</pre>`;
  }
})();
