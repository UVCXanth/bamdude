"""The `edges` data mode (spec B3, D): new entities for the states the mockup lacks.

Nothing here touches a baseline entity; every key is ``edge:<set>:<name>``.
``seed(run)`` writes the sets through the same client and writers as the
baseline; ``checks(client, mapping)`` answers table D's semantic conditions.
Pair screenshots are never taken in this mode — it exists for app-only checks.
"""

from __future__ import annotations

import secrets
from datetime import date, timedelta
from urllib.parse import quote

NOTE = "WS-13 stand · edges"
LONG = "Дуже довга назва крайового випадку, щоб перевірити перенесення тексту в картках, таблицях і шапках сторінок"


def _key(run, name: str) -> int:
    return run.id(f"edge:{name}")


def _file(name: str, model: str, plates: list[dict]) -> dict:
    return {
        "key": f"edge:file:{name}",
        "filename": name,
        "folder": None,
        "file_type": "gcode" if name.endswith(".gcode.3mf") else name.rsplit(".", 1)[-1],
        "sliced": bool(plates),
        "model": model,
        "plates": plates,
    }


def _plate(index: int, objects: dict, *, color: str = "#8a8a8a", material: str = "PLA", minutes: int = 60) -> dict:
    return {
        "index": index,
        "minutes": minutes,
        "grams": 20,
        "filaments": [{"type": material, "color": color}],
        "objects": objects,
    }


def _product(run, key: str, name: str, parts: list[dict], *, files=(), status="draft", groups=(), sku=None):
    """A product with parts (``variant`` = (group name, option name)), variant groups and files."""
    c = run.c
    made = c.post("/api/v1/products/", {"name": name, "status": "draft", "sku": sku})
    pid = made["id"]
    run.put(f"edge:{key}", pid, made.get("code"))
    options = {}
    for group, names in groups:
        answer = c.post(f"/api/v1/products/{pid}/variant-groups", {"name": group, "options": list(names)})
        g = next(g for g in answer["variant_groups"] if g["name"] == group)
        run.put(f"edge:{key}:group:{group}", g["id"])
        for o in g["options"]:
            options[(group, o["name"])] = o["id"]
            run.put(f"edge:{key}:option:{group}:{o['name']}", o["id"])
    for part in parts:
        p = c.post(
            f"/api/v1/products/{pid}/parts",
            {
                "kind": part.get("kind", "printed"),
                "name": part["name"],
                "qty_per_unit": part.get("qty", 1),
                "ignored": part.get("ignored", False),
                "unit_price": part.get("price"),
            },
        )
        run.put(f"edge:{key}:part:{part['name']}", p["id"])
        for alias in part.get("aliases", []):
            c.post(f"/api/v1/products/{pid}/parts/{p['id']}/aliases", {"name_key": alias})
        if part.get("variant"):
            c.patch(f"/api/v1/products/{pid}/parts/{p['id']}", {"variant_option_id": options[part["variant"]]})
    if files:
        c.put(f"/api/v1/products/{pid}/files", {"library_file_ids": [run.id(f) for f in files]})
    if status == "ready":
        c.patch(f"/api/v1/products/{pid}", {"status": "ready"})
    return pid


