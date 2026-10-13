"""Where this process runs from -- the one place that asks (part-render-startup-provisioning-spec P2)."""

from pathlib import Path

from backend.app.core import install_kind


def test_a_container_is_docker(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(install_kind, "is_docker_environment", lambda: True)
    assert install_kind.kind(tmp_path) == "docker"


def test_a_windows_tree_without_git_is_the_installer(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(install_kind, "is_docker_environment", lambda: False)
    monkeypatch.setattr(install_kind.sys, "platform", "win32")
    assert install_kind.kind(tmp_path) == "windows_installer"


def test_a_git_clone_is_native_on_every_os(monkeypatch, tmp_path: Path):
    (tmp_path / ".git").mkdir()
    monkeypatch.setattr(install_kind, "is_docker_environment", lambda: False)
    for platform in ("win32", "linux", "darwin"):
        monkeypatch.setattr(install_kind.sys, "platform", platform)
        assert install_kind.kind(tmp_path) == "native", platform


def test_a_linux_tree_without_git_is_native(monkeypatch, tmp_path: Path):
    # install.sh clones, but a tarball install has no .git -- off Windows that is still native
    monkeypatch.setattr(install_kind, "is_docker_environment", lambda: False)
    monkeypatch.setattr(install_kind.sys, "platform", "linux")
    assert install_kind.kind(tmp_path) == "native"
