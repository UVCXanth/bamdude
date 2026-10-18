"""The real Windows installer script (spec stage B R1–R3, R7, R9; plan Tasks 4–5): the service state is read
positively from the SCM, the installed payload is left alone unless BamDude is proven absent or stopped, only the
Node runtime is replaced whole, the install directory limit is the generated one, and no silent path opens a window
nobody can answer. Static reads of the files that ship; the behaviour of the compiled installer is accepted on a
Windows runner (plan Task 7)."""

from __future__ import annotations

import os
import re
import subprocess
import uuid
from pathlib import Path

import pytest

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


# --- install-service.bat: a proven stop, then the CAD verify, before PG or the service (plan Task 5) -------------

SERVICE = ROOT / "installers" / "windows" / "service"


def _main() -> str:
    script = (SERVICE / "install-service.bat").read_text(encoding="utf-8")
    return script.split("\n:main\n", 1)[1].split("\n:setup_pg_service\n", 1)[0]


def test_the_order_is_grace_proven_stop_verify_then_pg_and_registration():
    main = _main()
    grace = main.index('"%NSSM%" set BamDude AppStopMethodConsole 90000')
    stop = main.index('service-state.bat" BamDude 100 stop')
    verify = main.index("-m backend.app.step_runtime verify --app-dir")
    pg = main.index("call :setup_pg_service")
    nssm = min(main.index(f'"%NSSM%" {verb} BamDude') for verb in ("stop", "remove", "install", "start"))
    assert grace < stop < verify < pg < nssm


def test_an_unproven_stop_ends_before_pg_verify_and_nssm():
    main = _main()
    branch = main[main.index('service-state.bat" BamDude 100 stop') : main.index("-m backend.app.step_runtime verify")]
    assert "exit /b 5" in branch
    assert "setup_pg_service" not in branch and "%NSSM%" not in branch


def test_a_failed_verify_never_starts_the_service():
    main = _main()
    branch = main[main.index("-m backend.app.step_runtime verify") : main.index("call :setup_pg_service")]
    failed = branch[branch.index("VERIFY_RC") :]
    assert "config BamDude start= demand" in failed and "exit /b 4" in failed
    assert "CFG_RC" in failed  # the result of sc config is read and logged
    assert "%NSSM%" not in failed[: failed.index("exit /b 4")]


def test_old_cad_is_pruned_only_after_verify_and_never_blocks_the_start():
    main = _main()
    prune = main.index('-m backend.app.step_runtime prune --app-dir "%APP_DIR%" --other-keys')
    assert main.index("-m backend.app.step_runtime verify") < prune < main.index('"%NSSM%" start BamDude')
    after = main[prune : main.index("embedded-service: initialise")]
    assert "exit /b" not in after  # a prune that left something is no reason to keep BamDude down


def test_service_state_tells_absent_from_unknown():
    text = (SERVICE / "service-state.bat").read_text(encoding="utf-8")
    state = "\n".join(line for line in text.splitlines() if not line.lstrip().upper().startswith("REM"))
    assert '"!RC!"=="1060"' in state and state.count("1060") == 1  # only the SCM's own 1060 is "absent"
    assert "exit /b 3" in state and 'System32\\sc.exe"' in state and "net stop" not in state
    # Every tool by its System32 path: a PATH with Git's Unix tools first answers `find` with GNU find, which reads
    # "STOPPED" as a file name — a stopped service would never be seen stopped (measured on a dev machine).
    for tool in ("find", "ping"):
        assert not re.search(rf"^\s*{tool}\b|[(&|]\s*{tool}\b", state, re.M | re.I), tool
        assert f"System32\\{tool}.exe" in state, tool


def test_no_service_script_trusts_path_for_find_or_ping():
    """The same in every script that ships: install-service's PostgreSQL stop and uninstall-service's poll too."""
    for script in sorted(SERVICE.glob("*.bat")):
        code = "\n".join(
            line
            for line in script.read_text(encoding="utf-8").splitlines()
            if not line.lstrip().upper().startswith("REM")
        )
        for tool in ("find", "ping"):
            assert not re.search(rf"^\s*{tool}\b|[(&|]\s*{tool}\b", code, re.M | re.I), (script.name, tool)


@pytest.mark.skipif(os.name != "nt", reason="named skip: sc.exe is Windows'")
def test_a_stopped_service_is_stopped_for_real_whatever_the_path():
    """Query only, never a stop: the first service the SCM lists as stopped, with Git's Unix tools first on PATH."""
    listed = subprocess.run(["sc.exe", "query", "state=", "inactive"], capture_output=True, text=True, timeout=60)
    name = next(line.split(":", 1)[1].strip() for line in listed.stdout.splitlines() if "SERVICE_NAME" in line)
    git_tools = [p for p in os.environ.get("PATH", "").split(os.pathsep) if "Git" in p and "usr" in p]
    env = {**os.environ, "PATH": os.pathsep.join([*git_tools, os.environ.get("PATH", "")])}
    p = subprocess.run(["cmd", "/c", str(SERVICE / "service-state.bat"), name, "0"], capture_output=True, env=env)
    assert p.returncode == 0, (name, p.stdout)


@pytest.mark.skipif(os.name != "nt", reason="named skip: sc.exe is Windows'")
def test_an_absent_service_is_absent_for_real():
    name = f"BamDudeNoSuch{uuid.uuid4().hex[:12]}"
    p = subprocess.run(["cmd", "/c", str(SERVICE / "service-state.bat"), name, "2"], capture_output=True, timeout=60)
    assert p.returncode == 0
