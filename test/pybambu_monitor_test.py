"""Offline tests for the experimental passive cloud monitor."""
import builtins
import importlib.util
import os
import socket
import threading
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "pybambu_monitor.py"
spec = importlib.util.spec_from_file_location("pybambu_monitor", SCRIPT)
monitor_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor_module)


class FakeMqtt:
    def __init__(self):
        self.calls = []

    def tls_set(self):
        self.calls.append(("tls_set",))

    def username_pw_set(self, username, password):
        self.calls.append(("credentials", username, password))

    def connect_async(self, host, port, keepalive):
        self.calls.append(("connect", host, port, keepalive))

    def loop_start(self):
        self.calls.append(("loop_start",))

    def disconnect(self):
        self.calls.append(("disconnect",))

    def loop_stop(self):
        self.calls.append(("loop_stop",))

    def subscribe(self, topic, qos):
        self.calls.append(("subscribe", topic, qos))
        return (0, 1)

    def publish(self, *args, **kwargs):
        raise AssertionError("publishing is forbidden")


class PassiveMonitorTest(unittest.TestCase):
    def setUp(self):
        self.clients = []
        def factory():
            client = FakeMqtt()
            self.clients.append(client)
            return client
        self.monitor = monitor_module.Monitor(mqtt_factory=factory, clock=lambda: 123.0)
        self.params = {"region": "China", "deviceId": "SYNTHETIC-1", "username": "u_fake", "token": "fake-secret"}
        self.addCleanup(self.monitor.stop)

    def message(self, client, data, topic="device/SYNTHETIC-1/report"):
        payload = data if isinstance(data, bytes) else json.dumps(data).encode()
        client.on_message(client, None, SimpleNamespace(topic=topic, payload=payload))

    def test_real_model_passive_reports_and_no_side_effects(self):
        # Use the real pinned upstream model but intercept its hazardous entry points.
        import_path = Path(__file__).resolve().parents[1] / "vendor/ha-bambulab/custom_components/bambu_lab"
        sys.path.insert(0, str(import_path))
        from pybambu import BambuClient
        from pybambu.models import PrintJob
        forbidden = AssertionError("unexpected upstream side effect")
        with patch.object(BambuClient, "connect", side_effect=forbidden), \
             patch.object(BambuClient, "on_message", side_effect=forbidden), \
             patch.object(PrintJob, "_update_task_data", side_effect=forbidden), \
             patch.object(PrintJob, "_download_timelapse", side_effect=forbidden):
            self.monitor.start(self.params)
            client = self.clients[-1]
            client.on_connect(client, None, {}, 0)
            self.assertEqual(self.monitor.snapshot()["connection"], "subscribing")
            client.on_subscribe(client, None, 1, (0,))
            self.message(client, {"print": {"mc_percent": 0, "bed_temper": 52.3, "gcode_state": "RUNNING", "subtask_name": "ignored", "token": "fake-secret"}})
            result = self.monitor.snapshot()
            self.assertEqual(result["connection"], "connected")
            self.assertEqual(result["state"]["mc_percent"], 0)
            self.assertEqual(result["state"]["bed_temper"], 52)
            self.assertIsNone(result["state"]["nozzle_temper"])
            self.assertEqual(result["lastReportAt"], 123.0)
            self.message(client, {"print": {"layer_num": 4}})
            self.message(client, b"invalid json")
            self.assertEqual(self.monitor.snapshot()["state"]["mc_percent"], 0)
            self.assertEqual(self.monitor.snapshot()["state"]["layer_num"], 4)
            self.assertNotIn("fake-secret", json.dumps(self.monitor.snapshot()))
            self.assertIn(("connect", "cn.mqtt.bambulab.com", 8883, 30), client.calls)
            self.assertIn(("subscribe", "device/SYNTHETIC-1/report", 0), client.calls)
            self.assertEqual([c[0] for c in client.calls].count("tls_set"), 1)

    def test_stale_callbacks_and_auth_refusal(self):
        self.monitor.start(self.params)
        old = self.clients[-1]
        self.monitor.start(self.params)
        current = self.clients[-1]
        old.on_connect(old, None, {}, 0)
        self.message(old, {"print": {"mc_percent": 99}})
        self.assertIsNone(self.monitor.snapshot()["state"]["mc_percent"])
        self.assertNotIn("subscribe", [call[0] for call in old.calls])
        current.on_connect(current, None, {}, 5)
        current.on_disconnect(current, None, 0)
        self.assertEqual(self.monitor.snapshot()["connection"], "auth_failed")
        self.monitor.stop()  # waits for callback cleanup
        self.assertIn(("disconnect",), current.calls)

    def test_subscription_failure_disconnect_and_stop(self):
        self.monitor.start(self.params)
        client = self.clients[-1]
        client.on_connect(client, None, {}, 0)
        client.on_subscribe(client, None, 999, (0,))
        self.assertEqual(self.monitor.snapshot()["connection"], "subscribing")
        client.on_subscribe(client, None, 1, (128,))
        self.assertEqual(self.monitor.snapshot()["connection"], "disconnected")
        self.monitor.start(self.params)
        client = self.clients[-1]
        client.on_connect(client, None, {}, 0)
        client.on_subscribe(client, None, 1, (0,))
        self.message(client, {"print": {"mc_percent": 20}})
        client.on_disconnect(client, None, 1)
        self.assertEqual(self.monitor.snapshot()["connection"], "disconnected")
        self.assertEqual(self.monitor.snapshot()["state"]["mc_percent"], 20)
        self.monitor.stop()
        self.assertEqual(self.monitor.snapshot()["connection"], "stopped")
        self.assertIsNone(self.monitor.snapshot()["state"]["mc_percent"])
        self.assertIn(("loop_stop",), client.calls)
        self.message(client, {"print": {"mc_percent": 99}})
        self.assertIsNone(self.monitor.snapshot()["state"]["mc_percent"])

    def test_validate_region_and_topic(self):
        for change in ({"region": "other"}, {"deviceId": "../+"}, {"token": ""}):
            with self.assertRaises(ValueError):
                self.monitor.start({**self.params, **change})
        self.monitor.start(self.params)
        client = self.clients[-1]
        self.message(client, {"print": {"mc_percent": 34}}, "device/other/report")
        self.assertIsNone(self.monitor.snapshot()["state"]["mc_percent"])

    def test_model_failure_reclaims_client_and_does_not_leak(self):
        self.monitor.start(self.params)
        client = self.clients[-1]
        client.on_connect(client, None, {}, 0)
        client.on_subscribe(client, None, 1, (0,))
        with patch.object(self.monitor.model, "get_device", side_effect=RuntimeError("fake-secret")):
            self.message(client, {"print": {"mc_percent": 42}})
        self.assertEqual(self.monitor.snapshot()["connection"], "model_error")
        self.assertNotIn("fake-secret", json.dumps(self.monitor.snapshot()))
        self.monitor.stop()
        self.assertIn(("disconnect",), client.calls)
        self.assertIn(("loop_stop",), client.calls)
        self.assertIsNone(self.monitor.client)
        self.assertFalse(self.monitor.cleanup_threads)

    def test_failed_disconnect_still_stops_network_loop(self):
        self.monitor.start(self.params)
        client = self.clients[-1]
        def fail_disconnect():
            raise RuntimeError("fake-secret")
        client.disconnect = fail_disconnect
        client.on_connect(client, None, {}, 0)
        client.on_subscribe(client, None, 1, (0,))
        with patch.object(self.monitor.model, "get_device", side_effect=RuntimeError("fake-secret")):
            self.message(client, {"print": {"mc_percent": 42}})
        self.monitor.stop()
        self.assertIn(("loop_stop",), client.calls)
        self.assertFalse(self.monitor.cleanup_threads)

    def test_stop_racing_with_inflight_model_callback_reclaims_connection(self):
        self.monitor.start(self.params)
        client = self.clients[-1]
        client.on_connect(client, None, {}, 0)
        client.on_subscribe(client, None, 1, (0,))
        entered, release = threading.Event(), threading.Event()
        model = self.monitor.model
        real_get = model.get_device
        def block_then_fail():
            entered.set()
            release.wait(2)
            raise RuntimeError("fake-secret")
        model.get_device = block_then_fail
        callback = threading.Thread(target=self.message, args=(client, {"print": {"mc_percent": 1}}))
        callback.start()
        self.assertTrue(entered.wait(2))
        stopper = threading.Thread(target=self.monitor.stop)
        stopper.start()
        release.set()
        callback.join(2)
        stopper.join(2)
        model.get_device = real_get
        self.assertFalse(callback.is_alive())
        self.assertFalse(stopper.is_alive())
        self.assertEqual(self.monitor.snapshot()["connection"], "stopped")
        self.assertIn(("loop_stop",), client.calls)
        self.assertNotIn("fake-secret", json.dumps(self.monitor.snapshot()))

    def test_suback_requires_exactly_one_qos_zero_grant(self):
        for grants in ((), (128,), (0, 0), (1,), (True,), None):
            self.monitor.start(self.params)
            client = self.clients[-1]
            client.on_connect(client, None, {}, 0)
            self.message(client, {"print": {"mc_percent": 1}})
            self.assertIsNone(self.monitor.snapshot()["lastReportAt"])
            client.on_subscribe(client, None, 1, grants)
            self.assertEqual(self.monitor.snapshot()["connection"], "disconnected")
            self.monitor.stop()
            self.assertIn(("loop_stop",), client.calls)

    def test_stop_waits_for_callback_cleanup_before_replacement(self):
        self.monitor.start(self.params)
        client = self.clients[-1]
        entered, release, stopped = threading.Event(), threading.Event(), threading.Event()
        def slow_stop():
            entered.set()
            release.wait(2)
            client.calls.append(("loop_stop",))
        client.loop_stop = slow_stop
        client.on_connect(client, None, {}, 0)
        client.on_subscribe(client, None, 1, (128,))
        self.assertTrue(entered.wait(2))
        waiter = threading.Thread(target=lambda: (self.monitor.stop(), stopped.set()))
        waiter.start()
        try:
            self.assertFalse(stopped.wait(0.05))
            self.message(client, {"print": {"mc_percent": 99}})
        finally:
            release.set()
            waiter.join(2)
        self.assertTrue(stopped.is_set())
        self.monitor.start(self.params)
        self.assertIsNot(client, self.clients[-1])
        self.assertIsNone(self.monitor.snapshot()["lastReportAt"])

    def test_initialization_and_selected_updates_do_not_use_io_or_media(self):
        # Import dependencies first; audit the real model's construction and
        # selected update separately from normal Python module loading.
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "vendor/ha-bambulab/custom_components/bambu_lab"))
        from pybambu import BambuClient
        from requests.sessions import Session
        original_open = builtins.open
        original_os_open = os.open
        def guarded_open(file, mode="r", *args, **kwargs):
            if any(flag in mode for flag in "wax+"):
                raise AssertionError("file write")
            return original_open(file, mode, *args, **kwargs)
        def guarded_os_open(file, flags, *args, **kwargs):
            if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                raise AssertionError("file write")
            return original_os_open(file, flags, *args, **kwargs)
        with patch("builtins.open", side_effect=guarded_open), \
             patch("os.open", side_effect=guarded_os_open), \
             patch("os.mkdir", side_effect=AssertionError("mkdir")), \
             patch("os.unlink", side_effect=AssertionError("unlink")), \
             patch("os.rename", side_effect=AssertionError("rename")), \
             patch("os.replace", side_effect=AssertionError("replace")), \
             patch.object(socket.socket, "connect", side_effect=AssertionError("socket connect")), \
             patch.object(Session, "request", side_effect=AssertionError("cloud request")), \
             patch.object(BambuClient, "probe_remote_media_sources", side_effect=AssertionError("media")), \
             patch.object(BambuClient, "publish", side_effect=AssertionError("publish")):
            self.monitor.start(self.params)
            client = self.clients[-1]
            client.on_connect(client, None, {}, 0)
            client.on_subscribe(client, None, 1, (0,))
            self.message(client, {"print": {key: 0 for key in monitor_module.FIELDS}})
            self.assertEqual(self.monitor.snapshot()["connection"], "connected")
            self.assertEqual(self.monitor.snapshot()["state"]["mc_percent"], 0)

    def test_mapped_incremental_reports_and_staleness(self):
        self.monitor.start(self.params)
        client = self.clients[-1]
        client.on_connect(client, None, {}, 0)
        client.on_subscribe(client, None, 1, (0,))
        initial = self.monitor.snapshot()
        self.assertEqual(initial["reportTimeUnit"], "unix_seconds")
        self.assertTrue(initial["stale"])
        self.assertFalse(initial["mapped"]["fields"]["progress"]["reported"])
        self.message(client, {"print": {"subtask_name": "demo", "print_error": 0,
                      "ams": {"tray_exist_bits": "1", "ams": [{"id": "0", "tray": [
                          {"id": "0", "tray_type": "PLA", "tray_color": "FF0000FF", "remain": 0}]}]}}})
        first = self.monitor.snapshot()
        self.assertFalse(first["stale"])
        self.assertEqual(first["lastReportAt"], 123.0)
        self.assertIsNone(first["state"]["mc_percent"])
        fields = first["mapped"]["fields"]
        self.assertEqual(fields["taskName"], {"reported": True, "value": "demo"})
        self.assertEqual(fields["printError"], {"reported": True, "value": 0})
        slot = first["mapped"]["ams"]["units"]["value"][0]["slots"]["value"][0]
        self.assertEqual(slot["remaining"], {"reported": True, "value": 0})
        self.assertEqual(slot["color"]["value"], "FF0000FF")
        self.message(client, {"print": {"mc_percent": 0, "ams": {"ams": [
            {"id": "0", "tray": [{"id": "0", "remain": 50}]}]}}})
        second = self.monitor.snapshot()
        self.assertEqual(second["state"]["mc_percent"], 0)
        self.assertEqual(second["mapped"]["fields"]["taskName"]["value"], "demo")
        slot = second["mapped"]["ams"]["units"]["value"][0]["slots"]["value"][0]
        self.assertEqual(slot["remaining"]["value"], 50)
        self.assertEqual(slot["color"]["value"], "FF0000FF")
        client.on_disconnect(client, None, 1)
        disconnected = self.monitor.snapshot()
        self.assertTrue(disconnected["stale"])
        self.assertEqual(disconnected["mapped"]["fields"]["taskName"]["value"], "demo")
        self.assertEqual(disconnected["generation"], first["generation"])
        client.on_connect(client, None, {}, 0)
        client.on_subscribe(client, None, 1, (0,))
        self.assertTrue(self.monitor.snapshot()["stale"])
        self.message(client, {"print": {"ams_status": 1}})
        self.assertTrue(self.monitor.snapshot()["stale"])
        self.assertTrue(self.monitor.snapshot()["currentConnectionHasReport"])
        self.monitor.stop()
        stopped = self.monitor.snapshot()
        self.assertTrue(stopped["stale"])
        self.assertFalse(stopped["mapped"]["fields"]["taskName"]["reported"])

    def test_mapped_stale_generation_and_sensitive_input(self):
        self.monitor.start(self.params)
        old = self.clients[-1]
        old.on_connect(old, None, {}, 0)
        old.on_subscribe(old, None, 1, (0,))
        old_generation = self.monitor.snapshot()["generation"]
        self.monitor.start(self.params)
        current = self.clients[-1]
        current.on_connect(current, None, {}, 0)
        current.on_subscribe(current, None, 1, (0,))
        self.message(old, {"print": {"subtask_name": "obsolete", "print_error": 123}})
        self.assertNotEqual(old_generation, self.monitor.snapshot()["generation"])
        self.assertFalse(self.monitor.snapshot()["mapped"]["fields"]["taskName"]["reported"])
        self.message(current, {"print": {"subtask_name": "prefix fake-secret u_fake suffix",
                    "print_error": "fake-secret", "unknown": {"token": "fake-secret"},
                    "ams": {"ams": [{"id": "0", "tray": [{"id": "0", "tray_type": "fake-secret"}]}]}}})
        rendered = json.dumps(self.monitor.snapshot())
        self.assertNotIn("fake-secret", rendered)
        self.assertNotIn("u_fake", rendered)
        self.assertNotIn("unknown", rendered)
        self.assertNotIn("obsolete", rendered)
        self.assertIsNone(self.monitor.snapshot()["mapped"]["fields"]["taskName"]["value"])
        self.message(current, {"print": {"subtask_name": "<script>malicious</script>",
                    "mc_print_error_code": "bad\u202eevil"}})
        rendered = json.dumps(self.monitor.snapshot())
        self.assertNotIn("<script>", rendered)
        self.assertNotIn("malicious", rendered)
        self.assertNotIn("evil", rendered)

    def test_oversized_wrong_command_and_concurrent_snapshots(self):
        self.monitor.start(self.params)
        client = self.clients[-1]
        client.on_connect(client, None, {}, 0)
        client.on_subscribe(client, None, 1, (0,))
        self.message(client, {"print": {"command": "control", "mc_percent": 3}})
        self.message(client, b" " * (monitor_module.MAX_PAYLOAD + 1))
        self.assertIsNone(self.monitor.snapshot()["lastReportAt"])
        failures = []
        def writer():
            try:
                for n in range(100):
                    self.message(client, {"print": {"task_id": str(n + 1), "mc_percent": n}})
            except Exception as exc:
                failures.append(exc)
        worker = threading.Thread(target=writer)
        worker.start()
        for _ in range(100):
            snapshot = self.monitor.snapshot()
            self.assertEqual(snapshot["reportTimeUnit"], "unix_seconds")
            json.dumps(snapshot, allow_nan=False)
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertFalse(failures)
        self.assertEqual(self.monitor.snapshot()["state"]["mc_percent"], 99)

    def test_poll_preserves_order_replay_and_overflow(self):
        started = self.monitor.start(self.params)
        client = self.clients[-1]
        client.on_connect(client, None, {}, 0)
        client.on_subscribe(client, None, 1, (0,))
        self.message(client, {"print": {"mc_percent": 0, "subtask_name": "fake-secret"}})
        params = {"generation": started["generation"], "afterSeq": 0}
        first = self.monitor.poll(params)
        self.assertEqual(first, self.monitor.poll(params))
        self.assertEqual([e["seq"] for e in first["events"]], list(range(1, first["nextSeq"] + 1)))
        self.assertNotIn("fake-secret", json.dumps(first))
        self.assertEqual(first["events"][-1]["data"]["mc_percent"], 0)
        for n in range(monitor_module.MAX_EVENTS + 1):
            self.message(client, {"print": {"mc_percent": n % 100}})
        overflow = self.monitor.poll(params)
        self.assertTrue(overflow["resetRequired"])
        self.assertEqual(overflow["events"], [])
        resumed = self.monitor.poll({**params, "afterSeq": overflow["nextSeq"]})
        self.assertFalse(resumed["resetRequired"])
        self.assertEqual(resumed["events"], [])
        self.assertTrue(self.monitor.poll({**params, "generation": started["generation"] + 1})["resetRequired"])

    def test_poll_reports_disconnect_and_auth_failure(self):
        started = self.monitor.start(self.params)
        client = self.clients[-1]
        client.on_connect(client, None, {}, 0)
        client.on_subscribe(client, None, 1, (0,))
        client.on_disconnect(client, None, 1)
        result = self.monitor.poll({"generation": started["generation"], "afterSeq": 0})
        self.assertEqual(result["events"][-1]["data"]["state"], "disconnected")
        started = self.monitor.start(self.params)
        client = self.clients[-1]
        client.on_connect(client, None, {}, 5)
        result = self.monitor.poll({"generation": started["generation"], "afterSeq": 0})
        self.assertEqual(result["events"][-1]["data"]["state"], "auth_failed")
        self.assertEqual(result["currentConnection"], "auth_failed")

    def test_protocol_errors_do_not_echo_secrets_or_offer_refresh(self):
        secret = "fake-secret-xyz"
        lines = [json.dumps({"id": 1, "method": "hello"}),
                 json.dumps({"id": 2, "method": "monitor.refresh", "params": {"token": secret}}),
                 json.dumps({"id": 3, "method": "monitor.start", "params": {"token": secret}}),
                 json.dumps({"id": 4, "method": "shutdown"})]
        process = subprocess.run([sys.executable, "-B", str(SCRIPT)], input="\n".join(lines) + "\n", capture_output=True, text=True, timeout=15, check=True)
        replies = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual(replies[0]["result"]["protocol"], 1)
        self.assertEqual(replies[1]["error"]["code"], "invalid_request")
        self.assertEqual(replies[2]["error"]["code"], "invalid_request")
        self.assertNotIn(secret, process.stdout + process.stderr)
        self.assertEqual(process.stderr, "")


if __name__ == "__main__":
    unittest.main()
