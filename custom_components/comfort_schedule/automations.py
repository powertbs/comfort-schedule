"""Build Home Assistant automation configs from a comfort schedule.

This module has no Home Assistant imports so it can be unit tested on its own.
"""

from __future__ import annotations

import re
from typing import Any

DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# Every automation we own has an id starting with this. The thermostat's object id
# is wrapped in double underscores so "living" never matches "living_room".
ID_PREFIX = "comfort_schedule__"

TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

SLOT_KEYS = ("hvac_mode", "temperature", "target_temp_low", "target_temp_high", "fan_mode")

# Finds the box that should be active right now: the latest box today at or before
# the current time, otherwise the last box of the most recent earlier day.
CURRENT_SLOT_TEMPLATE = (
    "{%- set days = ['mon','tue','wed','thu','fri','sat','sun'] -%}\n"
    "{%- set hhmm = now().strftime('%H:%M') -%}\n"
    "{%- set ns = namespace(slot=none, today=false) -%}\n"
    "{%- for back in range(8) -%}\n"
    "  {%- if ns.slot is none -%}\n"
    "    {%- set day = schedule.get(days[(now().weekday() - back) % 7], []) -%}\n"
    "    {%- set cands = (day | selectattr('time', 'le', hhmm) | list) if back == 0 else day -%}\n"
    "    {%- if cands | count > 0 -%}\n"
    "      {%- set ns.slot = cands | last -%}\n"
    "      {%- set ns.today = back == 0 -%}\n"
    "    {%- endif -%}\n"
    "  {%- endif -%}\n"
    "{%- endfor -%}\n"
    "{{ dict(ns.slot, today=ns.today) if ns.slot is not none else none }}"
)

# Time triggers fire for the union of all box times. Only act when today really
# has a box at this minute; profile changes and manual runs always apply.
SHOULD_APPLY_TEMPLATE = (
    "{{ slot is mapping and (trigger is not defined or trigger.id is not defined"
    " or trigger.id != 'box_time'"
    " or (slot.today and slot.time == now().strftime('%H:%M'))) }}"
)


def object_id(entity_id: str) -> str:
    return entity_id.split(".", 1)[1]


def thermostat_prefix(entity_id: str) -> str:
    return f"{ID_PREFIX}{object_id(entity_id)}__"


def automation_id(entity_id: str, profile_id: str) -> str:
    return f"{thermostat_prefix(entity_id)}{profile_id}"


def is_ours(automation_cfg: Any) -> bool:
    return isinstance(automation_cfg, dict) and str(automation_cfg.get("id", "")).startswith(ID_PREFIX)


def belongs_to(automation_cfg: Any, entity_id: str) -> bool:
    return isinstance(automation_cfg, dict) and str(automation_cfg.get("id", "")).startswith(
        thermostat_prefix(entity_id)
    )


class ScheduleError(ValueError):
    """Raised when a submitted schedule is invalid."""


