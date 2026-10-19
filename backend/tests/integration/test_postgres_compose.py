"""Opt-in live test of the shipped PostgreSQL Compose override.

TEST_POSTGRES_COMPOSE=1 requires Docker Compose and uses only a disposable
project/volume, with no published ports or application data mounts.
"""

import copy
import json
import os
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest

pytestmark = pytest.mark.integration
REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.parametrize("existing_database", [False, True], ids=["fresh", "existing"])
def test_statistics_setup_preserves_database_and_is_repeatable(tmp_path, existing_database):
    if os.environ.get("TEST_POSTGRES_COMPOSE") != "1":
        pytest.skip("requires TEST_POSTGRES_COMPOSE=1 and Docker Compose")
    project = f"bd-stats-test-{uuid4().hex[:12]}"
    env = {
        **os.environ,
        "POSTGRES_USER": "stats_owner",
        "POSTGRES_PASSWORD": "disposable-test-password",
        "POSTGRES_DB": "stats_db",
        "DATABASE_URL": "",
    }
    overlay = tmp_path / "app-stub.json"
    overlay.write_text(json.dumps({"services": {"bamdude": {"image": "postgres:18", "command": ["true"]}}}))

    def compose(*args, files=None):
        command = ["docker", "compose", "-p", project]
        for path in files or [tmp_path / "compose.json"]:
            command.extend(["-f", str(path)])
        result = subprocess.run(  # noqa: S603 — fixed CLI, disposable project
            [*command, *args], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=120
        )
        assert result.returncode == 0, result.stdout + result.stderr
        return result.stdout.strip()

    config = json.loads(
        compose("config", "--format", "json", files=[REPO_ROOT / "docker-compose.postgres.yml", overlay])
    )
    postgres = config["services"]["postgres"]
    postgres.pop("container_name", None)
    postgres.pop("ports", None)
    postgres["healthcheck"]["interval"] = "1s"
    config["networks"]["default"]["internal"] = True
    config_path = tmp_path / "compose.json"
    config_path.write_text(json.dumps(config))

    def sql(statement):
        return compose(
            "exec",
            "-T",
            "postgres",
            "psql",
            "-XAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "stats_owner",
            "-d",
            "stats_db",
            "-c",
            statement,
        )

    try:
        if existing_database:
            legacy = copy.deepcopy(config)
            legacy["services"]["postgres"]["command"] = ["postgres"]
            legacy_path = tmp_path / "legacy.json"
            legacy_path.write_text(json.dumps(legacy))
            compose("up", "-d", "--wait", "--no-deps", "postgres", files=[legacy_path])
            assert sql("SHOW shared_preload_libraries") == ""
            sql("CREATE TABLE preserved_data (value integer); INSERT INTO preserved_data VALUES (42)")

        # Keep the real dependency chain; the application stub must start only
        # after the statistics job exits successfully.
        compose("up", "-d")
        assert sql("SHOW shared_preload_libraries") == "pg_stat_statements"
        assert sql("SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements'") == "1"
        assert int(sql("SELECT count(*) FROM pg_stat_statements")) >= 0
        if existing_database:
            assert sql("SELECT value FROM preserved_data") == "42"

        compose("up", "-d")
        assert sql("SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements'") == "1"
        assert int(sql("SELECT count(*) FROM pg_stat_statements")) >= 0
    finally:
        compose("down", "--volumes")
