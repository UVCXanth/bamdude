# Whole-plate order quantities

The single **Adjust without surplus** action beside whole-plan enqueue starts
with the closest lower, current (when exact), and closest higher quantities.
**Show more options** loads a wider range in that same dialog, with discrete
slider, arrows and range paging; line quantities have no duplicate action. Type a new
centre to jump straight to 20,000; the slider indexes only the displayed exact
answers. Search is bounded by the existing one-million-unit intake limit, not
by a percentage around the current order. Changes above 10% in either direction
need an initially empty acknowledgement; a new selection resets it.

## Existing solutions

- SciPy `optimize.milp` / HiGHS is already installed (`scipy>=1.11` for calibration
  meshes). Its integer bounds, time budget, gap and result status let us skip impossible quantities without replacing the greedy planner.
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
The existing stock-offer arithmetic is exposed as a pure shared pass; the
ordinary offer/take endpoints use that same pass, with no duplicated rules.

The invariant is **greedy covering, including free ready products, kits and
individual parts**. Every candidate quantity goes through the existing
`stock_offers` shared-shelf pass and `plan_engine.cover`. A mathematically exact
alternative mix is not an answer when the greedy planner leaves surplus
(e.g. demand 8 with plates of 6 and 4 is refused; the greedy exact quantity is
10). HiGHS searches only a necessary-condition integer relaxation, including
available stock bounds, to skip impossible quantities. Its runs are NEVER
returned. Each candidate is checked with the canonical greedy rules and Python
integer/Fraction arithmetic; rejected quantities are excluded and search
continues under the shared time budget. Nearest is reported only after
optimality and greedy verification; an unfinished search says **unfinished**.
The existing cover iteration guard remains a limit, not proof of no solution.

Every direction and browsing step uses the normal fleet snapshot, including
eligible printer models/counts, occupancy, operator policy and auto-eject mode.
Earlier lines reserve their work through the existing `plan_lines` pass before
this line is covered. Each candidate receives a new capacity copy. Reviewed
Auto Queue removals are omitted from virtual occupancy only; preview never
deletes jobs. Stable fleet topology/policy enters the review fingerprint;
applying rechecks the exact reviewed runs against fresh occupancy.

The same `cover` can leave equal-yield model variants unmerged for this exact
run list. Ordinary callers keep their compact rows and alternatives unchanged.
Applying maps the explicit runs into the existing split editor, and untouched
row alternatives stay available to the calculator. Explicit file/split choices
and zeroed rows still restrict its candidate set.

Required output includes `per * quantity + ceil(extra * quantity)`. Good output,
received coverage, existing allocations and running/queued output count once;
rejects do not. Free stock is proposed before new printing, and the shared-shelf
pass never spends it twice across configurations/lines. Already reserved stock
of other orders is unavailable. Preview never reserves anything. Unknown or
unselected shelf output and ambiguous implicit attribution are refused.
Already banked/returned output is refused rather than reusing another shelf's
parts.

## Applying and queue changes

The proposal carries a fingerprint of the quantity, resolved composition,
fixed output and selected recipes. The existing line PATCH rechecks it under
the normal positions/lines/parts locks before updating quantity, retains the existing
issued/held floors, fits reservations using the existing writer, takes the shown free stock through `stock_offers.take` (requiring stock-move permission), and verifies
that the resulting accounts still satisfy the exact plan. A clamped stock take rolls back the entire edit, including quantity and reviewed Auto Queue removals. A stale proposal
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

The bounded search reviews the nearest lower and upper quantities before any
extra neighbours. Each round shares the remaining budget between its active
directions; a timeout on one side does not consume the other side's turn.
Incomplete extra neighbours are also reported as limited. In dense ranges,
eight consecutive quantities are checked by the canonical greedy cover after
a rejected integer candidate, before another solver jump. Every intervening
quantity is checked in order, preserving nearestness.

Options reconsidered for this fix: the existing [SciPy milp interface](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.milp.html)
remains the sparse-range filter. Rebuilding it for every adjacent quantity was
measured to waste the budget. The [native HiGHS Python interface](https://ergo-code.github.io/HiGHS/stable/interfaces/python/example-py/)
could retain a solver model but adds another dependency and still cannot
replace the required canonical greedy fleet check. Returning its globally
optimized plate mix would violate that invariant. No solver or scheduler is
added. Repeated pure calendar calculations use the standard-library bounded
[lru_cache](https://docs.python.org/3.12/library/functools.html#functools.lru_cache)
instead of custom cache storage. Its key includes the immutable operator policy,
the actual UTC origin (including repeated-hour folds), finish offset and duration;
no database session, stock or mutable capacity ledger is cached.
