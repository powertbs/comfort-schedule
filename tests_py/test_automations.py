"""Run: python -m pytest tests_py  (needs jinja2 + pyyaml)."""
import ast
import datetime as dt
import sys
from pathlib import Path

import yaml
from jinja2.sandbox import ImmutableSandboxedEnvironment

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "custom_components" / "comfort_schedule"))
import automations as a  # noqa: E402

PROFILE = a.clean_profiles([{
    "id": "winter", "name": "Winter Home", "conditions": [{"condition": "state", "entity_id": "input_select.house", "state": "Home"}],
    "days": {
        "mon": [{"time": "22:00", "hvac_mode": "heat", "temperature": 64}, {"time": "07:00", "hvac_mode": "heat", "temperature": 68}],
        "tue": [{"time": "07:00", "hvac_mode": "heat", "temperature": 69}, {"time": "11:00", "hvac_mode": "heat_cool", "target_temp_low": 66, "target_temp_high": 74, "temperature": 1}],
        "sat": [{"time": "09:30", "hvac_mode": "off", "temperature": 70, "fan_mode": "auto"}],
    },
}])[0]


def render(template, now, **variables):
    env = ImmutableSandboxedEnvironment()
    env.globals["now"] = lambda: now
    out = env.from_string(template).render(now=lambda: now, **variables).strip()
    try:
        return ast.literal_eval(out)
    except Exception:
        return out


def slot_at(now):
    sched = {d: PROFILE["days"][d] for d in a.DAYS}
    return render(a.CURRENT_SLOT_TEMPLATE, now, schedule=sched)


MON = dt.datetime(2026, 11, 23)  # a Monday


def test_today_latest_box():
    s = slot_at(MON.replace(hour=8))
    assert s["time"] == "07:00" and s["temperature"] == 68 and s["today"] is True


def test_exact_minute_counts():
    assert slot_at(MON.replace(hour=22))["temperature"] == 64


def test_before_first_box_uses_previous_day():
    # Monday 06:00: nothing yet today, Sunday empty, Saturday 09:30 off.
    s = slot_at(MON.replace(hour=6))
    assert s["hvac_mode"] == "off" and s["today"] is False


def test_range_box_drops_single_setpoint():
    s = slot_at((MON + dt.timedelta(days=1)).replace(hour=12))
    assert s["target_temp_low"] == 66 and "temperature" not in s


def test_off_box_drops_setpoints_keeps_fan():
    assert PROFILE["days"]["sat"][0] == {"time": "09:30", "hvac_mode": "off", "fan_mode": "auto"}


def test_should_apply():
    tue7 = (MON + dt.timedelta(days=1)).replace(hour=7)
    slot = dict(slot_at(tue7))
    trig = {"id": "box_time"}
    assert render(a.SHOULD_APPLY_TEMPLATE, tue7, slot=slot, trigger=trig) is True
    # 22:00 is a box time only on Monday; on Tuesday it must not fire.
    tue22 = tue7.replace(hour=22)
    slot = dict(slot_at(tue22))
    assert render(a.SHOULD_APPLY_TEMPLATE, tue22, slot=slot, trigger=trig) is False
    assert render(a.SHOULD_APPLY_TEMPLATE, tue22, slot=slot, trigger={"id": "profile_active"}) is True


def test_automation_shape_and_yaml_roundtrip():
    auto = a.build_automation("climate.living_room", "Living Room", PROFILE, "sensor.living_room_comfort_profile")
    assert auto["id"] == "comfort_schedule__living_room__winter"
    assert [t["at"] for t in auto["triggers"] if t["trigger"] == "time"] == ["07:00:00", "09:30:00", "11:00:00", "22:00:00"]
    assert auto["conditions"][1]["entity_id"] == "input_select.house"
    back = yaml.safe_load(yaml.safe_dump([auto], sort_keys=False, allow_unicode=True))
    assert back[0]["actions"][0]["variables"]["schedule"]["tue"][1]["time"] == "11:00"


def test_merge_keeps_others_and_prefix_safe():
    existing = [{"id": "1"}, {"id": "comfort_schedule__living__x"}, {"id": "comfort_schedule__living_room__old"}, {"id": "2"}]
    out = a.merge_into(existing, "climate.living_room", [{"id": "comfort_schedule__living_room__new"}])
    assert [x["id"] for x in out] == ["1", "comfort_schedule__living__x", "comfort_schedule__living_room__new", "2"]


def test_rejects_bad_input():
    import pytest
    with pytest.raises(a.ScheduleError):
        a.clean_profiles([{"id": "a", "name": "X", "days": {"mon": [{"time": "7:00", "hvac_mode": "heat"}]}}])
    with pytest.raises(a.ScheduleError):
        a.clean_profiles([{"id": "a", "name": "X"}, {"id": "b", "name": "x"}])
