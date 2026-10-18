#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/bamdude}"
SERVICE_NAME="${SERVICE_NAME:-bamdude}"
BRANCH="${BRANCH:-}"
VENV_PIP="${VENV_PIP:-$INSTALL_DIR/venv/bin/pip}"
VENV_PYTHON="${VENV_PYTHON:-$INSTALL_DIR/venv/bin/python}"

# Lowest Python the application itself can run on. Keep in step with
# `requires-python` in pyproject.toml and the gate in install/install.sh — the
# same floor, enforced from a third place because the updater is the only one
# that runs against an installation that already exists.
REQUIRED_PYTHON_MAJOR=3
REQUIRED_PYTHON_MINOR=12
FRONTEND_DIR="${FRONTEND_DIR:-$INSTALL_DIR/frontend}"
BACKUP_DIR="${BACKUP_DIR:-$INSTALL_DIR/backups}"
BAMDUDE_API_URL="${BAMDUDE_API_URL:-http://127.0.0.1:8000/api/v1}"
BAMDUDE_API_KEY="${BAMDUDE_API_KEY:-}"
BACKUP_MODE="${BACKUP_MODE:-auto}" # auto|require|skip
BACKUP_KEEP_COUNT=5
FORCE="${FORCE:-0}"

SERVICE_STOPPED=0
CODE_UPDATED=0
old_commit=""

log() {
  printf '[bamdude-update] %s\n' "$*"
}

warn() {
  printf '[bamdude-update] WARNING: %s\n' "$*" >&2
}

