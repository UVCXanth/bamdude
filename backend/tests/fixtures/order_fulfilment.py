"""Closing an order the one way it closes (spec workshop-order-issue, rule 12) — for tests
that only need an order completed: everything the issue dialog offers, in one batch."""


async def complete_order(client, order_id: int):
    """Assemble, receive and issue everything the order's state allows, and complete it.

    An issue names its customer, so an order without one gets a stand-in first — what a
    test that is about something else wants. Returns the POST response; the caller asserts."""
    order = (await client.get(f"/api/v1/projects/{order_id}")).json()
    if order["customer_id"] is None:
        customer = (await client.post("/api/v1/customers", json={"name": f"Customer of {order_id}"})).json()
        await client.patch(f"/api/v1/projects/{order_id}", json={"customer_id": customer["id"]})
    state = (await client.get(f"/api/v1/projects/{order_id}/fulfilment")).json()
    lines = []
    for row in state["lines"]:
        if row["mode"] == "parts":
            parts = [
                {"part_id": p["part_id"], "receive": p["can_receive"], "issue": p["held"] + p["can_receive"]}
                for p in row["parts"]
            ]
            lines.append({"line_id": row["line_id"], "parts": parts})
        else:
            issue = row["held"] + row["can_assemble"] + row["can_receive"]
            lines.append(
                {
                    "line_id": row["line_id"],
                    "assemble": row["can_assemble"],
                    "receive": row["can_receive"],
                    "issue": issue,
                }
            )
    return await client.post(f"/api/v1/projects/{order_id}/fulfilment", json={"lines": lines, "complete": True})
