"""scripts/pin_step_runtime.py --upstream (spec §8 repin, plan A7): the scheduled check only REPORTS — a newer
upstream release or a candidate pin old enough to become release (actions, exit 2), a new Python ABI of the pinned
release or no build yet for the next Python (notices, exit 3). It writes nothing: no pin, no golden, no PR."""

import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def _pin_script():
    spec = importlib.util.spec_from_file_location("pin_step_runtime", ROOT / "scripts" / "pin_step_runtime.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pin = _pin_script()
PINNED = "8.0.1.1.0"
NOW = datetime(2026, 10, 16, tzinfo=UTC)


def wheel(version: str, py: str, plat: str = "manylinux_2_28_x86_64", **extra) -> dict:
    return {
        "filename": f"cadquery_ocp_novtk-{version}-{py}-{py}-{plat}.whl",
        "upload_time_iso_8601": "2026-10-05T13:37:04Z",
        **extra,
    }


def pypi(**releases) -> dict:
    return {
        "info": {"version": max(releases)},
        "releases": {v.replace("_", "."): files for v, files in releases.items()},
    }


def manifest(status="release", uploaded="2026-10-05T13:37:04Z") -> dict:
    return {"status": status, "artifacts": [{"upload_time": uploaded}, {"upload_time": "2026-09-01T00:00:00Z"}]}


CURRENT = [wheel(PINNED, py) for py in ("cp311", "cp312", "cp313", "cp314")]


def test_nothing_to_report_for_the_newest_release_already_pinned():
    report = pin.upstream_report(pypi(**{PINNED: CURRENT + [wheel(PINNED, "cp315")]}), manifest(), NOW)
    assert report == {"actions": [], "notices": []}
    assert pin.upstream_exit(report) == 0


def test_a_newer_upstream_release_is_an_action():
    newer = [wheel("8.0.2.0.0", py) for py in ("cp312", "cp313", "cp314", "cp315")]
    report = pin.upstream_report(pypi(**{PINNED: CURRENT, "8.0.2.0.0": newer}), manifest(), NOW)
    assert report["actions"] == ["new_release:8.0.2.0.0"]
    assert pin.upstream_exit(report) == 2


def test_a_yanked_or_wheelless_release_is_no_release():
    yanked = [wheel("8.0.2.0.0", "cp312", yanked=True)]
    sdist = [{"filename": "cadquery_ocp_novtk-8.0.3.0.0.tar.gz", "upload_time_iso_8601": "2026-10-10T00:00:00Z"}]
    report = pin.upstream_report(
        pypi(**{PINNED: CURRENT + [wheel(PINNED, "cp315")], "8.0.2.0.0": yanked, "8.0.3.0.0": sdist}), manifest(), NOW
    )
    assert report["actions"] == []


def test_versions_compare_as_versions_not_text():
    newer = [wheel("8.0.10.0.0", "cp315")]
    report = pin.upstream_report(pypi(**{PINNED: CURRENT, "8.0.10.0.0": newer}), manifest(), NOW)
    assert report["actions"] == ["new_release:8.0.10.0.0"]


def test_a_new_python_abi_of_the_pinned_release_is_a_notice():
    report = pin.upstream_report(pypi(**{PINNED: CURRENT + [wheel(PINNED, "cp315")]}), manifest(), NOW)
    assert report["notices"] == []
    report = pin.upstream_report(pypi(**{PINNED: CURRENT + [wheel(PINNED, "cp316")]}), manifest(), NOW)
    assert "new_abi:cp316" in report["notices"]
    assert pin.upstream_exit({"actions": [], "notices": ["new_abi:cp316"]}) == 3


def test_an_abi_below_the_floor_is_never_news():
    report = pin.upstream_report(pypi(**{PINNED: CURRENT + [wheel(PINNED, "cp315")]}), manifest(), NOW)
    assert not any("cp311" in n for n in report["notices"])


def test_no_build_for_the_next_python_is_a_notice():
    report = pin.upstream_report(pypi(**{PINNED: CURRENT}), manifest(), NOW)
    assert report["notices"] == [f"no_build_for:{pin.NEXT_PYTHON}"]


def test_a_candidate_pin_old_enough_is_due_for_a_release_repin():
    young = pin.upstream_report(pypi(**{PINNED: CURRENT + [wheel(PINNED, "cp315")]}), manifest("candidate"), NOW)
    assert young["actions"] == []  # its newest artifact is 11 days old
    later = datetime(2026, 10, 19, 13, 37, 4, tzinfo=UTC)
    due = pin.upstream_report(pypi(**{PINNED: CURRENT + [wheel(PINNED, "cp315")]}), manifest("candidate"), later)
    assert due["actions"] == ["release_repin_due"]


def test_the_check_reads_a_saved_index_and_writes_nothing(tmp_path, capsys):
    index = tmp_path / "pypi.json"
    index.write_text(json.dumps(pypi(**{PINNED: CURRENT})), encoding="utf-8")
    data = ROOT / "backend" / "app" / "data"
    before = {p.name: p.read_bytes() for p in data.glob("step_runtime_*.json")}
    rc = pin.main(["--upstream", "--pypi-json", str(index), "--now", "2026-10-16T00:00:00Z"])
    report = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert rc == 3 and report["notices"] == [f"no_build_for:{pin.NEXT_PYTHON}"]
    assert {p.name: p.read_bytes() for p in data.glob("step_runtime_*.json")} == before