die() {
  printf '[bamdude-update] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

# The install's own files are changed by their owner, never by root: git (the
# rollback included), the venv's pip and npm. Root keeps systemd. A root-run git
# met "dubious ownership" in the service user's tree on every fresh install, and
# root-run writes left files the service could not change later (the in-app
# update runs as the service user). The owner must be the service's user.
INSTALL_OWNER=""
resolve_install_owner() {
  local owner service_user
  owner="$(stat -c %U "$INSTALL_DIR" 2>/dev/null || true)"
  service_user="$(systemctl show "$SERVICE_NAME" -p User --value 2>/dev/null || true)"
  [ -n "$service_user" ] || service_user=root # a unit without User= runs as root
  if [ -z "$owner" ] || [ "$owner" = "UNKNOWN" ]; then
    die "Cannot tell which user owns $INSTALL_DIR. Nothing was changed."
  fi
  if [ "$owner" != "$service_user" ]; then
    die "$INSTALL_DIR belongs to $owner, but $SERVICE_NAME runs as $service_user. The update changes the install's files as their owner, who must be the service's user. Nothing was changed. Give the install to $service_user (sudo chown -R $service_user: $INSTALL_DIR) or correct the unit's User=, then run the update again."
  fi
  [ "$owner" = root ] || require_cmd sudo
  INSTALL_OWNER="$owner"
}

as_owner() {
  if [ "$INSTALL_OWNER" = root ]; then "$@"; else sudo -H -u "$INSTALL_OWNER" "$@"; fi
}

# What the owner's git, pip and npm write must already be the owner's: an
# earlier update run as root left root-owned files they cannot replace, which
# would break the update half way, with the service stopped. Data, logs,
# backups and the runtimes are not theirs to write and are left out. Found, the
# update stops before anything changes, with the repair to run — never a
# hidden chown.
check_owner_can_write() {
  local stray
  stray="$(find "$INSTALL_DIR" -xdev \( -path "$INSTALL_DIR/data" -o -path "$INSTALL_DIR/logs" \
    -o -path "$BACKUP_DIR" -o -path "$INSTALL_DIR/runtime" \) -prune -o ! -user "$INSTALL_OWNER" -print -quit \
    2>/dev/null || true)"
  if [ -n "$stray" ]; then
    die "Part of $INSTALL_DIR does not belong to $INSTALL_OWNER (first: ${stray#"$INSTALL_DIR"/}), likely left by an earlier update run as root. Nothing was changed. Give it back with: sudo chown -R $INSTALL_OWNER: $INSTALL_DIR — then run the update again."
  fi
}

# Restore the --loop asyncio pin on a unit file written before it existed
# (upstream 0dfcff59).
#
# install.sh has pinned the loop since 2026-07-08 (Virtual Printer FTP uploads
# truncated on uvloop), but nothing ever rewrote an existing unit file — so an
# install created before that still runs on uvloop however often it is
# updated: uvicorn[standard] puts uvloop in every venv and --loop auto prefers
# it. Only the one flag is ever inserted; everything else in the unit —
# hardening, environment, a hand-edited port — stays byte-identical, and the
# file is copied aside first. Anything but a plain single-line uvicorn unit is
# described, never edited.
repair_loop_flag() {
  local fragment exec_line backup

  # The effective ExecStart, so a drop-in that already pins the loop counts —
  # and a deliberate --loop of any kind is left alone.
  if systemctl show "$SERVICE_NAME" --property=ExecStart --value 2>/dev/null | grep -q -- '--loop'; then
    return 0
  fi

  fragment="$(systemctl show "$SERVICE_NAME" --property=FragmentPath --value 2>/dev/null || true)"
  if [ -z "$fragment" ] || [ ! -f "$fragment" ]; then
    warn "Cannot locate the unit file for $SERVICE_NAME; not repairing the --loop flag."
    return 0
  fi

  # A drop-in, not the fragment, may be what defines ExecStart; editing the
  # fragment would then change nothing while reporting success.
  if [ -n "$(systemctl show "$SERVICE_NAME" --property=DropInPaths --value 2>/dev/null || true)" ]; then
    warn "$SERVICE_NAME has systemd drop-ins; add '--loop asyncio' to its uvicorn command by hand."
    return 0
  fi

  if [ "$(grep -c '^ExecStart=' "$fragment")" -ne 1 ]; then
    warn "$fragment has no single ExecStart line; add '--loop asyncio' to its uvicorn command by hand."
    return 0
  fi
  exec_line="$(grep '^ExecStart=' "$fragment")"
  case "$exec_line" in
    *uvicorn*) ;;
    *)
      warn "$fragment does not start uvicorn directly; add '--loop asyncio' to it by hand."
      return 0
      ;;
  esac
  case "$exec_line" in
    *\\)
      warn "$fragment continues its ExecStart onto another line; add '--loop asyncio' by hand."
      return 0
      ;;
  esac
  if [ ! -w "$fragment" ]; then
    warn "$fragment is not writable; add '--loop asyncio' to its uvicorn command by hand."
    return 0
  fi

  backup="$fragment.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$fragment" "$backup" || {
    warn "Could not back up $fragment; leaving it alone."
    return 0
  }

  # Appended, not spliced: uvicorn accepts its options in any order after the
  # app path, and appending cannot disturb a value already on the line.
  if ! sed -i 's|^ExecStart=.*|& --loop asyncio|' "$fragment"; then
    warn "Failed to edit $fragment; restoring from $backup."
    cp -p "$backup" "$fragment" || true
    return 0
  fi

  log "Added the missing '--loop asyncio' flag to $fragment (backup at $backup)."
  log "Without it BamDude runs on uvloop, which can truncate Virtual Printer FTP uploads."
  systemctl daemon-reload || warn "systemctl daemon-reload failed; the new flag applies after the next reload."
}

