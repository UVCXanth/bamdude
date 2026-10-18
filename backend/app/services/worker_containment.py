"""Platform containment for owned worker child trees.

The camera worker must not be allowed to leave FFmpeg descendants behind once
it begins owning cameras.  This module is deliberately small and has no camera
imports so its failure is detectable before the child receives its bootstrap.
"""

from __future__ import annotations

import ctypes
import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass

_BASE_EXECUTABLE = getattr(sys, "_base_executable", None) or sys.executable


def contained_interpreter(
    env: Mapping[str, str] | None,
    *,
    platform: str = os.name,
    executable: str = sys.executable,
    base: str = _BASE_EXECUTABLE,
) -> tuple[str, dict[str, str] | None]:
    """The interpreter (and environment) to start for a Python child that is attached to a Job after the spawn.

    In a Windows venv ``sys.executable`` is a redirector that starts the real interpreter as its own child at once:
    that process — and everything it starts — can run before the attach, outside the Job, while the Job that holds
    only the redirector "proves" the tree ended. So start the base interpreter itself, told which venv it serves
    (``__PYVENV_LAUNCHER__``, as multiprocessing does, bpo-35797). Elsewhere nothing changes."""
    if platform != "nt" or os.path.normcase(executable) == os.path.normcase(base):
        return executable, (dict(env) if env is not None else None)
    out = dict(os.environ if env is None else env)
    out["__PYVENV_LAUNCHER__"] = executable
    return base, out


class WorkerContainmentError(RuntimeError):
    """The platform cannot prove containment for a newly spawned worker."""


@dataclass
class WorkerContainment:
    """Own the OS resource that terminates the worker process tree."""

    pid: int
    _job_handle: int | None = None

    @classmethod
    def attach(cls, pid: int, *, job_memory_limit: int | None = None) -> WorkerContainment:
        """``job_memory_limit``: a Job-wide COMMIT backstop (Windows; not RSS) for a crash-prone native child,
        with DIE_ON_UNHANDLED_EXCEPTION so its fault ends it instead of waiting on error reporting."""
        if os.name != "nt":
            # The supervisor starts the child in a new POSIX session.  It uses
            # this marker for the explicitly tested process-group fallback;
            # systemd/cgroup or watchdog service containment remains a release
            # gate, not an implicit claim here.
            return cls(pid=pid)
        try:
            return cls(pid=pid, _job_handle=_assign_windows_kill_on_close_job(pid, job_memory_limit))
        except WorkerContainmentError:
            raise
        except OSError as exc:
            raise WorkerContainmentError("could not load Windows Job Object APIs") from exc

    def close(self) -> None:
        """Closing a Windows job kills any remaining descendants."""

        if self._job_handle is not None:
            _close_windows_handle(self._job_handle)
            self._job_handle = None

    def end_tree(self, timeout: float) -> bool:
        """Windows: terminate every process of the job, then wait until the job reports none active — the proof a
        bare close does not give. True when proven within ``timeout``. (POSIX callers own a process group.)"""
        if self._job_handle is None:
            return True
        import time

        kernel32 = _windows_kernel32()
        kernel32.TerminateJobObject(ctypes.c_void_p(self._job_handle), 1)
        deadline = time.monotonic() + timeout
        info = _JOBOBJECT_BASIC_ACCOUNTING_INFORMATION()
        while True:
            if not kernel32.QueryInformationJobObject(
                ctypes.c_void_p(self._job_handle),
                _JOB_OBJECT_BASIC_ACCOUNTING,
                ctypes.byref(info),
                ctypes.sizeof(info),
                None,
            ):
                return False
            if info.ActiveProcesses == 0:
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.05)


def _assign_windows_kill_on_close_job(pid: int, job_memory_limit: int | None = None) -> int:
    """Attach ``pid`` before it receives any worker bootstrap input."""

    if os.name != "nt":  # pragma: no cover - protected by attach()
        raise WorkerContainmentError("Windows Job Objects are unavailable on this platform")

    kernel32 = _windows_kernel32()
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        raise _windows_error("could not create worker Job Object")
    process = None
    try:
        info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if job_memory_limit:
            info.BasicLimitInformation.LimitFlags |= _JOB_OBJECT_LIMIT_JOB_MEMORY | _JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED
            info.JobMemoryLimit = job_memory_limit
        if not kernel32.SetInformationJobObject(
            job,
            _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            raise _windows_error("could not configure worker Job Object")

        process = kernel32.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, pid)
        if not process:
            raise _windows_error("could not open worker process for containment")
        if not kernel32.AssignProcessToJobObject(job, process):
            raise _windows_error("could not assign worker process to Job Object")
        return int(job)
    except Exception:
        _close_windows_handle(int(job))
        raise
    finally:
        if process:
            _close_windows_handle(int(process))


def _close_windows_handle(handle: int) -> None:
    if os.name != "nt":  # pragma: no cover - protected by caller
        return
    kernel32 = _windows_kernel32()
    kernel32.CloseHandle(ctypes.c_void_p(handle))


def _windows_error(message: str) -> WorkerContainmentError:
    return WorkerContainmentError(f"{message} (Win32 error {ctypes.get_last_error()})")


def _windows_kernel32() -> ctypes.WinDLL:
    """Return typed APIs so 64-bit Windows handles are never truncated."""

    if os.name != "nt":  # pragma: no cover - protected by caller
        raise WorkerContainmentError("Windows Job Objects are unavailable on this platform")
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = (wintypes.LPVOID, wintypes.LPCWSTR)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    )
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
    kernel32.TerminateJobObject.restype = wintypes.BOOL
    kernel32.QueryInformationJobObject.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.LPVOID,
    )
    kernel32.QueryInformationJobObject.restype = wintypes.BOOL
    return kernel32


_JOB_OBJECT_BASIC_ACCOUNTING = 1
_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
_JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED = 0x00000400
_PROCESS_SET_QUOTA = 0x0100
_PROCESS_TERMINATE = 0x0001
_ULONG_PTR = ctypes.c_size_t


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", ctypes.c_ulong),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_ulong),
        ("Affinity", _ULONG_PTR),
        ("PriorityClass", ctypes.c_ulong),
        ("SchedulingClass", ctypes.c_ulong),
    ]


class _JOBOBJECT_BASIC_ACCOUNTING_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("TotalUserTime", ctypes.c_longlong),
        ("TotalKernelTime", ctypes.c_longlong),
        ("ThisPeriodTotalUserTime", ctypes.c_longlong),
        ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
        ("TotalPageFaultCount", ctypes.c_ulong),
        ("TotalProcesses", ctypes.c_ulong),
        ("ActiveProcesses", ctypes.c_ulong),
        ("TotalTerminatedProcesses", ctypes.c_ulong),
    ]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", _IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]
