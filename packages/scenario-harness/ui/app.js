// iRaceDeck Scenario Harness — single-file vanilla UI.
//
// All state writes go through HTTP. The WebSocket only carries server →
// client updates: bus events, controller / settings state changes, audio
// playback start/complete. Multiple browser tabs stay in sync because the
// server fans out every state change.

const $ = (id) => document.getElementById(id);
const MAX_LOG_ENTRIES = 500;

const state = {
  controller: null,
  settings: {},
  eventTemplates: [],
  presets: { telemetry: [], session: [] },
  audioDevices: [],
  eventCount: 0,
};

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
        renderSettings();
      } else if (msg.section === "audioDevices") {
        state.audioDevices = msg.value;
        renderSettings();
      }
    }
  });
  ws.addEventListener("close", () => setTimeout(connectWebSocket, 1000));
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
    const initial = await get("/api/state");
    state.controller = initial.controller;
    state.settings = initial.settings;
    state.eventTemplates = initial.eventTemplates;
    state.presets = initial.presets;
    state.audioDevices = initial.audio.devices;

    renderTopbar();
    renderTelemetry();
    renderSession();
    renderPresets();
    renderSettings();
    renderInjector();
    wire();
    connectWebSocket();
  } catch (e) {
    document.body.innerHTML = `<pre style="padding:20px;color:#ff6b6b;">Failed to load harness: ${e.message}</pre>`;
  }
})();
