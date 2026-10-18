"""The real Windows installer script (spec stage B R1–R3, R7, R9; plan Tasks 4–5): the service state is read
positively from the SCM, the installed payload is left alone unless BamDude is proven absent or stopped, only the
Node runtime is replaced whole, the install directory limit is the generated one, and no silent path opens a window
nobody can answer. Static reads of the files that ship; the behaviour of the compiled installer is accepted on a
Windows runner (plan Task 7)."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ISS = (ROOT / "installers" / "windows" / "bamdude.iss").read_text(encoding="utf-8")


def _section(name: str) -> str:
    match = re.search(rf"^\[{name}\]\n(.*?)(?=^\[\w+\]\n|\Z)", ISS, re.M | re.S)
    assert match, name
    return match.group(1)


def _entries(name: str) -> list[str]:
    return [line.strip() for line in _section(name).splitlines() if line.strip() and not line.strip().startswith(";")]


def _routine(name: str) -> str:
    code = _section("Code")
    match = re.search(rf"^(function|procedure) {name}\b.*?^end;", code, re.M | re.S)
    assert match, name
    return match.group(0)


def test_install_delete_removes_only_the_node_runtime():
    assert _entries("InstallDelete") == ['Type: filesandordirs; Name: "{app}\\app\\runtime\\node"']


def test_nothing_in_the_installer_deletes_the_cad_runtime():
    assert "step-preview" not in _section("InstallDelete")
    for line in _section("Code").splitlines():
        if re.search(r"\b(DelTree|DeleteFile|RemoveDir)\b", line):
            assert "step-preview" not in line and "runtime" not in line, line


def test_service_state_comes_from_the_scm_api():
    code = _section("Code")
    for api in ("OpenSCManagerW", "OpenServiceW", "QueryServiceStatus", "ControlService", "CloseServiceHandle"):
        assert re.search(rf"external '{api}@advapi32\.dll stdcall'", code), api
    statements = re.sub(r"//[^\n]*", "", code)
    assert "sc.exe" not in statements and "'query " not in statements  # no text parsed, no exit code guessed at
    state = _routine("ServiceState")
    assert re.search(r"Result := SvcUnknown;", state)  # anything not positively read is unknown
    assert re.search(r"=\s*ERROR_SERVICE_DOES_NOT_EXIST\s+then\s+Result := SvcAbsent", state)
    assert re.search(r"ERROR_SERVICE_DOES_NOT_EXIST\s*=\s*1060", code)
    assert state.count("SvcAbsent") == 1  # 1060 is the only way to "absent"


def test_prepare_refuses_unless_bamdude_is_absent_or_stopped():
    prepare = _routine("PrepareToInstall")
    limit = prepare.index("Length(ExpandConstant('{app}')) > {#StepMaxAppDirLen}")
    grace = prepare.index("set BamDude AppStopMethodConsole 90000")
    stop = prepare.index("StopServiceAndWait('BamDude', 100)")
    pg = prepare.index("StopServiceAndWait('BamDudePostgres'")
    assert limit < grace < stop < pg  # the limit refuses before anything is stopped
    after = prepare[stop:pg]
    assert re.search(r"SvcUnknown then\s+begin\s+Result := CustomMessage\('ServiceStateUnknown'\);\s+Exit;", after)
    assert re.search(
        r"\(State <> SvcAbsent\) and \(State <> SvcStopped\) then\s+begin\s+"
        r"Result := CustomMessage\('ServiceStillRunning'\);\s+Exit;",
        after,
    )
    assert re.search(r"AppDirTooLong", prepare[:grace])
    nxt = _routine("NextButtonClick")
    assert "wpSelectDir" in nxt and "{#StepMaxAppDirLen}" in nxt


def test_the_generated_limit_is_required():
    assert re.search(r"^#ifndef StepMaxAppDirLen\n\s*#error ", ISS, re.M)
    assert not re.search(r"#define\s+StepMaxAppDirLen", ISS)  # never a number of its own: build.py's only


def test_silent_paths_open_no_unsuppressible_window():
    code = _section("Code")
    plain = [m.start() for m in re.finditer(r"(?<![A-Za-z])MsgBox\(", code)]
    assert plain == [], "every message box must be SuppressibleMsgBox"
    uninstall = _routine("InitializeUninstall")
    assert uninstall.index("UninstallSilent") < uninstall.index("AskAboutData")
    assert re.search(r"if UninstallSilent then\s+begin\s+RemoveDataOnUninstall := False;", uninstall)
    post = _routine("CurStepChanged")
    assert "PostInstallFailure := 41" in post and "PostInstallFailure := 42" in post
    assert "ServiceSetupFailed" in post and "ServiceNotRunning" in post
    assert re.search(r"Result := PostInstallFailure;", _routine("GetCustomSetupExitCode"))


def test_every_installer_message_exists_in_both_languages():
    keys = {}
    for line in _entries("CustomMessages"):
        lang, _, rest = line.partition(".")
        keys.setdefault(lang, set()).add(rest.split("=", 1)[0])
    assert keys["english"] == keys["ukrainian"]
    assert {"ServiceStillRunning", "ServiceStateUnknown", "AppDirTooLong", "ServiceNotRunning"} <= keys["english"]
