/**
 * Action Card
 * An invisible Lovelace card that runs a Home Assistant action when the
 * dashboard is loaded or reloaded.
 *
 * https://github.com/thelectrowizard/ha-action-card
 */

const CARD_VERSION = "1.0.0";
const CARD_TYPE = "ha-action-card";
const STORAGE_PREFIX = "ha-action-card:last-run:";

// Actions that have already run during this page load, keyed by card config.
// Lives on window so it survives the card being re-created when views change.
const RUN_REGISTRY = (window.__haActionCardRuns = window.__haActionCardRuns || new Set());

const DEFAULTS = {
  delay: 0, // seconds to wait after the dashboard loads before running
  timeout: 10, // seconds to wait for the action to finish before treating it as failed
  cooldown: 0, // seconds; skip if this browser already ran the action this recently
  run_on: "page_load", // "page_load" | "view_load"
  run_in_edit_mode: false,
  notify_on_error: true,
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function fireEvent(node, type, detail = {}) {
  node.dispatchEvent(
    new CustomEvent(type, { detail, bubbles: true, composed: true, cancelable: false })
  );
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Normalise the many ways an action can be written into one shape. */
function normaliseAction(config) {
  let action = config.action;

  // Shorthand: `action: light.turn_on` plus top-level data/target.
  if (typeof action === "string" && action.includes(".")) {
    action = {
      action: "perform-action",
      perform_action: action,
      data: config.data,
      target: config.target,
    };
  }
  // Legacy: `service: light.turn_on` + `service_data`.
  if (!action && config.service) {
    action = {
      action: "perform-action",
      perform_action: config.service,
      data: config.data || config.service_data,
      target: config.target,
    };
  }
  if (!action || typeof action !== "object") return undefined;

  action = { ...action };
  if (action.action === "call-service") action.action = "perform-action";
  if (action.service && !action.perform_action) action.perform_action = action.service;
  if (action.service_data && !action.data) action.data = action.service_data;
  return action;
}

function describeAction(action) {
  if (!action || action.action === "none") return "No action configured";
  switch (action.action) {
    case "perform-action":
      return action.perform_action || "No action selected";
    case "navigate":
      return `Navigate to ${action.navigation_path || "?"}`;
    case "url":
      return `Open ${action.url_path || "?"}`;
    case "fire-dom-event":
      return "Fire DOM event";
    default:
      return action.action;
  }
}

function withTimeout(promise, seconds) {
  if (!seconds) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${seconds}s`)),
      seconds * 1000
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ------------------------------------------------------------------ */
/* card                                                                */
/* ------------------------------------------------------------------ */

class HaActionCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = undefined;
    this._hass = undefined;
    this._connected = false;
    this._scheduled = false;
    this._timer = undefined;
    this._status = "idle"; // idle | waiting | running | done | skipped | error
    this._statusDetail = "";
    this._editMode = false;
    this._preview = false;
  }

  static getConfigElement() {
    return document.createElement(`${CARD_TYPE}-editor`);
  }

  static getStubConfig() {
    return {
      action: { action: "perform-action", perform_action: "" },
      delay: DEFAULTS.delay,
      timeout: DEFAULTS.timeout,
    };
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    const cfg = { ...DEFAULTS, ...config };
    cfg.delay = toNumber(cfg.delay, DEFAULTS.delay);
    cfg.timeout = toNumber(cfg.timeout, DEFAULTS.timeout);
    cfg.cooldown = toNumber(cfg.cooldown, DEFAULTS.cooldown);
    if (!["page_load", "view_load"].includes(cfg.run_on)) cfg.run_on = DEFAULTS.run_on;
    this._config = cfg;
    this._action = normaliseAction(cfg);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._maybeSchedule();
  }

  get hass() {
    return this._hass;
  }

  // Home Assistant sets these on cards while editing a dashboard.
  set editMode(value) {
    this._editMode = Boolean(value);
    this._render();
  }

  get editMode() {
    return this._editMode;
  }

  set preview(value) {
    this._preview = Boolean(value);
    this._render();
  }

  get preview() {
    return this._preview;
  }

  connectedCallback() {
    this._connected = true;
    this._render();
    this._maybeSchedule();
  }

  disconnectedCallback() {
    this._connected = false;
    // If the user leaves the view before the delay elapses, cancel the run.
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
      RUN_REGISTRY.delete(this._registryKey());
      this._setStatus("idle");
    }
    // Re-evaluate on the next attach ("view_load" runs again; "page_load" is
    // still guarded by RUN_REGISTRY).
    this._scheduled = false;
  }

  getCardSize() {
    return this._isEditing() ? 1 : 0;
  }

  getGridOptions() {
    return this._isEditing() ? { columns: 12, rows: 1 } : { columns: 12, rows: "auto" };
  }

  /* ---------------- scheduling ---------------- */

  _isEditing() {
    if (this._editMode || this._preview) return true;
    // Fallbacks for older HA versions that don't set editMode/preview.
    if (new URLSearchParams(window.location.search).get("edit") === "1") return true;
    return Boolean(this.closest && this.closest("hui-card-preview, hui-card-options"));
  }

  _registryKey() {
    return `${window.location.pathname}|${JSON.stringify(this._config)}`;
  }

  _maybeSchedule() {
    if (!this._connected || !this._hass || !this._config || this._scheduled) return;

    // Let HA finish setting editMode / preview before deciding anything.
    this._scheduled = true;
    queueMicrotask(() => this._schedule());
  }

  _schedule() {
    if (!this._connected) {
      this._scheduled = false;
      return;
    }

    const cfg = this._config;
    const action = this._action;

    if (!action || action.action === "none" ||
        (action.action === "perform-action" && !action.perform_action)) {
      this._setStatus("skipped", "no action configured");
      return;
    }

    if (this._isEditing() && !cfg.run_in_edit_mode) {
      this._setStatus("skipped", "not run while editing");
      return;
    }

    const key = this._registryKey();
    if (cfg.run_on === "page_load" && RUN_REGISTRY.has(key)) {
      this._setStatus("skipped", "already ran on this page load");
      return;
    }

    if (cfg.cooldown > 0) {
      const last = this._lastRun();
      const elapsed = (Date.now() - last) / 1000;
      if (last && elapsed < cfg.cooldown) {
        const remaining = Math.ceil(cfg.cooldown - elapsed);
        this._setStatus("skipped", `cooldown, ${remaining}s left`);
        return;
      }
    }

    // Claim the run now so duplicate card instances don't both fire.
    if (cfg.run_on === "page_load") RUN_REGISTRY.add(key);

    if (cfg.delay > 0) {
      this._setStatus("waiting", `running in ${cfg.delay}s`);
      this._timer = setTimeout(() => {
        this._timer = undefined;
        this._run();
      }, cfg.delay * 1000);
    } else {
      this._run();
    }
  }

  _storageKey() {
    return STORAGE_PREFIX + JSON.stringify(this._action);
  }

  _lastRun() {
    try {
      return Number(window.localStorage.getItem(this._storageKey())) || 0;
    } catch (_e) {
      return 0;
    }
  }

  _rememberRun() {
    try {
      window.localStorage.setItem(this._storageKey(), String(Date.now()));
    } catch (_e) {
      /* storage unavailable: cooldown just won't apply */
    }
  }

  /* ---------------- running ---------------- */

  async _run() {
    const cfg = this._config;
    const action = this._action;
    this._setStatus("running", describeAction(action));
    this._rememberRun();

    try {
      await withTimeout(this._execute(action), cfg.timeout);
      this._setStatus("done", `${describeAction(action)} at ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      const message = (err && (err.message || err.error)) || String(err);
      this._setStatus("error", message);
      console.error(`[${CARD_TYPE}] ${describeAction(action)} failed:`, err);
      if (cfg.notify_on_error) {
        fireEvent(this, "hass-notification", {
          message: `Action card: ${describeAction(action)} failed (${message})`,
        });
      }
    }
  }

  async _execute(action) {
    switch (action.action) {
      case "perform-action": {
        const [domain, service] = String(action.perform_action).split(".", 2);
        if (!domain || !service) throw new Error(`Invalid action "${action.perform_action}"`);
        return this._hass.callService(domain, service, action.data || {}, action.target);
      }
      case "navigate": {
        if (!action.navigation_path) throw new Error("No navigation path");
        const replace = Boolean(action.navigation_replace);
        if (replace) window.history.replaceState(null, "", action.navigation_path);
        else window.history.pushState(null, "", action.navigation_path);
        fireEvent(window, "location-changed", { replace });
        return undefined;
      }
      case "url": {
        if (!action.url_path) throw new Error("No URL");
        window.open(action.url_path);
        return undefined;
      }
      case "fire-dom-event": {
        fireEvent(this, "ll-custom", action);
        return undefined;
      }
      default:
        throw new Error(`Unsupported action type "${action.action}"`);
    }
  }

  /* ---------------- rendering ---------------- */

  _setStatus(status, detail = "") {
    this._status = status;
    this._statusDetail = detail;
    this._render();
  }

  _render() {
    if (!this.shadowRoot) return;
    const editing = this._isEditing();

    // Invisible on the live dashboard.
    this.style.display = editing ? "" : "none";
    if (!editing) {
      this.shadowRoot.innerHTML = "";
      return;
    }

    const label = describeAction(this._action);
    const cfg = this._config || DEFAULTS;
    const detail = this._statusDetail ? ` · ${this._statusDetail}` : "";
    const timing = [
      cfg.delay ? `delay ${cfg.delay}s` : "no delay",
      cfg.timeout ? `timeout ${cfg.timeout}s` : "no timeout",
      cfg.cooldown ? `cooldown ${cfg.cooldown}s` : null,
      cfg.run_on === "view_load" ? "every view load" : "once per page load",
    ].filter(Boolean).join(" · ");

    this.shadowRoot.innerHTML = `
      <style>
        ha-card {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          border: 1px dashed var(--divider-color, #ccc);
          box-shadow: none;
          background: transparent;
          opacity: 0.85;
        }
        ha-icon { color: var(--state-icon-color, var(--primary-color)); flex: none; }
        .text { min-width: 0; }
        .title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .sub {
          font-size: 12px;
          color: var(--secondary-text-color);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .status-error { color: var(--error-color, #db4437); }
      </style>
      <ha-card>
        <ha-icon icon="mdi:play-circle-outline"></ha-icon>
        <div class="text">
          <div class="title"></div>
          <div class="sub timing"></div>
          <div class="sub status ${this._status === "error" ? "status-error" : ""}"></div>
        </div>
      </ha-card>
    `;
    // Set text via textContent so config values are never parsed as HTML.
    this.shadowRoot.querySelector(".title").textContent = `Action card: ${label}`;
    this.shadowRoot.querySelector(".timing").textContent =
      `Hidden on the dashboard · ${timing}`;
    this.shadowRoot.querySelector(".status").textContent = `Status: ${this._status}${detail}`;
  }
}