check_python_version() {
  # Must run before create_backup, the service stop and `git reset --hard`.
  # The failure this prevents is not one the rollback path can undo: code that
  # cannot be imported leaves the service down, and by the time that is
  # discovered the old tree has already been replaced. 0.5.0 raised the floor
  # to 3.12 (the app imports enum.StrEnum, which is 3.11+), and a venv built on
  # an older interpreter does not move just because the system gained a newer
  # one — so the venv's own python is what gets checked.
  local py
  if [ -x "$VENV_PYTHON" ]; then
    py="$VENV_PYTHON"
  elif command -v python3 >/dev/null 2>&1; then
    py="$(command -v python3)"
    warn "No venv interpreter at $VENV_PYTHON — checking $py instead."
  else
    warn "No Python interpreter found to verify against; continuing."
    return 0
  fi

  local version major minor
  version="$("$py" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true)"
  if [ -z "$version" ]; then
    warn "Could not determine the Python version of $py; continuing."
    return 0
  fi
  major="${version%%.*}"
  minor="${version#*.}"

  if [ "$major" -lt "$REQUIRED_PYTHON_MAJOR" ] ||
    { [ "$major" -eq "$REQUIRED_PYTHON_MAJOR" ] && [ "$minor" -lt "$REQUIRED_PYTHON_MINOR" ]; }; then
    cat >&2 <<EOF
[bamdude-update] ERROR: this installation runs Python $version, but BamDude
now requires ${REQUIRED_PYTHON_MAJOR}.${REQUIRED_PYTHON_MINOR} or newer.

Nothing has been changed. Your installation is untouched and still running.

Distributions older than Ubuntu 24.04 ship Python 3.10 or 3.11. Three ways
forward, easiest last:

  1. Upgrade the distribution, then rebuild the virtualenv on the new
     interpreter (the venv keeps the version it was created with):

       sudo systemctl stop ${SERVICE_NAME}
       sudo rm -rf ${INSTALL_DIR}/venv
       sudo -u ${INSTALL_OWNER:-bamdude} python3 -m venv ${INSTALL_DIR}/venv
       sudo -u ${INSTALL_OWNER:-bamdude} ${INSTALL_DIR}/venv/bin/pip install -r ${INSTALL_DIR}/requirements.txt
       sudo systemctl start ${SERVICE_NAME}

  2. Install a newer Python alongside the system one and rebuild the venv with
     it, pointing python3 at the new binary in step 1.

  3. Switch to the Docker image, which carries its own interpreter and is not
     affected by what the host has installed.
EOF
    exit 1
  fi

  log "Python $version detected (>= ${REQUIRED_PYTHON_MAJOR}.${REQUIRED_PYTHON_MINOR})"
}

cleanup_old_backups() {
  local -a backup_files
  local max_count="$1"

  [ "$max_count" -gt 0 ] || return 0

  mapfile -t backup_files < <(ls -1t "$BACKUP_DIR"/bamdude-backup-*.zip 2>/dev/null || true)
  if [ "${#backup_files[@]}" -le "$max_count" ]; then
    return 0
  fi

  for old_file in "${backup_files[@]:$max_count}"; do
    rm -f "$old_file"
  done

  log "Pruned old backups, kept newest $max_count file(s)"
}

on_error() {
  local exit_code="$1"

  if [ "$SERVICE_STOPPED" -eq 1 ]; then
    if [ "$CODE_UPDATED" -eq 1 ] && [ -n "$old_commit" ]; then
      warn "Update failed after code change, attempting rollback to $old_commit"
      as_owner git reset --hard "$old_commit" || warn "Rollback reset failed"
    fi

    warn "Update failed, attempting to restart service: $SERVICE_NAME"
    systemctl start "$SERVICE_NAME" || true
  fi

  exit "$exit_code"
}
trap 'on_error $?' ERR

# The part-render runtime (pinned Node.js, spec §6): an install made before it
# shipped gets it here, and a new pin in the manifest reaches every updated
# install -- the pin is how runtime security fixes travel. install.sh's own
# function does the work. Run in a subshell: sourcing install.sh brings its
# globals and `set -e`, which must not leak into this script.
refresh_render_runtime() {
  # shellcheck source=install.sh
  source "$INSTALL_DIR/install/install.sh"
  detect_os
  INSTALL_PATH="$INSTALL_DIR"
  SERVICE_USER="$(stat -c %U "$INSTALL_DIR")"
  provision_render_runtime
}

# The unit's cgroup, recorded BEFORE the stop whatever its state (spec stage C
# R4a, consilium C2-R1): a unit that is already failed or inactive may still
# have live descendants, so its group is checked like any other.
SERVICE_CGROUP=""
record_service_cgroup() {
  SERVICE_CGROUP="$(systemctl show "$SERVICE_NAME" -p ControlGroup --value 2>/dev/null || true)"
}

# 0 only on a PROOF that nothing of the service runs: a successful query of a
# loaded unit that is inactive or failed, a cgroup v2 hierarchy, and the
# recorded group either gone from that readable hierarchy or `populated 0`
# (the flag covers every descendant group). Unknown, unreadable, cgroup v1 or
# hybrid, or no group recorded: no proof. The unit's state alone never is one.
service_proven_stopped() {
  local load active events root="${CGROUP_ROOT:-/sys/fs/cgroup}"
  load="$(systemctl show "$SERVICE_NAME" -p LoadState --value 2>/dev/null)" || return 1
  active="$(systemctl show "$SERVICE_NAME" -p ActiveState --value 2>/dev/null)" || return 1
  [ "$load" = "loaded" ] || return 1
  [ "$active" = "inactive" ] || [ "$active" = "failed" ] || return 1
  [ "$(stat -fc %T "$root" 2>/dev/null || true)" = "cgroup2fs" ] || return 1
  [ -n "$SERVICE_CGROUP" ] || return 1
  if [ ! -e "$root$SERVICE_CGROUP" ]; then
    [ -r "$root/cgroup.controllers" ] || return 1  # the hierarchy itself is there and readable
    return 0
  fi
  events="$(cat "$root$SERVICE_CGROUP/cgroup.events" 2>/dev/null)" || return 1
  printf '%s\n' "$events" | grep -qx 'populated 0'
}

