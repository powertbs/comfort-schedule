import { describe, expect, it } from "vitest";
import { copyDay, currentSlot, dayOf, formatTime, newProfile, nextFreeTime, normaliseProfile } from "../src/schedule";

const p = normaliseProfile({
  id: "a", name: "Home",
  days: {
    mon: [{ time: "22:00", hvac_mode: "heat", temperature: 64 }, { time: "07:00", hvac_mode: "heat", temperature: 68 }],
    tue: [], wed: [], thu: [], fri: [], sun: [],
    sat: [{ time: "09:30", hvac_mode: "off" }],
  },
});
const MON = (h: number, m = 0) => new Date(2026, 10, 23, h, m); // Monday

describe("schedule", () => {
  it("knows the weekday", () => expect(dayOf(MON(1))).toBe("mon"));
  it("sorts boxes", () => expect(p.days.mon.map((s) => s.time)).toEqual(["07:00", "22:00"]));
  it("picks today's latest box", () => expect(currentSlot(p, MON(8))?.slot.temperature).toBe(68));
  it("counts the exact minute", () => expect(currentSlot(p, MON(22))?.slot.temperature).toBe(64));
  it("falls back to an earlier day", () => {
    const c = currentSlot(p, MON(6));
    expect(c?.day).toBe("sat");
    expect(c?.slot.hvac_mode).toBe("off");
  });
  it("returns null with no boxes", () => expect(currentSlot(newProfile("x", []), MON(6))).toBeNull());
  it("copies a day", () => {
    const c = copyDay(p, "mon", ["tue", "wed"]);
    expect(c.days.wed).toEqual(p.days.mon);
    expect(c.days.wed[0]).not.toBe(p.days.mon[0]);
  });
  it("suggests the next free time", () => {
    expect(nextFreeTime([])).toBe("07:00");
    expect(nextFreeTime(p.days.mon)).toBe("23:00");
    expect(nextFreeTime([{ time: "23:59", hvac_mode: "heat" }])).toBe("23:44");
  });
  it("formats 12 and 24 hour", () => {
    expect(formatTime("00:05", true)).toBe("12:05 AM");
    expect(formatTime("13:00", true)).toBe("1:00 PM");
    expect(formatTime("13:00", false)).toBe("13:00");
  });
  it("names new profiles uniquely", () => expect(newProfile("Home", [p]).name).toBe("Home 2"));
});
