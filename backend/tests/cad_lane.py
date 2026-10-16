"""The ``requires_cad`` lane (spec §9, plan A1): a test that needs the installed STEP-preview bundle.

Without a usable bundle such a test is a NAMED skip; under ``BAMDUDE_REQUIRE_CAD=1`` it is a failure, so a strict
CI lane can never pass by skipping its geometry. Tests that prove behaviour WITHOUT CAD (missing-CAD regression)
carry no marker and never skip. ``BAMDUDE_STEP_TEST_APP_DIR`` points the lane at another app dir (its own tests).
Hooks are re-exported by backend/tests/conftest.py and loadable on their own with ``-p backend.tests.cad_lane``.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

_found = None


def cad_app_dir() -> Path:
    return Path(os.environ.get("BAMDUDE_STEP_TEST_APP_DIR") or Path(__file__).resolve().parents[2])


def located():
    global _found
    if _found is None:
        from backend.app import step_runtime

        _found = step_runtime.locate(cad_app_dir())
    return _found


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "requires_cad: needs the installed STEP-preview bundle; named skip without it, failure under "
        "BAMDUDE_REQUIRE_CAD=1",
    )


def pytest_runtest_setup(item):
    if item.get_closest_marker("requires_cad") is None:
        return
    found = located()
    if found.ok:
        return
    message = f"requires_cad: STEP-preview bundle not usable ({found.reason})"
    if os.environ.get("BAMDUDE_REQUIRE_CAD") == "1":
        pytest.fail(message, pytrace=False)
    pytest.skip(message)
