import { LitElement, css, html, nothing } from "lit";
import yaml from "js-yaml";
import {
  DAYS,
  DAY_LABEL,
  type Day,
  type Profile,
  type Slot,
  copyDay,
  currentSlot,
  dayOf,
  formatTime,
  newProfile,
  nextFreeTime,
  normaliseProfile,
  sortSlots,
} from "./schedule";
import {
  type Hass,
  type HassEntity,
  friendlyName,
  loadHaSelector,
  modeLabel,
  tempLimits,
  uses12h,
  usesRange,
} from "./ha";
import "./editor";

const VERSION = "0.0.2";
const STORAGE_KEY = "comfort-schedule-card:selected";

interface CardConfig {
  type: string;
  entity?: string;
  entities?: string[];
  title?: string;
}

interface ThermostatData {
  profiles: Profile[];
  sensor: string | null;
  active: string;
  automations: string[];
}

const WORKDAYS: Day[] = ["mon", "tue", "wed", "thu", "fri"];
const WEEKEND: Day[] = ["sat", "sun"];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

class ComfortScheduleCard extends LitElement {
  static properties = {
    hass: { attribute: false },
    _config: { state: true },
    _data: { state: true },
    _loadError: { state: true },
    _selected: { state: true },
    _draft: { state: true },
    _profileIdx: { state: true },
    _days: { state: true },
    _multi: { state: true },
    _nowOpen: { state: true },
    _nowPending: { state: true },
    _editing: { state: true },
    _settingsOpen: { state: true },
    _copyOpen: { state: true },
    _copyTargets: { state: true },
    _saving: { state: true },
    _message: { state: true },
    _error: { state: true },
    _selectorReady: { state: true },
    _yamlMode: { state: true },
    _yamlError: { state: true },
  };

  hass?: Hass;
  private _config!: CardConfig;
  private _data?: Record<string, ThermostatData>;
  private _loadError?: string;
  private _selected = "";
  private _draft: Profile[] = [];
  private _baseline = "";
  private _profileIdx = 0;
  /** Selected days. Edits apply to all of them; the first (Mon-first order) is shown. */
  private _days: Day[] = [dayOf(new Date())];
  private _multi = false;
  private _nowOpen = false;
  private _nowPending: Record<string, number> = {};
  private _nowTimer?: number;
  private _editing: number | null = null;
  private _settingsOpen = false;
  private _copyOpen = false;
  private _copyTargets: Day[] = [];
  private _saving = false;
  private _message: string | null = null;
  private _error: string | null = null;
  private _selectorReady = false;
  private _yamlMode = false;
  private _yamlError: string | null = null;
  private _loading = false;

  static getConfigElement() {
    return document.createElement("comfort-schedule-card-editor");
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config: CardConfig) {
    if (config.entity && !config.entity.startsWith("climate.")) {
      throw new Error("entity must be a climate entity");
    }
    this._config = { ...config };
    this._selected = "";
  }

  getCardSize() {
    return 8;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  connectedCallback() {
    super.connectedCallback();
    loadHaSelector().then((ok) => (this._selectorReady = ok));
  }

  protected updated() {
    if (this.hass && !this._data && !this._loading && !this._loadError) this._load();
  }

  // ----- data ------------------------------------------------------------

  private async _load() {
    if (!this.hass) return;
    this._loading = true;
    try {
      const res = await this.hass.callWS<{ thermostats: Record<string, ThermostatData> }>({
        type: "comfort_schedule/get",
      });
      this._data = res.thermostats;
      this._loadError = undefined;
      if (!this._selected) this._select(this._initialThermostat(), false);
    } catch (err: any) {
      this._loadError =
        err?.code === "unknown_command" || err?.code === "not_set_up"
          ? "setup"
          : err?.message ?? String(err);
    } finally {
      this._loading = false;
    }
  }

  private get _thermostats(): string[] {
    if (!this.hass) return [];
    if (this._config.entity) return [this._config.entity];
    if (this._config.entities?.length) return this._config.entities;
    return Object.keys(this.hass.states)
      .filter((id) => id.startsWith("climate."))
      .sort((a, b) => friendlyName(this.hass!, a).localeCompare(friendlyName(this.hass!, b)));
  }

  private _initialThermostat(): string {
    const list = this._thermostats;
    if (this._config.entity) return this._config.entity;
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage blocked */
    }
    if (remembered && list.includes(remembered)) return remembered;
    return list.find((id) => this._data?.[id]) ?? list[0] ?? "";
  }

  private _select(entityId: string, remember = true) {
    this._selected = entityId;
    if (remember) {
      try {
        localStorage.setItem(STORAGE_KEY, entityId);
      } catch {
        /* storage blocked */
      }
    }
    const saved = this._data?.[entityId]?.profiles;
    this._draft = saved?.length
      ? saved.map((p) => normaliseProfile(p))
      : [{ ...newProfile("Default", []) }];
    this._baseline = saved?.length ? JSON.stringify(this._draft) : "";
    this._profileIdx = 0;
    this._editing = null;
    this._settingsOpen = false;
    this._copyOpen = false;
    this._message = null;
    this._error = null;
    this._yamlMode = false;
  }

