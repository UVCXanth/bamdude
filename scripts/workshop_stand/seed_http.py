"""The stand seed through the API (spec C1–C6, W1) — stdlib only.

Order of operations (C3), so nothing is counted twice:
  1. users, settings, delivery methods, categories, customers, library folders;
     printers and files through ``seed_direct``; products (parts, aliases,
     variants, files, folders, attachments, status, catalog flag);
  2. opening stock: each finished position receives exactly what the orders
     take from it, each part shelf exactly the kits the orders take;
  3. orders and their lines, with explicit stock numbers;
  4. prints (``seed_direct``), their defects (API), queues (API);
  5. issues — one fulfilment batch per mockup dispatch note, in date order,
     receiving what the batch issues; C6's duplicate is not issued twice;
  6. receipts nobody issued yet, stages, cancel;
  7. final balances: a stocktake of every position to the mockup's count, the
     manual reservation, the part shelves.
Every mapping lands in ``mapping.json``: mockup key → server id → code (C1).
"""

from __future__ import annotations

import json
import secrets
import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path

import recipe

SEED_NOTE = "WS-13 stand"


class Seed:
    def __init__(self, client, dump: dict, *, root: Path, delta: int, direct, mode: str):
        self.c = client
        self.dump = dump
        self.db = dump["db"]
        self.root = root
        self.delta = delta
        self.direct = direct  # direct(command, payload) -> result, runs seed_direct in a child
        self.mode = mode
        self.map: dict[str, dict] = {}
        self.findings: list[str] = []
        self.files_spec = recipe.library_files(dump)
        self.file_by_name = {f["filename"]: f for f in self.files_spec}

    # ── bookkeeping ──────────────────────────────────────────────────────────

    def put(self, key: str, server_id, code: str | None = None, **extra) -> None:
        self.map[key] = {"id": server_id, **({"code": code} if code else {}), **extra}

    def id(self, key: str):
        return self.map[key]["id"]

    def note(self, finding: str) -> None:
        self.findings.append(finding)
        print(f"  ! {finding}")

    # ── 1. People, settings, dictionaries ────────────────────────────────────

    def setup_admin(self) -> dict:
        password = "Ws13-" + secrets.token_urlsafe(18)
        status = self.c.get("/api/v1/auth/status")
        if not status.get("requires_setup"):
            raise RuntimeError("the stand already has an administrator; a seed needs a fresh instance")
        answer = self.c.post(
            "/api/v1/auth/setup", {"admin_username": "ws13-admin", "admin_password": password}, expect=(200, 201)
        )
        self.c.token = answer["access_token"]
        return {"username": "ws13-admin", "password": password, "user_id": answer["user"]["id"]}

    def settings(self) -> None:
        self.c.patch(
            "/api/v1/settings/",
            {
                "language": "uk",
                "check_updates": False,
                "check_printer_firmware": False,
                "dark_style": "classic",
                "dark_background": "neutral",
                "dark_accent": "green",
                "document_supplier_name": "BamDude · Майстерня",
                "document_supplier_address": "",
                "document_supplier_phone": "",
                "document_supplier_code": "",
                "document_supplier_iban": "",
            },
        )

    def users(self) -> None:
        groups = {g["name"]: g["id"] for g in self.c.get("/api/v1/groups/")}
        for user in self.dump["constants"]["USERS"]:
            created = self.c.post(
                "/api/v1/users/",
                {
                    "username": user["name"],
                    "password": "Ws13-" + secrets.token_urlsafe(18),
                    "group_ids": [groups["Operators"]],
                },
                expect=(200, 201),
            )
            self.put(f"user:{user['id']}", created["id"])

    def dictionaries(self) -> None:
        methods = []
        for customer in self.db["customers"]:
            method = recipe.customer_contact(customer)["delivery_method"]
            if method and method not in methods:
                methods.append(method)
        for name in methods:
            self.put(f"delivery:{name}", self.c.post("/api/v1/delivery-methods/", {"name": name})["id"])
        for name in self.dump["constants"]["CATEGORIES"]:
            self.put(f"category:{name}", self.c.post("/api/v1/product-categories/", {"name": name})["id"])

    def customers(self) -> None:
        for customer in self.db["customers"]:
            contact = recipe.customer_contact(customer)
            method = contact.pop("delivery_method")
            contact["delivery_method_id"] = self.id(f"delivery:{method}") if method else None
            created = self.c.post(
                "/api/v1/customers/",
                {
                    "name": customer["name"],
                    "kind": recipe.CUSTOMER_KINDS.get(customer.get("type"), "company"),
                    "notes": customer.get("note") or None,
                    "contacts": [contact] if any(contact.values()) else [],
                },
            )
            self.put(f"customer:{customer['id']}", created["id"], created.get("code"))
            if created.get("contacts"):
                self.put(f"contact:{customer['id']}", created["contacts"][0]["id"])

    # ── 1b. Library and farm ─────────────────────────────────────────────────

    def library(self) -> None:
        for path in recipe.folders(self.files_spec, self.db["products"]):
            parent, _, name = path.rpartition("/")
            created = self.c.post(
                "/api/v1/library/folders/",
                {"name": name, "parent_id": self.id(f"folder:{parent}") if parent else None},
                expect=(200, 201),
            )
            self.put(f"folder:{path}", created["id"])
        files = [
            {**f, "folder_id": self.id(f"folder:{f['folder']}") if f.get("folder") else None} for f in self.files_spec
        ]
        result = self.direct("files", {"printers": recipe.printers(self.dump), "files": files})
        for key, server_id in result["printers"].items():
            self.put(key, server_id)
        for key, server_id in result["files"].items():
            self.put(key, server_id)

    # ── 1c. Products ─────────────────────────────────────────────────────────

    def products(self) -> None:
        for product in self.db["products"]:
            if product["origin"] != "catalog":
                continue  # a one-off product is made by its order's plate line
            self.product(product)

    def product(self, product: dict) -> None:
        source = product.get("source") or None
        if source and not source.startswith(("http://", "https://")):
            source = "https://" + source
        created = self.c.post(
            "/api/v1/products/",
            {
                "name": product["name"],
                "sku": product.get("sku") or None,
                "version": product.get("version") or None,
                "category_id": self.id(f"category:{product['category']}") if product.get("category") else None,
                "description": product.get("description") or None,
                "designer": product.get("designer") or None,
                "license": product.get("license") or None,
                "source_url": source,
                "status": "draft",
            },
        )
        pid = created["id"]
        self.put(f"product:{product['id']}", pid, created.get("code"))
        # Variant groups first: a part is bound to an option by id.
        options = {}
        for group in product.get("variants") or []:
            answer = self.c.post(
                f"/api/v1/products/{pid}/variant-groups",
                {"name": group["name"], "options": [o["name"] for o in group["options"]]},
            )
            made = next(g for g in answer["variant_groups"] if g["name"] == group["name"])
            self.put(f"group:{product['id']}:{group['id']}", made["id"])
            by_name = {o["name"]: o["id"] for o in made["options"]}
            for option in group["options"]:
                options[(group["id"], option["id"])] = by_name[option["name"]]
                self.put(f"option:{product['id']}:{group['id']}:{option['id']}", by_name[option["name"]])
            default = options.get((group["id"], group.get("default")))
            if default and default != made.get("default_option_id"):
                self.c.patch(f"/api/v1/products/{pid}/variant-groups/{made['id']}", {"default_option_id": default})
        for part in product["parts"]:
            url = part.get("url") or None
            made = self.c.post(
                f"/api/v1/products/{pid}/parts",
                {
                    "kind": part["kind"],
                    "name": part["name"],
                    "qty_per_unit": part.get("qty", 1),
                    "ignored": bool(part.get("ignored")),
                    "unit_price": part.get("price"),
                    "sourcing_url": url if url and url.startswith(("http://", "https://")) else None,
                    "remarks": part.get("remarks") or None,
                },
            )
            self.put(f"part:{part['id']}", made["id"])
            for alias in part.get("aliases") or []:
                self.c.post(f"/api/v1/products/{pid}/parts/{made['id']}/aliases", {"name_key": alias})
            variant = part.get("variant")
            if variant:
                self.c.patch(
                    f"/api/v1/products/{pid}/parts/{made['id']}",
                    {"variant_option_id": options[(variant["group"], variant["option"])]},
                )
        file_ids = [self.id(f"file:{f['name']}") for f in product["files"]]
        if file_ids:
            self.c.put(f"/api/v1/products/{pid}/files", {"library_file_ids": file_ids})
        folder_ids = [self.id(f"folder:{path}") for path in product.get("folders") or []]
        if folder_ids:
            self.c.put(f"/api/v1/products/{pid}/folders", {"library_folder_ids": folder_ids})
        for doc in product.get("docs") or []:
            self.attachment(pid, doc)
        if product.get("status") == "ready":
            try:
                self.c.patch(f"/api/v1/products/{pid}", {"status": "ready"})
            except Exception as exc:  # noqa: BLE001 — reported, the rest of the seed goes on
                self.note(f"product:{product['id']} {product['name']!r} could not be made ready: {exc}")
        if not product.get("inCatalog", True):
            self.c.patch(f"/api/v1/products/{pid}", {"is_active": False})

    def attachment(self, product_id: int, doc: dict) -> None:
        category = recipe.ATTACHMENT_CATEGORIES.get(doc.get("category"), "other")
        boundary = uuid.uuid4().hex
        content = f"{SEED_NOTE}: placeholder for {doc['name']} ({doc.get('size', 0)} bytes in the mockup)\n".encode()
        body = (
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\n{category}\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{doc["name"]}"\r\n'
                "Content-Type: application/octet-stream\r\n\r\n"
            ).encode()
            + content
            + f"\r\n--{boundary}--\r\n".encode()
        )
        try:
            self.c.request(
                "POST",
                f"/api/v1/products/{product_id}/attachments",
                raw=body,
                content_type=f"multipart/form-data; boundary={boundary}",
            )
        except Exception as exc:  # noqa: BLE001
            self.note(f"attachment {doc['name']!r} of product {product_id} refused: {exc}")

    # ── 2. Opening stock ─────────────────────────────────────────────────────

    def _options_of(self, product_id: int, config: dict) -> list[int]:
        return [self.id(f"option:{product_id}:{g}:{o}") for g, o in sorted((config or {}).items())]

    def opening_stock(self) -> None:
        finished = defaultdict(int)
        kits = defaultdict(int)
        for order in self.db["orders"]:
            for line in order["lines"]:
                if line.get("fromFinished"):
                    finished[(line["productId"], json.dumps(line.get("config") or {}, sort_keys=True))] += line[
                        "fromFinished"
                    ]
                if line.get("fromKits"):
                    kits[line["productId"], json.dumps(line.get("config") or {}, sort_keys=True)] += line["fromKits"]
        for (product_id, config), qty in finished.items():
            self.c.post(
                "/api/v1/stock/moves",
                {
                    "kind": "receipt",
                    "product_id": self.id(f"product:{product_id}"),
                    "options": self._options_of(product_id, json.loads(config)),
                    "qty": qty,
                    "note": SEED_NOTE,
                },
            )
        for (product_id, config), n in kits.items():
            product = next(p for p in self.db["products"] if p["id"] == product_id)
            chosen = json.loads(config)
            for part in product["parts"]:
                if part["kind"] != "printed" or not part.get("qty"):
                    continue
                variant = part.get("variant")
                if variant and chosen.get(variant["group"]) != variant["option"]:
                    continue
                self.c.post(
                    f"/api/v1/products/{self.id(f'product:{product_id}')}/stock/adjust",
                    {"part_id": self.id(f"part:{part['id']}"), "delta": n * part["qty"], "note": SEED_NOTE},
                )

    # ── 3. Orders and lines ──────────────────────────────────────────────────

    def orders(self) -> None:
        for order in sorted(self.db["orders"], key=lambda o: o["id"]):
            self.order(order)

    def order(self, order: dict) -> None:
        customer = order.get("customerId")
        created = self.c.post(
            "/api/v1/projects/",
            {
                "name": order["name"],
                "customer_id": self.id(f"customer:{customer}") if customer else None,
                "contact_id": self.map.get(f"contact:{customer}", {}).get("id") if customer else None,
                "description": order.get("description") or None,
                "color": order.get("color") or None,
                "notes": order.get("notes") or None,
                "tags": ", ".join(order.get("tags") or []) or None,
                "due_date": recipe.shift_date(order.get("due"), self.delta),
                "priority": order.get("priority") or "normal",
                "price": order.get("price"),
                "url": order.get("url") or None,
                "responsible_id": self.id(f"user:{order['ownerId']}") if order.get("ownerId") else None,
            },
        )
        oid = created["id"]
        self.put(f"order:{order['id']}", oid, created.get("code"))
        lines = []
        for line in order["lines"]:
            product = next(p for p in self.db["products"] if p["id"] == line["productId"])
            if product["origin"] == "adhoc_plate":
                # I02: pieces in the mockup, plates on the server — the dump proved it divides.
                units = recipe.plate_units_for(self.dump, order["id"], line["id"])
                lines.append(
                    {
                        "kind": "plate",
                        "library_file_id": self.id(f"file:{units['file']}"),
                        "plate_index": units["plate"],
                        "copies": units["plates"],
                        "material": line.get("material"),
                        "color": line.get("color"),
                        "note": line.get("note") or None,
                    }
                )
            elif line["mode"] == "parts":
                lines.append(
                    {
                        "kind": "parts",
                        "product_id": self.id(f"product:{line['productId']}"),
                        "part_counts": {str(self.id(f"part:{p}")): n for p, n in line["parts"].items()},
                        "material": line.get("material"),
                        "color": line.get("color"),
                        "note": line.get("note") or None,
                    }
                )
            else:
                lines.append(
                    {
                        "kind": "product",
                        "product_id": self.id(f"product:{line['productId']}"),
                        "quantity": line["qty"],
                        "choices": {
                            str(self.id(f"group:{line['productId']}:{g}")): self.id(
                                f"option:{line['productId']}:{g}:{o}"
                            )
                            for g, o in (line.get("config") or {}).items()
                        },
                        "stock": {"from_finished": line.get("fromFinished", 0), "from_kits": line.get("fromKits", 0)},
                        "material": line.get("material"),
                        "color": line.get("color"),
                        "note": line.get("note") or None,
                    }
                )
        if lines:
            answer = self.c.post(f"/api/v1/projects/{oid}/lines/batch", {"lines": lines})
            for line, result in zip(order["lines"], answer["results"], strict=True):
                self.put(f"line:{order['id']}:{line['id']}", result["line_id"])
                for side in ("finished", "kits"):
                    if result.get(f"asked_{side}") != result.get(f"got_{side}"):
                        self.note(
                            f"line {order['id']}/{line['id']}: asked {side} {result.get(f'asked_{side}')}, got {result.get(f'got_{side}')}"
                        )
            if any(line["productId"] == 900 for line in order["lines"]):
                adhoc = next(p for p in self.db["products"] if p["origin"] == "adhoc_plate")
                detail = self.c.get(f"/api/v1/projects/{oid}")
                made = next(ln for ln in detail["lines"] if ln["id"] == self.id(f"line:{order['id']}:1"))
                self.put(f"product:{adhoc['id']}", made["product_id"])
        for part_id, qty in (order.get("procurement") or {}).items():
            self.c.patch(f"/api/v1/projects/{oid}/procurement/{self.id(f'part:{part_id}')}", {"quantity_acquired": qty})

    # ── 4. Prints and queues ─────────────────────────────────────────────────

    def prints(self, now: datetime) -> None:
        archives = []
        printers = {p["name"]: p for p in self.dump["constants"]["PRINTERS"]}
        for order in self.db["orders"]:
            if order["status"] == "cancelled" and not order["prints"]:
                continue
            # A print that runs now is in the mockup twice — in the prints and in the
            # queue; it is ONE archive, its remaining time taken from the queue row.
            running = {
                (q.get("printer"), q["fileName"], q["plateIndex"]): q
                for q in order["queue"]
                if q["tier"] == "printer" and q["status"] == "printing"
            }
            for pr in order["prints"]:
                if pr["status"] == "printing":
                    q = running.pop((pr.get("printer"), pr["fileName"], pr["plateIndex"]), None)
                    live = {**pr, "remainingMin": (q or {}).get("remainingMin", 0)}
                    archives.append(self._archive(order, live, printers, now, status="printing"))
                else:
                    archives.append(self._archive(order, pr, printers, now, status=pr["status"]))
            for q in running.values():
                archives.append(self._archive(order, q, printers, now, status="printing"))
        result = self.direct("archives", {"archives": archives})
        for key, server_id in result.items():
            self.put(key, server_id)
        for order in self.db["orders"]:
            for pr in order["prints"]:
                if pr.get("defects"):
                    self.defects(order, pr)

    def _archive(self, order: dict, pr: dict, printers: dict, now: datetime, *, status: str) -> dict:
        spec = self.file_by_name[pr["fileName"]]
        plate = next((p for p in spec["plates"] if p["index"] == pr["plateIndex"]), None)
        minutes = pr.get("minutes") or (plate["minutes"] if plate else 60)
        if status == "printing":
            done = minutes - (pr.get("remainingMin") or 0)
            started = now - timedelta(minutes=max(1, done))
            completed = None
            key = f"archive:q{pr['id']}"
        else:
            completed = datetime.fromisoformat(recipe.shift_datetime(pr["t"], self.delta))
            started = completed - timedelta(minutes=minutes)
            key = f"archive:{pr['id']}"
        line_id = pr.get("lineId")
        printer = printers.get(pr.get("printer") or "")
        return {
            "key": key,
            "printer_id": self.id(f"printer:{printer['name']}") if printer else None,
            "library_file_id": self.id(spec["key"]),
            "project_id": self.id(f"order:{order['id']}"),
            "project_line_id": self.id(f"line:{order['id']}:{line_id}") if line_id else None,
            "plate_index": pr["plateIndex"],
            "filename": pr["fileName"],
            "status": status,
            "started_at": started.isoformat(),
            "completed_at": completed.isoformat() if completed else None,
            "print_time_seconds": minutes * 60,
            "filament_used_grams": pr.get("grams") or (plate["grams"] if plate else None),
            "filament_type": plate["filaments"][0]["type"] if plate else None,
            "filament_color": plate["filaments"][0]["color"] if plate else None,
            "parts": recipe.print_parts(pr, spec) if status != "printing" else [],
        }

    def defects(self, order: dict, pr: dict) -> None:
        oid = self.id(f"order:{order['id']}")
        aid = self.id(f"archive:{pr['id']}")
        detail = self.c.get(f"/api/v1/archives/{aid}")
        rows = detail.get("parts") or []
        if not rows:
            self.c.post(f"/api/v1/projects/{oid}/archives/{aid}/defects", {"defective_count": pr["defects"]})
            return
        left = pr["defects"]
        body = []
        for row in rows:
            take = min(left, row["quantity"])
            body.append({"id": row["id"], "defective": take})
            left -= take
        self.c.post(f"/api/v1/projects/{oid}/archives/{aid}/defects", {"parts": body})

    def queues(self) -> None:
        for order in self.db["orders"]:
            for q in order["queue"]:
                if q["status"] != "pending":
                    continue
                spec = self.file_by_name[q["fileName"]]
                body = {
                    "library_file_id": self.id(spec["key"]),
                    "plate_id": q["plateIndex"],
                    "project_id": self.id(f"order:{order['id']}"),
                    "project_line_id": self.id(f"line:{order['id']}:{q['lineId']}") if q.get("lineId") else None,
                }
                if q["tier"] == "printer":
                    body["queue_id"] = self.id(f"printer:{q['printer']}")
                    made = self.c.post("/api/v1/queue/", body)
                    self.put(f"queue:{q['id']}", made["id"] if isinstance(made, dict) else made)
                else:
                    body["target_model"] = recipe.MODEL_NAMES.get(q.get("model"), q.get("model"))
                    made = self.c.post("/api/v1/auto-queue/", body)
                    self.put(f"auto:{q['id']}", made["id"] if isinstance(made, dict) else made)

    # ── 5–6. Issues, receipts, stages, statuses ──────────────────────────────

    def _recipient(self, customer_id) -> dict | None:
        if not customer_id:
            return None
        customer = next(c for c in self.db["customers"] if c["id"] == customer_id)
        contact = recipe.customer_contact(customer)
        return {
            "name": contact["name"] or customer["name"],
            "phone": contact["phone"],
            "delivery_method": contact["delivery_method"],
            "delivery_details": contact["delivery_details"],
        }

    def issues(self) -> None:
        duplicates = {int(k): v for k, v in self.dump["meta"]["agreed_duplicates"].items()}
        received = defaultdict(int)
        issued = defaultdict(int)
        docs = sorted(self.db["docs"], key=lambda d: (d["t"], d["id"]))
        last_doc = {}
        for doc in docs:
            if doc["id"] not in duplicates:
                last_doc[doc["orderId"]] = doc["id"]
        for doc in docs:
            if doc["id"] in duplicates:
                self.put(f"doc:{doc['id']}", None, duplicate_of=f"doc:{duplicates[doc['id']]}")
                continue
            order = next(o for o in self.db["orders"] if o["id"] == doc["orderId"])
            batch = {}
            for item in doc["items"]:
                line = recipe.line_for_doc_item(self.db, order, item)
                key = (order["id"], line["id"])
                held = line.get("fromFinished", 0) + received[key] - issued[key]
                receive = max(0, item["qty"] - held)
                entry = batch.setdefault(
                    key, {"line_id": self.id(f"line:{order['id']}:{line['id']}"), "receive": 0, "issue": 0}
                )
                entry["receive"] += receive
                entry["issue"] += item["qty"]
                received[key] += receive
                issued[key] += item["qty"]
            complete = order["status"] == "completed" and last_doc.get(order["id"]) == doc["id"]
            answer = self.c.post(
                f"/api/v1/projects/{self.id(f'order:{order["id"]}')}/fulfilment",
                {
                    "lines": list(batch.values()),
                    "recipient": self._recipient(doc.get("customerId") or order.get("customerId")),
                    "note": doc.get("note") or None,
                    "complete": complete,
                },
            )
            self.put(f"doc:{doc['id']}", answer.get("issue_id"), answer.get("issue_code"))
        # C6 / I01 (agreed): a completed mockup order that issued nothing is received,
        # issued and completed through the writers — one synthetic note.
        for conflict in self.dump["meta"].get("agreed_completions") or []:
            order = next(o for o in self.db["orders"] if o["id"] == conflict["order"])
            oid = self.id(f"order:{order['id']}")
            state = self.c.get(f"/api/v1/projects/{oid}/fulfilment")
            batch = [
                {
                    "line_id": row["line_id"],
                    "assemble": row["can_assemble"],
                    "receive": row["can_receive"],
                    "issue": row["held"] + row["can_assemble"] + row["can_receive"],
                }
                for row in state["lines"]
            ]
            answer = self.c.post(
                f"/api/v1/projects/{oid}/fulfilment",
                {"lines": batch, "recipient": self._recipient(order.get("customerId")), "complete": True},
            )
            for line, row in zip(order["lines"], batch, strict=False):
                received[(order["id"], line["id"])] += row["receive"]
                issued[(order["id"], line["id"])] += row["issue"]
            self.put(
                f"agreed:order:{order['id']}",
                answer.get("issue_id"),
                answer.get("issue_code"),
                replacement=conflict["replacement"],
                origin="synthetic issue of an agreed replacement (C6 / I01), not a mockup document",
                units=[u for u in self.dump["meta"]["plate_units"] if u["order"] == order["id"]],
            )
        self._received, self._issued = received, issued

    def receipts_and_stages(self) -> None:
        for order in self.db["orders"]:
            oid = self.id(f"order:{order['id']}")
            batch = []
            for line in order["lines"]:
                key = (order["id"], line["id"])
                left = line.get("received", 0) - self._received[key]
                if left > 0 and line["mode"] == "product":
                    batch.append({"line_id": self.id(f"line:{order['id']}:{line['id']}"), "receive": left})
                    self._received[key] += left
            if batch:
                self.c.post(f"/api/v1/projects/{oid}/fulfilment", {"lines": batch})
            stage = self.dump["stages"][str(order["id"])]
            if order["status"] == "active" and stage in ("prep", "printing", "qc"):
                self.c.put(f"/api/v1/projects/{oid}/stage", {"stage": stage})
            if order["status"] == "cancelled":
                self.c.patch(f"/api/v1/projects/{oid}", {"status": "cancelled"})
            if order["status"] == "completed":
                detail = self.c.get(f"/api/v1/projects/{oid}")
                if detail["status"] != "completed":
                    self.c.patch(f"/api/v1/projects/{oid}", {"status": "completed"})

    # ── 7. Final balances ────────────────────────────────────────────────────

    def balances(self) -> None:
        for fin in self.db["fin"]:
            pid = self.id(f"product:{fin['productId']}")
            options = self._options_of(fin["productId"], fin.get("config"))
            if not fin["qty"]:
                # A count of zero creates no position; an empty one with a minimum is a
                # receipt counted back down to nothing — both through the writer.
                self.c.post(
                    "/api/v1/stock/moves",
                    {"kind": "receipt", "product_id": pid, "options": options, "qty": 1, "note": SEED_NOTE},
                )
            answer = self.c.post(
                "/api/v1/stock/moves",
                {"kind": "stocktake", "product_id": pid, "options": options, "counted": fin["qty"], "note": SEED_NOTE},
            )
            item_id = answer["id"]
            self.put(f"fin:{fin['id']}", item_id, answer.get("code"))
            manual = fin.get("reserved", 0) - (answer.get("reserved") or 0)
            if manual > 0:
                self.c.post(
                    "/api/v1/stock/moves", {"kind": "reserve", "item_id": item_id, "qty": manual, "note": SEED_NOTE}
                )
            elif manual < 0:
                self.note(
                    f"fin:{fin['id']}: orders hold {answer.get('reserved')}, mockup reserves only {fin.get('reserved', 0)}"
                )
            self.c.patch(
                f"/api/v1/stock/items/{item_id}",
                {"location": fin.get("location") or None, "min_qty": fin.get("min") or 0},
            )
        for product in self.db["products"]:
            if product["origin"] != "catalog" or f"product:{product['id']}" not in self.map:
                continue
            pid = self.id(f"product:{product['id']}")
            current = {
                row["part_id"]: row["balance"] for row in self.c.get(f"/api/v1/products/{pid}/stock")["balances"]
            }
            for part_id, target in (product.get("shelf") or {}).items():
                sid = self.id(f"part:{part_id}")
                have = current.get(sid, 0)
                if target != have:
                    self.c.post(
                        f"/api/v1/products/{pid}/stock/adjust",
                        {"part_id": sid, "delta": target - have, "note": SEED_NOTE},
                    )

    # ── run ──────────────────────────────────────────────────────────────────

    def run(self) -> dict:
        now = datetime.now(UTC).replace(tzinfo=None)
        steps = [
            ("settings", self.settings),
            ("users", self.users),
            ("dictionaries", self.dictionaries),
            ("customers", self.customers),
            ("library", self.library),
            ("products", self.products),
            ("opening stock", self.opening_stock),
            ("orders", self.orders),
            ("prints", lambda: self.prints(now)),
            ("queues", self.queues),
            ("issues", self.issues),
            ("receipts and stages", self.receipts_and_stages),
            ("balances", self.balances),
        ]
        for name, step in steps:
            print(f"seed: {name}")
            step()
        return {"mapping": self.map, "findings": self.findings}
