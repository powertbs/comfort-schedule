"""One sensor per scheduled thermostat showing the profile that is active now.

The generated automations trigger on this sensor changing, which is how a schedule
takes over right away when, for example, the house switches from Away to Home.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .const import DOMAIN, NO_PROFILE
from .manager import (
    SIGNAL_PROFILE_CHANGED,
    SIGNAL_THERMOSTAT_ADDED,
    ComfortManager,
    sensor_unique_id,
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    manager: ComfortManager = entry.runtime_data
    added: set[str] = set()

    @callback
    def _add(entity_id: str) -> None:
        if entity_id in added:
            return
        added.add(entity_id)
        manager.sensor_entity_id(entity_id)  # make sure the registry entry exists
        async_add_entities([ComfortProfileSensor(manager, entity_id)])

    for entity_id in list(manager.thermostats):
        _add(entity_id)
    entry.async_on_unload(async_dispatcher_connect(hass, SIGNAL_THERMOSTAT_ADDED, _add))


class ComfortProfileSensor(SensorEntity, RestoreEntity):
    _attr_should_poll = False
    _attr_icon = "mdi:home-thermometer-outline"

    def __init__(self, manager: ComfortManager, thermostat: str) -> None:
        self._manager = manager
        self._thermostat = thermostat
        self._attr_unique_id = sensor_unique_id(thermostat)
        self._attr_name = f"{manager.thermostat_name(thermostat)} comfort profile"
        self._restored: str | None = None

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        # Restore the last profile so a restart does not look like a profile change
        # (that would re-apply the schedule over a manual setpoint).
        last = await self.async_get_last_state()
        if last and last.state not in ("unknown", "unavailable"):
            self._restored = last.state
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_PROFILE_CHANGED, self._changed)
        )

    @callback
    def _changed(self, thermostat: str) -> None:
        if thermostat == self._thermostat:
            self._restored = None
            self.async_write_ha_state()

    @property
    def native_value(self) -> str:
        if self._thermostat not in self._manager.active and self._restored:
            return self._restored
        return self._manager.active_name(self._thermostat)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        profile = self._manager.active.get(self._thermostat)
        profiles = self._manager.thermostats.get(self._thermostat, {}).get("profiles", [])
        return {
            "thermostat": self._thermostat,
            "profile_id": profile["id"] if profile else None,
            "profiles": [p["name"] for p in profiles if p.get("enabled", True)],
        }
