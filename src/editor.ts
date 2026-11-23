import { LitElement, html } from "lit";

const SCHEMA = [
  { name: "title", selector: { text: {} } },
  { name: "entity", selector: { entity: { domain: "climate" } } },
  { name: "entities", selector: { entity: { domain: "climate", multiple: true } } },
];

const LABELS: Record<string, string> = {
  title: "Title (optional)",
  entity: "One thermostat (hides the dropdown)",
  entities: "Thermostats in the dropdown (empty = all)",
};

class ComfortScheduleCardEditor extends LitElement {
  static properties = { hass: { attribute: false }, _config: { state: true } };
  hass?: unknown;
  private _config: Record<string, unknown> = {};

  setConfig(config: Record<string, unknown>) {
    this._config = config;
  }

  render() {
    return html`<ha-form
      .hass=${this.hass}
      .data=${this._config}
      .schema=${SCHEMA}
      .computeLabel=${(s: { name: string }) => LABELS[s.name] ?? s.name}
      @value-changed=${this._changed}
    ></ha-form>`;
  }

  private _changed(ev: CustomEvent) {
    const config = { ...ev.detail.value };
    for (const key of Object.keys(config)) {
      const v = config[key];
      if (v === "" || v == null || (Array.isArray(v) && !v.length)) delete config[key];
    }
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }
}

if (!customElements.get("comfort-schedule-card-editor")) {
  customElements.define("comfort-schedule-card-editor", ComfortScheduleCardEditor);
}