  private get _dirty(): boolean {
    if (!this._baseline) {
      // Never saved: only count it as a change once something was entered.
      return this._draft.some(
        (p) => p.conditions.length || DAYS.some((d) => p.days[d].length)
      ) || this._draft.length > 1;
    }
    return JSON.stringify(this._draft) !== this._baseline;
  }

  private get _profile(): Profile {
    return this._draft[Math.min(this._profileIdx, this._draft.length - 1)];
  }

  private get _entity(): HassEntity | undefined {
    return this.hass?.states[this._selected];
  }

  private get _day(): Day {
    return DAYS.find((d) => this._days.includes(d)) ?? this._days[0];
  }

  private _pickDay(day: Day) {
    this._editing = null;
    if (!this._multi) {
      this._days = [day];
      return;
    }
    if (this._days.includes(day)) {
      if (this._days.length > 1) this._days = this._days.filter((d) => d !== day);
    } else {
      this._days = [...this._days, day];
    }
  }

  private _setMulti(on: boolean) {
    this._multi = on;
    this._copyOpen = false;
    if (!on) this._days = [this._day];
  }

  /** Selected days whose times differ from the shown (first) day. */
  private get _differentDays(): Day[] {
    const shown = JSON.stringify(this._profile.days[this._day]);
    return DAYS.filter(
      (d) => this._days.includes(d) && d !== this._day && JSON.stringify(this._profile.days[d]) !== shown
    );
  }

  private _updateProfile(change: (p: Profile) => Profile) {
    const idx = Math.min(this._profileIdx, this._draft.length - 1);
    this._draft = this._draft.map((p, i) => (i === idx ? change(clone(p)) : p));
    this._message = null;
  }

  private _updateSlots(change: (slots: Slot[]) => Slot[]) {
    this._updateProfile((p) => {
      const result = change(p.days[this._day]);
      for (const d of this._days) p.days[d] = clone(result);
      return p;
    });
  }

  private async _save() {
    if (!this.hass) return;
    this._saving = true;
    this._error = null;
    try {
      const res = await this.hass.callWS<{ automations: string[]; warnings: string[] }>({
        type: "comfort_schedule/save",
        entity_id: this._selected,
        profiles: this._draft,
      });
      this._data = undefined;
      await this._load();
      this._select(this._selected, false);
      const n = res.automations.length;
      this._message = `Saved. ${n} automation${n === 1 ? "" : "s"} updated.`;
      if (res.warnings.length) this._error = res.warnings.join(" ");
    } catch (err: any) {
      this._error = err?.message ?? String(err);
    } finally {
      this._saving = false;
    }
  }

  private async _removeSchedule() {
    if (!this.hass) return;
    const name = friendlyName(this.hass, this._selected);
    if (!confirm(`Remove the whole schedule of ${name} and delete its automations?`)) return;
    try {
      await this.hass.callWS({ type: "comfort_schedule/remove", entity_id: this._selected });
      this._data = undefined;
      await this._load();
      this._select(this._selected, false);
      this._message = "Schedule removed.";
    } catch (err: any) {
      this._error = err?.message ?? String(err);
    }
  }

  // ----- actions -----------------------------------------------------------

  private _onPick(ev: Event) {
    const value = (ev.target as HTMLSelectElement).value;
    if (value === this._selected) return;
    if (this._dirty && !confirm("Discard the unsaved changes?")) {
      (ev.target as HTMLSelectElement).value = this._selected;
      return;
    }
    this._select(value);
  }

  private _pickProfile(index: number) {
    if (index === this._profileIdx) {
      this._settingsOpen = !this._settingsOpen;
    } else {
      this._profileIdx = index;
      this._editing = null;
      this._yamlMode = false;
    }
  }

  private _addProfile() {
    const profile = newProfile("New profile", this._draft);
    this._draft = [...this._draft, profile];
    this._profileIdx = this._draft.length - 1;
    this._settingsOpen = true;
    this._editing = null;
  }

  private _moveProfile(delta: number) {
    const from = this._profileIdx;
    const to = from + delta;
    if (to < 0 || to >= this._draft.length) return;
    const list = [...this._draft];
    [list[from], list[to]] = [list[to], list[from]];
    this._draft = list;
    this._profileIdx = to;
  }

  private _deleteProfile() {
    if (this._draft.length <= 1) return;
    if (!confirm(`Delete the profile "${this._profile.name}"?`)) return;
    this._draft = this._draft.filter((_, i) => i !== this._profileIdx);
    this._profileIdx = Math.max(0, this._profileIdx - 1);
    this._settingsOpen = false;
  }

  private _addSlot() {
    const slots = this._profile.days[this._day];
    const last = slots[slots.length - 1];
    const entity = this._entity;
    const modes: string[] = entity?.attributes.hvac_modes ?? ["heat", "cool", "off"];
    const mode = last?.hvac_mode ?? modes.find((m) => m !== "off") ?? "heat";
    const slot: Slot = last
      ? { ...clone(last), time: nextFreeTime(slots) }
      : this._withMode({ time: nextFreeTime(slots), hvac_mode: mode }, mode);
    const list = sortSlots([...slots, slot]);
    this._updateSlots(() => list);
    this._editing = list.findIndex((s) => s.time === slot.time);
  }

