"""The post-rebuild dispatch, interrupted-dispatch and tail-journal tests on PostgreSQL.

The same test bodies as their SQLite modules, collected here on independent connections to a
real server (``queue_test_database.test_engine``: a schema of its own per test). The default
suite's in-memory SQLite shares one connection, so a writer that waits on a lock its own
caller holds — a self-wait — silently joins that transaction there and hangs here
(post-rebuild D03/D08, I09, F09). Skipped unless ``DISPATCH_TEST_POSTGRES_URL`` is set; the
harness entry ``test_postgres_scenarios.py::test_post_rebuild_transactions_on_postgres``
sets it.
"""

import os

import pytest

from backend.tests.integration.queue_test_database import test_engine  # noqa: F401
from backend.tests.integration.test_direct_refusal_row import *  # noqa: F403
from backend.tests.integration.test_dispatch_attempt_outcome import *  # noqa: F403
from backend.tests.integration.test_dispatch_attempt_verdicts import *  # noqa: F403
from backend.tests.integration.test_filament_routing_dispatch import *  # noqa: F403
from backend.tests.integration.test_interrupted_dispatch import *  # noqa: F403
from backend.tests.integration.test_queue_source_failure import *  # noqa: F403
from backend.tests.integration.test_tail_refill_journal import *  # noqa: F403

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.environ.get("DISPATCH_TEST_POSTGRES_URL"), reason="runs only against PostgreSQL (see the docstring)"
    ),
]
