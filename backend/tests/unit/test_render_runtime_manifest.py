"""The Node pin (part-render-node-lines-spec D1): lines with one version each, every platform on one line."""

import json
import re
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

from backend.app.services.render_runtime import MANIFEST, PLATFORMS, pinned_version

LINE_OF = dict.fromkeys(("linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win-x64"), "24")


def _manifest() -> dict:
    return json.loads(Path(MANIFEST).read_text(encoding="utf-8"))


def test_the_manifest_pins_lines_not_platforms():
    data = _manifest()
    assert data["product"] == "node"
    assert data["source"] == "nodejs.org/dist"
    assert "version" not in data  # one version per LINE (D1), never per manifest or per platform
    date.fromisoformat(data["pinned_at"])
    for line, pin in data["lines"].items():
        assert re.fullmatch(rf"v{line}\.\d+\.\d+", pin["version"]), line
        date.fromisoformat(pin["end_of_life"])


def test_every_platform_is_pinned_on_its_line_with_a_hashed_official_archive():
    data = _manifest()
    assert set(data["platforms"]) == set(PLATFORMS)
    for key, entry in data["platforms"].items():
        assert entry["line"] == LINE_OF[key], key
        version = pinned_version(data, key)
        suffix = "zip" if key == "win-x64" else "tar.xz"
        url = urlparse(entry["url"])
        assert url.scheme == "https", key
        assert url.hostname == "nodejs.org", key
        assert url.path == f"/dist/{version}/node-{version}-{key}.{suffix}", key
        assert re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]), key
        assert isinstance(entry["bytes"], int) and entry["bytes"] > 0, key
