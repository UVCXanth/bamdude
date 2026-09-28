"""`stand.py status` — what the seed must have produced (spec C5, C6, C2, W1, W2).

Each check returns ``(name, ok, detail)``. A difference the review has not
agreed to is a failure; an agreed one (C6) is checked as the expected result.
"""

from __future__ import annotations

from collections import defaultdict

import recipe


class Checks:
    def __init__(self, client, dump: dict, mapping: dict, direct, mode: str):
        self.c = client
        self.dump = dump
        self.db = dump["db"]
        self.map = mapping
        self.direct = direct
        self.mode = mode
        self.results: list[tuple[str, bool, str]] = []

    def id(self, key: str):
        return self.map[key]["id"]

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.results.append((name, bool(ok), detail))

    # ── C5: lines, orders, positions, shelves ────────────────────────────────

    def lines_and_orders(self) -> None:
        unagreed = {u["order"] for u in self.dump["meta"].get("unagreed_completions") or []}
        stages = self.dump["stages"]
        for order in self.db["orders"]:
            detail = self.c.get(f"/api/v1/projects/{self.id(f'order:{order["id"]}')}")
            self.check(f"order {order['id']} status", detail["status"] == order["status"], detail["status"])
            stage = stages[str(order["id"])]
            if order["status"] == "active":
                self.check(
                    f"order {order['id']} stage", detail.get("stage") == stage, f"{detail.get('stage')} vs {stage}"
                )
            if order["id"] in unagreed:
                self.check(f"order {order['id']} UNAGREED completion", False, "awaiting the review (spec C5)")
                continue
            by_id = {ln["id"]: ln for ln in detail["lines"]}
            for line in order["lines"]:
                server = by_id[self.id(f"line:{order['id']}:{line['id']}")]
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

    def dispatch_notes(self) -> None:
        duplicates = {int(k): v for k, v in self.dump["meta"]["agreed_duplicates"].items()}
        unagreed = self.dump["meta"].get("unagreed_completions") or []
        listing = self.c.get("/api/v1/stock-issues/?all=true")
        listed = {row["id"] for row in listing["items"]}
        expected = len(self.db["docs"]) - len(duplicates) + len(unagreed)
        baseline = {
            entry["id"]
            for key, entry in self.map.items()
            if (key.startswith("doc:") or key.startswith("unagreed:order:")) and entry.get("id")
        }
        # Baseline notes are counted apart from the ones the edges set adds (C6).
        self.check(
            "C6 dispatch notes: 32 in the mockup, one duplicate → 31 (+ unagreed)",
            len(baseline) == expected and baseline <= listed,
            f"{len(baseline)} vs {expected} ({len(unagreed)} from unagreed completions)",
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
            note = self.c.get(f"/api/v1/stock-issues/{entry['id']}")
            units = sum(ln.get("quantity", 0) for ln in note.get("lines", []))
            want = sum(i["qty"] for i in doc["items"])
            self.check(f"doc {doc['id']} units", units == want, f"{units} vs {want}")
            self.check(
                f"doc {doc['id']} lines",
                len(note.get("lines", [])) == len(doc["items"]),
                f"{len(note.get('lines', []))}",
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

    # ── C2: the real reader on every file ────────────────────────────────────

    def reader(self) -> None:
        files = {f["filename"]: f for f in recipe.library_files(self.dump)}
        checks = []
        for name, spec in files.items():
            file_id = self.id(spec["key"])
            row = self.c.get(f"/api/v1/library/files/{file_id}")
            plates = [p["index"] for p in spec["plates"]] or [None]
            for plate in plates:
                checks.append({"key": f"{name}#{plate}", "file_path": row["file_path"], "plate": plate})
        answers = self.direct("reader", {"checks": checks})
        for name, spec in files.items():
            for plate in list(spec["plates"]) or [None]:
                key = f"{name}#{plate['index'] if plate else None}"
                got = answers[key]
                if spec["sliced"]:
                    ok = got["ok"] and got["print_time_seconds"] == plate["minutes"] * 60
                    self.check(f"reader {key}", ok, f"{got}")
                else:
                    self.check(f"reader {key} refuses (unsliced)", not got["ok"], f"{got.get('reason')}")

    # ── W1: three states of work ─────────────────────────────────────────────

    def work_states(self) -> None:
        for order in self.db["orders"]:
            if not order["queue"]:
                continue
            want = defaultdict(int)
            for q in order["queue"]:
                state = (
                    "printing" if q["status"] == "printing" else ("pending" if q["tier"] == "printer" else "awaiting")
                )
                want[state] += 1
            got = self.c.get(f"/api/v1/projects/{self.id(f'order:{order["id"]}')}/queue")
            for state in ("printing", "pending", "awaiting"):
                self.check(
                    f"W1 order {order['id']} {state}",
                    len(got.get(state, [])) == want[state],
                    f"{len(got.get(state, []))} vs {want[state]}",
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
