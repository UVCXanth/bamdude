"""Every migration has its own version, and the version is the number in its file name.

Two branches that each add "the next" migration pick the same number; their
file names differ, so git merges both without a conflict. The runner keys on
``version`` and ``_migrations.version`` is UNIQUE: a fresh database applies
both and crashes recording the second, and a database that already holds the
other one silently skips this one. This test turns that merge into a red build.
"""

from collections import Counter

from backend.app.migrations import _discover_migrations


def test_no_two_migrations_share_a_version():
    versions = Counter(m["version"] for m in _discover_migrations())
    assert [v for v, n in versions.items() if n > 1] == []


def test_each_version_is_the_number_in_its_file_name():
    for migration in _discover_migrations():
        module_name = migration["module"].__name__.rsplit(".", 1)[-1]
        assert int(module_name[1:4]) == migration["version"], module_name