def seed(run) -> list[str]:
    c = run.c
    today = date.fromisoformat(run.dump["constants"]["TODAY"][:10]) + timedelta(days=run.delta)
    findings: list[str] = []

    # ── R1: people ───────────────────────────────────────────────────────────
    groups = {g["name"]: g["id"] for g in c.get("/api/v1/groups/")}
    no_library = c.post(
        "/api/v1/groups/",
        {
            "name": "WS-13 · без бібліотеки",
            "permissions": ["projects:read", "projects:create", "projects:update", "printers:read"],
        },
        expect=(200, 201),
    )
    for name, group in (
        ("ws13-reader", groups["Viewers"]),
        ("ws13-no-library", no_library["id"]),
        ("ws13-inactive", groups["Operators"]),
    ):
        u = c.post(
            "/api/v1/users/",
            {"username": name, "password": "Ws13-" + secrets.token_urlsafe(18), "group_ids": [group]},
            expect=(200, 201),
        )
        run.put(f"edge:R1:{name}", u["id"])

    # ── Files for the edge products ──────────────────────────────────────────
    files = [
        _file("p1_multi_p1s.gcode.3mf", "P1S", [_plate(1, {"p1_body": 2, "p1_cap": 2}, color="#1d1d1d")]),
        _file(
            "p1_multi_x1c.gcode.3mf",
            "X1C",
            [
                _plate(1, {"p1_body": 2}, color="#e8e6df", material="PETG"),
                _plate(2, {"p1_tail_a": 4, "p1_tail_b": 4}, color="#4f78a6"),
            ],
        ),
        _file("q4_x1e_only.gcode.3mf", "X1E", [_plate(1, {"q4_part": 4})]),
        _file("q4_unsliced.stl", None, []),
        _file("s1_body.gcode.3mf", "P1S", [_plate(1, {"s1_body": 4, "s1_std": 4, "s1_alt": 4})]),
        _file("q1_long.gcode.3mf", "P1S", [_plate(1, {"q1_a": 6, "q1_b": 6})]),
    ]
    result = run.direct("files", {"printers": [], "files": files})
    for key, server_id in result["files"].items():
        run.put(key, server_id)

    # ── P1: printed + purchased, two variant groups with an empty option ─────
    _product(
        run,
        "P1",
        "P1 · Виріб із двома групами варіантів",
        [
            {"name": "Корпус P1", "aliases": ["p1_body"]},
            {"name": "Кришка P1", "aliases": ["p1_cap"], "variant": ("Верх", "з кришкою")},
            {"name": "Хвіст A", "aliases": ["p1_tail_a"], "variant": ("Хвіст", "A")},
            {"name": "Хвіст B", "aliases": ["p1_tail_b"], "variant": ("Хвіст", "B")},
            {"name": "Гвинт M3", "kind": "purchased", "qty": 4, "price": 1.5},
        ],
        groups=[("Верх", ["з кришкою", "без кришки"]), ("Хвіст", ["A", "B"])],
        files=["edge:file:p1_multi_p1s.gcode.3mf", "edge:file:p1_multi_x1c.gcode.3mf"],
        status="ready",
        sku="EDGE-P1",
    )

    # ── P2: zero-not-ignored, ignored, hidden, draft, long names ────────────
    p2 = _product(
        run,
        "P2",
        LONG,
        [
            {"name": "Основа P2", "aliases": ["q1_a"]},
            {"name": "Нуль без позначки", "qty": 0},
            {"name": "Не рахувати", "qty": 0, "ignored": True},
            {"name": "Деталь із довгими аліасами", "aliases": ["alias_" + "x" * 60, "alias_" + "y" * 60]},
        ],
        files=["edge:file:q1_long.gcode.3mf"],
    )
    c.patch(f"/api/v1/products/{p2}", {"is_active": False})
    _product(run, "P2-draft", "P2 · Чернетка без деталей", [])

    # ── P3: sorts onto page 2 by name, found by search on page 1 ────────────
    _product(run, "P3", "Я · P3 виріб наприкінці каталогу", [{"name": "Деталь P3"}], sku="EDGE-P3")

    # ── C1: contacts ─────────────────────────────────────────────────────────
    method = c.post("/api/v1/delivery-methods/", {"name": "WS-13 · кур'єр"})["id"]
    run.put("edge:C1:method", method)
    for key, contacts in (
        ("no-contacts", []),
        ("one-contact-no-phone", [{"name": "Основний без телефону", "email": "c1@example.com"}]),
        (
            "three-contacts",
            [
                {
                    "name": "Перший",
                    "phone": "+380 50 000 00 01",
                    "delivery_method_id": method,
                    "delivery_details": "Дуже довга адреса доставки: місто, вулиця, будинок, під'їзд, поверх, "
                    "квартира, код домофону, орієнтир і побажання щодо часу",
                },
                {"name": "Другий", "phone": "+380 50 000 00 02", "role": "бухгалтерія"},
                {"name": "Третій", "email": "third@example.com", "city": "Львів"},
            ],
        ),
    ):
        made = c.post("/api/v1/customers/", {"name": f"C1 · {key}", "kind": "company", "contacts": contacts})
        run.put(f"edge:C1:{key}", made["id"], made.get("code"))
    findings.append("C1: an inactive delivery method is not a state the application has (E0-I03) — not seeded")

    customer = run.id("edge:C1:three-contacts")

    # ── S1: three configurations of one product ─────────────────────────────
    s1 = _product(
        run,
        "S1",
        "S1 · Виріб на три конфігурації",
        [
            {"name": "Корпус S1", "aliases": ["s1_body"]},
            {"name": "Стандарт S1", "aliases": ["s1_std"], "variant": ("Тип", "стандарт")},
            {"name": "Альт S1", "aliases": ["s1_alt"], "variant": ("Тип", "альт")},
        ],
        groups=[("Тип", ["стандарт", "альт", "третій"])],
        files=["edge:file:s1_body.gcode.3mf"],
        status="ready",
    )
    opt = {n: run.id(f"edge:S1:option:Тип:{n}") for n in ("стандарт", "альт", "третій")}
    for name, qty in (("стандарт", 10), ("альт", 2), ("третій", 1)):
        item = c.post(
            "/api/v1/stock/moves",
            {"kind": "receipt", "product_id": s1, "options": [opt[name]], "qty": qty, "note": NOTE},
        )
        run.put(f"edge:S1:item:{name}", item["id"], item.get("code"))
    c.patch(f"/api/v1/stock/items/{run.id('edge:S1:item:альт')}", {"min_qty": 5})
    c.post(
        "/api/v1/stock/moves", {"kind": "reserve", "item_id": run.id("edge:S1:item:стандарт"), "qty": 2, "note": NOTE}
    )
    c.post(
        "/api/v1/stock/moves",
        {"kind": "stocktake", "item_id": run.id("edge:S1:item:третій"), "counted": 0, "note": NOTE},
    )
    # «can assemble» > 0 for the standard configuration, 0 for the others.
    for part in ("Корпус S1", "Стандарт S1"):
        c.post(
            f"/api/v1/products/{s1}/stock/adjust",
            {"part_id": run.id(f"edge:S1:part:{part}"), "delta": 3, "note": NOTE},
        )

    # ── Q1: active, two configurations, finished + kits + prints, partial issue
    p1 = run.id("edge:P1")
    g_top, g_tail = run.id("edge:P1:group:Верх"), run.id("edge:P1:group:Хвіст")
    o = {
        n: run.id(f"edge:P1:option:{g}:{n}")
        for g, n in (("Верх", "з кришкою"), ("Верх", "без кришки"), ("Хвіст", "A"), ("Хвіст", "B"))
    }
    c.post(
        "/api/v1/stock/moves",
        {"kind": "receipt", "product_id": p1, "options": [o["з кришкою"], o["A"]], "qty": 3, "note": NOTE},
    )
    for part, n in (("Корпус P1", 2), ("Хвіст B", 2)):
        c.post(
            f"/api/v1/products/{p1}/stock/adjust", {"part_id": run.id(f"edge:P1:part:{part}"), "delta": n, "note": NOTE}
        )
    q1 = c.post(
        "/api/v1/projects/",
        {
            "name": "Q1 · " + LONG,
            "customer_id": customer,
            "due_date": (today + timedelta(days=1)).isoformat(),
            "priority": "high",
            "price": 5000,
        },
    )["id"]
    run.put("edge:Q1", q1)
    lines = c.post(
        f"/api/v1/projects/{q1}/lines/batch",
        {
            "lines": [
                {
                    "kind": "product",
                    "product_id": p1,
                    "quantity": 6,
                    "choices": {str(g_top): o["з кришкою"], str(g_tail): o["A"]},
                    "stock": {"from_finished": 3, "from_kits": 0},
                },
                {
                    "kind": "product",
                    "product_id": p1,
                    "quantity": 4,
                    "choices": {str(g_top): o["без кришки"], str(g_tail): o["B"]},
                    "stock": {"from_finished": 0, "from_kits": 2},
                },
            ]
        },
    )["results"]
    run.put("edge:Q1:line:1", lines[0]["line_id"])
    run.put("edge:Q1:line:2", lines[1]["line_id"])
    c.post(
        f"/api/v1/projects/{q1}/fulfilment",
        {
            "lines": [{"line_id": lines[0]["line_id"], "issue": 2}],
            "recipient": {"name": "Перший", "phone": "+380 50 000 00 01"},
        },
    )

    # ── Q2: empty order ──────────────────────────────────────────────────────
    run.put("edge:Q2", c.post("/api/v1/projects/", {"name": "Q2 · порожнє замовлення", "responsible_id": None})["id"])

    # ── Q3: qc with a deficit; covered prep; completed by an inactive person; cancelled
    def order_with(name, product, qty, *, stock=None, due=None, responsible=None):
        body = {"name": name, "customer_id": customer, "due_date": due}
        if responsible is not None:
            body["responsible_id"] = responsible
        oid = c.post("/api/v1/projects/", body)["id"]
        line = {"kind": "product", "product_id": product, "quantity": qty}
        if stock:
            line["stock"] = stock
        result = c.post(f"/api/v1/projects/{oid}/lines/batch", {"lines": [line]})["results"][0]
        return oid, result["line_id"]

    q3_qc, _ = order_with("Q3 · контроль при дефіциті", run.id("edge:P3"), 20)
    c.put(f"/api/v1/projects/{q3_qc}/stage", {"stage": "qc"})
    run.put("edge:Q3:qc", q3_qc)
    std = run.id("edge:S1:item:стандарт")
    c.post("/api/v1/stock/moves", {"kind": "receipt", "item_id": std, "qty": 4, "note": NOTE})
    q3_prep, _ = order_with("Q3 · забезпечене на підготовці", s1, 2, stock={"from_finished": 2, "from_kits": 0})
    run.put("edge:Q3:prep", q3_prep)
    q3_done, q3_done_line = order_with(
        "Q3 · завершене",
        s1,
        1,
        stock={"from_finished": 1, "from_kits": 0},
        responsible=run.id("edge:R1:ws13-inactive"),
    )
    c.post(
        f"/api/v1/projects/{q3_done}/fulfilment",
        {"lines": [{"line_id": q3_done_line, "issue": 1}], "recipient": {"name": "Перший"}, "complete": True},
    )
    run.put("edge:Q3:done", q3_done)
    c.patch(f"/api/v1/users/{run.id('edge:R1:ws13-inactive')}", {"is_active": False})
    q3_cancel, _ = order_with("Q3 · скасоване", run.id("edge:P3"), 3)
    c.patch(f"/api/v1/projects/{q3_cancel}", {"status": "cancelled"})
    run.put("edge:Q3:cancelled", q3_cancel)

    # ── Q4: no farm printer for the file; overdue; an unsliced file ─────────
    q4p = _product(
        run,
        "Q4",
        "Q4 · Виріб лише під X1E",
        [{"name": "Деталь Q4", "aliases": ["q4_part"]}],
        files=["edge:file:q4_x1e_only.gcode.3mf", "edge:file:q4_unsliced.stl"],
    )
    q4, _ = order_with("Q4 · прострочене без принтера", q4p, 8, due=(today - timedelta(days=2)).isoformat())
    run.put("edge:Q4", q4)

    # ── Q5: partial receipt and issue, a write-off, customerless close to stock
    q5, q5_line = order_with("Q5 · часткова видача і списання", s1, 3, stock={"from_finished": 3, "from_kits": 0})
    c.post(
        f"/api/v1/projects/{q5}/fulfilment",
        {
            "lines": [{"line_id": q5_line, "issue": 1, "write_off": 1}],
            "recipient": {"name": "Перший"},
            "write_off_note": "Тріснула під час пакування",
        },
    )
    run.put("edge:Q5", q5)
    q5s = c.post("/api/v1/projects/", {"name": "Q5 · без замовника, на склад"})["id"]
    c.post(
        f"/api/v1/projects/{q5s}/lines/batch",
        {
            "lines": [
                {"kind": "product", "product_id": s1, "quantity": 1, "stock": {"from_finished": 1, "from_kits": 0}}
            ]
        },
    )
    c.patch(f"/api/v1/projects/{q5s}", {"status": "completed"})
    run.put("edge:Q5:to-stock", q5s)

    # ── N1 + J1: 40-line note; a note whose product was deleted; supplier changed
    n1_products = []
    for i in range(1, 41):
        pid = c.post(
            "/api/v1/products/", {"name": f"N1 · Виріб {i:02d} з довгою назвою для накладної", "sku": f"N1-{i:02d}"}
        )["id"]
        c.post("/api/v1/stock/moves", {"kind": "receipt", "product_id": pid, "options": [], "qty": 1, "note": NOTE})
        n1_products.append(pid)
    n1 = c.post("/api/v1/projects/", {"name": "N1 · сорок позицій", "customer_id": customer})["id"]
    lines = c.post(
        f"/api/v1/projects/{n1}/lines/batch",
        {
            "lines": [
                {"kind": "product", "product_id": pid, "quantity": 1, "stock": {"from_finished": 1, "from_kits": 0}}
                for pid in n1_products
            ]
        },
    )["results"]
    answer = c.post(
        f"/api/v1/projects/{n1}/fulfilment",
        {
            "lines": [{"line_id": r["line_id"], "issue": 1} for r in lines],
            "recipient": {"name": "Перший"},
            "complete": True,
        },
    )
    run.put("edge:N1:note-40", answer["issue_id"], answer.get("issue_code"))
    gone = c.post("/api/v1/products/", {"name": "J1 · Виріб, якого вже немає", "sku": "J1-GONE"})["id"]
    c.post("/api/v1/stock/moves", {"kind": "receipt", "product_id": gone, "options": [], "qty": 2, "note": NOTE})
    issued = c.post(
        "/api/v1/stock/moves",
        {
            "kind": "issue",
            "product_id": gone,
            "options": [],
            "qty": 2,
            "customer_id": customer,
            "recipient": {"name": "Перший"},
            "note": NOTE,
        },
    )
    run.put("edge:N1:note-1", issued["issue_id"], issued.get("issue_code"))
    c.delete(f"/api/v1/products/{gone}")
    run.put("edge:J1:deleted-product", gone)
    c.patch("/api/v1/settings/", {"document_supplier_name": "BamDude · Майстерня (нові реквізити)"})
    return findings


