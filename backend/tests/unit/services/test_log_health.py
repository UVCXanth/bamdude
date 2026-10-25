"""Tests for the log-health scanner (backend/app/services/log_health.py)."""

from backend.app.core.config import settings
from backend.app.services.log_health import SIGNATURES, scan_logs


def _line(level, logger, msg, ts="2026-05-22 10:00:00,000"):
    """Build one log line in the app's log format: TS LEVEL [logger] message."""
    return f"{ts} {level} [{logger}] {msg}"


def _write_log(tmp_path, monkeypatch, lines):
    log_file = tmp_path / "bamdude.log"
    log_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    monkeypatch.setattr(settings, "log_dir", tmp_path)
    return log_file


FTP_LOGGER = "backend.app.services.bambu_ftp"
MQTT_LOGGER = "backend.app.services.bambu_mqtt"
CAM_LOGGER = "backend.app.services.camera"


def test_clean_log_has_no_findings(tmp_path, monkeypatch):
    _write_log(
        tmp_path,
        monkeypatch,
        [
            _line("INFO", "backend.app.main", "Application startup complete"),
            _line("INFO", FTP_LOGGER, "FTP connected, logging in as bblp"),
        ],
    )
    result = scan_logs()
    assert result.findings == []
    assert result.log_available is True
    assert result.scanned_entries == 2
    assert result.summary == {"total": 0, "layer8": 0, "environment": 0, "bug": 0}


def test_log_unavailable_when_file_missing(tmp_path, monkeypatch):
    # No log file written.
    monkeypatch.setattr(settings, "log_dir", tmp_path)
    result = scan_logs()
    assert result.log_available is False
    assert result.findings == []


def test_ftp_auth_rejected_is_detected(tmp_path, monkeypatch):
    _write_log(
        tmp_path,
        monkeypatch,
        [_line("WARNING", FTP_LOGGER, "FTP connection permission error to 10.0.0.9: 530 Login incorrect")],
    )
    result = scan_logs()
    assert len(result.findings) == 1
    f = result.findings[0]
    assert f.signature_id == "ftp-auth-rejected"
    assert f.severity == "error"
    assert f.category == "layer8"
    assert f.count == 1


def test_min_count_gates_low_frequency_signals(tmp_path, monkeypatch):
    # ftp-connection-timeout requires min_count=3 — two hits must not surface.
    _write_log(
        tmp_path,
        monkeypatch,
        [_line("WARNING", FTP_LOGGER, "FTP connection timed out to 10.0.0.9: timed out")] * 2,
    )
    assert scan_logs().findings == []

    _write_log(
        tmp_path,
        monkeypatch,
        [_line("WARNING", FTP_LOGGER, "FTP connection timed out to 10.0.0.9: timed out")] * 3,
    )
    findings = scan_logs().findings
    assert len(findings) == 1
    assert findings[0].signature_id == "ftp-connection-timeout"
    assert findings[0].count == 3


def test_aggregation_tracks_count_and_seen_range(tmp_path, monkeypatch):
    _write_log(
        tmp_path,
        monkeypatch,
        [
            _line("WARNING", FTP_LOGGER, "FTP connection permission error to 10.0.0.9", ts="2026-05-22 09:00:00,000"),
            _line("WARNING", FTP_LOGGER, "FTP connection permission error to 10.0.0.9", ts="2026-05-22 10:30:00,000"),
        ],
    )
    f = scan_logs().findings[0]
    assert f.count == 2
    assert f.first_seen == "2026-05-22 09:00:00,000"
    assert f.last_seen == "2026-05-22 10:30:00,000"


def test_logger_prefix_filters_unrelated_loggers(tmp_path, monkeypatch):
    # Same text, but logged by an unrelated logger — must not match the
    # bambu_ftp-scoped signature.
    _write_log(
        tmp_path,
        monkeypatch,
        [_line("WARNING", "backend.app.services.something_else", "FTP connection permission error to 10.0.0.9")],
    )
    assert scan_logs().findings == []


def test_min_level_filters_below_threshold(tmp_path, monkeypatch):
    # ftp-auth-rejected requires at least WARNING — an INFO line must not match.
    _write_log(
        tmp_path,
        monkeypatch,
        [_line("INFO", FTP_LOGGER, "FTP connection permission error to 10.0.0.9")],
    )
    assert scan_logs().findings == []


