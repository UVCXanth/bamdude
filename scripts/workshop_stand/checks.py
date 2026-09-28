"""`stand.py status` — what the seed must have produced (spec C2, C5, C6, W1, W2).

Each check returns ``(name, ok, detail)``. A difference the review has not
agreed to is a failure; an agreed one (C6: the duplicate 245, the completed 249
with its plate units) is checked as its exact expected result, never skipped.
The comparisons themselves are the pure functions below, so their sensitivity
is tested without a stand: a right time with a wrong plate, model or filament,
or a right note total with the wrong lines, must all fail.
"""

from __future__ import annotations

from collections import Counter, defaultdict

import recipe


def _norm(value):
    """Colours compare case-insensitively; everything else as it is."""
    if isinstance(value, str) and value.startswith("#"):
        return value.upper()
    return value


def reader_mismatches(expected: dict, got: dict) -> list[str]:
    """The real 3MF reader's answer against the recipe: plate, model, time and every channel."""
    if not got.get("ok"):
        return [f"refused: {got.get('reason')}"]
    out = [f"{k} {got.get(k)!r} ≠ {expected[k]!r}" for k in ("plate", "model", "seconds") if got.get(k) != expected[k]]
    want = [(t.upper(), _norm(c)) for t, c in expected["filaments"]]
    have = [(str(t).upper(), _norm(c)) for t, c in got.get("filaments") or []]
    if want != have:
        out.append(f"filaments {have} ≠ {want}")
    return out


def row_mismatches(expected: dict, got: dict) -> list[str]:
    """Every field ``expected`` names, compared in ``got``."""
    return [f"{k} {got.get(k)!r} ≠ {v!r}" for k, v in expected.items() if _norm(got.get(k)) != _norm(v)]


def note_mismatches(expected: list[tuple], got: list[tuple]) -> list[str]:
    """Dispatch-note lines as (product, options, quantity) — equal as a multiset, not only in sum."""
    if Counter(expected) == Counter(got):
        return []
    return [f"lines {sorted(got)} ≠ {sorted(expected)}"]


def metadata_mismatches(spec: dict, metadata: dict | None) -> list[str]:
    """A library file's stored ``file_metadata`` against the recipe it was written from (C2)."""
    metadata = metadata or {}
    if not spec["sliced"]:
        return [] if not metadata.get("plates") else [f"an unsliced file has plates {metadata.get('plates')}"]
    out = []
    if metadata.get("sliced_for_model") != spec["model"]:
        out.append(f"model {metadata.get('sliced_for_model')!r} ≠ {spec['model']!r}")
    stored = {p["index"]: p for p in metadata.get("plates") or []}
    for plate in spec["plates"]:
        got = stored.get(plate["index"])
        if got is None:
            out.append(f"plate {plate['index']} missing")
            continue
        objects = Counter((got.get("printable_objects") or {}).values())
        if dict(objects) != plate["objects"]:
            out.append(f"plate {plate['index']} objects {dict(objects)} ≠ {plate['objects']}")
        if got.get("print_time_seconds") != plate["minutes"] * 60:
            out.append(f"plate {plate['index']} time {got.get('print_time_seconds')} ≠ {plate['minutes'] * 60}")
        want = [(f["type"], _norm(f["color"])) for f in plate["filaments"]]
        have = [(f.get("type"), _norm(f.get("color"))) for f in got.get("filaments") or []]
        if want != have:
            out.append(f"plate {plate['index']} filaments {have} ≠ {want}")
    return out