/* ------------------------------------------------------------------ */
/* editor                                                              */
/* ------------------------------------------------------------------ */

const EDITOR_SCHEMA = [
  {
    name: "action",
    selector: {
      ui_action: {
        actions: ["perform-action", "navigate", "url", "none"],
        default_action: "perform-action",
      },
    },
  },
  {
    type: "grid",
    name: "",
    schema: [
      {
        name: "delay",
        selector: { number: { min: 0, max: 3600, step: 0.5, mode: "box", unit_of_measurement: "s" } },
      },
      {
        name: "timeout",
        selector: { number: { min: 0, max: 3600, step: 1, mode: "box", unit_of_measurement: "s" } },
      },
      {
        name: "cooldown",
        selector: { number: { min: 0, max: 604800, step: 1, mode: "box", unit_of_measurement: "s" } },
      },
      {
        name: "run_on",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "page_load", label: "Once per page load" },
              { value: "view_load", label: "Every time the view is shown" },
            ],
          },
        },
      },
    ],
  },
  { name: "run_in_edit_mode", selector: { boolean: {} } },
  { name: "notify_on_error", selector: { boolean: {} } },
];

const EDITOR_LABELS = {
  action: "Action to run when the dashboard loads",
  delay: "Delay before running",
  timeout: "Action timeout (0 = none)",
  cooldown: "Cooldown between runs (0 = none)",
  run_on: "Run",
  run_in_edit_mode: "Also run while editing the dashboard",
  notify_on_error: "Show a notification if the action fails",
};

