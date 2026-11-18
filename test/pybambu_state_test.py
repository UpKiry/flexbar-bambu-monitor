import unittest
from unittest.mock import patch

from scripts.pybambu_state import PrinterStateMapper


def field(value, reported=True):
    return {"reported": reported, "value": value}


def slot(snapshot, unit_id="0", slot_id="0"):
    units = snapshot["ams"]["units"]["value"]
    unit = next(item for item in units if item["id"] == unit_id)
    return next(item for item in unit["slots"]["value"] if item["id"] == slot_id)


class StateMappingTest(unittest.TestCase):
    def setUp(self):
        self.mapper = PrinterStateMapper()
        self.generation = self.mapper.select_device("printer-a")

    def send(self, data):
        self.assertTrue(self.mapper.update("printer-a", self.generation, data))
        return self.mapper.snapshot()

    def test_presence_null_zero_and_safe_whitelist(self):
        initial = self.mapper.snapshot()
        self.assertEqual(initial["fields"]["nozzleCurrent"], field(None, False))
        self.assertFalse(initial["ams"]["reported"])
        result = self.send({"nozzle_temper": 0, "bed_temper": None, "mc_percent": 0,
                            "layer_num": "0", "task_id": 0,
                            "access_token": "FAKE_SECRET", "password": "FAKE_PASSWORD"})
        fields = result["fields"]
        self.assertEqual(fields["nozzleCurrent"], field(0))
        self.assertEqual(fields["bedCurrent"], field(None))
        self.assertEqual(fields["progress"], field(0))
        self.assertEqual(fields["layer"], field(0))
        self.assertEqual(fields["taskId"], field(0))
        self.assertEqual(fields["bedTarget"], field(None, False))
        self.assertNotIn("FAKE_SECRET", repr(result))
        self.assertNotIn("FAKE_PASSWORD", repr(result))

    def test_ams_incremental_presence_and_reinsertion(self):
        first = self.send({"ams": {"tray_exist_bits": "3", "tray_now": "1", "ams": [{"id": "0", "tray": [
            {"id": "0", "tray_color": "ff0011ff", "tray_type": "PLA", "remain": 0, "state": 0},
            {"id": "1", "tray_color": "00ff00ff", "tray_type": "PETG", "remain": 50},
        ]}]}})
        self.assertEqual(slot(first)["exists"], field(True))
        self.assertEqual(slot(first)["color"], field("FF0011FF"))
        self.assertEqual(slot(first)["remaining"], field(0))
        self.assertEqual(slot(first)["rawState"], field(0))
        updated = self.send({"ams": {"ams": [{"id": 0, "tray": [{"id": 1, "remain": None}]}]}})
        self.assertEqual(slot(updated)["material"], field("PLA"))
        self.assertEqual(slot(updated, slot_id="1")["remaining"], field(None))
        absent = self.send({"ams": {"tray_exist_bits": "2"}})
        self.assertEqual(slot(absent)["exists"], field(False))
        self.assertEqual(slot(absent)["material"], field(None, False))
        self.send({"ams": {"ams": [{"id": "0", "tray": [{"id": "0", "tray_type": "OLD"}]}]}})
        inserted = self.send({"ams": {"tray_exist_bits": "3"}})
        self.assertEqual(slot(inserted)["exists"], field(True))
        self.assertEqual(slot(inserted)["material"], field(None, False))
        inserted = self.send({"ams": {"ams": [{"id": "0", "tray": [{"id": "0", "tray_type": "ABS"}]}]}})
        self.assertEqual(slot(inserted)["material"], field("ABS"))
        self.assertEqual(slot(first)["material"], field("PLA"))

    def test_mask_before_slot_high_unit_and_explicit_null(self):
        self.send({"ams": {"tray_exist_bits": "10"}})
        result = self.send({"ams": {"ams": [{"id": "1", "tray": [{"id": "0", "remain": -1}]},
                                             {"id": "128", "tray": [{"id": "0"}]}]}})
        self.assertEqual(slot(result, "1")["exists"], field(True))
        self.assertEqual(slot(result, "1")["remaining"], field(None))
        self.assertEqual(slot(result, "128")["exists"], field(None))
        cleared = self.send({"ams": {"tray_exist_bits": None}})
        self.assertEqual(slot(cleared, "1")["exists"], field(None))
        self.assertEqual(cleared["ams"]["existBits"], field(None))

    def test_empty_null_and_invalid_arrays_are_distinct(self):
        self.send({"ams": {"ams": [{"id": "0", "tray": [{"id": "0", "tray_type": "PLA"}]}]}})
        ignored = self.send({"ams": {"ams": [{"id": "oops"}]}})
        self.assertEqual(slot(ignored)["material"], field("PLA"))
        result = self.send({"ams": {"ams": [{"id": 0, "tray": None}]}})
        self.assertEqual(result["ams"]["units"]["value"][0]["slots"], field(None))
        self.send({"ams": {"ams": [{"id": 0, "tray": []}]}})
        result = self.mapper.snapshot()
        self.assertEqual(result["ams"]["units"]["value"][0]["slots"], field([]))
        self.assertEqual(self.send({"ams": {"ams": None}})["ams"]["units"], field(None))
        self.assertEqual(self.send({"ams": {"ams": []}})["ams"]["units"], field([]))

    def test_task_switch_id_name_and_independent_errors(self):
        self.send({"task_id": "10", "subtask_name": "same", "mc_percent": 70,
                   "layer_num": 4, "print_error": 123, "mc_print_error_code": 9})
        result = self.send({"task_id": "11", "subtask_name": "same", "mc_print_error_code": 0})
        self.assertEqual(result["fields"]["progress"], field(None, False))
        self.assertEqual(result["fields"]["layer"], field(None, False))
        self.assertEqual(result["fields"]["taskName"], field("same"))
        self.assertEqual(result["fields"]["printError"], field(123))
        self.assertEqual(result["fields"]["printErrorCode"], field(0))
        result = self.send({"task_id": None, "subtask_name": "other", "hms": [{"code": 1, "attr": 0, "password": "FAKE"}]})
        self.assertEqual(result["fields"]["taskId"], field(None))
        self.assertEqual(result["fields"]["hms"], field([{"code": 1, "attr": 0}]))
        self.assertNotIn("FAKE", repr(result))

    def test_device_isolation_and_detached_snapshots(self):
        self.send({"subtask_name": "a", "nozzle_temper": 0})
        self.mapper.select_device("printer-b")
        self.assertFalse(self.mapper.update("printer-a", self.generation, {"subtask_name": "old"}))
        snapshot = self.mapper.snapshot()
        self.assertEqual(snapshot["fields"]["taskName"], field(None, False))
        snapshot["fields"]["taskName"]["value"] = "mutated"
        self.assertEqual(self.mapper.snapshot()["fields"]["taskName"], field(None, False))
        next_generation = self.mapper.select_device("printer-a")
        self.assertNotEqual(next_generation, self.generation)
        self.assertFalse(self.mapper.update("printer-a", self.generation, {"subtask_name": "late"}))
        self.assertTrue(self.mapper.update("printer-a", next_generation, {"subtask_name": "new"}))
        self.mapper.select_device(None)
        self.assertFalse(self.mapper.update(None, next_generation, {}))

    def test_accumulated_units_and_slots_are_bounded(self):
        trays = [{"id": i, "tray_type": "PLA"} for i in range(32)]
        self.send({"ams": {"ams": [{"id": i, "tray": trays} for i in range(80)]}})
        units = self.mapper.snapshot()["ams"]["units"]["value"]
        self.assertEqual(len(units), 64)
        self.assertTrue(all(len(unit["slots"]["value"]) == 16 for unit in units))
        self.send({"ams": {"ams": [{"id": 0, "tray": [{"id": 0, "tray_type": "PETG"}]}]}})
        self.assertEqual(slot(self.mapper.snapshot())["material"], field("PETG"))

    def test_no_io_or_logging_on_mapping(self):
        with patch("builtins.open", side_effect=AssertionError("unexpected file access")), \
             patch("socket.socket", side_effect=AssertionError("unexpected socket")), \
             patch("logging.Logger._log", side_effect=AssertionError("unexpected logging")):
            self.send({"ams": {"ams": [{"id": 0, "tray": [{"id": 0, "tray_type": "PLA"}]}]}, "mc_percent": 0})


if __name__ == "__main__":
    unittest.main()