  /** Give a box the setpoint fields its mode needs. */
  private _withMode(slot: Slot, mode: string): Slot {
    const limits = tempLimits(this.hass!, this._entity);
    const base = slot.temperature ?? slot.target_temp_low ?? limits.fallback;
    const next: Slot = { time: slot.time, hvac_mode: mode };
    if (slot.fan_mode) next.fan_mode = slot.fan_mode;
    if (mode === "off") return next;
    if (usesRange(this._entity, mode)) {
      const gap = limits.unit.includes("F") ? 4 : 2;
      next.target_temp_low = slot.target_temp_low ?? base;
      next.target_temp_high = slot.target_temp_high ?? Math.min(base + gap, limits.max);
    } else {
      next.temperature = slot.temperature ?? base;
    }
    return next;
  }

  private _setSlot(index: number, change: (s: Slot) => Slot) {
    let movedTo = index;
    this._updateSlots((slots) => {
      const updated = change({ ...slots[index] });
      const list = slots.map((s, i) => (i === index ? updated : s));
      sortSlots(list);
      movedTo = list.indexOf(updated);
      return list;
    });
    this._editing = movedTo;
  }

  private _setTime(index: number, value: string) {
    if (!/^\d{2}:\d{2}$/.test(value)) return;
    const slots = this._profile.days[this._day];
    if (slots.some((s, i) => i !== index && s.time === value)) {
      this._error = `There is already a box at ${this._fmt(value)}.`;
      return;
    }
    this._error = null;
    this._setSlot(index, (s) => ({ ...s, time: value }));
  }

  private _clampTemp(value: number): number {
    const limits = tempLimits(this.hass!, this._entity);
    const rounded = Math.round(value * 10) / 10;
    return Math.min(limits.max, Math.max(limits.min, rounded));
  }

  private _setTemp(index: number, key: "temperature" | "target_temp_low" | "target_temp_high", value: number) {
    if (!Number.isFinite(value)) return;
    this._setSlot(index, (s) => {
      const next = { ...s, [key]: this._clampTemp(value) };
      if (next.target_temp_low !== undefined && next.target_temp_high !== undefined && next.target_temp_low > next.target_temp_high) {
        if (key === "target_temp_low") next.target_temp_high = next.target_temp_low;
        else next.target_temp_low = next.target_temp_high;
      }
      return next;
    });
  }

  // ----- change the thermostat right now -----------------------------------

  private _nowMode(mode: string) {
    this.hass!.callService("climate", "set_hvac_mode", { entity_id: this._selected, hvac_mode: mode });
  }

  /** Setpoint changes are sent after a short pause so +/- taps don't flood the thermostat. */
  private _nowTemp(key: "temperature" | "target_temp_low" | "target_temp_high", value: number) {
    if (!Number.isFinite(value)) return;
    this._nowPending = { ...this._nowPending, [key]: this._clampTemp(value) };
    clearTimeout(this._nowTimer);
    this._nowTimer = window.setTimeout(() => {
      const a = this._entity?.attributes ?? {};
      const data: Record<string, unknown> = { entity_id: this._selected };
      if ("target_temp_low" in this._nowPending || "target_temp_high" in this._nowPending) {
        data.target_temp_low = this._nowPending.target_temp_low ?? a.target_temp_low;
        data.target_temp_high = this._nowPending.target_temp_high ?? a.target_temp_high;
      } else {
        data.temperature = this._nowPending.temperature;
      }
      this.hass!.callService("climate", "set_temperature", data).finally(() => {
        this._nowPending = {};
      });
    }, 700);
  }

  private _removeSlot(index: number) {
    this._updateSlots((slots) => slots.filter((_, i) => i !== index));
    this._editing = null;
  }

  private _toggleCopyTarget(day: Day) {
    this._copyTargets = this._copyTargets.includes(day)
      ? this._copyTargets.filter((d) => d !== day)
      : [...this._copyTargets, day];
  }

  private _applyCopy() {
    const targets = this._copyTargets.filter((d) => d !== this._day);
    if (!targets.length) return;
    this._updateProfile((p) => copyDay(p, this._day, targets));
    this._copyOpen = false;
    this._message = `Copied ${DAY_LABEL[this._day]} to ${targets.map((d) => DAY_LABEL[d]).join(", ")}.`;
  }

  private _setConditions(value: unknown) {
    const list = value == null ? [] : Array.isArray(value) ? value : [value];
    this._updateProfile((p) => ({ ...p, conditions: list }));
  }

  private _onYaml(ev: Event) {
    const text = (ev.target as HTMLTextAreaElement).value;
    try {
      const parsed = text.trim() ? yaml.load(text) : [];
      this._yamlError = null;
      this._setConditions(parsed);
    } catch (err: any) {
      this._yamlError = err?.message ?? String(err);
    }
  }

  // ----- rendering ---------------------------------------------------------

  private _fmt(time: string): string {
    return formatTime(time, uses12h(this.hass!));
  }

  private _slotSummary(slot: Slot): string {
    const mode = modeLabel(slot.hvac_mode);
    if (slot.hvac_mode === "off") return mode;
    if (slot.target_temp_low !== undefined) return `${mode} ${slot.target_temp_low}–${slot.target_temp_high}`;
    if (slot.temperature !== undefined) return `${mode} ${slot.temperature}`;
    return mode;
  }

