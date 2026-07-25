# -*- coding: utf-8 -*-
"""GitHub Release update helpers for Steam Quick Sell."""

from __future__ import annotations

import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


GITHUB_OWNER = "kristong769-maker"
GITHUB_REPOSITORY = "efficient_sell"
LATEST_RELEASE_API = (
    f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPOSITORY}/releases/latest"
)
USER_AGENT = "efficent_sell-updater"
MAX_RELEASE_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_CHECKSUM_BYTES = 256 * 1024
MAX_UPDATE_BYTES = 150 * 1024 * 1024
SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")


class UpdateError(RuntimeError):
    """A user-facing update error."""


def parse_version(value):
    """Return a comparable numeric version tuple."""
    text = str(value or "").strip()
    match = re.fullmatch(r"[vV]?(\d+(?:\.\d+){1,3})(?:[-+][0-9A-Za-z.-]+)?", text)
    if not match:
        raise UpdateError(f"无法识别版本号：{text or '空值'}")
    parts = [int(part) for part in match.group(1).split(".")]
    while len(parts) < 4:
        parts.append(0)
    return tuple(parts)


def is_newer_version(candidate, current):
    return parse_version(candidate) > parse_version(current)


def _request(url, accept):
    return urllib.request.Request(
        url,
        headers={
            "Accept": accept,
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )


def _read_limited(response, limit):
    content_length = response.headers.get("Content-Length")
    if content_length:
        try:
            if int(content_length) > limit:
                raise UpdateError("服务器返回的数据超过允许大小")
        except ValueError:
            pass
    data = response.read(limit + 1)
    if len(data) > limit:
        raise UpdateError("服务器返回的数据超过允许大小")
    return data


def fetch_latest_release(api_url=LATEST_RELEASE_API, timeout=10):
    try:
        with urllib.request.urlopen(
            _request(api_url, "application/vnd.github+json"),
            timeout=timeout,
        ) as response:
            payload = _read_limited(response, MAX_RELEASE_RESPONSE_BYTES)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise UpdateError("GitHub 上还没有可用的正式 Release") from error
        if error.code == 403:
            raise UpdateError("GitHub 暂时限制了更新检查，请稍后重试") from error
        raise UpdateError(f"检查更新失败：GitHub 返回 HTTP {error.code}") from error
    except urllib.error.URLError as error:
        raise UpdateError(f"检查更新失败：{error.reason}") from error

    try:
        release = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UpdateError("GitHub 返回了无法解析的版本信息") from error
    return release


def _asset_digest(asset):
    digest = str(asset.get("digest") or "").strip()
    if digest.lower().startswith("sha256:"):
        value = digest.split(":", 1)[1].strip().lower()
        if SHA256_PATTERN.fullmatch(value):
            return value
    return None


def _validate_repository_download_url(url):
    parsed = urllib.parse.urlparse(str(url or ""))
    expected_prefix = f"/{GITHUB_OWNER}/{GITHUB_REPOSITORY}/releases/download/"
    if (
        parsed.scheme.lower() != "https"
        or parsed.hostname not in {"github.com", "www.github.com"}
        or not parsed.path.startswith(expected_prefix)
    ):
        raise UpdateError("Release 包下载地址不属于指定的 GitHub 仓库")
    return url


def select_release_update(release, current_version):
    if not isinstance(release, dict):
        raise UpdateError("GitHub Release 数据格式不正确")
    if release.get("draft") or release.get("prerelease"):
        raise UpdateError("最新版本不是正式发布版本")

    tag_name = str(release.get("tag_name") or "").strip()
    version = tag_name.lstrip("vV")
    parse_version(version)
    html_url = str(release.get("html_url") or "").strip()
    assets = release.get("assets") if isinstance(release.get("assets"), list) else []

    expected_name = f"efficent_sell-v{version}.zip".lower()
    zip_assets = [
        asset
        for asset in assets
        if isinstance(asset, dict)
        and str(asset.get("name") or "").lower().endswith(".zip")
    ]
    zip_asset = next(
        (
            asset
            for asset in zip_assets
            if str(asset.get("name") or "").lower() == expected_name
        ),
        zip_assets[0] if zip_assets else None,
    )

    result = {
        "version": version,
        "tag": tag_name,
        "is_newer": is_newer_version(version, current_version),
        "html_url": html_url,
        "notes": str(release.get("body") or "").strip(),
        "zip_name": None,
        "zip_url": None,
        "sha256": None,
        "checksum_url": None,
    }
    if not zip_asset:
        return result

    zip_name = str(zip_asset.get("name") or "").strip()
    zip_url = _validate_repository_download_url(
        str(zip_asset.get("browser_download_url") or "").strip()
    )
    checksum_names = {
        f"{zip_name}.sha256".lower(),
        f"{Path(zip_name).stem}.sha256".lower(),
    }
    checksum_asset = next(
        (
            asset
            for asset in assets
            if isinstance(asset, dict)
            and str(asset.get("name") or "").lower() in checksum_names
        ),
        None,
    )
    result.update(
        {
            "zip_name": zip_name,
            "zip_url": zip_url,
            "sha256": _asset_digest(zip_asset),
            "checksum_url": (
                _validate_repository_download_url(
                    str(checksum_asset.get("browser_download_url") or "").strip()
                )
                if checksum_asset
                else None
            ),
        }
    )
    return result


def download_text(url, timeout=20):
    _validate_repository_download_url(url)
    try:
        with urllib.request.urlopen(
            _request(url, "application/octet-stream"),
            timeout=timeout,
        ) as response:
            data = _read_limited(response, MAX_CHECKSUM_BYTES)
    except (urllib.error.HTTPError, urllib.error.URLError) as error:
        raise UpdateError(f"无法下载更新校验文件：{error}") from error
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise UpdateError("更新校验文件不是有效文本") from error


def parse_sha256_file(text, expected_filename):
    candidates = []
    expected_lower = expected_filename.lower()
    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split()
        checksum = parts[0].lower() if parts else ""
        if not SHA256_PATTERN.fullmatch(checksum):
            continue
        filename = parts[-1].lstrip("*") if len(parts) > 1 else ""
        candidates.append((checksum, filename))
        if filename.lower() == expected_lower:
            return checksum
    if len(candidates) == 1:
        return candidates[0][0]
    raise UpdateError("校验文件中没有找到更新包对应的 SHA-256")


def download_file(url, destination, timeout=60, progress=None):
    _validate_repository_download_url(url)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".part")
    try:
        with urllib.request.urlopen(
            _request(url, "application/octet-stream"),
            timeout=timeout,
        ) as response, temporary.open("wb") as output:
            content_length = response.headers.get("Content-Length")
            total = int(content_length) if content_length and content_length.isdigit() else 0
            if total > MAX_UPDATE_BYTES:
                raise UpdateError("更新包超过允许大小")
            received = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                received += len(chunk)
                if received > MAX_UPDATE_BYTES:
                    raise UpdateError("更新包超过允许大小")
                output.write(chunk)
                if progress:
                    progress(received, total)
        temporary.replace(destination)
        return destination
    except (urllib.error.HTTPError, urllib.error.URLError) as error:
        raise UpdateError(f"下载更新包失败：{error}") from error
    finally:
        if temporary.exists():
            temporary.unlink()


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
