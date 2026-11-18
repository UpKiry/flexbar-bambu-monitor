"""Offline subprocess fixture for the real monitor protocol; no network calls."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

script = Path(__file__).resolve().parents[2] / "scripts" / "pybambu_monitor.py"
spec = importlib.util.spec_from_file_location("offline_monitor", script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeMqtt:
    def tls_set(self): pass
    def username_pw_set(self, username, password): pass
    def connect_async(self, host, port, keepalive): pass
    def subscribe(self, topic, qos): return (0, 1)
    def disconnect(self): pass
    def loop_stop(self): pass
    def loop_start(self):
        self.on_connect(self, None, {}, 0)
        self.on_subscribe(self, None, 1, (0,))
        payload = json.dumps({"print": {"mc_percent": 0, "subtask_name": "offline task", "ams": {"ams": [{"id": "0", "tray": [{"id": "0", "tray_type": "PLA"}]}]}}}).encode()
        self.on_message(self, None, SimpleNamespace(topic="device/DEV1/report", payload=payload))


real_monitor = module.Monitor
module.Monitor = lambda: real_monitor(mqtt_factory=FakeMqtt)
module.main()
