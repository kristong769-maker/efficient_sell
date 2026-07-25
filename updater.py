# -*- coding: utf-8 -*-
"""Apply a verified Steam Quick Sell update after the main app exits."""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path, PurePosixPath


MAX_FILES = 5000
MAX_EXTRACTED_BYTES = 250 * 1024 * 1024
REQUIRED_FILES = {
    "native-ui.py",
    "updater.py",
    "update_support.py",
    "start.bat",
    "package.json",
    "src/main.js",
}


class ApplyError(RuntimeError):
    pass


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_relative_path(value):
    text = str(value or "")
    if not text or "\\" in text or "\x00" in text:
        raise ApplyError(f"更新包包含无效路径：{text!r}")
    path = PurePosixPath(text)
    if path.is_absolute() or ".." in path.parts or "." in path.parts:
        raise ApplyError(f"更新包包含不安全路径：{text}")
    if any(part.endswith(":") for part in path.parts):
        raise ApplyError(f"更新包包含不安全路径：{text}")
    return Path(*path.parts)


def wait_for_process(pid, timeout_seconds=45):
    if pid <= 0 or pid == os.getpid() or os.name != "nt":
        return
    synchronize = 0x00100000
    wait_object_0 = 0x00000000
    wait_timeout = 0x00000102
    handle = ctypes.windll.kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        return
    try:
        result = ctypes.windll.kernel32.WaitForSingleObject(
            handle, int(timeout_seconds * 1000)
        )
        if result == wait_timeout:
            raise ApplyError("等待旧版本退出超时")
        if result != wait_object_0:
            raise ApplyError("无法确认旧版本已经退出")
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def load_and_extract(package_path, staging_dir, expected_version):
    with zipfile.ZipFile(package_path, "r") as archive:
        infos = archive.infolist()
        if len(infos) > MAX_FILES:
            raise ApplyError("更新包文件数量超过限制")
        total_size = sum(info.file_size for info in infos)
        if total_size > MAX_EXTRACTED_BYTES:
            raise ApplyError("更新包解压后超过允许大小")

        regular_names = set()
        for info in infos:
            relative = safe_relative_path(info.filename.rstrip("/"))
            if info.is_dir():
                continue
            mode = (info.external_attr >> 16) & 0o170000
            if mode == 0o120000:
                raise ApplyError("更新包不能包含符号链接")
            regular_names.add(relative.as_posix())

        if "update-manifest.json" not in regular_names:
            raise ApplyError("更新包缺少 update-manifest.json")
        manifest_bytes = archive.read("update-manifest.json")
        try:
            manifest = json.loads(manifest_bytes.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ApplyError("更新清单无法解析") from error

        if str(manifest.get("version") or "") != expected_version:
            raise ApplyError("更新清单版本与下载版本不一致")
        entries = manifest.get("files")
        if not isinstance(entries, list) or not entries:
            raise ApplyError("更新清单没有文件列表")
        if len(entries) > MAX_FILES:
            raise ApplyError("更新清单文件数量超过限制")

        manifest_names = set()
        manifest_name_keys = set()
        normalized_entries = []
        for entry in entries:
            if not isinstance(entry, dict):
                raise ApplyError("更新清单文件条目格式不正确")
            relative = safe_relative_path(entry.get("path"))
            relative_text = relative.as_posix()
            checksum = str(entry.get("sha256") or "").lower()
            if (
                len(checksum) != 64
                or any(character not in "0123456789abcdef" for character in checksum)
            ):
                raise ApplyError(f"更新清单校验值无效：{relative_text}")
            relative_key = relative_text.lower()
            if relative_key in manifest_name_keys:
                raise ApplyError(f"更新清单包含重复文件：{relative_text}")
            if relative_text not in regular_names:
                raise ApplyError(f"更新包缺少文件：{relative_text}")
            manifest_names.add(relative_text)
            manifest_name_keys.add(relative_key)
            normalized_entries.append((relative, checksum))

        unexpected = regular_names - manifest_names - {"update-manifest.json"}
        if unexpected:
            raise ApplyError(f"更新包包含未登记文件：{sorted(unexpected)[0]}")
        if not REQUIRED_FILES.issubset(manifest_names):
            missing = sorted(REQUIRED_FILES - manifest_names)
            raise ApplyError(f"更新包缺少程序核心文件：{', '.join(missing)}")

        staging_dir.mkdir(parents=True, exist_ok=True)
        for relative, checksum in normalized_entries:
            target = staging_dir / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(relative.as_posix(), "r") as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
            if file_sha256(target) != checksum:
                raise ApplyError(f"文件校验失败：{relative.as_posix()}")
        return [relative for relative, _checksum in normalized_entries]


def json_file(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}


def dependencies_changed(app_dir, staging_dir):
    old_package = json_file(app_dir / "package.json")
    new_package = json_file(staging_dir / "package.json")
    keys = ("dependencies", "optionalDependencies")
    return any(old_package.get(key, {}) != new_package.get(key, {}) for key in keys)


def install_dependencies(app_dir, log):
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        raise ApplyError("更新需要安装依赖，但没有找到 npm")
    command = [npm, "install", "--no-audit", "--no-fund"]
    if os.name == "nt" and npm.lower().endswith((".cmd", ".bat")):
        command = ["cmd.exe", "/d", "/s", "/c", *command]
    result = subprocess.run(
        command,
        cwd=str(app_dir),
        stdout=log,
        stderr=subprocess.STDOUT,
        timeout=300,
        check=False,
    )
    if result.returncode:
        raise ApplyError(f"依赖安装失败，退出码 {result.returncode}")


def apply_files(app_dir, staging_dir, relative_paths, backup_dir):
    backed_up = []
    newly_created = []
    backup_dir.mkdir(parents=True, exist_ok=True)
    for relative in relative_paths:
        target = app_dir / relative
        if target.exists():
            backup = backup_dir / relative
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, backup)
            backed_up.append(relative)
        else:
            newly_created.append(relative)

    try:
        for relative in relative_paths:
            source = staging_dir / relative
            target = app_dir / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f"{target.name}.update-{os.getpid()}")
            shutil.copy2(source, temporary)
            os.replace(temporary, target)
    except Exception:
        rollback_files(app_dir, backup_dir, backed_up, newly_created)
        raise
    return backed_up, newly_created