class Checks:
    def __init__(self, client, dump: dict, mapping: dict, direct, mode: str):
        self.c = client
        self.dump = dump
        self.db = dump["db"]
        self.map = mapping
        self.direct = direct
        self.mode = mode
        self.results: list[tuple[str, bool, str]] = []
        self.files = {f["filename"]: f for f in recipe.library_files(dump)}

    def id(self, key: str):
        return self.map[key]["id"]

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.results.append((name, bool(ok), detail))

    def check_list(self, name: str, mismatches: list[str]) -> None:
        self.check(name, not mismatches, "; ".join(mismatches))

    # ── C5 / C6: lines, orders, positions, shelves ───────────────────────────

    def lines_and_orders(self) -> None:
        agreed = {u["order"] for u in self.dump["meta"].get("agreed_completions") or []}
        stages = self.dump["stages"]
        for order in self.db["orders"]:
            detail = self.c.get(f"/api/v1/projects/{self.id(f'order:{order["id"]}')}")
            self.check(f"order {order['id']} status", detail["status"] == order["status"], detail["status"])
            stage = stages[str(order["id"])]
            if order["status"] == "active":
                self.check(
                    f"order {order['id']} stage", detail.get("stage") == stage, f"{detail.get('stage')} vs {stage}"
                )
            by_id = {ln["id"]: ln for ln in detail["lines"]}
            for line in order["lines"]:
                server = by_id[self.id(f"line:{order['id']}:{line['id']}")]
                if order["id"] in agreed:
                    self.agreed_completion_line(order, line, server)
                    continue
                for field, mock in (
                    ("from_finished", "fromFinished"),
                    ("assembled", "assembled"),
                    ("received", "received"),
                    ("issued", "issued"),
                ):
                    want = line.get(mock, 0) or 0
                    self.check(
                        f"line {order['id']}/{line['id']} {field}",
                        server.get(field, 0) == want,
                        f"{server.get(field)} vs {want}",
                    )

    def agreed_completion_line(self, order: dict, line: dict, server: dict) -> None:
        """C6 / I01 / I02: 150 pieces = 5 plates × 30, received and issued, completed."""
        units = recipe.plate_units_for(self.dump, order["id"], line["id"])
        self.check(
            f"C6 order {order['id']} plate units exact",
            units["plates"] * units["per_plate"] == units["mockup_units"] == line["qty"],
            f"{units['plates']} × {units['per_plate']} vs {line['qty']}",
        )
        expected = {
            "quantity": units["plates"],
            "received": units["plates"],
            "issued": units["plates"],
            "from_finished": 0,
            "assembled": 0,
        }
        self.check_list(f"C6 order {order['id']}/{line['id']} agreed replacement", row_mismatches(expected, server))
        entry = self.map.get(f"agreed:order:{order['id']}") or {}
        self.check(
            f"C6 order {order['id']} mapping marks the replacement and its units",
            bool(entry.get("id")) and entry.get("units") and entry["units"][0]["plates"] == units["plates"],
            str({k: entry.get(k) for k in ("code", "units")}),
        )
        if entry.get("id"):
            note = self.c.get(f"/api/v1/stock-issues/{entry['id']}")
            got = [(ln.get("product_id"), (), ln["quantity"]) for ln in note["lines"]]
            self.check_list(
                f"C6 order {order['id']} synthetic note: one line of {units['plates']} plates",
                note_mismatches([(server["product_id"], (), units["plates"])], got)
                + ([] if note.get("project_id") == self.id(f"order:{order['id']}") else ["not this order's note"]),
            )

    def dispatch_notes(self) -> None:
        duplicates = {int(k): v for k, v in self.dump["meta"]["agreed_duplicates"].items()}
        agreed = self.dump["meta"].get("agreed_completions") or []
        listing = self.c.get("/api/v1/stock-issues/?all=true")
        listed = {row["id"] for row in listing["items"]}
        expected = len(self.db["docs"]) - len(duplicates) + len(agreed)
        baseline = {
            entry["id"]
            for key, entry in self.map.items()
            if (key.startswith("doc:") or key.startswith("agreed:order:")) and entry.get("id")
        }
        # 32 mockup documents − 1 duplicate of 245 + 1 synthetic issue of 249 = 32 (C6);
        # the edges set's own notes are counted apart.
        self.check(
            "C6 baseline dispatch notes: 32 − 1 duplicate + 1 synthetic = 32",
            len(baseline) == expected == 32 and baseline <= listed,
            f"{len(baseline)} vs {expected}",
        )
        extra = listed - baseline
        self.check(
            f"C6 notes beyond the baseline belong to the edges set ({len(extra)})",
            (not extra) if self.mode == "baseline" else True,
            f"{len(extra)}",
        )
        for doc in self.db["docs"]:
            entry = self.map.get(f"doc:{doc['id']}") or {}
            if doc["id"] in duplicates:
                self.check(
                    f"doc {doc['id']} is an alias of {duplicates[doc['id']]}",
                    entry.get("duplicate_of") == f"doc:{duplicates[doc['id']]}" and entry.get("id") is None,
                )
                continue
            order = next(o for o in self.db["orders"] if o["id"] == doc["orderId"])
            want = []
            for item in doc["items"]:
                line = recipe.line_for_doc_item(self.db, order, item)
                options = tuple(sorted(recipe.option_names(self.db, line)))
                want.append((self.id(f"product:{item['productId']}"), options, item["qty"]))
            note = self.c.get(f"/api/v1/stock-issues/{entry['id']}")
            got = [
                (
                    ln.get("product_id"),
                    tuple(sorted(c["option_name"] for c in (ln.get("configuration") or {}).get("choices") or [])),
                    ln["quantity"],
                )
                for ln in note.get("lines", [])
            ]
            self.check_list(f"doc {doc['id']} lines (product, configuration, quantity)", note_mismatches(want, got))
            self.check(
                f"doc {doc['id']} belongs to order {order['id']}",
                note.get("project_id") == self.id(f"order:{order['id']}"),
                f"{note.get('project_id')}",
            )

    def positions_and_shelves(self) -> None:
        for fin in self.db["fin"]:
            item = self.c.get(f"/api/v1/stock/items/{self.id(f'fin:{fin["id"]}')}")
            self.check(f"fin {fin['id']} on_hand", item["on_hand"] == fin["qty"], f"{item['on_hand']} vs {fin['qty']}")
            self.check(
                f"fin {fin['id']} reserved",
                item["reserved"] == fin.get("reserved", 0),
                f"{item['reserved']} vs {fin.get('reserved', 0)}",
            )
        for product in self.db["products"]:
            if product["origin"] != "catalog":
                continue
            pid = self.id(f"product:{product['id']}")
            balances = {
                row["part_id"]: row["balance"] for row in self.c.get(f"/api/v1/products/{pid}/stock")["balances"]
            }
            for part_id, want in (product.get("shelf") or {}).items():
                have = balances.get(self.id(f"part:{part_id}"), 0)
                self.check(f"shelf {product['id']}/{part_id}", have == want, f"{have} vs {want}")

    # ── C2: stored metadata and the real reader on every file ────────────────

    @staticmethod
    def _plate_expectation(spec: dict, plate: dict) -> dict:
        return {
            "plate": plate["index"],
            "model": spec["model"],
            "seconds": plate["minutes"] * 60,
            "filaments": [(f["type"], f["color"]) for f in plate["filaments"]],
        }

    def reader(self) -> None:
        requests = []
        rows = {}
        for name, spec in self.files.items():
            row = self.c.get(f"/api/v1/library/files/{self.id(spec['key'])}")
            rows[name] = row
            self.check_list(f"metadata {name}", metadata_mismatches(spec, row.get("metadata")))
            for plate in [p["index"] for p in spec["plates"]] or [None]:
                requests.append({"key": f"{name}#{plate}", "file_path": row["file_path"], "plate": plate})
        answers = self.direct("reader", {"checks": requests})
        for name, spec in self.files.items():
            if not spec["sliced"]:
                got = answers[f"{name}#None"]
                self.check(f"reader {name} refuses (unsliced)", not got["ok"], f"{got.get('reason')}")
                continue
            for plate in spec["plates"]:
                key = f"{name}#{plate['index']}"
                self.check_list(f"reader {key}", reader_mismatches(self._plate_expectation(spec, plate), answers[key]))

    # ── W1: three states of work, each row by what it holds ──────────────────

    def work_states(self) -> None:
        for order in self.db["orders"]:
            if not order["queue"] and not any(p["status"] == "printing" for p in order["prints"]):
                continue
            oid = self.id(f"order:{order['id']}")
            got = self.c.get(f"/api/v1/projects/{oid}/queue")
            want = defaultdict(int)
            pending = {row["id"]: row for row in got.get("pending", [])}
            sources: list[tuple] = []
            awaiting = {row["id"]: row for row in got.get("awaiting", [])}
            for q in order["queue"]:
                if q["status"] == "printing":
                    want["printing"] += 1
                    continue
                spec = self.files[q["fileName"]]
                plate = next(p for p in spec["plates"] if p["index"] == q["plateIndex"])
                line_id = self.id(f"line:{order['id']}:{q['lineId']}") if q.get("lineId") else None
                common = {
                    "library_file_id": self.id(spec["key"]),
                    "plate_id": q["plateIndex"],
                    "project_line_id": line_id,
                    "print_time_seconds": plate["minutes"] * 60,
                }
                if q["tier"] == "printer":
                    want["pending"] += 1
                    row = pending.get(self.id(f"queue:{q['id']}"), {})
                    expected = {**common, "queue_id": self.id(f"printer:{q['printer']}")}
                    self.check_list(f"W1 queue {q['id']} (printer)", row_mismatches(expected, row))
                    sources.append((f"pq:{row.get('id')}", q, spec, plate))
                    self.check(
                        f"W1 queue {q['id']} owns its bytes",
                        row.get("source_storage") not in (None, "legacy"),
                        str(row.get("source_storage")),
                    )
                else:
                    want["awaiting"] += 1
                    row = awaiting.get(self.id(f"auto:{q['id']}"), {})
                    expected = {**common, "target_model": recipe.MODEL_NAMES.get(q.get("model"), q.get("model"))}
                    self.check_list(f"W1 queue {q['id']} (auto)", row_mismatches(expected, row))
                    sources.append((f"aq:{row.get('id')}", q, spec, plate))
                    types = row.get("required_filament_types")
                    if types is not None:
                        self.check(
                            f"W1 queue {q['id']} filament types",
                            sorted(t.upper() for t in types) == sorted({f["type"].upper() for f in plate["filaments"]}),
                            str(types),
                        )
            printing_keys = {
                self.id(f"archive:q{p['id']}")
                for p in order["prints"]
                if p["status"] == "printing" and f"archive:q{p['id']}" in self.map
            } | {
                self.id(f"archive:q{q['id']}")
                for q in order["queue"]
                if q["status"] == "printing" and f"archive:q{q['id']}" in self.map
            }
            got_printing = {row["archive_id"]: row for row in got.get("printing", [])}
            self.check(
                f"W1 order {order['id']} printing archives",
                set(got_printing) == printing_keys and len(printing_keys) == want["printing"],
                f"{sorted(got_printing)} vs {sorted(printing_keys)}",
            )
            for state in ("pending", "awaiting"):
                self.check(
                    f"W1 order {order['id']} {state} count",
                    len(got.get(state, [])) == want[state],
                    f"{len(got.get(state, []))} vs {want[state]}",
                )
            self.queue_sources(sources)

    def queue_sources(self, sources: list[tuple]) -> None:
        """The bytes each queued job owns, read by the real reader for its plate (C2): the
        queue response does not carry the channels, the stored source does."""
        if not sources:
            return
        ids = {"pq": [], "aq": []}
        for key, *_ in sources:
            kind, _, item = key.partition(":")
            if item != "None":
                ids[kind].append(int(item))
        paths = self.direct("queue_sources", ids)
        requests = [
            {"key": key, "file_path": paths[key]["file_path"], "plate": paths[key]["plate"]}
            for key, *_ in sources
            if paths.get(key)
        ]
        answers = self.direct("reader", {"checks": requests}) if requests else {}
        for key, q, spec, plate in sources:
            if not paths.get(key):
                self.check(f"W1 queue {q['id']} source", False, "no captured source")
                continue
            self.check_list(
                f"W1 queue {q['id']} source (plate, model, time, channels)",
                reader_mismatches(self._plate_expectation(spec, plate), answers[key]),
            )

    # ── W2: the journal by its cursor ────────────────────────────────────────

    def journal(self, page: int = 20) -> None:
        for book in ("both", "finished", "parts"):
            seen: set = set()
            pages = 0
            cursor = None
            duplicates = 0
            while True:
                query = f"/api/v1/stock/journal?book={book}&limit={page}" + (f"&cursor={cursor}" if cursor else "")
                answer = self.c.get(query)
                pages += 1
                for row in answer["items"]:
                    key = (row.get("book"), row.get("id"))
                    duplicates += key in seen
                    seen.add(key)
                cursor = answer.get("next_cursor")
                if not cursor or pages > 1000:
                    break
            self.check(f"W2 journal {book}: ≥3 pages of {page}", pages >= 3, f"{pages} pages, {len(seen)} rows")
            self.check(f"W2 journal {book}: no row twice", duplicates == 0, f"{duplicates}")
            self.check(f"W2 journal {book}: the walk ends", not cursor, "")

    def run(self) -> list[tuple[str, bool, str]]:
        for step in (
            self.lines_and_orders,
            self.dispatch_notes,
            self.positions_and_shelves,
            self.reader,
            self.work_states,
            self.journal,
        ):
            step()
        return self.results
