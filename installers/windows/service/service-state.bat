@echo off
REM The state of one Windows service, read positively, optionally after asking it to stop.
REM   %1 = service name   %2 = seconds to wait   %3 = "stop" to ask it to stop first
REM Exit codes:
REM   0  ABSENT (the SCM's own 1060, nothing else) or STOPPED: proven
REM   2  any other state (STOP_PENDING included) still after the wait
REM   3  UNKNOWN: any other failure of the query (access denied, say) - never taken for "absent"
REM
REM Called by install-service.bat before anything of the install is touched. The old check took any failure of
REM `sc query` for "not installed" and went on (Codex B-R1).
REM
REM ⚠️ sc stop, never `net stop`: `net stop` asks whether to also stop the services that depend on this one, and
REM this runs hidden with no console input, so that question would hang the installer with the service still up.
REM ⚠️ sc returns as soon as the control code is delivered, NOT when the service has stopped: the poll is the point.

setlocal enabledelayedexpansion
REM Every tool by its System32 path: with Git's Unix tools first on PATH, `find` is GNU find, which reads
REM "STOPPED" as a file name, and a stopped service would never be seen stopped.
set "SC=%SystemRoot%\System32\sc.exe"
set "FIND=%SystemRoot%\System32\find.exe"
set "PING=%SystemRoot%\System32\ping.exe"
set "NAME=%~1"
set "WAIT=%~2"
if "%WAIT%"=="" set "WAIT=0"

call :state
if "!STATE!"=="absent" exit /b 0
if "!STATE!"=="stopped" exit /b 0
if "!STATE!"=="unknown" exit /b 3
if /I "%~3"=="stop" (
    echo [service-state] stopping %NAME%
    "%SC%" stop "%NAME%" >nul 2>&1
)
set /a WAITED=0
:wait
if !WAITED! GEQ %WAIT% (
    echo [service-state] %NAME% still not stopped after !WAITED!s
    exit /b 2
)
REM ping as the sleep: `timeout` needs a console this script does not have.
"%PING%" -n 3 127.0.0.1 >nul
set /a WAITED+=2
call :state
if "!STATE!"=="absent" exit /b 0
if "!STATE!"=="stopped" exit /b 0
if "!STATE!"=="unknown" exit /b 3
goto :wait

:state
set "STATE=unknown"
set "QUERY=%TEMP%\bamdude_service_state_%RANDOM%%RANDOM%.txt"
"%SC%" query "%NAME%" > "!QUERY!" 2>&1
set "RC=!errorlevel!"
if "!RC!"=="1060" (
    set "STATE=absent"
) else if "!RC!"=="0" (
    "%FIND%" "STOPPED" "!QUERY!" >nul
    if errorlevel 1 (set "STATE=other") else (set "STATE=stopped")
) else (
    echo [service-state] %NAME%: sc query failed with !RC!
)
del "!QUERY!" 2>nul
exit /b 0