def rollback_files(app_dir, backup_dir, backed_up, newly_created):
    for relative in newly_created:
        target = app_dir / relative
        if target.exists():
            target.unlink()
    for relative in backed_up:
        backup = backup_dir / relative
        target = app_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(backup, target)


def write_result(app_dir, success, version, message):
    data_dir = app_dir / ".data"
    data_dir.mkdir(parents=True, exist_ok=True)
    result_path = data_dir / "update-result.json"
    temporary = result_path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(
            {
                "success": bool(success),
                "version": version,
                "message": str(message),
                "timestamp": int(time.time()),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    os.replace(temporary, result_path)


def restart_app(app_dir):
    start_file = app_dir / "start.bat"
    if os.name == "nt" and start_file.exists():
        os.startfile(str(start_file))


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--app-dir", required=True)
    parser.add_argument("--wait-pid", type=int, default=0)
    parser.add_argument("--no-restart", action="store_true")
    parser.add_argument("--skip-dependency-install", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    app_dir = Path(args.app_dir).resolve()
    package_path = Path(args.package).resolve()
    data_dir = app_dir / ".data"
    data_dir.mkdir(parents=True, exist_ok=True)
    log_path = data_dir / "update.log"
    staging_dir = data_dir / f"update-staging-{os.getpid()}"
    backup_dir = data_dir / "update-backups" / (
        f"before-v{args.version}-{time.strftime('%Y%m%d-%H%M%S')}"
    )
    backed_up = []
    newly_created = []

    with log_path.open("a", encoding="utf-8") as log:
        try:
            print(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] 更新到 v{args.version}", file=log)
            wait_for_process(args.wait_pid)
            expected_sha256 = args.sha256.strip().lower()
            if file_sha256(package_path) != expected_sha256:
                raise ApplyError("更新包 SHA-256 校验失败")
            relative_paths = load_and_extract(
                package_path,
                staging_dir,
                args.version,
            )
            needs_dependencies = dependencies_changed(app_dir, staging_dir)
            backed_up, newly_created = apply_files(
                app_dir,
                staging_dir,
                relative_paths,
                backup_dir,
            )
            if (
                not args.skip_dependency_install
                and (
                    needs_dependencies
                    or not (app_dir / "node_modules" / "playwright-core").exists()
                )
            ):
                install_dependencies(app_dir, log)
            write_result(app_dir, True, args.version, "更新已安装完成")
            print("更新安装成功", file=log)
        except Exception as error:
            if backed_up or newly_created:
                try:
                    rollback_files(app_dir, backup_dir, backed_up, newly_created)
                except Exception as rollback_error:
                    error = ApplyError(f"{error}；回滚失败：{rollback_error}")
            write_result(app_dir, False, args.version, str(error))
            print(f"更新失败：{error}", file=log)
        finally:
            shutil.rmtree(staging_dir, ignore_errors=True)

    if not args.no_restart:
        restart_app(app_dir)


if __name__ == "__main__":
    main()
