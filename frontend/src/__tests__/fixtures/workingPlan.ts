import { vi } from 'vitest';
import { api, type WorkingPlan, type PlanSubmission } from '../../api/client';

/** Shared-draft wire for older presentation tests. Their legacy enqueue spy
 * represents the server writer; production never calls that legacy endpoint.
 * Dedicated working-plan tests assert registration/receipts independently.
 */
export function mockWorkingPlanApi() {
  let state: WorkingPlan = { schema_version: 1, revision: 0, entries: [], saved_revision: 0,
    saved_at: null, saved_by: null, epoch: 0, saved_epoch: null, active_operation: null,
    inputs_token: 'inputs', changed: false, issues: [] };
  let operation: PlanSubmission = { operation_id: '', status: 'pending', created: [], remaining: [] };
  vi.spyOn(api, 'getWorkingPlan').mockImplementation(async () => structuredClone(state));
  vi.spyOn(api, 'writeWorkingPlan').mockImplementation(async (_, body) => {
    state = { ...state, entries: body.entries, revision: state.revision + 1 };
    return structuredClone(state);
  });
  vi.spyOn(api, 'registerPlanSubmission').mockImplementation(async (_, body) => {
    state.active_operation = body.operation_id;
    operation = { operation_id: body.operation_id, status: 'pending', created: [], remaining: body.parts };
    return structuredClone(operation);
  });
  vi.spyOn(api, 'getPlanSubmission').mockImplementation(async () => structuredClone(operation));
  vi.spyOn(api, 'actPlanSubmission').mockImplementation(async (id, _, action) => {
    if (action === 'cancel') operation.status = 'cancelled';
    else {
      const items = state.entries.filter(e => operation.remaining.some(p => p.entry_id === e.entry_id))
        .map(({ line_id, plate_id, count }) => ({ line_id, plate_id, count }));
      const result = await api.enqueueOrderPlan(id, { target: { kind: 'auto' }, items });
      operation = { ...operation, status: 'complete', remaining: [], created: result.created.map((r, index) => ({
        entry_id: state.entries[index]?.entry_id ?? `entry-${index}`, count: r.queue_item_ids.length,
        queue_item_ids: r.queue_item_ids, queue_kind: 'auto',
      })) };
    }
    state = { ...state, active_operation: null, epoch: 1, revision: state.revision + 1 };
    return structuredClone(operation);
  });
  return () => state;
}
