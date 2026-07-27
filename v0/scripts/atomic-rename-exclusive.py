#!/usr/bin/env python3
"""Reserve, inspect, or publish a directory relative to an inherited parent fd."""

import ctypes
import errno
import json
import os
import secrets
import stat
import sys


SOURCE_PARENT_FD = 3
TARGET_PARENT_FD = 4
RENAME_EXCL = 0x00000004
STAGE_PREFIX = ".writcraft-author-copy-"


def identity(stat_result):
    return {
        "dev": str(stat_result.st_dev),
        "ino": str(stat_result.st_ino),
        "mode": stat_result.st_mode & 0o777,
    }


def inspect_name(parent_fd, name):
    try:
        stat_result = os.stat(
            name,
            dir_fd=parent_fd,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(stat_result.st_mode):
        return {"type": "other", **identity(stat_result)}
    return {"type": "directory", **identity(stat_result)}


def reserve():
    for _ in range(16):
        name = f"{STAGE_PREFIX}{secrets.token_hex(24)}"
        try:
            os.mkdir(name, mode=0o700, dir_fd=SOURCE_PARENT_FD)
        except FileExistsError:
            continue
        directory_fd = None
        try:
            directory_fd = os.open(
                name,
                os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=SOURCE_PARENT_FD,
            )
            os.fchmod(directory_fd, 0o700)
            stat_result = os.fstat(directory_fd)
            at_path = os.stat(
                name,
                dir_fd=SOURCE_PARENT_FD,
                follow_symlinks=False,
            )
            if (stat_result.st_dev, stat_result.st_ino) != (
                at_path.st_dev,
                at_path.st_ino,
            ):
                raise RuntimeError("reserved directory identity changed")
            os.fsync(SOURCE_PARENT_FD)
            return {"ok": True, "name": name, **identity(stat_result)}
        finally:
            if directory_fd is not None:
                os.close(directory_fd)
    raise RuntimeError("unable to reserve a unique stage")


def rename_exclusive(source, target):
    libc = ctypes.CDLL(None, use_errno=True)
    rename_at_exclusive = libc.renameatx_np
    rename_at_exclusive.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    rename_at_exclusive.restype = ctypes.c_int
    result = rename_at_exclusive(
        SOURCE_PARENT_FD,
        os.fsencode(source),
        TARGET_PARENT_FD,
        os.fsencode(target),
        RENAME_EXCL,
    )
    if result == 0:
        return 0
    return ctypes.get_errno()


def publish(request):
    source = request["source"]
    target = request["target"]
    expected_dev = request["dev"]
    expected_ino = request["ino"]
    if (
        not isinstance(source, str)
        or not source.startswith(STAGE_PREFIX)
        or "/" in source
        or not isinstance(target, str)
        or "/" in target
        or not isinstance(expected_dev, str)
        or not isinstance(expected_ino, str)
    ):
        raise ValueError("invalid publish request")
    code = rename_exclusive(source, target)
    report = {
        "ok": code == 0,
        "errno": code,
        "source": inspect_name(SOURCE_PARENT_FD, source),
        "target": inspect_name(TARGET_PARENT_FD, target),
    }
    target_identity = report["target"]
    report["expected"] = bool(
        target_identity
        and target_identity.get("type") == "directory"
        and target_identity.get("dev") == expected_dev
        and target_identity.get("ino") == expected_ino
        and report["source"] is None
    )
    return report


def inspect(request):
    return {
        "ok": True,
        "source": inspect_name(SOURCE_PARENT_FD, request["source"]),
        "target": inspect_name(TARGET_PARENT_FD, request["target"]),
    }


def main():
    try:
        request = json.load(sys.stdin)
        mode = request.get("mode")
        if mode == "reserve":
            report = reserve()
            status = 0
        elif mode == "publish":
            report = publish(request)
            status = 0 if report["ok"] and report["expected"] else (
                2 if report["errno"] == errno.EEXIST else 1
            )
        elif mode == "inspect":
            report = inspect(request)
            status = 0
        else:
            raise ValueError("invalid mode")
        print(json.dumps(report, separators=(",", ":")))
        return status
    except Exception:
        print(json.dumps(
            {"ok": False, "errno": None},
            separators=(",", ":"),
        ))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