# The STEP preview component (spec stage C R4): only an install whose
# administrator enabled it, and an old bundle pruned only on a proven stop.
# A subshell, like the render runtime: install.sh's globals stay out of here.
refresh_step_preview() {
  # shellcheck source=install.sh
  source "$INSTALL_DIR/install/install.sh"
  detect_os
  INSTALL_PATH="$INSTALL_DIR"
  SERVICE_USER="$(stat -c %U "$INSTALL_DIR")"
  step_preview_may_prune() { service_proven_stopped; }
  refresh_enabled_step_preview
}

create_backup() {
  local ts backup_file
  local -a auth_args=()

  if [ "$BACKUP_MODE" = "skip" ]; then
    log "Skipping backup (BACKUP_MODE=skip)"
    return 0
  fi

  if ! systemctl is-active --quiet "$SERVICE_NAME"; then
    if [ "$BACKUP_MODE" = "require" ]; then
      die "Service is not running; cannot call built-in backup API."
    fi
    warn "Service is not running; skipping built-in backup API call."
    return 0
  fi

  mkdir -p "$BACKUP_DIR"
  ts="$(date +%Y%m%d-%H%M%S)"
  backup_file="$BACKUP_DIR/bamdude-backup-$ts.zip"

  [ -n "$BAMDUDE_API_KEY" ] && auth_args=(-H "X-API-Key: $BAMDUDE_API_KEY")

  log "Creating built-in backup via API: $backup_file"
  if curl --silent --show-error --fail --location \
    --connect-timeout 5 --max-time 900 \
    "${auth_args[@]}" \
    "$BAMDUDE_API_URL/settings/backup" \
    --output "$backup_file"; then
    log "Backup created successfully"
    cleanup_old_backups "$BACKUP_KEEP_COUNT"
    return 0
  fi

  rm -f "$backup_file"
  if [ "$BACKUP_MODE" = "require" ]; then
    die "Built-in backup API call failed (BACKUP_MODE=require)."
  fi
  warn "Built-in backup API call failed. Continuing because BACKUP_MODE=auto."
}

[ "${EUID:-$(id -u)}" -eq 0 ] || die "Run as root (or with sudo)."

case "$BACKUP_MODE" in
  auto|require|skip) ;;
  *) die "Invalid BACKUP_MODE '$BACKUP_MODE' (expected: auto, require, skip)." ;;
esac

require_cmd git
require_cmd systemctl
require_cmd curl

[ -d "$INSTALL_DIR" ] || die "Install directory not found: $INSTALL_DIR"
cd "$INSTALL_DIR"
if [ ! -d .git ]; then
  cat >&2 <<EOF
ERROR: No git repository found in: $INSTALL_DIR

