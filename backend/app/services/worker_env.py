"""The one environment every local worker child gets (no .env, DB URL, credentials or NATS token). Stdlib only.

PreviewProcess and the STEP-runtime smoke both build their child's environment here, so a smoke never proves
the CAD bundle under a dev environment the product chain would not give it (plan A1).
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

INHERITED = frozenset(
    {
        "PATH",
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LD_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
        "MPLCONFIGDIR",
    }
)
SINGLE_THREADED = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS")


def worker_environment(cache: Path, source: Mapping[str, str] | None = None) -> dict[str, str]:
    source = os.environ if source is None else source
    env = {key: value for key, value in source.items() if key.upper() in INHERITED}
    env.update(BAMDUDE_IGNORE_DOTENV="1", PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
    for key in SINGLE_THREADED:
        env[key] = "1"
    cache.mkdir(parents=True, exist_ok=True)
    env.setdefault("MPLCONFIGDIR", str(cache))
    return env
