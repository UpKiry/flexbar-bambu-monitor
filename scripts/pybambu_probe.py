#!/usr/bin/env python3
"""Offline JSON-lines probe for pybambu's upstream model.

PYBAMBU_PATH overrides vendor/ha-bambulab/custom_components/bambu_lab.
Requests use {"id":1,"method":"hello","params":{}} or
{"id":2,"method":"update","params":{"print":{...}}}. IDs are echoed;
callers must use non-sensitive identifiers. Only numeric fields below are
accepted as printer data; errors never contain input, exceptions or paths.
"""
import contextlib
import io
import json
import logging
import math
import os
import socket
import sys

# Keep the pinned upstream tree unchanged when importing its modules.
sys.dont_write_bytecode = True

# Explicit bounds also prevent strings, credentials and arbitrary nested data
# from entering the upstream model or being reflected in output.
FIELDS = {
    "mc_percent": (0, 100),
    "mc_remaining_time": (0, 1000000),
    "layer_num": (0, 1000000),
    "total_layer_num": (0, 1000000),
    "bed_temper": (-100, 1000),
    "nozzle_temper": (-100, 1000),
}


def reject_network(*_args, **_kwargs):
    raise RuntimeError("network disabled")


def load_client():
    path = os.environ.get("PYBAMBU_PATH")
    if path is None:
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "vendor", "ha-bambulab", "custom_components", "bambu_lab")
    if not os.path.isfile(os.path.join(path, "pybambu", "__init__.py")):
        raise FileNotFoundError("upstream unavailable")
    # Do not allow the upstream package or its dependencies to open connections.
    socket.socket.connect = reject_network
    socket.socket.connect_ex = reject_network
    socket.socket.send = reject_network
    socket.socket.sendall = reject_network
    socket.socket.sendto = reject_network
    socket.create_connection = reject_network
    socket.getaddrinfo = reject_network
    sys.path.insert(0, path)
    logging.disable(logging.CRITICAL)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from pybambu import BambuClient
        client = BambuClient({"host": "", "enable_camera": False})
    # Even a model-triggered publish must remain offline.
    client.publish = lambda *_args, **_kwargs: False
    return client


def response_state(device):
    job = device.print_job
    temp = device.temperature
    return {
        "mc_percent": job.print_percentage,
        "mc_remaining_time": job.remaining_time,
        "layer_num": job.current_layer,
        "total_layer_num": job.total_layers,
        "bed_temper": temp.bed_temp,
        "nozzle_temper": temp.nozzle_temps[0],
    }


MAX_LINE_BYTES = 65536


def input_lines():
    """Read bounded lines, draining oversized input before the next request."""
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_LINE_BYTES:
            while not line.endswith(b"\n"):
                line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
                if not line:
                    break
            yield None
        else:
            yield line


def main():
    client = None
    for line in input_lines():
        request_id = None
        try:
            if line is None:
                raise ValueError("oversized request")
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("invalid request")
            request_id = request.get("id")
            if type(request_id) is not int or not 0 <= request_id <= 9007199254740991:
                request_id = None
                raise ValueError("invalid id")
            method = request.get("method")
            params = request.get("params", {})
            if not isinstance(params, dict):
                raise ValueError("invalid params")
            if method == "hello":
                result = {"protocol": 1}
            elif method == "update":
                data = params.get("print")
                if not isinstance(data, dict) or not data or set(data) - FIELDS.keys():
                    raise ValueError("invalid update")
                for key, value in data.items():
                    lo, hi = FIELDS[key]
                    if type(value) not in (int, float) or not math.isfinite(value) or not lo <= value <= hi:
                        raise ValueError("invalid field")
                try:
                    if client is None:
                        client = load_client()
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        client.get_device().print_update(data)
                        state = response_state(client.get_device())
                except Exception:
                    # A model exception can leave partially updated state. Discard it.
                    client = None
                    raise RuntimeError("upstream failure") from None
                result = {"state": state}
            else:
                raise ValueError("invalid method")
            response = {"id": request_id, "result": result}
        except (ValueError, TypeError, OverflowError, RecursionError, UnicodeDecodeError):
            response = {"id": request_id, "error": {"code": "invalid_request", "message": "Invalid request"}}
        except Exception:
            response = {"id": request_id, "error": {"code": "upstream_failure", "message": "Upstream unavailable or failed"}}
        print(json.dumps(response, allow_nan=False, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
