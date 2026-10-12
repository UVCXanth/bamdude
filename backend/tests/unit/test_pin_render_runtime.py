"""scripts/pin_render_runtime.py: the pinned hashes come only from a SHASUMS256.txt a Node release key signed."""

import importlib.util
import shutil
import subprocess
import tempfile
from datetime import date
from pathlib import Path

import pytest

from backend.app.services.render_runtime import PLATFORMS, ProvisionError

ROOT = Path(__file__).resolve().parents[3]
GPG = shutil.which("gpg")
needs_gpg = pytest.mark.skipif(GPG is None, reason="no gpg on PATH")


def _pin_script():
    spec = importlib.util.spec_from_file_location("pin_render_runtime", ROOT / "scripts" / "pin_render_runtime.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pin = _pin_script()
BODY = b"0" * 64 + b"  node-v24.17.0-linux-x64.tar.xz\n"


def _signer(name: str) -> tuple[bytes, bytes]:
    """A throwaway key: (its public key, BODY clear-signed with it)."""
    with tempfile.TemporaryDirectory() as tmp:
        home = pin.gpg_home(tmp, GPG)
        base = [GPG, "--homedir", home, "--batch", "--passphrase", "", "--pinentry-mode", "loopback"]
        subprocess.run(
            [*base, "--quick-gen-key", f"{name} <{name}@example.invalid>", "ed25519", "sign", "never"],
            check=True,
            capture_output=True,
        )
        public = subprocess.run([*base, "--armor", "--export"], check=True, capture_output=True).stdout
        signed = subprocess.run([*base, "--clearsign"], input=BODY, check=True, capture_output=True).stdout
    return public, signed


@needs_gpg
def test_a_body_signed_by_a_release_key_is_returned():
    public, signed = _signer("releaser")
    assert pin.verify_shasums(signed, public, GPG).encode() == BODY


@needs_gpg
def test_a_tampered_body_is_refused():
    public, signed = _signer("releaser")
    tampered = signed.replace(b"0" * 64, b"1" * 64)
    with pytest.raises(ProvisionError, match="signature"):
        pin.verify_shasums(tampered, public, GPG)


@needs_gpg
def test_a_body_signed_by_another_key_is_refused():
    release_key, _ = _signer("releaser")
    _, by_stranger = _signer("stranger")
    with pytest.raises(ProvisionError, match="signature"):
        pin.verify_shasums(by_stranger, release_key, GPG)


def test_the_vendored_release_keys_are_there():
    keys = (ROOT / "scripts" / "node-release-keys.asc").read_text(encoding="ascii")
    assert keys.count("-----BEGIN PGP PUBLIC KEY BLOCK-----") >= 20


RELEASES = [
    {"version": "v26.1.0", "lts": False, "security": False},
    {"version": "v24.21.0", "lts": "Krypton", "security": False},
    {"version": "v24.18.1", "lts": "Krypton", "security": True},
    {"version": "v24.17.0", "lts": "Krypton", "security": True},
    {"version": "v24.10.0", "lts": False, "security": False},
    {"version": "v22.23.3", "lts": "Jod", "security": False},
    {"version": "v22.23.2", "lts": "Jod", "security": True},
]
SCHEDULE = {
    "v22": {"start": "2024-04-24", "lts": "2024-10-29", "end": "2027-04-30"},
    "v24": {"start": "2025-05-06", "lts": "2025-10-28", "end": "2028-04-30"},
    "v26": {"start": "2026-05-05", "lts": "2026-10-28", "end": "2029-04-30"},
}
TODAY = date(2026, 10, 13)


def _pinned(**versions: str) -> dict:
    return {"lines": {line: {"version": v} for line, v in versions.items()}}


def test_every_platform_is_on_exactly_one_line():
    on = [key for platforms in pin.LINES.values() for key in platforms]
    assert sorted(on) == sorted(PLATFORMS)


def test_the_newest_lts_patch_of_a_line_is_chosen():
    assert pin.newest_patch(RELEASES, "24") == "v24.21.0"  # v26.1.0 is no LTS, v24.10.0 neither


def test_a_line_past_its_end_of_life_is_refused():
    with pytest.raises(pin.PinError, match="end of life"):
        pin.plan_versions(RELEASES, SCHEDULE, date(2028, 5, 1), {})


def test_an_override_names_a_line_of_the_table():
    with pytest.raises(pin.PinError, match="no line"):
        pin.plan_versions(RELEASES, SCHEDULE, TODAY, {"20": "v20.1.0"})


@pytest.mark.parametrize("override", ["v22.23.3", "v26.1.0", "v24.10.0", "v24.not-a-version", "v24.99.0"])
def test_an_override_must_be_a_published_lts_of_its_line(override):
    # consilium NL-R2: another line's release, a non-LTS major, a pre-LTS patch, a malformed and an unpublished
    # version -- all refused before anything is downloaded
    with pytest.raises(pin.PinError):
        pin.plan_versions(RELEASES, SCHEDULE, TODAY, {"24": override})


def test_an_older_lts_patch_of_the_line_is_a_valid_override():
    # the way back from a patch that broke the renderer (spec D6); the weekly check reports it as behind
    assert pin.plan_versions(RELEASES, SCHEDULE, TODAY, {"24": "v24.17.0"})["24"]["version"] == "v24.17.0"


def test_check_reports_a_pin_behind_and_the_security_releases_it_missed():
    report = pin.check(_pinned(**{"24": "v24.17.0"}), RELEASES, SCHEDULE, TODAY)
    entry = report["lines"]["24"]
    assert entry["behind"] and entry["newest"] == "v24.21.0"
    assert entry["missed_security"] == ["v24.18.1"]
    assert report["repin"] and report["action"]


def test_check_on_a_current_pin_asks_nothing():
    current = {line: pin.newest_patch(RELEASES, line) for line in pin.LINES}
    report = pin.check(_pinned(**current), RELEASES, SCHEDULE, TODAY)
    assert not report["action"] and not report["notice"] and not report["repin"]


def test_check_names_a_new_lts_line_but_never_repins_for_it():
    current = {line: pin.newest_patch(RELEASES, line) for line in pin.LINES}
    report = pin.check(_pinned(**current), RELEASES, SCHEDULE, date(2026, 11, 2))
    assert report["new_lines"] == ["26"]
    # final review M1: a new LTS line is a notice for the maintainer, never an action the gate waits on
    assert report["notice"] and not report["action"] and not report["repin"]


def test_check_warns_ninety_days_before_a_line_ends():
    current = {line: pin.newest_patch(RELEASES, line) for line in pin.LINES}
    report = pin.check(_pinned(**current), RELEASES, SCHEDULE, date(2028, 2, 15))
    assert report["lines"]["24"]["end_soon"] and report["notice"]


def test_build_manifest_pins_each_platform_on_its_line():
    plan = {"24": {"version": "v24.21.0", "end_of_life": "2028-04-30"}}
    shasums = "\n".join(
        f"{i:064x}  node-v24.21.0-{key}.{'zip' if key == 'win-x64' else 'tar.xz'}"
        for i, key in enumerate(pin.LINES["24"])
    )
    manifest = pin.build_manifest(plan, {"v24.21.0": shasums}, TODAY, size=lambda url: 7)
    assert manifest["lines"] == plan and manifest["pinned_at"] == "2026-10-13"
    assert {entry["line"] for entry in manifest["platforms"].values()} == {"24"}
    assert manifest["platforms"]["win-x64"]["url"] == "https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip"


GOOD = {"two-objects": {"101": "a" * 64}}
OTHER = {"two-objects": {"101": "b" * 64}}


def test_versions_that_agree_make_the_golden():
    golden = pin.agreed_golden({"v24.21.0": GOOD, "v22.23.3": GOOD}, None, 3)
    assert golden == {"renderer": 3, "node": ["v22.23.3", "v24.21.0"], "png_sha256": GOOD}


def test_versions_that_render_different_pixels_are_refused():
    with pytest.raises(pin.PinError, match="RENDERER_VERSION"):
        pin.agreed_golden({"v24.21.0": GOOD, "v22.23.3": OTHER}, None, 3)


def test_a_pin_that_changes_the_pixels_of_this_renderer_is_refused():
    existing = {"renderer": 3, "node": ["v24.17.0"], "png_sha256": GOOD}
    with pytest.raises(pin.PinError, match="RENDERER_VERSION"):
        pin.agreed_golden({"v24.21.0": OTHER}, existing, 3)


def test_a_new_renderer_takes_its_new_pixels():
    existing = {"renderer": 2, "node": ["v24.17.0"], "png_sha256": GOOD}
    assert pin.agreed_golden({"v24.21.0": OTHER}, existing, 3)["png_sha256"] == OTHER


def test_the_manifest_is_written_only_after_the_golden_is_proven(tmp_path, monkeypatch):
    manifest_file, golden_file = tmp_path / "render_runtime.json", tmp_path / "golden.json"
    manifest_file.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(pin, "MANIFEST", manifest_file)
    monkeypatch.setattr(pin, "GOLDEN", golden_file)
    monkeypatch.setattr(pin, "fetch_json", lambda url: SCHEDULE if url == pin.SCHEDULE else RELEASES)
    # a fixed plan: the refusal under test is the golden's, never a line that ended by the day the test runs
    monkeypatch.setattr(
        pin, "plan_versions", lambda *args: {"24": {"version": "v24.21.0", "end_of_life": "2028-04-30"}}
    )
    monkeypatch.setattr(pin.shutil, "which", lambda name: "gpg")
    monkeypatch.setattr(pin, "signed_shasums", lambda version, gpg: "")
    monkeypatch.setattr(pin, "build_manifest", lambda plan, shasums, today: {"lines": plan, "platforms": {}})

    def refuse(*args, **kwargs):
        raise pin.PinError("Node v22.23.3 and v24.21.0 render different pixels: a RENDERER_VERSION decision")

    monkeypatch.setattr(pin, "prove_golden", refuse)
    assert pin.main([]) == 1
    assert manifest_file.read_text(encoding="utf-8") == "{}" and not golden_file.exists()


def test_an_ended_line_is_an_action():
    current = {line: pin.newest_patch(RELEASES, line) for line in pin.LINES}
    report = pin.check(_pinned(**current), RELEASES, SCHEDULE, date(2027, 5, 3))
    assert report["lines"]["22"]["ended"] and report["action"] and not report["repin"]


@pytest.mark.parametrize(
    ("report", "code"),
    [
        ({"action": False, "notice": False}, 0),
        ({"action": True, "notice": False}, 2),
        ({"action": True, "notice": True}, 2),
        ({"action": False, "notice": True}, 3),
    ],
)
def test_the_check_exit_code_tells_an_action_from_a_notice(report, code):
    assert pin.check_exit_code(report) == code


def test_a_new_fixture_joins_the_golden_of_the_same_renderer():
    # final review M2: only a fixture or object present in both may not differ; an added fixture is no pixel change
    existing = {"renderer": 3, "node": ["v24.21.0"], "png_sha256": GOOD}
    grown = {**GOOD, "new-fixture": {"1": "c" * 64}}
    assert pin.agreed_golden({"v24.21.0": grown}, existing, 3)["png_sha256"] == grown


@pytest.mark.parametrize("item", ["24", "=v24.1.0", "x=v24.1.0", "24="])
def test_a_malformed_line_override_is_refused(item):
    with pytest.raises(pin.PinError, match="LINE=vX.Y.Z"):
        pin.parse_lines([item])


def test_a_line_override_parses():
    assert pin.parse_lines(["24=v24.17.0", "22=v22.23.3"]) == {"24": "v24.17.0", "22": "v22.23.3"}


@pytest.mark.parametrize("mode", ["--check", "--golden"])
def test_a_line_override_does_not_combine_with_check_or_golden(mode):
    with pytest.raises(SystemExit):
        pin.main([mode, "--line", "24=v24.17.0"])


def _official(versions_lines: dict[str, str]) -> tuple[dict, dict]:
    """A manifest pinned exactly as the pin script would, and the (unsigned, test-only) SHASUMS bodies behind it."""
    plan = {line: {"version": version, "end_of_life": "2028-04-30"} for line, version in versions_lines.items()}
    shasums = {
        version: "\n".join(
            f"{i:064x}  node-{version}-{key}.{'zip' if key == 'win-x64' else 'tar.xz'}"
            for i, key in enumerate(pin.LINES[line])
        )
        for line, version in versions_lines.items()
    }
    return pin.build_manifest(plan, shasums, TODAY, size=lambda url: 7), shasums


def test_a_manifest_made_from_the_signed_sums_verifies():
    manifest, shasums = _official({"24": "v24.21.0", "22": "v22.23.3"})
    pin.verify_manifest(manifest, shasums)


def test_a_tampered_archive_hash_is_refused_by_verify():
    # final review I1: the job that pushes re-checks what the job that made the pin wrote
    manifest, shasums = _official({"24": "v24.21.0", "22": "v22.23.3"})
    manifest["platforms"]["win-x64"]["sha256"] = "f" * 64
    with pytest.raises(pin.PinError, match="win-x64"):
        pin.verify_manifest(manifest, shasums)


def test_a_platform_on_another_line_is_refused_by_verify():
    manifest, shasums = _official({"24": "v24.21.0", "22": "v22.23.3"})
    manifest["platforms"]["linux-armv7l"]["line"] = "24"
    with pytest.raises(pin.PinError, match="linux-armv7l"):
        pin.verify_manifest(manifest, shasums)


def test_a_missing_platform_is_refused_by_verify():
    manifest, shasums = _official({"24": "v24.21.0", "22": "v22.23.3"})
    del manifest["platforms"]["darwin-x64"]
    with pytest.raises(pin.PinError, match="darwin-x64"):
        pin.verify_manifest(manifest, shasums)