const EDITOR_HELPERS = {
  delay: "Seconds to wait after the dashboard loads.",
  timeout: "Seconds to wait for the action to finish before reporting a failure.",
  cooldown: "Skip the action if this browser ran it within this many seconds.",
};

class HaActionCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = undefined;
    this._form = undefined;
  }

  setConfig(config) {
    // Present shorthand / legacy configs in the editor's object form.
    const action = normaliseAction(config);
    const cfg = { ...config };
    if (action) {
      cfg.action = action;
      delete cfg.service;
      delete cfg.service_data;
      if (typeof config.action === "string" || config.service) {
        delete cfg.data;
        delete cfg.target;
      }
    }
    this._config = cfg;
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  connectedCallback() {
    this._ensureFormLoaded().then(() => this._update());
  }

  async _ensureFormLoaded() {
    if (customElements.get("ha-form")) return;
    // ha-form is lazy-loaded by HA; loading a built-in card editor pulls it in.
    try {
      const helpers = await window.loadCardHelpers?.();
      const card = await helpers?.createCardElement({ type: "entities", entities: [] });
      await card?.constructor?.getConfigElement?.();
    } catch (_e) {
      /* fall through: ha-form may still appear later */
    }
    await customElements.whenDefined("ha-form");
  }

  _update() {
    if (!this._hass || !customElements.get("ha-form")) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] ?? s.name;
      this._form.computeHelper = (s) => EDITOR_HELPERS[s.name];
      this._form.addEventListener("value-changed", (ev) => this._valueChanged(ev));
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = { ...DEFAULTS, ...this._config };
  }

  _valueChanged(ev) {
    ev.stopPropagation();
    const value = { ...ev.detail.value };
    // Keep the YAML tidy: drop options that are still at their defaults.
    for (const [key, def] of Object.entries(DEFAULTS)) {
      if (value[key] === def || value[key] === undefined || value[key] === "") delete value[key];
    }
    this._config = { type: this._config.type || `custom:${CARD_TYPE}`, ...value };
    fireEvent(this, "config-changed", { config: this._config });
  }
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

if (!customElements.get(CARD_TYPE)) customElements.define(CARD_TYPE, HaActionCard);
if (!customElements.get(`${CARD_TYPE}-editor`)) {
  customElements.define(`${CARD_TYPE}-editor`, HaActionCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD_TYPE)) {
  window.customCards.push({
    type: CARD_TYPE,
    name: "Action Card",
    description: "Invisible card that runs an action when the dashboard loads.",
    preview: false,
    documentationURL: "https://github.com/thelectrowizard/ha-action-card",
  });
}

console.info(
  `%c ACTION-CARD %c v${CARD_VERSION} `,
  "color: white; background: #03a9f4; font-weight: 700;",
  "color: #03a9f4; background: white; font-weight: 700;"
);