  render() {
    if (!this._config || !this.hass) return nothing;
    if (this._loadError === "setup") {
      return html`<ha-card><div class="notice">
        Comfort Schedule is installed but not set up. Go to <b>Settings → Devices &amp; services → Add integration</b>
        and add <b>Comfort Schedule</b>, then reload this page.
      </div></ha-card>`;
    }
    if (this._loadError) {
      return html`<ha-card><div class="notice error">Could not load schedules: ${this._loadError}</div></ha-card>`;
    }
    if (!this._data) return html`<ha-card><div class="notice">Loading…</div></ha-card>`;
    if (!this._selected) {
      return html`<ha-card><div class="notice">No thermostats (climate entities) found.</div></ha-card>`;
    }

    return html`
      <ha-card>
        ${this._renderHeader()} ${this._renderStatus()} ${this._nowOpen ? this._renderNow() : nothing} ${this._renderTabs()}
        ${this._settingsOpen ? this._renderSettings() : nothing} ${this._renderDays()}
        ${this._multi ? this._renderMultiBar() : nothing}
        ${this._copyOpen ? this._renderCopy() : nothing} ${this._renderSlots()}
        ${this._renderFooter()}
      </ha-card>
    `;
  }

  private _renderHeader() {
    const list = this._thermostats;
    if (this._config.entity || list.length === 1) {
      return html`<div class="header"><div class="title">${this._config.title ?? friendlyName(this.hass!, this._selected)}</div></div>`;
    }
    return html`
      <div class="header">
        ${this._config.title ? html`<div class="title small">${this._config.title}</div>` : nothing}
        <select class="picker" .value=${this._selected} @change=${this._onPick}>
          ${list.map(
            (id) => html`<option value=${id} ?selected=${id === this._selected}>
              ${friendlyName(this.hass!, id)}${this._data?.[id] ? " ●" : ""}
            </option>`
          )}
        </select>
      </div>
    `;
  }

  private _renderStatus() {
    const entity = this._entity;
    const parts: string[] = [];
    if (entity) {
      const a = entity.attributes;
      if (a.current_temperature != null) parts.push(`${a.current_temperature}° now`);
      if (entity.state === "off") parts.push("Off");
      else if (a.target_temp_low != null && a.target_temp_high != null)
        parts.push(`${modeLabel(entity.state)} ${a.target_temp_low}–${a.target_temp_high}°`);
      else if (a.temperature != null) parts.push(`${modeLabel(entity.state)} ${a.temperature}°`);
      else parts.push(modeLabel(entity.state));
    } else {
      parts.push("Unavailable");
    }
    const active = this._activeProfileName();
    return html`<div class="status">
      <button class="now-btn" @click=${() => (this._nowOpen = !this._nowOpen)} title="Change the thermostat now">
        ${parts.join(" · ")} <span class="caret">${this._nowOpen ? "Close" : "Change"}</span>
      </button>
      <span class="active ${active ? "" : "none"}">${active ? `${active} active` : this._data?.[this._selected] ? "No profile active" : "Not scheduled yet"}</span>
    </div>`;
  }

  /** A − [typed number] + control. */
  private _tempControl(value: number | undefined, colour: string, onSet: (v: number) => void, label?: string) {
    const limits = tempLimits(this.hass!, this._entity);
    const current = value ?? limits.fallback;
    return html`<div class="stepper">
      ${label ? html`<span class="lbl">${label}</span>` : nothing}
      <button @click=${() => onSet(current - limits.step)}>−</button>
      <input class="num mode-${colour}" type="number" inputmode="decimal"
        .value=${value === undefined ? "" : String(value)} min=${limits.min} max=${limits.max} step=${limits.step}
        @focus=${(e: Event) => (e.target as HTMLInputElement).select()}
        @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        @change=${(e: Event) => onSet(parseFloat((e.target as HTMLInputElement).value))} />
      <button @click=${() => onSet(current + limits.step)}>+</button>
    </div>`;
  }

  private _renderNow() {
    const entity = this._entity;
    if (!entity) return nothing;
    const a = entity.attributes;
    const modes: string[] = a.hvac_modes ?? [];
    const pending = this._nowPending;
    const range =
      entity.state !== "off" && a.target_temp_low != null && a.target_temp_high != null && a.temperature == null;
    let setpoint: unknown = nothing;
    if (entity.state !== "off" && range) {
      setpoint = html`<div class="row steppers">
        ${this._tempControl(pending.target_temp_low ?? a.target_temp_low, "heat", (v) => this._nowTemp("target_temp_low", v), "Heat to")}
        ${this._tempControl(pending.target_temp_high ?? a.target_temp_high, "cool", (v) => this._nowTemp("target_temp_high", v), "Cool to")}
      </div>`;
    } else if (entity.state !== "off" && (a.temperature != null || pending.temperature != null)) {
      setpoint = html`<div class="row steppers">
        ${this._tempControl(pending.temperature ?? a.temperature, entity.state, (v) => this._nowTemp("temperature", v))}
      </div>`;
    }
    return html`<div class="now-panel">
      <div class="hint">Changes the thermostat now. The schedule takes over again at its next time.</div>
      <div class="chips">
        ${modes.map(
          (m) => html`<button class="chip ${m === entity.state ? "on" : ""}" @click=${() => this._nowMode(m)}>${modeLabel(m)}</button>`
        )}
      </div>
      ${setpoint}
    </div>`;
  }