def checks(client, mapping: dict) -> list[tuple[str, bool, str]]:
    c = client
    out: list[tuple[str, bool, str]] = []

    def add(name, ok, detail=""):
        out.append((name, bool(ok), str(detail)))

    def mid(key):
        return mapping[key]["id"]

    q1 = c.get(f"/api/v1/projects/{mid('edge:Q1')}")
    line = next(ln for ln in q1["lines"] if ln["id"] == mid("edge:Q1:line:1"))
    add("Q1 partial issue", 0 < line["issued"] < line["quantity"], f"{line['issued']}/{line['quantity']}")
    second = next(ln for ln in q1["lines"] if ln["id"] == mid("edge:Q1:line:2"))
    add(
        "Q1 finished and kits are separate numbers",
        line["from_finished"] == 3 and second["from_kit_units"] >= 2,
        f"{line['from_finished']} / {second['from_kit_units']}",
    )

    q2 = c.get(f"/api/v1/projects/{mid('edge:Q2')}")
    add(
        "Q2 unknowns are null",
        all(q2.get(k) is None for k in ("customer_id", "responsible_id", "due_date", "price")),
        {k: q2.get(k) for k in ("customer_id", "responsible_id", "due_date", "price")},
    )

    qc = c.get(f"/api/v1/projects/{mid('edge:Q3:qc')}")
    add("Q3 qc kept with a deficit", qc["stage"] == "qc" and qc["figures"]["remaining"] > 0, qc["figures"]["remaining"])

    fc = c.get(f"/api/v1/projects/{mid('edge:Q4')}/forecast")
    add(
        "Q4 forecast says no printer / incomplete",
        fc["unroutable_prints"] > 0 or not fc["eta_complete"],
        {k: fc.get(k) for k in ("unroutable_prints", "unknown_prints", "eta_complete")},
    )

    q5 = c.get(f"/api/v1/projects/{mid('edge:Q5')}")
    add("Q5 write-off raises the need", q5["lines"][0]["written_off"] == 1, q5["lines"][0]["written_off"])
    to_stock = c.get(f"/api/v1/projects/{mid('edge:Q5:to-stock')}")
    notes = c.get(f"/api/v1/stock-issues/?project_id={mid('edge:Q5:to-stock')}&all=true")
    add(
        "Q5 closed to stock without a note",
        to_stock["status"] == "completed" and notes["meta"]["total"] == 0,
        f"{to_stock['status']}, notes {notes['meta']['total']}",
    )

    p1 = next(p for p in c.get("/api/v1/products?page=1&q=EDGE-P1")["items"] if p["id"] == mid("edge:P1"))
    models = set(p1.get("models") or [])
    add("P1 facets carry every model", {"P1S", "X1C"} <= models, sorted(models))
    colors = set(p1.get("colors") or [])
    add("P1 facets carry every colour", len(colors) >= 3, sorted(colors))

    stock = c.get(f"/api/v1/products/{mid('edge:P2')}/stock")
    counted = {b["part_id"] for b in stock["balances"]}
    add(
        "P2 zero part has a shelf, ignored has none",
        mid("edge:P2:part:Нуль без позначки") in counted and mid("edge:P2:part:Не рахувати") not in counted,
        sorted(counted),
    )

    name = "Я · P3 виріб наприкінці каталогу"
    first = c.get("/api/v1/products?page=1&per_page=24&sort_by=name-asc")
    add("P3 not on page 1 of the name sort", all(p["id"] != mid("edge:P3") for p in first["items"]))
    found = c.get(f"/api/v1/products?page=1&per_page=24&q={quote(name.split()[-1])}")
    add("P3 found on page 1 of a search", any(p["id"] == mid("edge:P3") for p in found["items"]))

    items = {k: c.get(f"/api/v1/stock/items/{mid(f'edge:S1:item:{k}')}") for k in ("стандарт", "альт", "третій")}
    add("S1 manual and order reservations differ", items["стандарт"]["reserved"] >= 2, items["стандарт"]["reserved"])
    add("S1 below minimum", items["альт"]["below_min"], items["альт"]["on_hand"])
    add("S1 zero position", items["третій"]["on_hand"] == 0)
    add(
        "S1 can assemble >0 and 0",
        items["стандарт"]["can_assemble"] > 0 and items["альт"]["can_assemble"] == 0,
        f"{items['стандарт']['can_assemble']} / {items['альт']['can_assemble']}",
    )

    note40 = c.get(f"/api/v1/stock-issues/{mid('edge:N1:note-40')}")
    add("N1 note of 40 lines", len(note40["lines"]) == 40, len(note40["lines"]))
    note1 = c.get(f"/api/v1/stock-issues/{mid('edge:N1:note-1')}")
    add(
        "N1 note of a deleted product keeps its text",
        len(note1["lines"]) == 1 and note1["lines"][0]["product_id"] is None and note1["lines"][0]["product_name"],
        note1["lines"][0],
    )
    supplier = (note40.get("supplier") or {}).get("name")
    add("N1 supplier snapshot unchanged after the settings changed", supplier == "BamDude · Майстерня", supplier)
    return out
