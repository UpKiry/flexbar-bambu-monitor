#!/usr/bin/env python3
"""Compare the vendored pybambu snapshot with a local Git commit, without writes.

Example: python3 scripts/sync_pybambu.py check --upstream /path/to/checkout \
    --commit 0123456789012345678901234567890123456789

Exit status: 0 identical, 1 differences, 2 unsafe input or operational error.
The tool deliberately has no update command: the snapshot may contain local work.
"""

import argparse
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

SOURCE = "custom_components/bambu_lab/pybambu"
VENDOR = Path(__file__).resolve().parent.parent / "vendor" / "ha-bambulab"


class SyncError(Exception):
    pass


def git(checkout, *args):
    # Do not consult a user's global configuration, run a filesystem monitor, or
    # lazily fetch missing promisor objects. Commands here never contact remotes.
    env = os.environ.copy()
    for key in list(env):
        if key.startswith("GIT_"):
            del env[key]
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_TERMINAL_PROMPT="0", GIT_NO_LAZY_FETCH="1",
               GIT_NO_REPLACE_OBJECTS="1", GIT_OPTIONAL_LOCKS="0")
    command = ["git", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never",
               "-C", str(checkout), *args]
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=env, check=False)
    except OSError as exc:
        raise SyncError(f"无法运行 git: {exc}") from exc
    if result.returncode:
        raise SyncError("git 操作失败: " + result.stderr.decode("utf-8", "replace").strip())
    return result.stdout


def check_checkout(path, commit):
    if not path.is_absolute() or not path.is_dir():
        raise SyncError("上游 checkout 必须是存在的绝对目录路径")
    path = path.resolve(strict=True)
    root = Path(os.fsdecode(git(path, "rev-parse", "--show-toplevel").strip())).resolve()
    if path != root or git(path, "rev-parse", "--is-bare-repository").strip() != b"false":
        raise SyncError("上游路径必须是非裸仓库的 checkout 根目录")
    fmt = git(path, "rev-parse", "--show-object-format").strip()
    length = {b"sha1": 40, b"sha256": 64}.get(fmt)
    if length is None or not re.fullmatch(r"[0-9a-f]{%d}" % length, commit):
        raise SyncError("commit 必须是该仓库对象格式的完整小写十六进制 ID")
    if git(path, "cat-file", "-t", commit).strip() != b"commit":
        raise SyncError("指定对象必须是 commit")
    if git(path, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"):
        raise SyncError("上游 checkout 存在未提交或未跟踪的更改")
    return path


def upstream_files(checkout, commit):
    raw = git(checkout, "ls-tree", "-r", "-z", "--full-tree", commit, "--", "LICENSE", SOURCE)
    files = {}
    for entry in raw.split(b"\0"):
        if not entry:
            continue
        try:
            header, raw_name = entry.split(b"\t", 1)
            mode, kind, oid = header.split(b" ")
            name = raw_name.decode("utf-8", "strict")
        except (ValueError, UnicodeError) as exc:
            raise SyncError("上游包含无法解析的 Git 树条目") from exc
        parts = name.split("/")
        if any(part in ("", ".", "..") or "\\" in part for part in parts):
            raise SyncError(f"不安全的上游路径: {name!r}")
        if name != "LICENSE" and not name.startswith(SOURCE + "/"):
            raise SyncError(f"非预期上游路径: {name!r}")
        if name.startswith(SOURCE + "/mock_data/") or name == SOURCE + "/mock_data":
            continue
        if kind != b"blob" or mode not in (b"100644", b"100755"):
            raise SyncError(f"上游含符号链接、子模块或不支持的文件类型: {name}")
        files[name] = (git(checkout, "cat-file", "blob", oid.decode("ascii")), mode == b"100755")
    if "LICENSE" not in files or not any(p.startswith(SOURCE + "/") for p in files):
        raise SyncError("commit 缺少根 LICENSE 或 pybambu 文件")
    return files


def snapshot_files(root):
    # Check every component without following links, including vendor parents.
    root = Path(os.path.abspath(root))
    for part in (root, *root.parents):
        try:
            info = part.lstat()
        except OSError as exc:
            raise SyncError(f"无法检查目录 {part}: {exc}") from exc
        if not stat.S_ISDIR(info.st_mode):
            raise SyncError(f"目录不存在或包含符号链接: {part}")
    files, directories = {}, set()

    def visit(directory, relative):
        with os.scandir(directory) as entries:
            for entry in entries:
                rel = relative / entry.name
                name = rel.as_posix()
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    directories.add(name)
                    visit(entry.path, rel)
                elif stat.S_ISREG(info.st_mode):
                    if name != "UPSTREAM.json" and entry.name != ".DS_Store":
                        with open(entry.path, "rb") as stream:
                            files[name] = (stream.read(), bool(info.st_mode & 0o111))
                else:
                    raise SyncError(f"快照含符号链接或特殊文件: {name}")
    try:
        visit(root, Path())
    except OSError as exc:
        raise SyncError(f"读取快照失败: {exc}") from exc
    return files, directories


def compare(expected, actual, directories):
    differences = []
    expected_dirs = set()
    for name in expected:
        parent = Path(name).parent
        while str(parent) != ".":
            expected_dirs.add(parent.as_posix())
            parent = parent.parent
    for name in sorted(expected.keys() - actual.keys()):
        differences.append(f"缺少文件: {name}")
    for name in sorted(actual.keys() - expected.keys()):
        differences.append(f"额外文件: {name}")
    for name in sorted(expected.keys() & actual.keys()):
        if expected[name][0] != actual[name][0]:
            differences.append(f"内容不同: {name}")
        if expected[name][1] != actual[name][1]:
            differences.append(f"可执行权限不同: {name}")
    for name in sorted(directories - expected_dirs):
        differences.append(f"额外目录: {name}")
    return differences


def main(argv=None):
    parser = argparse.ArgumentParser(description="只读比较本地上游 Git 对象与 vendor 快照；不访问网络或更新文件。")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="比较快照和明确指定的上游 commit")
    check.add_argument("--upstream", required=True, type=Path, help="本地 checkout 根目录的绝对路径")
    check.add_argument("--commit", required=True, help="完整 commit 对象 ID")
    args = parser.parse_args(argv)
    try:
        checkout = check_checkout(args.upstream, args.commit)
        expected = upstream_files(checkout, args.commit)
        actual, dirs = snapshot_files(VENDOR)
        differences = compare(expected, actual, dirs)
        if differences:
            print("\n".join(differences))
            return 1
        print(f"快照与上游 commit {args.commit} 一致。")
        return 0
    except (SyncError, OSError) as exc:
        print(f"核验失败: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
