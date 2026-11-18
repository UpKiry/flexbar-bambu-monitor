#!/usr/bin/env python3
"""Experimental cloud-only passive monitor. JSON lines over stdin/stdout.

No printer command is sent, including on connect and refresh. A parent polls
monitor.poll for bounded incremental events; snapshot is available for diagnostics.
Credentials are passed only via stdin and never included in responses or diagnostics.
"""
from collections import deque
import json
import logging
import math
from pathlib import Path
import re
import sys
import threading
import time

# The parent directory is fixed relative to this script, not resolved from PATH.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pybambu_state import PrinterStateMapper, filter_delta

sys.dont_write_bytecode = True
logging.disable(logging.CRITICAL)

FIELDS = {
    "mc_percent": (0, 100), "mc_remaining_time": (0, 1000000),
    "layer_num": (0, 1000000), "total_layer_num": (0, 1000000),
    "bed_temper": (-100, 1000), "nozzle_temper": (-100, 1000),
}
HOSTS = {"China": "cn.mqtt.bambulab.com", "Global": "us.mqtt.bambulab.com"}
MAX_LINE = 65536
MAX_PAYLOAD = 262144
MAX_EVENTS = 64
MAX_EVENT_BYTES = 16384
MAX_POLL_EVENTS = 16
MAX_RESPONSE_BYTES = MAX_LINE - 512


def load_model():
    path = Path(__file__).resolve().parent.parent / "vendor/ha-bambulab/custom_components/bambu_lab"
    sys.path.insert(0, str(path))
    from pybambu import BambuClient
    client = BambuClient({"host": "", "enable_camera": False})
    # Fail closed if a future upstream model tries to publish during parsing.
    def reject_publish(*_args, **_kwargs):
        raise RuntimeError("model publish forbidden")
    client.publish = reject_publish
    return client


def create_mqtt():
    import paho.mqtt.client as mqtt
    return mqtt.Client(protocol=mqtt.MQTTv311, clean_session=True)


