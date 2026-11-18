"""Side-effect-free, presence-aware mapping of a single printer's reports.

This adapter intentionally does not instantiate pybambu: its models have defaults
which do not prove a field was reported. Field names and the traditional AMS
mask follow the pinned upstream pybambu/models.py. Only the fields below are
retained. No network, disk access, logging, or raw payload retention occurs.
"""
from copy import deepcopy
import math
import re


MAX_UNITS = 64
MAX_SLOTS_PER_UNIT = 16


def _field():
    return {"reported": False, "value": None}


def _set(field, value):
    field.update(reported=True, value=value)


def _number(value, low=None, high=None):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number) or (low is not None and number < low) or (high is not None and number > high):
        return None
    return int(number) if number.is_integer() else number


def _text(value, limit=256):
    return value[:limit] if isinstance(value, str) else None


def _raw(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return value[:128]
    return None


def _id(value, maximum=255):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        result = value
    elif isinstance(value, str) and re.fullmatch(r"[0-9]{1,3}", value):
        result = int(value)
    else:
        return None
    return str(result) if 0 <= result <= maximum else None


def _mask(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    text = str(value)
    if not re.fullmatch(r"[0-9a-fA-F]{1,128}", text):
        return None
    return text.lower()


def _color(value):
    return value.upper() if isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{8}", value) else None


def _hms(value):
    if not isinstance(value, list):
        return None
    result = []
    for item in value[:100]:
        if isinstance(item, dict):
            result.append({key: _raw(item[key]) for key in ("code", "attr", "module") if key in item})
    return result


def filter_delta(report, secrets=()):
    """Return only reviewed fields from *this* report, never accumulated values.

    Invalid fields are omitted, explicit None is retained, and unsafe strings
    are dropped rather than replaced with a misleading value. Oversized arrays
    raise ValueError so the caller can signal an unrecoverable sequence gap.
    """
    if not isinstance(report, dict):
        return {}
    secrets = tuple(s for s in secrets if isinstance(s, str) and s)
    unsafe = re.compile(r"[<>\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]")

    def clean(value, convert):
        if value is None:
            return True, None
        converted = convert(value)
        if converted is None:
            return False, None
        if isinstance(converted, str) and (unsafe.search(converted) or any(s in converted for s in secrets)):
            return False, None
        return True, converted

    result = {}
    for key, (_, convert) in _FIELDS.items():
        if key not in report:
            continue
        if key == "hms":
            value = report[key]
            if value is None:
                result[key] = None
            elif isinstance(value, list):
                if len(value) > 100:
                    raise ValueError("too many hms entries")
                entries = []
                for entry in value:
                    if not isinstance(entry, dict):
                        continue
                    safe = {}
                    for name in ("code", "attr", "module"):
                        if name in entry:
                            ok, item = clean(entry[name], _raw)
                            if ok:
                                safe[name] = item
                    if safe:
                        entries.append(safe)
                result[key] = entries
            continue
        ok, value = clean(report[key], convert)
        if ok:
            result[key] = value
    if "ams_status" in report:
        ok, value = clean(report["ams_status"], _raw)
        if ok:
            result["ams_status"] = value
    if "ams" in report:
        source = report["ams"]
        if source is None:
            result["ams"] = None
        elif isinstance(source, dict):
            ams = {}
            for key, convert in (("tray_now", _raw), ("tray_exist_bits", _mask)):
                if key in source:
                    ok, value = clean(source[key], convert)
                    if ok:
                        ams[key] = value
            if "ams" in source:
                units = source["ams"]
                if units is None:
                    ams["ams"] = None
                elif isinstance(units, list):
                    if len(units) > MAX_UNITS:
                        raise ValueError("too many ams units")
                    output = []
                    for unit in units:
                        if not isinstance(unit, dict) or _id(unit.get("id")) is None:
                            continue
                        item = {"id": _id(unit["id"])}
                        if "tray" in unit:
                            trays = unit["tray"]
                            if trays is None:
                                item["tray"] = None
                            elif isinstance(trays, list):
                                if len(trays) > MAX_SLOTS_PER_UNIT:
                                    raise ValueError("too many ams slots")
                                slots = []
                                for tray in trays:
                                    if not isinstance(tray, dict) or _id(tray.get("id")) is None:
                                        continue
                                    slot = {"id": _id(tray["id"])}
                                    for key, (_, convert) in _SLOT_FIELDS.items():
                                        if key in tray:
                                            if key == "remain":
                                                convert = lambda v: _number(v, -1, 100)
                                            ok, value = clean(tray[key], convert)
                                            if ok:
                                                slot[key] = value
                                    slots.append(slot)
                                item["tray"] = slots
                        output.append(item)
                    ams["ams"] = output
            if ams:
                result["ams"] = ams
    return result


# Raw names are the protocol names used by the pinned upstream models.
_FIELDS = {
    "gcode_state": ("activity", _raw),
    "mc_percent": ("progress", lambda v: _number(v, 0, 100)),
    "mc_remaining_time": ("remainingMinutes", lambda v: _number(v, 0)),
    "subtask_name": ("taskName", _text),
    "task_id": ("taskId", _raw),
    "nozzle_temper": ("nozzleCurrent", _number),
    "nozzle_target_temper": ("nozzleTarget", _number),
    "bed_temper": ("bedCurrent", _number),
    "bed_target_temper": ("bedTarget", _number),
    "layer_num": ("layer", lambda v: _number(v, 0)),
    "total_layer_num": ("totalLayers", lambda v: _number(v, 0)),
    "print_error": ("printError", _raw),
    "mc_print_error_code": ("printErrorCode", _raw),
    "hms": ("hms", _hms),
}
REPORT_FIELDS = frozenset(_FIELDS) | {"ams", "ams_status"}
_SLOT_FIELDS = {
    "tray_color": ("color", _color),
    "tray_type": ("material", _text),
    "remain": ("remaining", lambda v: _number(v, 0, 100)),
    "state": ("rawState", _raw),
}
_TASK_FIELDS = ("taskName", "taskId", "progress", "remainingMinutes", "layer", "totalLayers")


def _slot(slot_id):
    return {"id": slot_id, "exists": _field(), **{name: _field() for name, _ in _SLOT_FIELDS.values()}}


def _unit(unit_id):
    return {"id": unit_id, "slots": {"reported": False, "value": {}}}


def _task_id(value):
    value = _raw(value)
    return None if value in (None, "", "0", 0) else str(value)


class PrinterStateMapper:
    """One selected device, with caller-supplied device identity on each update.

    select_device(id) resets state and returns a new generation every call.
    update(id, generation, report) rejects stale devices or generations.
    snapshot() returns a detached JSON-compatible object. Every leaf is a
    {reported, value} pair; invalid supplied values are reported with null value.
    """

    def __init__(self):
        self._device = None
        self._generation = 0
        self._reset()

    def _reset(self):
        self._fields = {name: _field() for name, _ in _FIELDS.values()}
        self._ams = {"reported": False, "units": {"reported": False, "value": {}},
                     "trayNow": _field(), "status": _field(), "existBits": _field()}

    def select_device(self, device_id):
        if device_id is not None and (not isinstance(device_id, str) or not device_id or len(device_id) > 128):
            raise ValueError("invalid device id")
        self._device = device_id
        self._generation += 1
        self._reset()
        return self._generation

    def _presence(self, unit, slot):
        bits_field = self._ams["existBits"]
        if not bits_field["reported"]:
            return
        mask = bits_field["value"]
        index, position = int(unit["id"]), int(slot["id"])
        exists = None if mask is None or index >= 128 or position >= 4 else bool((int(mask, 16) >> (index * 4 + position)) & 1)
        previous = slot["exists"]["value"]
        if exists is False or (previous is False and exists is True):
            for name, _ in _SLOT_FIELDS.values():
                slot[name] = _field()
        _set(slot["exists"], exists)

    def _update_ams(self, report):
        self._ams["reported"] = True
        if report is None:
            self._ams = {"reported": True, "units": {"reported": True, "value": None},
                         "trayNow": _field(), "status": self._ams["status"], "existBits": _field()}
            return
        if not isinstance(report, dict):
            return
        if "tray_now" in report:
            _set(self._ams["trayNow"], _raw(report["tray_now"]))
        if "tray_exist_bits" in report:
            _set(self._ams["existBits"], _mask(report["tray_exist_bits"]))
            units = self._ams["units"]["value"] or {}
            for unit in units.values():
                for slot in (unit["slots"]["value"] or {}).values():
                    self._presence(unit, slot)
        if "ams" not in report:
            return
        units_field = self._ams["units"]
        incoming = report["ams"]
        if incoming is None:
            _set(units_field, None)
            return
        if not isinstance(incoming, list):
            return
        if not incoming:
            _set(units_field, {})
            return
        valid = [(u, _id(u.get("id"))) for u in incoming[:128] if isinstance(u, dict)]
        valid = [(u, i) for u, i in valid if i is not None]
        if not valid:
            return
        if units_field["value"] is None:
            units_field["value"] = {}
        units_field["reported"] = True
        for raw_unit, unit_id in valid:
            if unit_id not in units_field["value"] and len(units_field["value"]) >= MAX_UNITS:
                continue
            unit = units_field["value"].setdefault(unit_id, _unit(unit_id))
            if "tray" not in raw_unit:
                continue
            slots, trays = unit["slots"], raw_unit["tray"]
            if trays is None:
                _set(slots, None)
                continue
            if not isinstance(trays, list):
                continue
            if not trays:
                _set(slots, {})
                continue
            valid_slots = [(t, _id(t.get("id"))) for t in trays[:64] if isinstance(t, dict)]
            valid_slots = [(t, i) for t, i in valid_slots if i is not None]
            if not valid_slots:
                continue
            if slots["value"] is None:
                slots["value"] = {}
            slots["reported"] = True
            for raw_slot, slot_id in valid_slots:
                slot = slots["value"].get(slot_id)
                if slot is None:
                    if len(slots["value"]) >= MAX_SLOTS_PER_UNIT:
                        continue
                    slot = _slot(slot_id)
                    self._presence(unit, slot)
                    slots["value"][slot_id] = slot
                if slot["exists"]["value"] is False:
                    continue
                for key, (name, converter) in _SLOT_FIELDS.items():
                    if key in raw_slot:
                        _set(slot[name], converter(raw_slot[key]))

    def update(self, device_id, generation, report):
        if (self._device is None or device_id != self._device or type(generation) is not int
                or generation != self._generation or not isinstance(report, dict)):
            return False
        old_id = _task_id(self._fields["taskId"]["value"])
        new_id = _task_id(report.get("task_id")) if "task_id" in report else None
        old_name = self._fields["taskName"]["value"]
        new_name = _text(report.get("subtask_name")) if "subtask_name" in report else None
        switched = (new_id is not None and old_id is not None and new_id != str(old_id))
        if not (new_id is not None and old_id is not None):
            switched = bool(old_name and new_name and old_name != new_name)
        if switched:
            for name in _TASK_FIELDS:
                self._fields[name] = _field()
        for key, (name, converter) in _FIELDS.items():
            if key in report:
                _set(self._fields[name], converter(report[key]))
        if "ams" in report:
            self._update_ams(report["ams"])
        if "ams_status" in report:
            self._ams["reported"] = True
            _set(self._ams["status"], _raw(report["ams_status"]))
        return True

    def snapshot(self):
        ams = deepcopy(self._ams)
        units = ams["units"]["value"]
        if units is not None:
            for unit in units.values():
                slots = unit["slots"]["value"]
                if slots is not None:
                    unit["slots"]["value"] = list(slots.values())
            ams["units"]["value"] = list(units.values())
        return {"deviceId": self._device, "generation": self._generation, "fields": deepcopy(self._fields), "ams": ams}
