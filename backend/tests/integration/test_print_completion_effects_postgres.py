"""The actual callback admission and completion scope on disposable PostgreSQL."""

import pytest
from sqlalchemy import event

from backend.app.core.database import _strip_tz_from_params
from backend.tests.integration.test_embedded_postgres_live import live_settings  # noqa: F401
from backend.tests.integration.test_print_completion_effect_lifetime import (
    test_actual_completion_backgrounds_run_after_callback as exercise_completion,
    test_prepared_dispatch_first_start_notifies_once as exercise_start,
)
from backend.tests.integration.test_printer_status_batch_postgres import test_engine  # noqa: F401

pytest.importorskip("embedded_postgres")
pytestmark = [pytest.mark.integration, pytest.mark.slow]


async def test_actual_start_and_completion_on_postgres(
    test_engine, db_session, printer_factory, archive_factory, tmp_path, monkeypatch
):
    # The disposable fixture builds a raw engine; production installs this
    # adapter so aware UTC datetimes bind to its timestamp columns correctly.
    event.listen(test_engine.sync_engine, "before_cursor_execute", _strip_tz_from_params, retval=True)
    try:
        await exercise_start(test_engine, printer_factory, archive_factory, monkeypatch, None)
        await exercise_completion(test_engine, db_session, printer_factory, archive_factory, tmp_path, monkeypatch)
    finally:
        event.remove(test_engine.sync_engine, "before_cursor_execute", _strip_tz_from_params)
