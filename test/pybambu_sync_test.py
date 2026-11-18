"""Offline tests using hand-written Git repositories; run with unittest."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sync_pybambu.py"
spec = importlib.util.spec_from_file_location("sync_pybambu", SCRIPT)
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name).resolve()
        self.repo = self.base / "upstream"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")
        self.put("LICENSE", b"license\n")
        self.put(sync.SOURCE + "/__init__.py", b"value = 1\n")
        self.put(sync.SOURCE + "/mock_data/sample", b"excluded\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.commit = self.git("rev-parse", "HEAD").decode().strip()
        self.vendor = self.base / "vendor" / "ha-bambulab"
        (self.vendor / sync.SOURCE).mkdir(parents=True)
        (self.vendor / "LICENSE").write_bytes(b"license\n")
        (self.vendor / sync.SOURCE / "__init__.py").write_bytes(b"value = 1\n")
        (self.vendor / "UPSTREAM.json").write_text("{}")
        self.addCleanup(self.tmp.cleanup)

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

    def put(self, name, data):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def check(self):
        path = sync.check_checkout(self.repo, self.commit)
        return sync.compare(sync.upstream_files(path, self.commit), *sync.snapshot_files(self.vendor))

    def test_identical_and_mock_data_excluded(self):
        self.assertEqual(self.check(), [])
        (self.vendor / sync.SOURCE / "mock_data").mkdir()
        self.assertIn("额外目录: " + sync.SOURCE + "/mock_data", self.check())

    def test_modified_extra_missing_and_empty_directory(self):
        (self.vendor / "LICENSE").write_bytes(b"changed")
        (self.vendor / sync.SOURCE / "__init__.py").unlink()
        (self.vendor / "extra").write_bytes(b"extra")
        (self.vendor / "empty").mkdir()
        result = self.check()
        self.assertIn("内容不同: LICENSE", result)
        self.assertIn("缺少文件: " + sync.SOURCE + "/__init__.py", result)
        self.assertIn("额外文件: extra", result)
        self.assertIn("额外目录: empty", result)

    def test_git_commit_not_working_tree_and_dirty_refused(self):
        self.put("LICENSE", b"different")
        with self.assertRaisesRegex(sync.SyncError, "未提交"):
            self.check()
        self.git("add", "LICENSE")
        self.git("commit", "-qm", "second")
        self.assertEqual(self.check(), [])
        self.put("untracked", b"x")
        with self.assertRaisesRegex(sync.SyncError, "未跟踪"):
            self.check()

    def test_reject_incomplete_ids_and_wrong_checkout_directory(self):
        for commit in (self.commit[:10], "HEAD", self.commit.upper(), "0" * 40):
            with self.subTest(commit=commit), self.assertRaises(sync.SyncError):
                sync.check_checkout(self.repo, commit)
        with self.assertRaises(sync.SyncError):
            sync.check_checkout(self.repo / "custom_components", self.commit)

    def test_reject_links_in_snapshot_and_upstream(self):
        (self.vendor / "unsafe").symlink_to(self.base, target_is_directory=True)
        with self.assertRaisesRegex(sync.SyncError, "符号链接"):
            self.check()
        (self.vendor / "unsafe").unlink()
        (self.repo / sync.SOURCE / "unsafe").symlink_to("__init__.py")
        self.git("add", ".")
        self.git("commit", "-qm", "symlink")
        self.commit = self.git("rev-parse", "HEAD").decode().strip()
        with self.assertRaisesRegex(sync.SyncError, "符号链接"):
            self.check()

    def test_ds_store_regular_files_ignored_but_symlinks_rejected(self):
        (self.vendor / ".DS_Store").write_bytes(b"finder metadata")
        nested = self.vendor / "custom_components" / ".DS_Store"
        nested.write_bytes(b"finder metadata")
        self.assertEqual(self.check(), [])
        nested.unlink()
        nested.symlink_to(self.vendor / ".DS_Store")
        with self.assertRaisesRegex(sync.SyncError, "符号链接"):
            self.check()

    def test_executable_mode(self):
        (self.vendor / sync.SOURCE / "__init__.py").chmod(0o755)
        self.assertIn("可执行权限不同: " + sync.SOURCE + "/__init__.py", self.check())

    def test_cli_check_success_and_differences(self):
        scripts = self.base / "scripts"
        scripts.mkdir()
        script = scripts / "sync_pybambu.py"
        shutil.copyfile(SCRIPT, script)
        command = [sys.executable, "-B", str(script), "check", "--upstream", str(self.repo),
                   "--commit", self.commit]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("一致", result.stdout)
        (self.vendor / "LICENSE").write_bytes(b"changed")
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("内容不同: LICENSE", result.stdout)
        self.put("untracked", b"x")
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("未跟踪", result.stderr)

    def test_cli_rejects_update_and_does_not_modify_snapshot(self):
        before = (self.vendor / "LICENSE").read_bytes()
        result = subprocess.run([sys.executable, str(SCRIPT), "update", "--upstream", str(self.repo),
                                 "--commit", self.commit], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.vendor / "LICENSE").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
