#!/usr/bin/env bash
# BamDude's STEP preview component on a native install (spec stage C R7).
#
#   install/step-preview.sh enable [--path DIR]   install it, or repair it (the same command)
#   install/step-preview.sh status [--path DIR]   check that it really works, and say what to do if not
#
# The component is the administrator's choice on a native install: `enable`
# records that choice, installs the system libraries it needs (root, through
# sudo) and then the component itself as the install's owner. BamDude may keep
# running meanwhile: the next STEP thumbnail uses the new component.
set -Eeuo pipefail

STEP_PREVIEW_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=install.sh
source "$STEP_PREVIEW_SCRIPT_DIR/install.sh"

# What the helper really bounds — never one number for the whole run.
step_preview_bounds() {
    local limits lock pip smoke
    limits=$(step_preview_helper limits 2>/dev/null) || limits=""
    lock=$(sed -n 's/.*"lock_seconds": \([0-9]*\).*/\1/p' <<<"$limits")
    pip=$(sed -n 's/.*"pip_seconds": \([0-9]*\).*/\1/p' <<<"$limits")
    smoke=$(sed -n 's/.*"smoke_seconds": \([0-9]*\).*/\1/p' <<<"$limits")
    if [[ -n "$lock" && -n "$pip" && -n "$smoke" ]]; then
        echo "Waits at most $((lock / 60)) min for another install of the component, $((pip / 60)) min for its download, ${smoke} s for each check of it; reading its files and proving its processes ended are not bounded."
    else
        echo "Waits for another install of the component, its download and its checks; reading its files and proving its processes ended are not bounded."
    fi
}

step_preview_enable() {
    local rc=0
    if [[ -z "$(step_preview_packages)" && "$OS_TYPE" != "macos" ]]; then
        log_warn "Install libGL, libX11 and expat with your package manager if they are missing; this script installs them only on Debian/Ubuntu and Fedora/RHEL"
    fi
    run_step_preview_step cli || rc=$?
    case "$rc" in
        0) log_success "STEP preview component ready: the next STEP thumbnail uses it" ;;
        3) ;;  # said so already
        *) log_warn "The STEP preview component was not installed: $(step_preview_hint "$STEP_PREVIEW_ANSWER")" ;;
    esac
    return "$rc"
}

step_preview_status() {
    local answer rc=0 choice bundle
    answer=$(step_preview_helper status --check) || rc=$?
    choice=$(sed -n 's/.*"choice": "\([^"]*\)".*/\1/p' <<<"$answer")
    bundle=$(sed -n 's/.*"bundle": "\([^"]*\)".*/\1/p' <<<"$answer")
    case "$choice" in
        enabled) echo "Choice: enabled" ;;
        disabled) echo "Choice: disabled (updates leave the component alone)" ;;
        *) echo "Choice: not made" ;;
    esac
    case "$bundle" in
        works) echo "Component: works" ;;
        smoke_failed:system_library:*)
            echo "Component: the system library ${bundle##*:} is missing"
            echo "To fix: install $(step_preview_package_for "${bundle##*:}"), then run install/step-preview.sh enable"
            ;;
        missing) echo "Component: not installed" ;;
        unsupported) echo "Component: not available for this machine" ;;
        *) echo "Component: ${bundle:-unknown}" ;;
    esac
    if [[ "$bundle" != "works" && "$bundle" != smoke_failed:system_library:* && "$bundle" != "unsupported" ]]; then
        echo "To enable or repair: install/step-preview.sh enable"
    fi
    return "$rc"
}

step_preview_usage() {
    echo "Usage: install/step-preview.sh enable|status [--path DIR]" >&2
    exit 2
}

step_preview_main() {
    local command="${1:-}" path=""
    shift || true
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --path)
                [[ -n "${2:-}" ]] || step_preview_usage
                path="$2"
                shift 2
                ;;
            *) log_error "Unknown option: $1"; exit 2 ;;
        esac
    done
    detect_os
    # Absolute: the helper runs after a `cd` into the install, where a relative --path names nothing.
    if [[ -n "$path" ]]; then
        if ! INSTALL_PATH="$(cd "$path" 2>/dev/null && pwd)"; then
            log_error "No install at $path"
            exit 2
        fi
    else
        INSTALL_PATH="$(cd "$STEP_PREVIEW_SCRIPT_DIR/.." && pwd)"
    fi
    if [[ "$OS_TYPE" == "macos" ]]; then
        # The helper runs as whoever runs this script: under sudo it would leave root's files in the user's install.
        if [[ "$(id -u)" == 0 ]]; then
            log_error "On macOS run install/step-preview.sh without sudo, as the user BamDude runs as"
            exit 1
        fi
        SERVICE_USER="$(id -un)"
    else
        # -L: a symlinked install belongs to whoever owns the tree, not to whoever made the link.
        SERVICE_USER="$(stat -L -c %U "$INSTALL_PATH")"
    fi
    case "$command" in
        enable)
            if step_preview_owner_refused; then
                exit 1
            fi
            step_preview_bounds
            step_preview_enable
            ;;
        status)
            step_preview_status
            ;;
        *)
            step_preview_usage
            ;;
    esac
}

# Run only when executed; the tests source it for its functions.
if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
    step_preview_main "$@"
fi
