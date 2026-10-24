"""The telemetry day-window tests on PostgreSQL (telemetry-day-window spec T08).

The same bodies as ``test_telemetry_day_window.py`` on a real server
(``queue_test_database.test_engine``: a schema of its own per test), so the boundary rows are
compared by PostgreSQL itself, with the aware UTC bounds going through asyncpg. Skipped unless
``DISPATCH_TEST_POSTGRES_URL`` is set; the harness entry
``test_postgres_scenarios.py::test_telemetry_day_window_on_postgres`` sets it.
"""

import os

import pytest

from backend.tests.integration.queue_test_database import test_engine  # noqa: F401
from backend.tests.integration.test_telemetry_day_window import *  # noqa: F403

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.environ.get("DISPATCH_TEST_POSTGRES_URL"), reason="runs only against PostgreSQL (see the docstring)"
    ),
]
