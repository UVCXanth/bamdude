"""scripts/cleanup-betas.sh deletes obsolete beta releases — and with a release go its assets. The STEP component's
source bundle is one of them, and the notices that shipped with that beta offer it for three years: a beta release is
kept when it holds the only copy of a bundle, and deleted as before when a release that stays carries the same one
(its Docker tags and GHCR versions go either way). "The same one" is a PUBLIC copy — a published, not draft, release
whose asset is fully uploaded — with the same digest, never a name alone (Codex SRC-R3); a listing that fails stops
the script."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

from backend.tests.unit.test_update_script_repairs_loop_flag import BASH

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts" / "cleanup-betas.sh"

pytestmark = pytest.mark.skipif(BASH is None, reason="named skip: bash is not available")

BUNDLE_A = "bamdude-step-preview-sources-533f263356f9.tar"
BUNDLE_B = "bamdude-step-preview-sources-aaaaaaaaaaaa.tar"
DIGEST_A = "sha256:" + "a" * 64
DIGEST_A2 = "sha256:" + "b" * 64


def _text() -> str:
    return SCRIPT.read_text(encoding="utf-8").replace("\r\n", "\n")


def _lifted(name: str) -> str:
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", _text(), re.S | re.M)
    assert match, f"cleanup-betas.sh must define {name}()"
    return match.group(0)


def _run(tmp_path: Path, lines: list[str]) -> subprocess.CompletedProcess:
    script = tmp_path / "run.sh"
    script.write_text("\n".join(["set -euo pipefail", *lines]) + "\n", encoding="utf-8", newline="\n")
    return subprocess.run([BASH, script.as_posix()], capture_output=True, text=True, timeout=30)


def _only_copies(tmp_path: Path, targets: list[str], assets: list[tuple[str, str, str]], tag: str) -> list[str]:
    listing = "\n".join(" ".join(a) for a in assets)
    result = _run(
        tmp_path,
        [
            f"TARGETS=({' '.join(targets)})",
            f"ASSETS_BY_TAG='{listing}'",
            _lifted("is_target"),
            _lifted("only_copies"),
            f"only_copies {tag}",
        ],
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.split()


def test_the_same_public_copy_on_a_staying_release_lets_the_beta_go(tmp_path):
    assets = [("v0.8.0b1", BUNDLE_A, DIGEST_A), ("v0.8.0b1", "setup.exe", "-"), ("v0.8.0", BUNDLE_A, DIGEST_A)]
    assert _only_copies(tmp_path, ["v0.8.0b1"], assets, "v0.8.0b1") == []


def test_the_only_copy_of_a_bundle_keeps_the_beta(tmp_path):
    assets = [("v0.8.0b1", BUNDLE_B, DIGEST_A), ("v0.8.0b2", BUNDLE_B, DIGEST_A), ("v0.8.0", BUNDLE_A, DIGEST_A)]
    assert _only_copies(tmp_path, ["v0.8.0b1", "v0.8.0b2"], assets, "v0.8.0b1") == [BUNDLE_B]


@pytest.mark.parametrize(
    "other",
    [
        ("v0.8.0", BUNDLE_A, DIGEST_A2),  # the same name, other bytes (a re-issued bundle)
        ("v0.8.0", BUNDLE_A, "-"),  # a copy whose digest GitHub does not give
    ],
)
def test_a_name_alone_proves_no_copy(tmp_path, other):
    assets = [("v0.8.0b1", BUNDLE_A, DIGEST_A), other]
    assert _only_copies(tmp_path, ["v0.8.0b1"], assets, "v0.8.0b1") == [BUNDLE_A]


def test_a_beta_whose_own_digest_is_unknown_is_kept(tmp_path):
    assets = [("v0.8.0b1", BUNDLE_A, "-"), ("v0.8.0", BUNDLE_A, DIGEST_A)]
    assert _only_copies(tmp_path, ["v0.8.0b1"], assets, "v0.8.0b1") == [BUNDLE_A]


def test_other_assets_never_keep_a_release(tmp_path):
    assets = [("v0.8.0b1", "bamdude-code-graph-0.8.0b1.json.gz", "-"), ("v0.8.0b1", "notes.txt", "-")]
    assert _only_copies(tmp_path, ["v0.8.0b1"], assets, "v0.8.0b1") == []


def test_only_published_and_uploaded_assets_are_listed():
    """A maintainer's listing includes private drafts, and an upload can be unfinished: neither is a public copy."""
    body = _lifted("list_release_assets")
    assert "select(.draft | not)" in body and 'select(.state == "uploaded")' in body and ".digest" in body


def test_a_listing_that_fails_stops_the_script(tmp_path):
    result = _run(
        tmp_path,
        [
            'OWNER=kainpl REPO=bamdude; gh() { echo "HTTP 502" >&2; return 1; }',
            _lifted("list_release_assets"),
            'ASSETS_BY_TAG=$(list_release_assets) || { echo "STOPPED" >&2; exit 1; }',
            'echo "WENT ON"',
        ],
    )
    assert result.returncode == 1 and "WENT ON" not in result.stdout
    text = _text()
    assert re.search(r"ASSETS_BY_TAG=\$\(list_release_assets\) \|\| \{[^}]*exit 1", text)


def test_the_release_is_deleted_only_through_the_guard():
    text = _text()
    deletes = [line for line in text.splitlines() if "gh release delete" in line and not line.lstrip().startswith("#")]
    assert len(deletes) == 1
    loop = text[text.index('for tag in "${TARGETS[@]}"; do\n  echo ""') :]
    assert loop.index('only_copies "$tag"') < loop.index("gh release delete")
