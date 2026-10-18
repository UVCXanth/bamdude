"""scripts/cleanup-betas.sh deletes obsolete beta releases — and with a release go its assets. The STEP component's
source bundle is one of them, and the notices that shipped with that beta offer it for three years: a beta release is
kept when it holds the only copy of a bundle, and deleted as before when a release that stays carries the same one
(its Docker tags and GHCR versions go either way)."""

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


def _lifted(name: str) -> str:
    text = SCRIPT.read_text(encoding="utf-8").replace("\r\n", "\n")
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", text, re.S | re.M)
    assert match, f"cleanup-betas.sh must define {name}()"
    return match.group(0)


def _only_copies(tmp_path: Path, targets: list[str], assets: list[tuple[str, str]], tag: str) -> list[str]:
    listing = "\n".join(f"{t} {n}" for t, n in assets)
    program = "\n".join(
        [
            "set -euo pipefail",
            f"TARGETS=({' '.join(targets)})",
            f"ASSETS_BY_TAG='{listing}'",
            _lifted("is_target"),
            _lifted("only_copies"),
            f"only_copies {tag}",
        ]
    )
    script = tmp_path / "run.sh"
    script.write_text(program, encoding="utf-8", newline="\n")
    result = subprocess.run([BASH, script.as_posix()], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    return result.stdout.split()


def test_a_bundle_a_staying_release_carries_lets_the_beta_go(tmp_path):
    assets = [("v0.8.0b1", BUNDLE_A), ("v0.8.0b1", "bamdude-0.8.0b1-windows-x64-setup.exe"), ("v0.8.0", BUNDLE_A)]
    assert _only_copies(tmp_path, ["v0.8.0b1"], assets, "v0.8.0b1") == []


def test_the_only_copy_of_a_bundle_keeps_the_beta(tmp_path):
    assets = [("v0.8.0b1", BUNDLE_B), ("v0.8.0b2", BUNDLE_B), ("v0.8.0", BUNDLE_A)]
    assert _only_copies(tmp_path, ["v0.8.0b1", "v0.8.0b2"], assets, "v0.8.0b1") == [BUNDLE_B]


def test_other_assets_never_keep_a_release(tmp_path):
    assets = [("v0.8.0b1", "bamdude-code-graph-0.8.0b1.json.gz"), ("v0.8.0b1", "notes.txt")]
    assert _only_copies(tmp_path, ["v0.8.0b1"], assets, "v0.8.0b1") == []


def test_the_release_is_deleted_only_through_the_guard():
    text = SCRIPT.read_text(encoding="utf-8")
    deletes = [line for line in text.splitlines() if "gh release delete" in line and not line.lstrip().startswith("#")]
    assert len(deletes) == 1
    loop = text[text.index('for tag in "${TARGETS[@]}"; do\n  echo ""') :]
    assert loop.index('only_copies "$tag"') < loop.index("gh release delete")
    assert "ASSETS_BY_TAG=$(gh api --paginate" in text
