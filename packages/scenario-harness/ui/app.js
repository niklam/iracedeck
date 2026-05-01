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
      key: "raceEngineerEnabled",
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
      key: "radarEnabled",
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
  };
}

// Server-side translator turns the snapshot into a telemetry patch and
// `tickOnce`s the mock controller, so the production readback resolver
// (`getReadbackSnapshot()` from sim-events-iracing) sees the user's
// selections when the readback fires. Per-control change listeners call
// this on every edit so iRacing's per-toggle confirmations also fire as
// the user composes — disconnect the controller if you want silence.
async function pushReadbackSnapshot() {
  try {
    await post("/api/readback/snapshot", readReadbackSnapshot());
  } catch (e) {
    console.error("Readback snapshot push failed:", e);
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
      // in flight. The endpoint is idempotent and fast.
      await pushReadbackSnapshot();
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
    wire();
    wireReadbackComposer();
    connectWebSocket();
  } catch (e) {
    document.body.innerHTML = `<pre style="padding:20px;color:#ff6b6b;">Failed to load harness: ${e.message}</pre>`;
  }
})();