def _num(value: Any, what: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as err:
        raise ScheduleError(f"{what} must be a number") from err
    return int(number) if number.is_integer() else number


def clean_slot(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ScheduleError("each box must be an object")
    time = str(raw.get("time", ""))
    if not TIME_RE.match(time):
        raise ScheduleError(f"box time '{time}' must be HH:MM")
    mode = str(raw.get("hvac_mode", "")).strip()
    if not mode:
        raise ScheduleError(f"box at {time} has no mode")
    slot: dict[str, Any] = {"time": time, "hvac_mode": mode}
    if mode != "off":
        if raw.get("target_temp_low") is not None and raw.get("target_temp_high") is not None:
            slot["target_temp_low"] = _num(raw["target_temp_low"], f"low setpoint at {time}")
            slot["target_temp_high"] = _num(raw["target_temp_high"], f"high setpoint at {time}")
        elif raw.get("temperature") is not None:
            slot["temperature"] = _num(raw["temperature"], f"setpoint at {time}")
    if raw.get("fan_mode"):
        slot["fan_mode"] = str(raw["fan_mode"])
    return slot


def clean_profiles(raw_profiles: Any) -> list[dict[str, Any]]:
    """Validate and normalise profiles coming from the card. Conditions are kept as-is
    (Home Assistant validates them separately)."""
    if not isinstance(raw_profiles, list):
        raise ScheduleError("profiles must be a list")
    seen_ids: set[str] = set()
    seen_names: set[str] = set()
    profiles = []
    for raw in raw_profiles:
        if not isinstance(raw, dict):
            raise ScheduleError("each profile must be an object")
        pid = str(raw.get("id", "")).strip()
        if not re.match(r"^[a-z0-9_]{1,32}$", pid):
            raise ScheduleError(f"profile id '{pid}' is invalid")
        name = str(raw.get("name", "")).strip()
        if not name:
            raise ScheduleError("every profile needs a name")
        if pid in seen_ids:
            raise ScheduleError(f"duplicate profile id '{pid}'")
        if name.lower() in seen_names:
            raise ScheduleError(f"two profiles are named '{name}'")
        seen_ids.add(pid)
        seen_names.add(name.lower())
        conditions = raw.get("conditions") or []
        if not isinstance(conditions, list):
            raise ScheduleError(f"conditions of '{name}' must be a list")
        days_raw = raw.get("days") or {}
        days: dict[str, list[dict[str, Any]]] = {}
        for day in DAYS:
            slots = [clean_slot(s) for s in (days_raw.get(day) or [])]
            slots.sort(key=lambda s: s["time"])
            times = [s["time"] for s in slots]
            if len(times) != len(set(times)):
                raise ScheduleError(f"'{name}' has two boxes at the same time on {day}")
            days[day] = slots
        profiles.append(
            {
                "id": pid,
                "name": name,
                "enabled": bool(raw.get("enabled", True)),
                "conditions": conditions,
                "days": days,
            }
        )
    return profiles


def _setpoint_actions(entity_id: str) -> list[dict[str, Any]]:
    target = {"entity_id": entity_id}
    return [
        {
            "choose": [
                {
                    "conditions": "{{ slot.hvac_mode == 'off' }}",
                    "sequence": [
                        {
                            "action": "climate.set_hvac_mode",
                            "target": target,
                            "data": {"hvac_mode": "off"},
                        }
                    ],
                },
                {
                    "conditions": "{{ slot.target_temp_low is defined }}",
                    "sequence": [
                        {
                            "action": "climate.set_temperature",
                            "target": target,
                            "data": {
                                "hvac_mode": "{{ slot.hvac_mode }}",
                                "target_temp_low": "{{ slot.target_temp_low }}",
                                "target_temp_high": "{{ slot.target_temp_high }}",
                            },
                        }
                    ],
                },
                {
                    "conditions": "{{ slot.temperature is defined }}",
                    "sequence": [
                        {
                            "action": "climate.set_temperature",
                            "target": target,
                            "data": {
                                "hvac_mode": "{{ slot.hvac_mode }}",
                                "temperature": "{{ slot.temperature }}",
                            },
                        }
                    ],
                },
            ],
            "default": [
                {
                    "action": "climate.set_hvac_mode",
                    "target": target,
                    "data": {"hvac_mode": "{{ slot.hvac_mode }}"},
                }
            ],
        },
        {
            "if": "{{ slot.fan_mode is defined }}",
            "then": [
                {
                    "action": "climate.set_fan_mode",
                    "target": target,
                    "data": {"fan_mode": "{{ slot.fan_mode }}"},
                }
            ],
        },
    ]


def build_automation(
    entity_id: str,
    thermostat_name: str,
    profile: dict[str, Any],
    sensor_entity_id: str,
) -> dict[str, Any] | None:
    """Return the automation config for one thermostat + profile, or None if the
    profile has no boxes."""
    times = sorted({slot["time"] for day in DAYS for slot in profile["days"].get(day, [])})
    if not times:
        return None

    triggers: list[dict[str, Any]] = [
        {"trigger": "time", "at": f"{t}:00", "id": "box_time"} for t in times
    ]
    triggers.append(
        {
            "trigger": "state",
            "entity_id": sensor_entity_id,
            "to": profile["name"],
            "not_from": ["unavailable", "unknown"],
            "id": "profile_active",
        }
    )

    conditions: list[Any] = [
        {"condition": "state", "entity_id": sensor_entity_id, "state": profile["name"]}
    ]
    conditions.extend(profile.get("conditions") or [])

    schedule = {day: profile["days"].get(day, []) for day in DAYS}

    return {
        "id": automation_id(entity_id, profile["id"]),
        "alias": f"Comfort Schedule · {thermostat_name} · {profile['name']}",
        "description": (
            "Managed by Comfort Schedule. Edit it in the Comfort Schedule card: "
            "changes made here are overwritten the next time the schedule is saved."
        ),
        "mode": "restart",
        "triggers": triggers,
        "conditions": conditions,
        "actions": [
            {"variables": {"schedule": schedule}},
            {"variables": {"slot": CURRENT_SLOT_TEMPLATE}},
            {"condition": "template", "value_template": SHOULD_APPLY_TEMPLATE},
            *_setpoint_actions(entity_id),
        ],
    }


def build_automations(
    entity_id: str,
    thermostat_name: str,
    profiles: list[dict[str, Any]],
    sensor_entity_id: str,
) -> list[dict[str, Any]]:
    result = []
    for profile in profiles:
        if not profile.get("enabled", True):
            continue
        automation = build_automation(entity_id, thermostat_name, profile, sensor_entity_id)
        if automation is not None:
            result.append(automation)
    return result


def merge_into(
    existing: list[Any], entity_id: str, generated: list[dict[str, Any]]
) -> list[Any]:
    """Replace this thermostat's automations in the automations.yaml list, keeping
    everything else in place. New ones go where the old ones were, or at the end."""
    out: list[Any] = []
    inserted = False
    for item in existing:
        if belongs_to(item, entity_id):
            if not inserted:
                out.extend(generated)
                inserted = True
            continue
        out.append(item)
    if not inserted:
        out.extend(generated)
    return out
