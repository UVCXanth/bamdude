#!/bin/sh
# CI (spec Q2, plan A7): 32-bit armhf has no STEP-preview CAD build. The container runs with no network at all, so
# the helper must answer "unsupported" (exit 3) to select, install and verify without ever reaching for a download.
set -u
for cmd in select install verify; do
    python -m backend.app.step_runtime "$cmd" --app-dir /tmp/app
    rc=$?
    echo "$cmd -> $rc"
    [ "$rc" -eq 3 ] || exit 1
done
test ! -e /tmp/app/runtime || { echo "unsupported install left files"; exit 1; }
