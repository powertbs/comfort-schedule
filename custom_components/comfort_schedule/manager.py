"""Stores schedules, works out each thermostat's active profile, and writes the
automations that carry the schedule out."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import timedelta
import logging
import os
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import CoreState, Event, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import condition as condition_helper
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.helpers.storage import Store
from homeassistant.util.file import write_utf8_file_atomic
from homeassistant.util.yaml import dump, load_yaml

from . import automations as builder
from .const import DOMAIN, NO_PROFILE, REEVALUATE_SECONDS, STORAGE_KEY, STORAGE_VERSION

_LOGGER = logging.getLogger(__name__)

SIGNAL_PROFILE_CHANGED = f"{DOMAIN}_profile_changed"
SIGNAL_THERMOSTAT_ADDED = f"{DOMAIN}_thermostat_added"

AUTOMATIONS_FILE = "automations.yaml"


def sensor_unique_id(entity_id: str) -> str:
    return f"{DOMAIN}_profile_{entity_id}"


class _Compiled:
    """Profile checkers for one thermostat, in priority order."""

    def __init__(self) -> None:
        self.checkers: list[tuple[dict[str, Any], Callable[..., Any] | None]] = []
        self.entities: set[str] = set()


class ComfortManager:
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.data: dict[str, Any] = {"thermostats": {}}
        self.active: dict[str, dict[str, Any] | None] = {}
        self._compiled: dict[str, _Compiled] = {}
        self._unsub_state: Callable[[], None] | None = None
        self._unsub_interval: Callable[[], None] | None = None
        self._write_lock = asyncio.Lock()

    # ----- lifecycle -------------------------------------------------------

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        if stored and isinstance(stored.get("thermostats"), dict):
            self.data = stored

    async def async_start(self) -> None:
        """Compile conditions once Home Assistant is running, so device and
        template conditions can resolve."""

        async def _start(_event: Event | None = None) -> None:
            for entity_id in list(self.thermostats):
                await self._async_compile(entity_id)
            self._resubscribe()
            self._unsub_interval = async_track_time_interval(
                self.hass, self._interval, timedelta(seconds=REEVALUATE_SECONDS)
            )
            self.evaluate_all()

        if self.hass.state is CoreState.running:
            await _start()
        else:
            self.entry.async_on_unload(
                self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _start)
            )

    @callback
    def async_stop(self) -> None:
        if self._unsub_state:
            self._unsub_state()
            self._unsub_state = None
        if self._unsub_interval:
            self._unsub_interval()
            self._unsub_interval = None
        for compiled in self._compiled.values():
            _unload(compiled)
        self._compiled.clear()

    @property
    def thermostats(self) -> dict[str, Any]:
        return self.data["thermostats"]

    # ----- profile evaluation ---------------------------------------------

    async def _async_compile(self, entity_id: str) -> None:
        _unload(self._compiled.pop(entity_id, None))
        compiled = _Compiled()
        for profile in self.thermostats.get(entity_id, {}).get("profiles", []):
            if not profile.get("enabled", True):
                continue
            conditions = profile.get("conditions") or []
            if not conditions:
                compiled.checkers.append((profile, None))
                continue
            try:
                validated = await _validate_conditions(self.hass, conditions)
                checker = await condition_helper.async_conditions_from_config(
                    self.hass, validated, _LOGGER, f"Comfort Schedule {profile['name']}"
                )
                for cond in validated:
                    compiled.entities |= condition_helper.async_extract_entities(cond)
            except Exception as err:  # noqa: BLE001 - one bad profile must not break the rest
                _LOGGER.warning(
                    "Conditions of %s / %s are invalid, the profile is skipped: %s",
                    entity_id,
                    profile.get("name"),
                    err,
                )
                continue
            compiled.checkers.append((profile, checker))
        self._compiled[entity_id] = compiled

    @callback
    def _resubscribe(self) -> None:
        if self._unsub_state:
            self._unsub_state()
            self._unsub_state = None
        entities: set[str] = set()
        for compiled in self._compiled.values():
            entities |= compiled.entities
        if entities:
            self._unsub_state = async_track_state_change_event(
                self.hass, sorted(entities), self._state_changed
            )

    @callback
    def _state_changed(self, event: Event) -> None:
        changed = event.data.get("entity_id")
        for entity_id, compiled in self._compiled.items():
            if changed in compiled.entities:
                self.evaluate(entity_id)

    @callback
    def _interval(self, _now: Any) -> None:
        self.evaluate_all()

    @callback
    def evaluate_all(self) -> None:
        for entity_id in list(self._compiled):
            self.evaluate(entity_id)

    @callback
    def evaluate(self, entity_id: str) -> None:
        compiled = self._compiled.get(entity_id)
        winner: dict[str, Any] | None = None
        if compiled:
            for profile, checker in compiled.checkers:
                if checker is None:
                    winner = profile
                    break
                try:
                    if _check(self.hass, checker):
                        winner = profile
                        break
                except Exception as err:  # noqa: BLE001
                    _LOGGER.debug("Condition check failed for %s: %s", profile.get("name"), err)
        first = entity_id not in self.active
        previous = self.active.get(entity_id) or {}
        current = winner or {}
        if first or (previous.get("id"), previous.get("name")) != (
            current.get("id"),
            current.get("name"),
        ):
            self.active[entity_id] = winner
            async_dispatcher_send(self.hass, SIGNAL_PROFILE_CHANGED, entity_id)

    def active_name(self, entity_id: str) -> str:
        profile = self.active.get(entity_id)
        return profile["name"] if profile else NO_PROFILE

    # ----- saving ---------------------------------------------------------

    def sensor_entity_id(self, entity_id: str) -> str:
        """Create (or find) the registry entry of the thermostat's profile sensor so
        its entity id is known before the automations are written."""
        registry = er.async_get(self.hass)
        entry = registry.async_get_or_create(
            "sensor",
            DOMAIN,
            sensor_unique_id(entity_id),
            suggested_object_id=f"{builder.object_id(entity_id)}_comfort_profile",
            config_entry=self.entry,
        )
        return entry.entity_id

    def thermostat_name(self, entity_id: str) -> str:
        state = self.hass.states.get(entity_id)
        if state and state.attributes.get("friendly_name"):
            return str(state.attributes["friendly_name"])
        return builder.object_id(entity_id).replace("_", " ").title()

    async def async_save(self, entity_id: str, raw_profiles: Any) -> dict[str, Any]:
        if not entity_id.startswith("climate."):
            raise HomeAssistantError("Only climate entities can be scheduled")
        try:
            profiles = builder.clean_profiles(raw_profiles)
        except builder.ScheduleError as err:
            raise HomeAssistantError(str(err)) from err

        for profile in profiles:
            if profile["conditions"]:
                try:
                    await _validate_conditions(self.hass, profile["conditions"])
                except Exception as err:  # noqa: BLE001
                    raise HomeAssistantError(
                        f"Conditions of '{profile['name']}' are invalid: {err}"
                    ) from err

        is_new = entity_id not in self.thermostats
        self.thermostats[entity_id] = {"profiles": profiles}
        await self._store.async_save(self.data)

        sensor_id = self.sensor_entity_id(entity_id)
        if is_new:
            async_dispatcher_send(self.hass, SIGNAL_THERMOSTAT_ADDED, entity_id)

        generated = builder.build_automations(
            entity_id, self.thermostat_name(entity_id), profiles, sensor_id
        )
        await self._async_write_automations(entity_id, generated)

        await self._async_compile(entity_id)
        self._resubscribe()
        self.evaluate(entity_id)

        return {
            "sensor": sensor_id,
            "automations": self.automation_entities(entity_id, generated),
            "warnings": self._missing_warning(generated),
        }

    async def async_remove(self, entity_id: str) -> None:
        if entity_id not in self.thermostats:
            return
        del self.thermostats[entity_id]
        await self._store.async_save(self.data)
        await self._async_write_automations(entity_id, [])
        _unload(self._compiled.pop(entity_id, None))
        self.active.pop(entity_id, None)
        self._resubscribe()
        registry = er.async_get(self.hass)
        sensor = registry.async_get_entity_id("sensor", DOMAIN, sensor_unique_id(entity_id))
        if sensor:
            registry.async_remove(sensor)

    async def _async_write_automations(
        self, entity_id: str, generated: list[dict[str, Any]]
    ) -> None:
        path = self.hass.config.path(AUTOMATIONS_FILE)

        def _write() -> None:
            current: Any = []
            if os.path.exists(path):
                current = load_yaml(path) or []
            if not isinstance(current, list):
                raise HomeAssistantError(
                    f"{AUTOMATIONS_FILE} is not a list of automations, Comfort Schedule cannot add to it"
                )
            write_utf8_file_atomic(path, dump(builder.merge_into(current, entity_id, generated)))

        async with self._write_lock:
            await self.hass.async_add_executor_job(_write)
            await self.hass.services.async_call("automation", "reload", blocking=True)

    def automation_entities(
        self, entity_id: str, generated: list[dict[str, Any]] | None = None
    ) -> list[str]:
        registry = er.async_get(self.hass)
        if generated is None:
            ids = [
                builder.automation_id(entity_id, p["id"])
                for p in self.thermostats.get(entity_id, {}).get("profiles", [])
            ]
        else:
            ids = [a["id"] for a in generated]
        found = []
        for automation_id in ids:
            entity = registry.async_get_entity_id("automation", "automation", automation_id)
            if entity:
                found.append(entity)
        return found

    def _missing_warning(self, generated: list[dict[str, Any]]) -> list[str]:
        registry = er.async_get(self.hass)
        missing = [
            a["alias"]
            for a in generated
            if not registry.async_get_entity_id("automation", "automation", a["id"])
        ]
        if not missing:
            return []
        return [
            "The automations were written to automations.yaml but Home Assistant did not load "
            "them. Check that configuration.yaml contains `automation: !include automations.yaml` "
            "and look at the log for errors. Missing: " + ", ".join(missing)
        ]

    def as_dict(self) -> dict[str, Any]:
        registry = er.async_get(self.hass)
        out = {}
        for entity_id, item in self.thermostats.items():
            out[entity_id] = {
                "profiles": item.get("profiles", []),
                "sensor": registry.async_get_entity_id(
                    "sensor", DOMAIN, sensor_unique_id(entity_id)
                ),
                "active": self.active_name(entity_id),
                "automations": self.automation_entities(entity_id),
            }
        return out


async def _validate_conditions(hass: HomeAssistant, conditions: list[Any]) -> list[Any]:
    schema_checked = cv.CONDITIONS_SCHEMA(conditions)
    return await condition_helper.async_validate_conditions_config(hass, schema_checked)


def _check(hass: HomeAssistant, checker: Any) -> bool:
    """Run a conditions checker. Home Assistant 2025.x returned a plain function
    taking (hass, variables); newer versions return an object with async_check."""
    if hasattr(checker, "async_check"):
        return bool(checker.async_check(variables={}))
    return bool(checker(hass, {}))


def _unload(compiled: _Compiled | None) -> None:
    if compiled is None:
        return
    for _profile, checker in compiled.checkers:
        unload = getattr(checker, "async_unload", None)
        if unload:
            try:
                unload()
            except Exception:  # noqa: BLE001
                _LOGGER.debug("Unloading a condition checker failed", exc_info=True)