  private _activeProfileName(): string | null {
    const sensor = this._data?.[this._selected]?.sensor;
    const state = sensor ? this.hass!.states[sensor]?.state : undefined;
    if (!state || state === "No profile" || state === "unknown" || state === "unavailable") return null;
    return state;
  }

  private _renderTabs() {
    const active = this._activeProfileName();
    return html`
      <div class="tabs">
        ${this._draft.map(
          (p, i) => html`<button
            class="tab ${i === this._profileIdx ? "selected" : ""} ${p.enabled ? "" : "disabled"}"
            @click=${() => this._pickProfile(i)}
            title="Click again for conditions and settings"
          >
            ${p.name === active ? html`<span class="dot"></span>` : nothing}${p.name}
          </button>`
        )}
        <button class="tab add" @click=${this._addProfile} title="Add profile">+</button>
      </div>
      <div class="profile-line">
        <span>${this._conditionSummary(this._profile)}</span>
        <button class="link" @click=${() => (this._settingsOpen = !this._settingsOpen)}>
          ${this._settingsOpen ? "Close" : "Conditions & settings"}
        </button>
      </div>
    `;
  }

  private _conditionSummary(p: Profile): string {
    const priority = this._draft.length > 1 ? ` · priority ${this._draft.indexOf(p) + 1} of ${this._draft.length}` : "";
    if (!p.enabled) return `Disabled${priority}`;
    const n = p.conditions.length;
    return (n ? `Active when ${n === 1 ? "its condition matches" : `all ${n} conditions match`}` : "Always active (no conditions)") + priority;
  }

  private _renderSettings() {
    const p = this._profile;
    const idx = this._profileIdx;
    return html`
      <div class="settings">
        <div class="row">
          <label class="grow">Name
            <input type="text" .value=${p.name}
              @change=${(e: Event) => this._updateProfile((x) => ({ ...x, name: (e.target as HTMLInputElement).value.trim() || x.name }))} />
          </label>
          <label class="check">
            <input type="checkbox" .checked=${p.enabled}
              @change=${(e: Event) => this._updateProfile((x) => ({ ...x, enabled: (e.target as HTMLInputElement).checked }))} />
            Enabled
          </label>
        </div>
        <div class="row buttons">
          <button ?disabled=${idx === 0} @click=${() => this._moveProfile(-1)}>◀ Higher priority</button>
          <button ?disabled=${idx === this._draft.length - 1} @click=${() => this._moveProfile(1)}>Lower priority ▶</button>
          <span class="grow"></span>
          <button class="danger" ?disabled=${this._draft.length <= 1} @click=${this._deleteProfile}>Delete profile</button>
        </div>
        <div class="hint">
          The first profile (from the left) whose conditions all match is the active one. A profile with no
          conditions is always active, so keep it last as the fallback.
        </div>
        <div class="cond-head">
          <b>Conditions</b>
          <button class="link" @click=${() => { this._yamlMode = !this._yamlMode; this._yamlError = null; }}>
            ${this._yamlMode || !this._selectorReady ? "Visual editor" : "Edit in YAML"}
          </button>
        </div>
        ${this._selectorReady && !this._yamlMode
          ? html`<ha-selector
              .hass=${this.hass}
              .selector=${{ condition: {} }}
              .value=${p.conditions}
              @value-changed=${(e: CustomEvent) => this._setConditions(e.detail.value)}
            ></ha-selector>`
          : html`<textarea class="yaml" rows="8" spellcheck="false"
              placeholder="- condition: state&#10;  entity_id: input_select.house_mode&#10;  state: Home"
              .value=${p.conditions.length ? yaml.dump(p.conditions) : ""}
              @change=${this._onYaml}></textarea>
              ${this._yamlError ? html`<div class="error">${this._yamlError}</div>` : nothing}`}
      </div>
    `;
  }

  private _renderDays() {
    const today = dayOf(new Date());
    return html`
      <div class="days">
        ${DAYS.map(
          (d) => html`<button class="day ${this._days.includes(d) ? "selected" : ""} ${this._multi ? "multi" : ""} ${d === today ? "today" : ""} ${this._profile.days[d].length ? "" : "unset"}"
            @click=${() => this._pickDay(d)}>
            ${DAY_LABEL[d]}
          </button>`
        )}
        <button class="copy ${this._multi ? "on" : ""}" title="Select several days" @click=${() => this._setMulti(!this._multi)}>
          <svg viewBox="0 0 24 24"><path d="M20,2H8A2,2 0 0,0 6,4V16A2,2 0 0,0 8,18H20A2,2 0 0,0 22,16V4A2,2 0 0,0 20,2M20,16H8V4H20V16M16,20V22H4A2,2 0 0,1 2,20V7H4V20H16M18.53,8.06L17.47,7L12.76,11.71L10.64,9.6L9.58,10.66L12.76,13.84L18.53,8.06Z" /></svg>
        </button>
        <button class="copy" title="Copy this day to other days"
          @click=${() => { const open = !this._copyOpen; this._setMulti(false); this._copyOpen = open; this._copyTargets = []; }}>
          <svg viewBox="0 0 24 24"><path d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z" /></svg>
        </button>
      </div>
    `;
  }

