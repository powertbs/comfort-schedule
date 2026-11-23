export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];

export const DAY_LABEL: Record<Day, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};

export interface Slot {
  time: string; // HH:MM
  hvac_mode: string;
  temperature?: number;
  target_temp_low?: number;
  target_temp_high?: number;
  fan_mode?: string;
}

export interface Profile {
  id: string;
  name: string;
  enabled: boolean;
  conditions: unknown[];
  days: Record<Day, Slot[]>;
}

export function emptyDays(): Record<Day, Slot[]> {
  return { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
}

export function makeId(taken: string[]): string {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, "x");
    if (id.length === 6 && !taken.includes(id)) return id;
  }
}

export function uniqueName(base: string, profiles: Profile[]): string {
  const names = new Set(profiles.map((p) => p.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

export function newProfile(name: string, profiles: Profile[]): Profile {
  return {
    id: makeId(profiles.map((p) => p.id)),
    name: uniqueName(name, profiles),
    enabled: true,
    conditions: [],
    days: emptyDays(),
  };
}

/** Normalise whatever came from the backend into a complete profile. */
export function normaliseProfile(raw: Partial<Profile>): Profile {
  const days = emptyDays();
  for (const d of DAYS) days[d] = sortSlots([...(raw.days?.[d] ?? [])]);
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    enabled: raw.enabled !== false,
    conditions: Array.isArray(raw.conditions) ? raw.conditions : [],
    days,
  };
}

export function sortSlots(slots: Slot[]): Slot[] {
  return slots.sort((a, b) => a.time.localeCompare(b.time));
}

/** JS getDay() is 0=Sunday; schedules use Monday first. */
export function dayOf(date: Date): Day {
  return DAYS[(date.getDay() + 6) % 7];
}

export function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export interface CurrentSlot {
  slot: Slot;
  day: Day;
  index: number;
}

/** Same rule as the generated automation: the latest box today at or before now,
 * otherwise the last box of the most recent earlier day. */
export function currentSlot(profile: Profile, now: Date): CurrentSlot | null {
  const today = DAYS.indexOf(dayOf(now));
  const time = hhmm(now);
  for (let back = 0; back < 8; back++) {
    const day = DAYS[(today - back + 7 * 2) % 7];
    const slots = profile.days[day];
    let index = -1;
    if (back === 0) {
      slots.forEach((s, i) => { if (s.time <= time) index = i; });
    } else {
      index = slots.length - 1;
    }
    if (index >= 0) return { slot: slots[index], day, index };
  }
  return null;
}

export function copyDay(profile: Profile, from: Day, to: Day[]): Profile {
  const days = { ...profile.days };
  for (const d of to) {
    if (d !== from) days[d] = profile.days[from].map((s) => ({ ...s }));
  }
  return { ...profile, days };
}

export function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = Math.min(Math.max(h * 60 + m + minutes, 0), 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** A sensible time for a new box: an hour after the last one, never a duplicate. */
export function nextFreeTime(slots: Slot[]): string {
  const taken = new Set(slots.map((s) => s.time));
  let time = slots.length ? addMinutes(slots[slots.length - 1].time, 60) : "07:00";
  while (taken.has(time)) {
    const next = addMinutes(time, time >= "23:00" ? -15 : 15);
    if (next === time) break;
    time = next;
  }
  return time;
}

export function formatTime(time: string, hour12: boolean): string {
  const [h, m] = time.split(":").map(Number);
  if (!hour12) return time;
  const suffix = h < 12 ? "AM" : "PM";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function sameDay(a: Slot[], b: Slot[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