update.sh pulls new versions with \`git pull\`, so it needs BamDude to be a
working git clone. Most commonly this path is hit when BamDude was installed
from a downloaded ZIP instead of via install.sh, so the .git directory is
missing.

Recovery steps:

  1. Back up the database and data directory (so your history, settings and
     archives survive the reinstall):

       sudo systemctl stop ${SERVICE_NAME}
       sudo tar -czvf /tmp/bamdude-backup-\$(date +%Y%m%d).tar.gz \\
         $INSTALL_DIR/bamdude.db* $INSTALL_DIR/data/

  2. Re-install from the official installer, which does a real \`git clone\`
     into the same path:

       curl -fsSL https://raw.githubusercontent.com/kainpl/bamdude/main/install/install.sh | sudo bash

  3. Restore the backup on top of the fresh install:

       sudo systemctl stop ${SERVICE_NAME}
       sudo tar -xzvf /tmp/bamdude-backup-\$(date +%Y%m%d).tar.gz -C /
       sudo systemctl start ${SERVICE_NAME}
EOF
  exit 1
fi

load_state="$(systemctl show "$SERVICE_NAME" --property=LoadState --value 2>/dev/null || true)"
if [ -z "$load_state" ] || [ "$load_state" = "not-found" ]; then
  die "Service not found: ${SERVICE_NAME}.service"
fi

# Before any git: who changes the files, and whether they can.
resolve_install_owner
check_owner_can_write

if [ -z "$BRANCH" ]; then
  BRANCH="$(as_owner git rev-parse --abbrev-ref HEAD)"
  [ "$BRANCH" = "HEAD" ] && BRANCH="main"
fi

check_python_version

old_commit="$(as_owner git rev-parse --short HEAD || true)"

log "Fetching latest code from origin/$BRANCH"
as_owner git fetch --prune origin

remote_commit="$(as_owner git rev-parse --short "origin/$BRANCH" || true)"
log "Current commit: ${old_commit:-unknown}"
log "Remote commit: ${remote_commit:-unknown}"

if as_owner git diff --quiet HEAD "origin/$BRANCH"; then
  log "You are already running the latest version of BamDude."
  read -r -p "Do you want to run the update process anyway? [y/N]: " run_anyway
  case "${run_anyway:-}" in
    y|Y|yes|YES) ;;
    *) exit 0 ;;
  esac
else
  read -r -p "An update for BamDude is available. Install now? [y/N]: " install_now
  case "${install_now:-}" in
    y|Y|yes|YES) ;;
    *) exit 0 ;;
  esac
fi

if [ -n "$(as_owner git status --porcelain)" ]; then
  if [ "$FORCE" != "1" ]; then
    read -r -p "Local edits were detected in your installation. Updating now will overwrite those edits. Continue? [y/N]: " answer
    case "${answer:-}" in
      y|Y|yes|YES) ;;
      *) die "Update cancelled by user." ;;
    esac
  else
    warn "Proceeding without prompt because FORCE=1."
  fi
fi

create_backup

record_service_cgroup  # before the stop: what the prune of an old STEP component must prove empty
log "Stopping service: $SERVICE_NAME"
systemctl stop "$SERVICE_NAME"
SERVICE_STOPPED=1

log "Updating code to origin/$BRANCH"
as_owner git reset --hard "origin/$BRANCH"
CODE_UPDATED=1

if [ -x "$VENV_PIP" ] && [ -f requirements.txt ]; then
  log "Updating Python dependencies"
  as_owner "$VENV_PIP" install -r requirements.txt
else
  warn "Skipping Python dependency update (venv pip or requirements.txt missing)."
fi

# Never fails the update: a missing runtime is a missing feature, reported on
# the System page, not a reason to roll the code back.
if [ -f "$INSTALL_DIR/install/install.sh" ] && [ -x "$VENV_PYTHON" ]; then
  log "Updating the part-render runtime"
  if ! (refresh_render_runtime); then
    warn "Render runtime update failed; part thumbnails will report it on the System page."
  fi
else
  warn "Skipping the render runtime (install/install.sh or the venv python missing)."
fi

# Never fails the update either: only an install whose administrator enabled
# the STEP preview component gets it, and its old bundle goes only on a proven stop.
if [ -f "$INSTALL_DIR/install/install.sh" ] && [ -x "$VENV_PYTHON" ]; then
  log "Updating the STEP preview component (if enabled)"
  if ! (refresh_step_preview); then
    warn "STEP preview update failed; run install/step-preview.sh status to see why."
  fi
fi

if [ -f "$FRONTEND_DIR/package.json" ]; then
  if command -v npm >/dev/null 2>&1; then
    log "Building frontend"
    (
      cd "$FRONTEND_DIR"
      as_owner npm ci
      as_owner npm run build
    )
  else
    warn "Skipping frontend build (npm not installed)."
  fi
else
  warn "Skipping frontend build (frontend/package.json not found)."
fi

# While the service is stopped, so the flag takes effect on this restart.
repair_loop_flag

log "Starting service: $SERVICE_NAME"
systemctl start "$SERVICE_NAME"
SERVICE_STOPPED=0
systemctl --no-pager --lines=8 status "$SERVICE_NAME"

new_commit="$(as_owner git rev-parse --short HEAD || true)"
log "Update complete: ${old_commit:-unknown} -> ${new_commit:-unknown}"
