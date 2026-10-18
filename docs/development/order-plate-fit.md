# Whole-plate order quantities

The order-line **Plate quantities** action browses nearby exact quantities. The
**Adjust without surplus** action beside whole-plan enqueue starts with the
closest lower, current (when exact), and closest higher quantities. Type a new
centre to jump straight to 20,000; the slider indexes only the displayed exact
answers. Search is bounded by the existing one-million-unit intake limit, not
by a percentage around the current order. Changes above 10% in either direction
need an initially empty acknowledgement; a new selection resets it.

## Existing solutions

- SciPy `optimize.milp` / HiGHS is already installed (`scipy>=1.11` for calibration
  meshes). Its integer bounds, time budget, gap and result status fit this task.
  Official API: <https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.milp.html>.
- PuLP / CBC would introduce another modelling dependency and solver executable
  configuration. It offers no benefit over the already bundled solver here:
  <https://coin-or.github.io/pulp/guides/how_to_configure_solvers.html>.
- OR-Tools CP-SAT is a maintained integer solver but another binary dependency
  and runtime for a small linear model already covered by SciPy:
  <https://developers.google.com/optimization/cp/cp_solver>.

No general solver, scheduler, ledger or persistence layer is added. The domain
adapter reads the existing composition, order metrics, reservations and shared
queued-yield reader. The ordinary greedy planner and dispatcher are unchanged.

For each counted printed part, required output is `per * quantity + ceil(extra *
quantity)`. Good output, received coverage, existing allocations, expected
running and queued output are fixed offsets; new plate runs are nonnegative
integers. Rejected output is absent. Every returned answer is verified with
Python integer/Fraction arithmetic. A time/node limit says **unfinished**, never
**infeasible** or **nearest**. Nearest is reported only after solver optimality.
Unknown/unselected shelf output and ambiguous implicit attribution are refused.
Already banked/returned output is refused rather than reusing another shelf's
parts. Free stock is never borrowed automatically: allocate it through the
existing Stock & issue action first, then recalculate.

## Applying and queue changes

The proposal carries a fingerprint of the quantity, resolved composition,
fixed output and selected recipes. The existing line PATCH rechecks it under
the normal stock/line locks before updating quantity, retains the existing
issued/held floors, fits reservations using the existing writer, and verifies
that the resulting accounts still satisfy the exact plan. A stale proposal
rolls back. No new migration or database column is required.

By default both queues remain fixed. An optional **Recalculate unassigned Auto
Queue work** choice uses the existing rebalance refusal policy: assigned,
scheduled, staged/manual, located, pinned and archive-sourced work stays fixed.
The preview lists exact removable IDs. Applying requires queue read/delete-all
rights and separate consent. It locks pending rows NOWAIT and conditionally
deletes only the reviewed never-assigned rows in the SAME transaction as the
quantity change. A scheduler claim or changed options invalidates the proposal.
Deletion follows the existing pre-dispatch cancel rule; existing source GC owns
unreferenced blobs. No printer queue, physical command or plate gate is touched.

The result fills the ordinary browser-local plan draft (same lifetime as manual
count edits). A fresh plan read must still have the reviewed outstanding parts,
and the draft is applied only to that exact plan signature. Reloads do not retain
draft counts: recalculate before enqueueing. New work is sent separately through
the existing **Whole plan to queue** action, with its usual profiles, order
options, source capture, permissions and per-batch limits. If the quantity save
succeeds but the following plan read fails, retry only the read, never the PATCH.

Late defect entry invalidates an old proposal. A new read accounts for the good
output and prepares replacement runs or a different product quantity through
the same two controls; it does not require a third action.
