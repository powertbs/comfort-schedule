export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
}

export interface Hass {
  states: Record<string, HassEntity>;
  callWS<T>(msg: Record<string, unknown>): Promise<T>;
  locale?: { language?: string; time_format?: string };
  language?: string;
  user?: { is_admin?: boolean };
  config: { unit_system: { temperature: string } };
}

export const CLIMATE_TARGET_TEMPERATURE = 1;
export const CLIMATE_TARGET_TEMPERATURE_RANGE = 2;

export const MODE_LABEL: Record<string, string> = {
  heat: "Heat",
  cool: "Cool",
  heat_cool: "Heat/Cool",
  auto: "Auto",
  off: "Off",
  dry: "Dry",
  fan_only: "Fan",
};

export function modeLabel(mode: string): string {
  return MODE_LABEL[mode] ?? mode.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function friendlyName(hass: Hass, entityId: string): string {
  return hass.states[entityId]?.attributes.friendly_name ?? entityId.split(".")[1].replace(/_/g, " ");
}

export function uses12h(hass: Hass): boolean {
  const format = hass.locale?.time_format;
  if (format === "12") return true;
  if (format === "24") return false;
  const lang = format === "system" ? undefined : hass.locale?.language ?? hass.language;
  try {
    return !!new Intl.DateTimeFormat(lang, { hour: "numeric" }).resolvedOptions().hour12;
  } catch {
    return false;
  }
}

/** Whether this mode takes a low/high range instead of one setpoint on this thermostat. */
export function usesRange(entity: HassEntity | undefined, mode: string): boolean {
  if (mode === "heat_cool") return true;
  if (mode !== "auto" || !entity) return false;
  const features = Number(entity.attributes.supported_features ?? 0);
  return (
    (features & CLIMATE_TARGET_TEMPERATURE_RANGE) !== 0 &&
    (features & CLIMATE_TARGET_TEMPERATURE) === 0
  );
}

export interface TempLimits {
  min: number;
  max: number;
  step: number;
  unit: string;
  fallback: number;
}

export function tempLimits(hass: Hass, entity: HassEntity | undefined): TempLimits {
  const unit = hass.config.unit_system.temperature || "°C";
  const fahrenheit = unit.includes("F");
  const a = entity?.attributes ?? {};
  return {
    min: Number(a.min_temp ?? (fahrenheit ? 45 : 7)),
    max: Number(a.max_temp ?? (fahrenheit ? 95 : 35)),
    step: Number(a.target_temp_step ?? (fahrenheit ? 1 : 0.5)),
    unit,
    fallback: Number(a.temperature ?? (fahrenheit ? 70 : 21)),
  };
}

/** The dashboard does not always load Home Assistant's form elements. Opening a
 * built-in card editor pulls in ha-form and ha-selector, which the condition
 * editor needs. Resolves false if they never appear. */
export async function loadHaSelector(): Promise<boolean> {
  if (customElements.get("ha-selector")) return true;
  try {
    const helpers = await (window as any).loadCardHelpers?.();
    if (helpers && !customElements.get("ha-selector")) {
      const card = await helpers.createCardElement({ type: "tile", entity: "sun.sun" });
      await (card?.constructor as any)?.getConfigElement?.();
    }
  } catch {
    /* fall through to the wait below */
  }
  return Promise.race([
    customElements.whenDefined("ha-selector").then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
}
