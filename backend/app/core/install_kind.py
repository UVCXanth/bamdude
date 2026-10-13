"""Where this process runs from -- the one place that asks (part-render-startup-provisioning-spec P2).

The updater and the part-render runtime both need it; a service never imports a route module for it.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def is_docker_environment() -> bool:
    """A Docker / Podman / OCI container (the image carries its own runtime)."""
    if os.path.exists("/.dockerenv"):
        return True
    try:
        with open("/proc/1/cgroup") as f:
            if "docker" in f.read():
                return True
    except (FileNotFoundError, PermissionError):
        pass  # cgroup file unavailable; continue with other detection methods
    # Check systemd container type (avoids false positive on Proxmox LXC)
    try:
        with open("/run/systemd/container") as f:
            return f.read().strip() in ("docker", "podman", "oci")
    except (FileNotFoundError, PermissionError):
        pass
    return False


def is_windows_installer_install(app_dir: Path) -> bool:
    """A Windows install the Inno Setup installer staged (no .git): it carries and replaces its runtime whole."""
    if sys.platform != "win32":
        return False
    return not (app_dir / ".git").exists()


def kind(app_dir: Path) -> str:
    if is_docker_environment():
        return "docker"
    if is_windows_installer_install(app_dir):
        return "windows_installer"
    return "native"