  private _renderMultiBar() {
    const set = (days: Day[]) => {
      this._days = days;
      this._editing = null;
    };
    const different = this._differentDays;
    const which = this._days.length === 7 ? "every day" : DAYS.filter((d) => this._days.includes(d)).map((d) => DAY_LABEL[d]).join(", ");
    return html`<div class="multi-bar">
      <div class="row buttons">
        <button @click=${() => set(WORKDAYS)}>Workdays</button>
        <button @click=${() => set(WEEKEND)}>Weekend</button>
        <button @click=${() => set([...DAYS])}>Every day</button>
        <span class="grow"></span>
        <button class="primary" @click=${() => this._setMulti(false)}>Done</button>
      </div>
      <div class="hint">
        Tap days to add or remove them. Changes apply to ${which}.
        ${different.length
          ? html`<br /><span class="warn">${different.map((d) => DAY_LABEL[d]).join(", ")} ${different.length === 1 ? "has" : "have"} different times; the first change replaces them with ${DAY_LABEL[this._day]}'s times below.</span>`
          : nothing}
      </div>
    </div>`;
  }

  private _renderCopy() {
    const set = (days: Day[]) => (this._copyTargets = days.filter((d) => d !== this._day));
    return html`
      <div class="copy-panel">
        <div>Copy <b>${DAY_LABEL[this._day]}</b> to:</div>
        <div class="chips">
          ${DAYS.filter((d) => d !== this._day).map(
            (d) => html`<button class="chip ${this._copyTargets.includes(d) ? "on" : ""}" @click=${() => this._toggleCopyTarget(d)}>${DAY_LABEL[d]}</button>`
          )}
        </div>
        <div class="row buttons">
          <button @click=${() => set(WORKDAYS)}>Workdays</button>
          <button @click=${() => set(WEEKEND)}>Weekend</button>
          <button @click=${() => set([...DAYS])}>Every day</button>
          <span class="grow"></span>
          <button @click=${() => (this._copyOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${!this._copyTargets.length} @click=${this._applyCopy}>Copy</button>
        </div>
      </div>
    `;
  }

  private _renderSlots() {
    const slots = this._profile.days[this._day];
    const isActive = this._profile.name === this._activeProfileName();
    const now = isActive ? currentSlot(this._profile, new Date()) : null;
    return html`
      <div class="boxes">
        ${slots.length
          ? slots.map((s, i) => {
              const isNow = !!now && now.day === this._day && now.index === i;
              return this._editing === i ? this._renderSlotEditor(s, i) : html`
                <div class="box ${isNow ? "now" : ""}" @click=${() => (this._editing = i)}>
                  <span class="time">${this._fmt(s.time)}</span>
                  <span class="what">${this._slotSummary(s)}${s.fan_mode ? html`<small> · fan ${s.fan_mode}</small>` : nothing}</span>
                  ${isNow ? html`<span class="now-tag">now</span>` : nothing}
                  <span class="value mode-${s.hvac_mode}">
                    ${s.hvac_mode === "off" ? "Off" : s.target_temp_low !== undefined ? `${s.target_temp_low}–${s.target_temp_high}` : s.temperature ?? ""}
                  </span>
                </div>`;
            })
          : html`<div class="empty-day">No times on ${this._days.length > 1 ? "these days" : DAY_LABEL[this._day]}. The last time of the previous day stays in effect.</div>`}
        <button class="add-box" @click=${this._addSlot}>+ Add time</button>
      </div>
    `;
  }

  private _renderSlotEditor(s: Slot, i: number) {
    const entity = this._entity;
    const modes: string[] = entity?.attributes.hvac_modes ?? ["heat", "cool", "heat_cool", "off"];
    const fanModes: string[] | undefined = entity?.attributes.fan_modes;
    const allModes = modes.includes(s.hvac_mode) ? modes : [...modes, s.hvac_mode];
    const stepper = (key: "temperature" | "target_temp_low" | "target_temp_high", label?: string) =>
      this._tempControl(
        s[key],
        key === "target_temp_low" ? "heat" : key === "target_temp_high" ? "cool" : s.hvac_mode,
        (v) => this._setTemp(i, key, v),
        label
      );
    return html`
      <div class="box editing">
        <div class="row">
          <input type="time" step="60" .value=${s.time} @change=${(e: Event) => this._setTime(i, (e.target as HTMLInputElement).value)} />
          <span class="grow"></span>
          <button class="link" @click=${() => (this._editing = null)}>Done</button>
        </div>
        <div class="chips">
          ${allModes.map(
            (m) => html`<button class="chip mode-chip ${m === s.hvac_mode ? "on" : ""}" @click=${() => this._setSlot(i, (x) => this._withMode(x, m))}>${modeLabel(m)}</button>`
          )}
        </div>
        ${s.hvac_mode === "off"
          ? nothing
          : s.target_temp_low !== undefined
            ? html`<div class="row steppers">${stepper("target_temp_low", "Heat to")}${stepper("target_temp_high", "Cool to")}</div>`
            : html`<div class="row steppers">${stepper("temperature")}</div>`}
        <div class="row">
          ${fanModes?.length
            ? html`<label>Fan
                <select @change=${(e: Event) => {
                  const v = (e.target as HTMLSelectElement).value;
                  this._setSlot(i, (x) => { const n = { ...x }; if (v) n.fan_mode = v; else delete n.fan_mode; return n; });
                }}>
                  <option value="" ?selected=${!s.fan_mode}>Don't change</option>
                  ${fanModes.map((f) => html`<option value=${f} ?selected=${f === s.fan_mode}>${f}</option>`)}
                </select></label>`
            : nothing}
          <span class="grow"></span>
          <button class="danger" @click=${() => this._removeSlot(i)}>Remove</button>
        </div>
      </div>
    `;
  }

  private _renderFooter() {
    const dirty = this._dirty;
    const scheduled = !!this._data?.[this._selected];
    const automations = this._data?.[this._selected]?.automations ?? [];
    return html`
      ${this._error ? html`<div class="msg error">${this._error}</div>` : nothing}
      ${this._message ? html`<div class="msg ok">${this._message}</div>` : nothing}
      <div class="footer">
        ${dirty
          ? html`<span class="unsaved">Unsaved changes</span><span class="grow"></span>
              <button @click=${() => this._select(this._selected, false)} ?disabled=${this._saving}>Discard</button>
              <button class="primary" @click=${this._save} ?disabled=${this._saving}>${this._saving ? "Saving…" : "Save"}</button>`
          : html`<span class="meta">${scheduled ? `${automations.length} automation${automations.length === 1 ? "" : "s"}` : ""}</span>
              <span class="grow"></span>
              ${scheduled ? html`<button class="link danger" @click=${this._removeSchedule}>Remove schedule</button>` : nothing}`}
      </div>
    `;
  }

  static styles = css`
    :host {
      --cs-heat: var(--state-climate-heat-color, #ff8100);
      --cs-cool: var(--state-climate-cool-color, #2b9af9);
      --cs-auto: var(--state-climate-auto-color, #8bc34a);
      --cs-line: var(--divider-color, rgba(127, 127, 127, 0.25));
      --cs-muted: var(--secondary-text-color);
      --cs-accent: var(--primary-color);
    }
    ha-card { overflow: hidden; }
    button { font: inherit; color: inherit; cursor: pointer; background: none; border: none; }
    button:disabled { opacity: 0.4; cursor: default; }
    .grow { flex: 1; }
    .notice { padding: 16px; }
    .error { color: var(--error-color, #db4437); }
    .header { padding: 14px 16px 4px; display: flex; flex-direction: column; gap: 4px; }
    .title { font-size: 22px; font-weight: 400; }
    .title.small { font-size: 14px; color: var(--cs-muted); }
    .picker {
      font: inherit; font-size: 20px; color: var(--primary-text-color);
      background: transparent; border: none; border-bottom: 1px solid var(--cs-line);
      padding: 4px 0; width: 100%; cursor: pointer;
    }
    .picker option { color: initial; }
    .status { display: flex; justify-content: space-between; gap: 8px; padding: 2px 16px 10px; color: var(--cs-muted); font-size: 14px; flex-wrap: wrap; }
    .status .active { color: var(--cs-accent); }
    .status .active.none { color: var(--cs-muted); }
    .tabs { display: flex; gap: 4px; overflow-x: auto; padding: 0 12px; border-top: 1px solid var(--cs-line); background: var(--secondary-background-color, rgba(127,127,127,0.06)); scrollbar-width: none; }
    .tab { padding: 12px 10px; white-space: nowrap; color: var(--cs-muted); font-size: 16px; border-bottom: 2px solid transparent; }
    .tab.selected { color: var(--primary-text-color); border-bottom-color: var(--cs-accent); }
    .tab.disabled { text-decoration: line-through; }
    .tab.add { font-size: 20px; padding: 8px 12px; }
    .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--cs-accent); margin-right: 6px; vertical-align: middle; }
    .profile-line { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 16px; font-size: 13px; color: var(--cs-muted); }
    .link { color: var(--cs-accent); padding: 4px; font-size: 13px; }
    .link.danger, .danger { color: var(--error-color, #db4437); }
    .settings { padding: 8px 16px 12px; border-bottom: 1px solid var(--cs-line); display: flex; flex-direction: column; gap: 10px; }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .row.buttons button, .copy-panel button, .footer button:not(.link), .box.editing .danger {
      padding: 6px 12px; border-radius: 16px; border: 1px solid var(--cs-line); font-size: 13px;
    }
    button.primary { background: var(--cs-accent); color: var(--text-primary-color, #fff); border-color: transparent; }
    label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--cs-muted); }
    label.check { flex-direction: row; align-items: center; gap: 6px; font-size: 14px; color: var(--primary-text-color); }
    input[type="text"], input[type="time"], select, textarea {
      font: inherit; font-size: 15px; color: var(--primary-text-color); background: var(--card-background-color);
      border: 1px solid var(--cs-line); border-radius: 6px; padding: 6px 8px;
    }
    input[type="time"] { font-size: 20px; color-scheme: light dark; }
    textarea.yaml { font-family: var(--code-font-family, monospace); font-size: 13px; width: 100%; box-sizing: border-box; }
    .hint { font-size: 12px; color: var(--cs-muted); }
    .cond-head { display: flex; justify-content: space-between; align-items: center; }
    .days { display: flex; align-items: center; border-top: 1px solid var(--cs-line); border-bottom: 1px solid var(--cs-line); padding: 0 6px; }
    .day { flex: 1; padding: 12px 0; font-size: 16px; color: var(--cs-muted); position: relative; }
    .day.selected { color: var(--primary-text-color); font-weight: 600; }
    .day.today::after { content: ""; position: absolute; left: 30%; right: 30%; bottom: 6px; height: 2px; background: var(--cs-line); }
    .day.selected.today::after { background: var(--cs-accent); }
    .day.unset:not(.selected) { opacity: 0.45; }
    .copy { padding: 8px; }
    .copy svg { width: 20px; height: 20px; fill: var(--cs-muted); display: block; }
    .copy-panel { padding: 10px 16px; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--cs-line); font-size: 14px; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { padding: 6px 12px; border-radius: 16px; border: 1px solid var(--cs-line); font-size: 14px; }
    .chip.on { background: var(--cs-accent); color: var(--text-primary-color, #fff); border-color: transparent; }
    .boxes { display: flex; flex-direction: column; }
    .box { display: flex; align-items: center; gap: 12px; padding: 16px; border-bottom: 1px solid var(--cs-line); cursor: pointer; font-size: 18px; }
    .box:hover { background: var(--secondary-background-color, rgba(127,127,127,0.06)); }
    .box.now { box-shadow: inset 3px 0 0 var(--cs-accent); }
    .box .time { width: 100px; flex-shrink: 0; }
    .box .what { flex: 1; }
    .box .what small { color: var(--cs-muted); font-size: 13px; }
    .now-tag { font-size: 11px; text-transform: uppercase; color: var(--cs-accent); border: 1px solid var(--cs-accent); border-radius: 8px; padding: 1px 6px; }
    .box .value { font-size: 22px; min-width: 48px; text-align: right; }
    .mode-heat { color: var(--cs-heat); }
    .mode-cool { color: var(--cs-cool); }
    .mode-heat_cool, .mode-auto { color: var(--cs-auto); }
    .mode-off { color: var(--cs-muted); }
    .box.editing { flex-direction: column; align-items: stretch; cursor: default; gap: 12px; background: var(--secondary-background-color, rgba(127,127,127,0.06)); }
    .steppers { justify-content: center; gap: 24px; }
    .stepper { display: flex; align-items: center; gap: 10px; }
    .stepper .lbl { font-size: 13px; color: var(--cs-muted); }
    .stepper button { width: 36px; height: 36px; border-radius: 50%; border: 1px solid var(--cs-line); font-size: 20px; line-height: 1; }
    .stepper .num {
      font: inherit; font-size: 28px; width: 72px; text-align: center; background: transparent;
      border: none; border-bottom: 1px dashed var(--cs-line); border-radius: 0; padding: 2px 0;
      -moz-appearance: textfield; appearance: textfield;
    }
    .stepper .num::-webkit-outer-spin-button, .stepper .num::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .stepper .num:focus { outline: none; border-bottom-color: var(--cs-accent); }
    .now-btn { padding: 0; text-align: left; color: var(--cs-muted); font-size: 14px; }
    .now-btn .caret { color: var(--cs-accent); margin-left: 6px; }
    .now-panel { padding: 4px 16px 12px; display: flex; flex-direction: column; gap: 10px; border-bottom: 1px solid var(--cs-line); }
    .copy.on svg { fill: var(--cs-accent); }
    .day.multi.selected { color: var(--cs-accent); }
    .multi-bar { padding: 8px 16px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid var(--cs-line); }
    .warn { color: var(--warning-color, #ffa600); }
    .empty-day { padding: 16px; color: var(--cs-muted); font-size: 14px; }
    .add-box { padding: 14px; color: var(--cs-accent); font-size: 15px; text-align: left; padding-left: 16px; }
    .msg { padding: 8px 16px; font-size: 13px; }
    .msg.ok { color: var(--success-color, #43a047); }
    .footer { display: flex; align-items: center; gap: 8px; padding: 8px 16px 12px; border-top: 1px solid var(--cs-line); min-height: 36px; }
    .unsaved { font-size: 13px; color: var(--warning-color, #ffa600); }
    .meta { font-size: 12px; color: var(--cs-muted); }
  `;
}

if (!customElements.get("comfort-schedule-card")) {
  customElements.define("comfort-schedule-card", ComfortScheduleCard);
}

(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: "comfort-schedule-card",
  name: "Comfort Schedule",
  description: "Control4-style thermostat schedules with profiles. Saving creates real automations.",
  preview: false,
});

console.info(`%c COMFORT-SCHEDULE-CARD %c ${VERSION} `, "background:#ff8100;color:#fff", "");
