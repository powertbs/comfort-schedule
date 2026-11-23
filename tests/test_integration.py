"""End-to-end: save a schedule over the websocket, check automations.yaml, the
profile sensor, and that the automations actually drive the thermostat."""

from datetime import datetime
from pathlib import Path

from freezegun.api import FrozenDateTimeFactory
import pytest
import yaml

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_fire_time_changed,
    async_mock_service,
)

DOMAIN = "comfort_schedule"
USER_AUTOMATION = {
    "id": "mine",
    "alias": "My own automation",
    "triggers": [{"trigger": "event", "event_type": "nothing"}],
    "actions": [],
}


def box(time, mode, temp=None, **extra):
    out = {"time": time, "hvac_mode": mode, **extra}
    if temp is not None:
        out["temperature"] = temp
    return out


def week(*slots):
    return {d: list(slots) for d in ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]}


PROFILES = [
    {
        "id": "winter",
        "name": "Winter Home",
        "conditions": [
            {"condition": "state", "entity_id": "input_select.house_mode", "state": "Home"}
        ],
        "days": week(box("07:00", "heat", 68), box("22:00", "heat", 64)),
    },
    {
        "id": "away",
        "name": "Away",
        "conditions": [],
        "days": week(box("00:00", "heat", 58)),
    },
]


@pytest.fixture
async def ws(hass, hass_ws_client):
    """Connect before the clock is moved, so the login token is valid."""
    return await hass_ws_client(hass)


@pytest.fixture
async def setup(hass: HomeAssistant, ws, freezer: FrozenDateTimeFactory):
    await hass.config.async_set_time_zone("UTC")
    freezer.move_to(datetime(2026, 11, 23, 9, 0, tzinfo=dt_util.UTC))  # Monday 09:00
    config_dir = Path(hass.config.config_dir)
    (config_dir / "configuration.yaml").write_text("automation: !include automations.yaml\n")
    (config_dir / "automations.yaml").write_text(yaml.safe_dump([USER_AUTOMATION]))

    hass.states.async_set(
        "climate.living_room",
        "heat",
        {"friendly_name": "Living Room", "temperature": 70, "hvac_modes": ["off", "heat", "cool"]},
    )
    assert await async_setup_component(hass, "input_select", {
        "input_select": {"house_mode": {"options": ["Home", "Away"], "initial": "Home"}}
    })
    assert await async_setup_component(hass, "automation", {"automation": [USER_AUTOMATION]})

    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    yield entry
    # Stop the generated automations' time triggers before the test ends.
    await hass.services.async_call("automation", "turn_off", {"entity_id": "all"}, blocking=True)
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()


async def _save(hass, client, profiles):
    await client.send_json_auto_id(
        {"type": f"{DOMAIN}/save", "entity_id": "climate.living_room", "profiles": profiles}
    )
    msg = await client.receive_json()
    await hass.async_block_till_done()
    return msg, client


async def test_save_creates_automations(hass, ws, setup):
    set_temp = async_mock_service(hass, "climate", "set_temperature")
    msg, client = await _save(hass, ws, PROFILES)
    assert msg["success"], msg
    assert msg["result"]["warnings"] == []
    assert len(msg["result"]["automations"]) == 2

    written = yaml.safe_load((Path(hass.config.config_dir) / "automations.yaml").read_text())
    assert [a["id"] for a in written] == [
        "mine",
        "comfort_schedule__living_room__winter",
        "comfort_schedule__living_room__away",
    ]

    sensor = msg["result"]["sensor"]
    assert hass.states.get(sensor).state == "Winter Home"
    for entity in msg["result"]["automations"]:
        assert hass.states.get(entity).state == "on"

    # get returns what was saved
    await client.send_json_auto_id({"type": f"{DOMAIN}/get"})
    got = (await client.receive_json())["result"]["thermostats"]["climate.living_room"]
    assert got["active"] == "Winter Home"
    assert [p["name"] for p in got["profiles"]] == ["Winter Home", "Away"]

    # The first save makes Winter Home active, which applies the 07:00 box now.
    assert set_temp and set_temp[-1].data["temperature"] == 68
    assert set_temp[-1].data["hvac_mode"] == "heat"


async def test_profile_change_applies_current_box(hass, ws, setup):
    msg, _ = await _save(hass, ws, PROFILES)
    set_temp = async_mock_service(hass, "climate", "set_temperature")

    await hass.services.async_call(
        "input_select", "select_option",
        {"entity_id": "input_select.house_mode", "option": "Away"}, blocking=True,
    )
    await hass.async_block_till_done()
    assert hass.states.get(msg["result"]["sensor"]).state == "Away"
    assert len(set_temp) == 1 and set_temp[0].data["temperature"] == 58


async def test_box_time_fires(hass, ws, setup, freezer):
    await _save(hass, ws, PROFILES)
    set_temp = async_mock_service(hass, "climate", "set_temperature")
    freezer.move_to(datetime(2026, 11, 23, 22, 0, 0, tzinfo=dt_util.UTC))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert [c.data["temperature"] for c in set_temp] == [64]


async def test_off_box_and_invalid_input(hass, ws, setup, freezer):
    set_mode = async_mock_service(hass, "climate", "set_hvac_mode")
    async_mock_service(hass, "climate", "set_temperature")
    profiles = [{"id": "p", "name": "Only", "conditions": [], "days": week(box("08:00", "off"))}]
    msg, _ = await _save(hass, ws, profiles)
    assert msg["success"]
    assert set_mode[-1].data["hvac_mode"] == "off"

    bad = [{"id": "p", "name": "Only", "conditions": [{"condition": "nope"}], "days": week()}]
    msg, _ = await _save(hass, ws, bad)
    assert not msg["success"] and "invalid" in msg["error"]["message"]


async def test_remove(hass, ws, setup):
    msg, client = await _save(hass, ws, PROFILES)
    await client.send_json_auto_id({"type": f"{DOMAIN}/remove", "entity_id": "climate.living_room"})
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    written = yaml.safe_load((Path(hass.config.config_dir) / "automations.yaml").read_text())
    assert [a["id"] for a in written] == ["mine"]
    assert hass.states.get(msg["result"]["sensor"]) is None
