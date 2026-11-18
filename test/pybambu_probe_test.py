"""Run: .venv-pybambu/bin/python -m unittest test/pybambu_probe_test.py

The default upstream is vendor/ha-bambulab; PYBAMBU_PATH can override it.
All messages below are synthetic. No printer or network is needed.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

PROBE = Path(__file__).resolve().parents[1] / "scripts" / "pybambu_probe.py"


def request(request_id, method, params=None):
    return {"id": request_id, "method": method, "params": params or {}}


def run_probe(lines, env=None):
    process = subprocess.run(
        [sys.executable, str(PROBE)], input="\n".join(lines) + "\n",
        capture_output=True, text=True, env=env, timeout=20, check=True,
    )
    return [json.loads(line) for line in process.stdout.splitlines()], process.stderr


class ProbeTest(unittest.TestCase):
    def test_hello_and_safe_errors_without_upstream(self):
        env = os.environ.copy()
        env["PYBAMBU_PATH"] = "/nonexistent/pybambu-probe-test"
        secret = "private-token-example"
        replies, stderr = run_probe([
            json.dumps(request(1, "hello")), 'invalid ' + secret,
            json.dumps(request(2, "update", {"print": {"mc_percent": 10}})),
            json.dumps({"id": 3, "method": "unknown", "secret": secret}),
        ], env)
        self.assertEqual(replies[0], {"id": 1, "result": {"protocol": 1}})
        self.assertEqual(replies[1]["id"], None)
        self.assertEqual(replies[2]["error"]["code"], "upstream_failure")
        self.assertEqual(replies[2]["id"], 2)
        self.assertEqual(replies[3]["error"]["code"], "invalid_request")
        self.assertNotIn(secret, json.dumps(replies) + stderr)
        self.assertEqual(stderr, "")

    def test_incremental_state_and_rejected_input(self):
        lines = [
            request(1, "update", {"print": {"mc_percent": 23, "bed_temper": 52.3, "nozzle_temper": 201.2}}),
            request(2, "update", {"print": {"layer_num": 7, "mc_percent": 24}}),
            request(3, "update", {"print": {"mc_percent": 40, "token": "private-token-example"}}),
            request(4, "update", {"print": {"mc_percent": True}}),
            request(5, "update", {"print": {"total_layer_num": 100}}),
        ]
        replies, stderr = run_probe([json.dumps(line) for line in lines])
        self.assertEqual([reply["id"] for reply in replies], [1, 2, 3, 4, 5])
        self.assertEqual(replies[0]["result"]["state"]["bed_temper"], 52)
        self.assertEqual(replies[0]["result"]["state"]["nozzle_temper"], 201)
        self.assertEqual(replies[1]["result"]["state"]["mc_percent"], 24)
        self.assertEqual(replies[1]["result"]["state"]["bed_temper"], 52)
        self.assertEqual(replies[1]["result"]["state"]["layer_num"], 7)
        self.assertEqual(replies[2]["error"]["code"], "invalid_request")
        self.assertEqual(replies[3]["error"]["code"], "invalid_request")
        self.assertEqual(replies[4]["result"]["state"]["mc_percent"], 24)
        self.assertEqual(replies[4]["result"]["state"]["total_layer_num"], 100)
        self.assertNotIn("private-token-example", json.dumps(replies) + stderr)
        self.assertEqual(stderr, "")

    def test_default_vendor_and_oversized_line_recovery(self):
        env = os.environ.copy()
        env.pop("PYBAMBU_PATH", None)
        replies, stderr = run_probe([
            "x" * 70000,
            json.dumps(request(11, "hello")),
            json.dumps(request(12, "update", {"print": {"mc_percent": 12}})),
        ], env)
        self.assertEqual(replies[0]["error"]["code"], "invalid_request")
        self.assertEqual(replies[1]["id"], 11)
        self.assertEqual(replies[2]["result"]["state"]["mc_percent"], 12)
        self.assertEqual(stderr, "")


if __name__ == "__main__":
    unittest.main()
