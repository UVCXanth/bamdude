"""The STEP-preview component's notices and source-material manifest (spec §8, plan A7) against the catalog: every
native library of every pinned wheel belongs to exactly one component of its platform family, every component still
names a library there, every licence text it cites ships, a licence offered under alternatives says which one we
distribute under, and every copyleft component names its exact corresponding source. A repin that changes the
closure fails here until the notices are revisited."""

from __future__ import annotations

import fnmatch
import json
import re
from pathlib import Path

import pytest

from backend.app import step_runtime as sr

DATA = Path(sr.__file__).resolve().parent / "data"
NOTICES = json.loads((DATA / "step_runtime_notices.json").read_text(encoding="utf-8"))
TEXTS = DATA / "step_runtime_notices"
CATALOG = sr.load_catalog()
COPYLEFT = re.compile(r"\b(L?GPL|MPL|CDDL|FreeImage)\b")


def family_of(artifact: dict) -> str:
    tag = artifact["tags"][0]
    return "linux" if "manylinux" in tag else "windows" if "win" in tag else "macos"


WHEELS = [a for a in CATALOG.manifest["artifacts"] if a["key"]]


def owners(family: str, library: str) -> list[str]:
    name = library.rsplit("/", 1)[-1]
    return [
        c["id"]
        for c in NOTICES["families"][family]["components"]
        if any(fnmatch.fnmatchcase(name, pattern) for pattern in c["libraries"])
    ]


def test_the_notices_were_made_for_this_closure():
    assert NOTICES["closure_sha256"] == CATALOG.manifest["closure_sha256"]


@pytest.mark.parametrize("artifact", WHEELS, ids=lambda a: a["key"])
def test_every_bundled_library_belongs_to_exactly_one_component(artifact):
    family = family_of(artifact)
    stray = {}
    for lib in CATALOG.closure["artifacts"][artifact["filename"]]:
        found = owners(family, lib["path"])
        if len(found) != 1:
            stray[lib["path"]] = found
    assert stray == {}


@pytest.mark.parametrize("artifact", WHEELS, ids=lambda a: a["key"])
def test_every_component_still_names_a_library_of_every_wheel_of_its_family(artifact):
    family = family_of(artifact)
    names = [lib["path"].rsplit("/", 1)[-1] for lib in CATALOG.closure["artifacts"][artifact["filename"]]]
    unused = [
        c["id"]
        for c in NOTICES["families"][family]["components"]
        if not any(fnmatch.fnmatchcase(n, p) for n in names for p in c["libraries"])
    ]
    assert unused == []


def _components():
    for family, body in NOTICES["families"].items():
        for component in body["components"]:
            yield family, component
            for part in component.get("embedded", []):
                yield family, {**part, "id": f"{component['id']}/{part['name']}"}


def test_every_cited_text_ships_and_nothing_else_does():
    cited = {text for _, c in _components() for text in c["texts"]}
    shipped = {p.relative_to(TEXTS).as_posix() for p in TEXTS.rglob("*") if p.is_file()} - {"README.txt"}
    assert cited == shipped
    for _, c in _components():
        assert c["texts"], c["id"]
        assert all((TEXTS / text).stat().st_size > 0 for text in c["texts"]), c["id"]


def test_a_licence_with_alternatives_names_the_one_we_distribute_under():
    undecided = [f"{f}:{c['id']}" for f, c in _components() if " OR " in c["licence"].upper() and not c.get("terms")]
    assert undecided == []


def test_every_copyleft_component_names_its_exact_corresponding_source():
    vague = []
    for family, c in _components():
        if not COPYLEFT.search(c.get("terms") or c["licence"]):
            continue
        source = c["source"]
        exact = (
            (source["kind"] == "git" and (source.get("commit") or source.get("ref")))
            or (source["kind"] == "srpm" and source["name"].endswith(".src.rpm"))
            or (source["kind"] == "archive" and re.fullmatch(r"[0-9a-f]{64}", source.get("sha256", "")))
        )
        if not exact:
            vague.append(f"{family}:{c['id']}")
    assert vague == []


# the licence (or exception) a component is distributed under -> the text that must be among its OWN citations
REQUIRED_TEXT = [
    (r"LGPL-2\.1", r"LGPL"),
    (r"OCCT-exception", r"EXCEPTION"),
    (r"GPL-3\.0", r"(?i)copying3|gplv3"),
    (r"GCC-exception", r"RUNTIME"),
    (r"\bFreeImage\b", r"(?i)license-fi"),
    (r"\bFTL\b", r"FTL"),
]


def test_a_copyleft_licence_and_its_exception_ship_with_the_component_itself():
    missing = []
    for family, c in _components():
        terms = c.get("terms") or c["licence"]
        for licence, text in REQUIRED_TEXT:
            if re.search(licence, terms) and not any(re.search(text, t) for t in c["texts"]):
                missing.append(f"{family}:{c['id']}:{licence}")
    assert missing == []


FREETYPE_YEARS = {"2.9.1": 2018, "2.12.1": 2022}  # the release year of each FreeType version the wheels carry


def test_the_readme_names_every_chosen_term_and_credits_freetype():
    """The owner left the choice among alternatives to us (2026-10-18): the terms lightest under AGPL-3.0 — FTL for
    FreeType, the FreeImage Public License, LGPL-2.1 for LibRaw — and the README that ships says so. FTL asks for its
    credit in the documentation, with the year of the version actually used."""
    readme = (TEXTS / "README.txt").read_text(encoding="utf-8")
    for family, c in _components():
        if c.get("terms"):
            assert c["name"].casefold() in readme.casefold() and c["terms"] in readme, f"{family}:{c['id']}"
        if c.get("terms") == "FTL":
            version = c["version"].split("-")[0]
            credit = f"Portions of this software are copyright © {FREETYPE_YEARS[version]} The FreeType"
            assert credit in readme, f"{family}:{version}"