class Monitor:
    def __init__(self, mqtt_factory=create_mqtt, model_factory=load_model, clock=time.time):
        self.mqtt_factory = mqtt_factory
        self.model_factory = model_factory
        self.clock = clock
        self.lock = threading.Lock()
        # Serializes externally requested lifecycle operations, including waiting
        # for a callback's asynchronous cleanup before replacing a connection.
        self.lifecycle_lock = threading.RLock()
        self.cleanup_threads = set()
        self.subscription_mid = None
        self.client = None
        self.generation = 0
        self.model = None
        self.mapper = PrinterStateMapper()
        self.mapper_generation = None
        self.secrets = ()
        self.state = {key: None for key in FIELDS}
        self.connection = "stopped"
        self.last_report_at = None
        self.has_current_report = False
        self.had_disconnect = False
        self.device_id = None
        self.events = deque()
        self.sequence = 0
        self.lost_through = 0

    def _enqueue(self, kind, data):
        # Called under self.lock; never keep raw packets or credentials.
        self.sequence += 1
        event = {"seq": self.sequence, "type": kind,
                 "receivedAtMs": int(self.clock() * 1000), "data": data}
        encoded = json.dumps(event, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_EVENT_BYTES:
            self.lost_through = self.sequence
            self.events.clear()
            return
        if len(self.events) >= MAX_EVENTS:
            self.lost_through = self.events.popleft()["seq"]
        self.events.append(event)

    def _set_connection(self, state):
        if self.connection != state:
            self.connection = state
            self._enqueue("connection", {"state": state})

    def poll(self, params):
        if not isinstance(params, dict) or set(params) != {"generation", "afterSeq"}:
            raise ValueError()
        generation, after = params["generation"], params["afterSeq"]
        if type(generation) is not int or type(after) is not int or generation < 0 or after < 0 or after > 9007199254740991:
            raise ValueError()
        with self.lock:
            result = {"generation": self.generation, "deviceId": self.device_id,
                      "currentConnection": self.connection, "events": [],
                      "nextSeq": self.sequence, "hasMore": False, "resetRequired": False}
            if generation != self.generation or after < self.lost_through:
                result["resetRequired"] = True
                return result
            if after > self.sequence:
                raise ValueError()
            result["nextSeq"] = after
            available = [event for event in self.events if event["seq"] > after]
            for event in available:
                candidate = dict(result, events=result["events"] + [event], nextSeq=event["seq"])
                # Reserve bytes for the outer response and request id.
                size = len(json.dumps(candidate, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8"))
                if size > MAX_RESPONSE_BYTES or len(result["events"]) >= MAX_POLL_EVENTS:
                    break
                result["events"].append(event)
                result["nextSeq"] = event["seq"]
            result["hasMore"] = result["nextSeq"] < self.sequence
            return result

    @staticmethod
    def _close_client(client):
        # Attempt both operations even if disconnect fails. Never log exceptions:
        # third-party exceptions can contain credentials or raw payloads.
        try:
            client.disconnect()
        except Exception:
            pass
        try:
            client.loop_stop()
        except Exception:
            pass

    def _fail_from_callback(self, generation, connection):
        # Paho invokes callbacks on its network thread; loop_stop must run in
        # another thread because it joins that network thread. Remove ownership
        # before spawning, so late callbacks cannot mutate a new generation.
        with self.lock:
            if generation != self.generation or self.client is None:
                return
            client = self.client
            self.client = None
            self.model = None
            self.mapper_generation = self.mapper.select_device(None)
            self.secrets = ()
            self.subscription_mid = None
            self.state = {key: None for key in FIELDS}
            self.last_report_at = None
            self.has_current_report = False
            self._set_connection(connection)
            worker = threading.Thread(target=self._close_client, args=(client,), daemon=True)
            self.cleanup_threads.add(worker)
            worker.start()

    def _join_cleanup(self):
        # Called only outside the state lock, from the request thread.
        with self.lock:
            workers = tuple(self.cleanup_threads)
        for worker in workers:
            worker.join()
        with self.lock:
            self.cleanup_threads.difference_update(workers)

    def start(self, params):
        with self.lifecycle_lock:
            return self._start(params)

    def _start(self, params):
        if not isinstance(params, dict) or set(params) != {"region", "deviceId", "username", "token"}:
            raise ValueError()
        region, device, username, token = (params[k] for k in ("region", "deviceId", "username", "token"))
        if not isinstance(region, str) or region not in HOSTS or not isinstance(device, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", device):
            raise ValueError()
        if any(not isinstance(s, str) or not 1 <= len(s) <= 4096 or "\x00" in s for s in (username, token)):
            raise ValueError()
        self.stop()
        model = self.model_factory()
        client = self.mqtt_factory()
        try:
            client.tls_set()  # Paho defaults validate CA certificates and hostnames.
            client.username_pw_set(username, password=token)
        except Exception:
            self._close_client(client)
            raise
        with self.lock:
            self.generation += 1
            generation = self.generation
            self.events.clear()
            self.sequence = 0
            self.lost_through = 0
            self.device_id = device
            self.model, self.client = model, client
            self.mapper_generation = self.mapper.select_device(device)
            self.secrets = (username, token)
            self.state = {key: None for key in FIELDS}
            self.last_report_at = None
            self.has_current_report = False
            self.had_disconnect = False
            self._set_connection("connecting")
        client.on_connect = lambda c, u, f, rc: self.on_connect(generation, c, device, rc)
        client.on_disconnect = lambda c, u, rc: self.on_disconnect(generation, rc)
        client.on_subscribe = lambda c, u, mid, qos: self.on_subscribe(generation, mid, qos)
        client.on_message = lambda c, u, msg: self.on_message(generation, device, msg)
        try:
            client.connect_async(HOSTS[region], 8883, keepalive=30)
            client.loop_start()
        except Exception:
            self.stop()
            raise
        return {"connection": "connecting", "generation": generation, "deviceId": device}

    def on_connect(self, generation, client, device, rc):
        failure = None
        with self.lock:
            if generation != self.generation or client is not self.client:
                return
            if rc != 0:
                self._set_connection("auth_failed" if rc in (4, 5) else "disconnected")
                if rc in (4, 5):
                    failure = "auth_failed"
            else:
                try:
                    result, mid = client.subscribe(f"device/{device}/report", qos=0)
                except Exception:
                    result, mid = -1, None
                if result == 0 and type(mid) is int and 1 <= mid <= 65535:
                    self.subscription_mid = mid
                    self._set_connection("subscribing")
                else:
                    failure = "disconnected"
        if failure:
            self._fail_from_callback(generation, failure)

    def on_subscribe(self, generation, mid, qos):
        failure = False
        with self.lock:
            if (generation == self.generation and self.connection == "subscribing"
                    and type(mid) is int and mid == self.subscription_mid):
                # We requested one QoS 0 subscription; exactly one matching
                # grant is required. Rejection, malformed and extra grants fail.
                if isinstance(qos, (tuple, list)) and len(qos) == 1 and type(qos[0]) is int and qos[0] == 0:
                    self._set_connection("connected")
                else:
                    failure = True
        if failure:
            self._fail_from_callback(generation, "disconnected")

    def on_disconnect(self, generation, rc):
        with self.lock:
            if generation == self.generation and self.connection != "auth_failed":
                self._set_connection("disconnected")
                self.has_current_report = False
                self.had_disconnect = True

    def on_message(self, generation, device, msg):
        if msg.topic != f"device/{device}/report" or len(msg.payload) > MAX_PAYLOAD:
            return
        try:
            data = json.loads(msg.payload)
        except (ValueError, UnicodeError, RecursionError):
            return
        try:
            data = data.get("print") if isinstance(data, dict) else None
            if not isinstance(data, dict) or (data.get("command") not in (None, "push_status", "pushall")):
                return
            selected = {}
            for key, (lo, hi) in FIELDS.items():
                value = data.get(key)
                if type(value) in (int, float) and lo <= value <= hi and math.isfinite(value):
                    selected[key] = value
            with self.lock:
                if generation != self.generation or self.model is None or self.connection != "connected":
                    return
                try:
                    mapped = filter_delta(data, self.secrets)
                except ValueError:
                    self.sequence += 1
                    self.lost_through = self.sequence
                    self.events.clear()
                    return
                if not mapped:
                    return
                if selected:
                    # Only numeric values observed in this report reach upstream.
                    self.model.get_device().print_update(selected)
                    device_model = self.model.get_device()
                    values = {
                        "mc_percent": device_model.print_job.print_percentage,
                        "mc_remaining_time": device_model.print_job.remaining_time,
                        "layer_num": device_model.print_job.current_layer,
                        "total_layer_num": device_model.print_job.total_layers,
                        "bed_temper": device_model.temperature.bed_temp,
                        "nozzle_temper": device_model.temperature.nozzle_temps[0],
                    }
                    for key in selected:
                        self.state[key] = values[key]
                self.mapper.update(device, self.mapper_generation, mapped)
                self._enqueue("report", mapped)
                self.last_report_at = self.clock()
                self.has_current_report = True
        except Exception:
            # Drop malformed reports and model failures without logging payloads.
            self._fail_from_callback(generation, "model_error")

    def snapshot(self):
        with self.lock:
            mapped = self.mapper.snapshot()
            # Untrusted device strings may echo credentials even in allowed fields.
            # Never expose currently held credentials through the private protocol.
            secrets = tuple(sorted(set(self.secrets), key=len, reverse=True))
            def scrub(value):
                if isinstance(value, str):
                    if any(secret in value for secret in secrets) or re.search(r"[<>\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]", value):
                        return None
                    return value
                if isinstance(value, list):
                    return [scrub(item) for item in value]
                if isinstance(value, dict):
                    return {key: scrub(item) for key, item in value.items()}
                return value
            return {"connection": self.connection, "state": dict(self.state),
                    "lastReportAt": self.last_report_at, "reportTimeUnit": "unix_seconds",
                    "generation": self.generation,
                    "currentConnectionHasReport": self.has_current_report,
                    # A later partial report cannot prove retained fields are current.
                    "stale": self.connection != "connected" or not self.has_current_report or self.had_disconnect,
                    "mapped": scrub(mapped)}

    def stop(self):
        with self.lifecycle_lock:
            with self.lock:
                client = self.client
                self.generation += 1
                self.events.clear()
                self.sequence = 0
                self.lost_through = 0
                self.device_id = None
                self.client = None
                self.model = None
                self.mapper_generation = self.mapper.select_device(None)
                self.secrets = ()
                self.subscription_mid = None
                self.state = {key: None for key in FIELDS}
                self.last_report_at = None
                self.has_current_report = False
                self.connection = "stopped"
            if client is not None:
                self._close_client(client)
            self._join_cleanup()


def main():
    monitor = Monitor()
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_LINE + 1)
            if not line:
                break
            request_id = None
            try:
                if len(line) > MAX_LINE:
                    while line and not line.endswith(b"\n"):
                        line = sys.stdin.buffer.readline(MAX_LINE + 1)
                    raise ValueError()
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError()
                request_id = request.get("id")
                if type(request_id) is not int or not 0 <= request_id <= 9007199254740991:
                    request_id = None
                    raise ValueError()
                method, params = request.get("method"), request.get("params", {})
                if not isinstance(params, dict):
                    raise ValueError()
                if method == "hello" and not params:
                    result = {"protocol": 1, "capabilities": ["monitor.passive", "monitor.snapshot", "monitor.poll-deltas"]}
                elif method == "monitor.start":
                    result = monitor.start(params)
                elif method == "monitor.poll":
                    result = monitor.poll(params)
                elif method == "monitor.snapshot" and not params:
                    result = monitor.snapshot()
                elif method == "monitor.stop" and not params:
                    monitor.stop()
                    result = {"connection": "stopped"}
                elif method == "shutdown" and not params:
                    monitor.stop()
                    print(json.dumps({"id": request_id, "result": {}}, separators=(",", ":")), flush=True)
                    break
                else:
                    raise ValueError()
                response = {"id": request_id, "result": result}
            except (ValueError, TypeError, UnicodeError, RecursionError):
                response = {"id": request_id, "error": {"code": "invalid_request", "message": "Invalid request"}}
            except Exception:
                response = {"id": request_id, "error": {"code": "backend_failure", "message": "Backend failed"}}
            print(json.dumps(response, allow_nan=False, separators=(",", ":")), flush=True)
    finally:
        monitor.stop()


if __name__ == "__main__":
    main()