def test_sample_is_sanitized(tmp_path, monkeypatch):
    _write_log(
        tmp_path,
        monkeypatch,
        [_line("WARNING", FTP_LOGGER, "FTP connection permission error to 192.168.1.50: 530")],
    )
    f = scan_logs().findings[0]
    assert "192.168.1.50" not in f.sample
    assert "[IP]" in f.sample


def test_database_locked_matches_inside_traceback(tmp_path, monkeypatch):
    # The signature text appears on a continuation line of a multi-line entry;
    # read_log_entries folds it into the parent message.
    _write_log(
        tmp_path,
        monkeypatch,
        [
            _line("ERROR", "backend.app.core.database", "Unhandled DB error"),
            "Traceback (most recent call last):",
            "sqlite3.OperationalError: database is locked",
        ],
    )
    findings = scan_logs().findings
    assert len(findings) == 1
    assert findings[0].signature_id == "database-locked"
    assert findings[0].category == "environment"


def test_findings_sorted_layer8_then_environment(tmp_path, monkeypatch):
    _write_log(
        tmp_path,
        monkeypatch,
        [
            _line("ERROR", "backend.app.core.database", "x: database is locked"),
            _line("WARNING", FTP_LOGGER, "FTP connection timed out to 10.0.0.9"),
            _line("WARNING", FTP_LOGGER, "FTP connection timed out to 10.0.0.9"),
            _line("WARNING", FTP_LOGGER, "FTP connection timed out to 10.0.0.9"),
            _line("WARNING", FTP_LOGGER, "FTP connection permission error to 10.0.0.9"),
        ],
    )
    ids = [f.signature_id for f in scan_logs().findings]
    # layer8 error, then layer8 warning, then environment.
    assert ids == ["ftp-auth-rejected", "ftp-connection-timeout", "database-locked"]


def test_every_signature_id_is_unique():
    ids = [s.id for s in SIGNATURES]
    assert len(ids) == len(set(ids))


DISPATCH_LOGGER = "backend.app.services.background_dispatch"
TRACKER_LOGGER = "backend.app.services.dispatch_stall_tracker"


def test_a_stalled_dispatch_warning_is_a_finding(tmp_path, monkeypatch):
    """Spec printer-runtime-stall r3 R5: the tracker's one aggregated WARNING names printer and job."""
    _write_log(
        tmp_path,
        monkeypatch,
        [
            _line(
                "WARNING",
                TRACKER_LOGGER,
                "Dispatch stalled without progress: printer=7 item=11 reason=dispatch_claim_changed "
                "detail=current_run_conflict blocker_archive=19 attempts=3 span=60s",
            )
        ],
    )
    (finding,) = scan_logs().findings
    assert finding.signature_id == "dispatch-stalled" and finding.count == 1
    assert "printer=7" in finding.sample and "item=11" in finding.sample


def test_old_unattributed_deferrals_are_a_fallback_finding(tmp_path, monkeypatch):
    """A log written before the tracker: repeated INFO lines with no printer -- a cause not established."""
    lines = [
        _line("INFO", DISPATCH_LOGGER, f"Dispatch {n} deferred before publish: dispatch_claim_changed")
        for n in range(5)
    ]
    _write_log(tmp_path, monkeypatch, lines)
    (finding,) = scan_logs().findings
    assert finding.signature_id == "dispatch-deferred-unattributed" and finding.count == 5


def test_a_single_old_deferral_is_no_finding(tmp_path, monkeypatch):
    _write_log(
        tmp_path,
        monkeypatch,
        [_line("INFO", DISPATCH_LOGGER, "Dispatch 1 deferred before publish: dispatch_claim_changed")],
    )
    assert scan_logs().findings == []


def test_attributed_deferrals_are_never_counted_twice(tmp_path, monkeypatch):
    """The new INFO lines carry their printer: they belong to the tracker's WARNING, not to the fallback."""
    lines = [
        _line(
            "INFO",
            DISPATCH_LOGGER,
            f"Dispatch {n} deferred before publish: dispatch_claim_changed printer=7 item=11 "
            "detail=current_run_conflict blocker_archive=19",
        )
        for n in range(5)
    ]
    _write_log(tmp_path, monkeypatch, lines)
    assert scan_logs().findings == []


def test_other_signatures_still_ignore_info(tmp_path, monkeypatch):
    """The fallback lowers its own level only: an INFO FTP line is still no finding."""
    _write_log(tmp_path, monkeypatch, [_line("INFO", FTP_LOGGER, "FTP connection permission error to x")])
    assert scan_logs().findings == []
