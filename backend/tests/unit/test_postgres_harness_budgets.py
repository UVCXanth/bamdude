"""An outer watchdog must let a nested PostgreSQL suite report and reap its child."""

import ast
import configparser
import shlex
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]


def nested_budgets(source, default):
    for function in ast.parse(source).body:
        if not isinstance(function, ast.FunctionDef) or not function.name.startswith("test_"):
            continue
        outer = default
        for decorator in function.decorator_list:
            if isinstance(decorator, ast.Call) and ast.unparse(decorator.func) == "pytest.mark.timeout":
                outer = ast.literal_eval(decorator.args[0])
        for call in ast.walk(function):
            if isinstance(call, ast.Call) and ast.unparse(call.func) == "subprocess.run":
                timeout = next(keyword.value for keyword in call.keywords if keyword.arg == "timeout")
                yield function.name, outer, ast.literal_eval(timeout)


def test_outer_watchdogs_leave_nested_suites_time_to_report_their_result():
    config = configparser.ConfigParser()
    config.read(ROOT / "backend/tests/pytest.ini")
    default = next(
        int(arg.split("=", 1)[1]) for arg in shlex.split(config["pytest"]["addopts"]) if arg.startswith("--timeout=")
    )
    source = (ROOT / "backend/tests/integration/test_postgres_scenarios.py").read_text(encoding="utf-8")
    budgets = list(nested_budgets(source, default))
    assert budgets, "the nested-suite guard must inspect actual subprocess launches"
    for name, outer, child in budgets:
        assert outer > child, f"{name}: outer watchdog {outer}s kills the child before its {child}s budget"

    workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8"))
    step = next(
        step
        for job in workflow["jobs"].values()
        for step in job.get("steps", [])
        if step.get("name") == "Run PostgreSQL scenarios"
    )
    assert step["timeout-minutes"] * 60 > max(outer for _, outer, _ in budgets)
