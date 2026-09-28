"""The mockup, read as a seed (spec B2, C1–C4) — pure functions, stdlib only.

Everything here turns the dump of the final mockup into plain specifications:
which printers, folders and files exist, what each file's plates carry, which
prints a printer reported, and where every date lands on the stand's calendar.
``seed_http.py`` sends them through the API; ``seed_direct.py`` writes the few
rows only a printer or a file gives birth to.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

MOCKUP_TODAY = date(2026, 9, 25)
RECIPE_VERSION = 1

# The mockup writes "A1 mini"; the application's model names are its own.
MODEL_NAMES = {"P1S": "P1S", "X1C": "X1C", "A1 mini": "A1 Mini", "H2D": "H2D"}


# ── Dates: one anchor, every mockup date moved by the same whole days (B2) ───


def shift_days(anchor: date) -> int:
    return (anchor - MOCKUP_TODAY).days


def shift_date(value: str | None, delta: int) -> str | None:
    """A mockup date (``YYYY-MM-DD``) on the stand's calendar."""
    if not value:
        return None
    return (date.fromisoformat(value[:10]) + timedelta(days=delta)).isoformat()


def shift_datetime(value: str | None, delta: int) -> str | None:
    """A mockup local date-time on the stand's calendar, the time of day kept."""
    if not value:
        return None
    return (datetime.fromisoformat(value) + timedelta(days=delta)).isoformat()


# ── The farm ──────────────────────────────────────────────────────────────────


def printers(dump: dict) -> list[dict]:
    """The mockup's farm, on TEST-NET addresses (RFC 5737) that route nowhere."""
    out = []
    for n, p in enumerate(dump["constants"]["PRINTERS"], start=1):
        out.append(
            {
                "key": f"printer:{p['name']}",
                "name": p["name"],
                "model": MODEL_NAMES[p["model"]],
                "serial": f"WS13{p['name'].replace('-', '').replace(' ', '').upper()}",
                "ip": f"192.0.2.{n}",
            }
        )
    return out


# ── Library: folders and files with their plates ─────────────────────────────


def _object_name(part: dict) -> str:
    """What the slicer calls the part's object — its first alias, else its name."""
    return (part.get("aliases") or [part["name"]])[0]


def _plate(plate: dict, objects: dict[str, int]) -> dict:
    materials = plate.get("materials") or ["PLA"]
    colors = plate.get("colors") or ["#8a8a8a"]
    filaments = [
        {"type": materials[i] if i < len(materials) else materials[-1], "color": colors[i]}
        for i in range(max(len(materials), len(colors)))
    ]
    return {
        "index": plate["index"],
        "minutes": plate.get("minutes") or 60,
        "grams": plate.get("grams") or 10,
        "filaments": filaments,
        "objects": objects,
    }


def _file_spec(file: dict, *, objects_of) -> dict:
    name = file["name"]
    sliced = file.get("sliced", True) and bool(file.get("plates")) and file.get("model") is not None
    return {
        # By name: the mockup reuses file id 1001 for two different files.
        "key": f"file:{name}",
        "filename": name,
        "folder": file.get("folder"),
        "file_type": "gcode" if name.endswith(".gcode.3mf") else name.rsplit(".", 1)[-1][:10],
        "sliced": sliced,
        "model": MODEL_NAMES.get(file.get("model")) if file.get("model") else None,
        "plates": [_plate(p, objects_of(p)) for p in file.get("plates", [])] if sliced else [],
    }


def library_files(dump: dict) -> list[dict]:
    """Every file the mockup names: product files, loose library files, and the
    one a print names without it being anywhere (the calibration cube)."""
    db = dump["db"]
    out = []
    for product in db["products"]:
        if product["origin"] != "catalog":
            continue  # a one-off product's file is a library file of its own, listed below
        parts = {str(p["id"]): p for p in product["parts"]}

        def objects_of(plate, parts=parts):
            return {_object_name(parts[pid]): n for pid, n in (plate.get("yield") or {}).items() if pid in parts}

        for file in product["files"]:
            out.append(_file_spec(file, objects_of=objects_of))
    for file in db["library"]:
        if any(f["filename"] == file["name"] for f in out):
            continue  # a one-off product's file is the same library file
        out.append(_file_spec(file, objects_of=lambda plate: dict(plate.get("objects") or {})))
    known = {f["filename"] for f in out}
    for order in db["orders"]:
        for pr in order["prints"]:
            if pr["fileName"] not in known:
                known.add(pr["fileName"])
                printer = next(p for p in dump["constants"]["PRINTERS"] if p["name"] == pr["printer"])
                out.append(
                    {
                        "key": f"file:{pr['fileName']}",
                        "filename": pr["fileName"],
                        "folder": "Калібрування",
                        "file_type": "gcode",
                        "sliced": True,
                        "model": MODEL_NAMES[printer["model"]],
                        "plates": [
                            {
                                "index": pr["plateIndex"],
                                "minutes": pr.get("minutes") or 20,
                                "grams": pr.get("grams") or 5,
                                "filaments": [{"type": "PLA", "color": "#8a8a8a"}],
                                "objects": {"Калібрувальний куб": 1},
                            }
                        ],
                    }
                )
    return out


def folders(files: list[dict], products: list[dict]) -> list[str]:
    """Every folder path the mockup names, parents before children."""
    paths = {f["folder"] for f in files if f.get("folder")}
    for product in products:
        paths.update(product.get("folders") or [])
    full = set()
    for path in paths:
        parts = path.split("/")
        for i in range(1, len(parts) + 1):
            full.add("/".join(parts[:i]))
    return sorted(full, key=lambda p: (p.count("/"), p))


# ── Prints a printer reported ─────────────────────────────────────────────────


def print_parts(print_row: dict, file_spec: dict) -> list[dict]:
    """The objects one print made: the plate's objects, scaled to what the print says it made."""
    if not print_row.get("qty"):
        return []
    plate = next((p for p in file_spec["plates"] if p["index"] == print_row["plateIndex"]), None)
    if plate is None or not plate["objects"]:
        return []
    most = max(plate["objects"].values())
    return [
        {"name": name, "quantity": max(1, round(n * print_row["qty"] / most))} for name, n in plate["objects"].items()
    ]


def customer_contact(customer: dict) -> dict:
    """The mockup's one contact per customer, in the application's contact shape."""
    method, _, details = (customer.get("delivery") or "").partition(" · ")
    return {
        "name": customer.get("person") or None,
        "phone": customer.get("phone") or None,
        "email": customer.get("email") or None,
        "city": customer.get("city") or None,
        "delivery_method": method.strip() or None,
        "delivery_details": details.strip() or None,
    }


CUSTOMER_KINDS = {"company": "company", "regular": "regular", "private": "private"}
ATTACHMENT_CATEGORIES = {"bom": "bom_docs", "assembly": "assembly", "other": "other"}
