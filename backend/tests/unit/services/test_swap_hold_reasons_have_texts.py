"""Every reason a held table swap can record is a sentence in both languages, on both sides (spec r4 R2-6).

The server writes the code on the archive and the sentence on the queue rows (``filament_routing``); the archive
card composes the sentence from the code (``utils/swapHold.ts`` + ``archives.swapHold.reason.*``). A reason
missing on either side shows the operator a key or nothing.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from backend.app.services import swap_terminal

ROOT = Path(__file__).resolve().parents[4]
DATA = ROOT / "backend" / "app" / "data"
FRONTEND = ROOT / "frontend" / "src"


def test_every_hold_reason_has_a_server_sentence_in_both_languages():
    for lang in ("en", "uk"):
        texts = json.loads((DATA / f"filament_routing_{lang}.json").read_text(encoding="utf-8"))
        missing = sorted(reason for reason in swap_terminal.HOLD_REASONS if not texts.get(reason))
        assert not missing, f"filament_routing_{lang}.json lacks {missing}"


def test_the_archive_card_knows_exactly_the_servers_reasons():
    source = (FRONTEND / "utils" / "swapHold.ts").read_text(encoding="utf-8")
    listed = set(re.findall(r"'(swap_hold_[a-z_]+)'", source.split("] as const")[0]))
    assert listed == set(swap_terminal.HOLD_REASONS)
    for lang in ("en", "uk"):
        locale = (FRONTEND / "i18n" / "locales" / f"{lang}.ts").read_text(encoding="utf-8")
        missing = sorted(reason for reason in swap_terminal.HOLD_REASONS if f"{reason}:" not in locale)
        assert not missing, f"{lang}.ts lacks archives.swapHold.reason {missing}"
