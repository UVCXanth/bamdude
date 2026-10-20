import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type WorkingEntry, type WorkingPlan } from '../api/client';

export const workingSignature = (entries: WorkingEntry[] | undefined) => JSON.stringify(entries?.map(e => [
  e.entry_id, e.line_id, e.line_token ?? null, e.plate_id, e.count, e.target?.kind ?? 'auto', e.target?.kind === 'printer' ? e.target.printer_id : null,
  e.source_token ?? null, e.manual, e.protected_count,
]));

function identified(entries: WorkingEntry[], stored: WorkingEntry[]) {
  const known = new Map(stored.map(e => [e.entry_id, e]));
  return entries.map(entry => {
    const old = known.get(entry.entry_id);
    if (!old || old.line_id !== entry.line_id || old.plate_id !== entry.plate_id) return entry;
    return { ...entry, line_token: entry.line_token ?? old.line_token, source_token: entry.source_token ?? old.source_token };
  });
}

/** One serial writer per editor. A conflict keeps local input and stops writes. */
export function useWorkingPlan(orderId: number, enabled: boolean, onCommit?: () => void) {
  const { t } = useTranslation();
  const [state, setState] = useState<WorkingPlan>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error>();
  const [baselineChanged, setBaselineChanged] = useState(false);
  const [, renderLocalChange] = useState(0);
  const current = useRef<WorkingPlan | undefined>(undefined);
  const desired = useRef<WorkingEntry[] | undefined>(undefined);
  const inflight = useRef<Promise<WorkingPlan> | null>(null);
  const blocked = useRef(false);
  const confirming = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const committed = useRef(onCommit);
  committed.current = onCommit;
  const accept = useCallback((value: WorkingPlan, confirmed = false) => {
    if (!confirmed && current.current && (value.revision < current.current.revision ||
      value.revision === current.current.revision && value.saved_revision < current.current.saved_revision)) return value;
    if (!confirmed && current.current && value.saved_revision !== current.current.saved_revision) setBaselineChanged(true);
    current.current = value;
    if (desired.current) desired.current = identified(desired.current, value.entries);
    if (mounted.current) setState(value);
    return value;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);
  const reload = useCallback(async () => {
    const value = await api.getWorkingPlan(orderId);
    blocked.current = false;
    desired.current = undefined;
    setError(undefined);
    setBaselineChanged(false);
    return accept(value, true);
  }, [orderId, accept]);
  const refreshInputs = useCallback(async () => {
    const before = current.current?.revision;
    const value = await api.getWorkingPlan(orderId);
    if (current.current && current.current.revision !== before && value.revision <= current.current.revision) return;
    if (current.current && value.revision !== current.current.revision) {
      if (!desired.current) { accept(value); return; }
      blocked.current = true;
      setError(new Error('workingPlan.conflict'));
      return;
    }
    accept(value); // Keep desired local input; refresh only its current context.
  }, [orderId, accept]);
  useEffect(() => {
    if (!enabled) return;
    const focus = () => { if (!inflight.current && !confirming.current) void refreshInputs().catch(() => undefined); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [enabled, refreshInputs]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void api.getWorkingPlan(orderId).then(value => { if (alive) accept(value); })
      .catch(e => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [orderId, enabled, accept]);
  const flush = useCallback(async (): Promise<WorkingPlan> => {
    clearTimeout(timer.current);
    if (inflight.current) {
      await inflight.current;
      return flush();
    }
    if (!current.current || blocked.current) throw new Error('workingPlan.conflict');
    if (confirming.current) return current.current;
    const entries = desired.current;
    if (!entries || current.current.revision > 0 && workingSignature(entries) === workingSignature(current.current.entries)) return current.current;
    const before = current.current;
    setSaving(true);
    const task = api.writeWorkingPlan(orderId, { expected_revision: before.revision, entries, inputs_token: before.inputs_token })
      .then(value => { accept(value); committed.current?.(); return value; }).catch((e: Error) => {
        blocked.current = true;
        if (mounted.current) setError(e);
        throw e;
      }).finally(() => {
        inflight.current = null;
        if (mounted.current) setSaving(false);
      });
    inflight.current = task;
    await task;
    return flush();
  }, [accept, orderId]);
  const change = useCallback((entries: WorkingEntry[]) => {
    desired.current = identified(entries, current.current?.entries ?? []);
    renderLocalChange(value => value + 1);
    clearTimeout(timer.current);
    if (blocked.current) return;
    timer.current = setTimeout(() => { void flush().catch(() => undefined); }, 600);
  }, [flush]);
  const save = useCallback(async (entries: WorkingEntry[]) => {
    // The click names one payload. Later input stays desired and is autosaved
    // after this acknowledgment, never substituted into the baseline.
    if (confirming.current || blocked.current) throw new Error('workingPlan.conflict');
    confirming.current = true;
    clearTimeout(timer.current);
    const captured = structuredClone(entries);
    const expected = current.current;
    try {
      if (inflight.current) await inflight.current;
      if (!current.current) throw new Error('workingPlan.conflict');
      let value = current.current;
      if (!value.revision || workingSignature(value.entries) !== workingSignature(captured)) {
        value = accept(await api.writeWorkingPlan(orderId, { expected_revision: value.revision, inputs_token: value.inputs_token, entries: captured }));
      }
      const result = accept(await api.actWorkingPlan(orderId, 'save', { ...value,
        saved_revision: expected?.saved_revision ?? value.saved_revision,
        epoch: expected?.epoch ?? value.epoch,
      }), true);
      committed.current?.();
      return result;
    } catch (e) {
      blocked.current = true;
      setError(e as Error);
      throw e;
    } finally {
      confirming.current = false;
      if (!blocked.current && mounted.current) timer.current = setTimeout(() => { void flush().catch(() => undefined); }, 0);
    }
  }, [accept, orderId, flush]);
  const dirty = !!desired.current && workingSignature(desired.current) !== workingSignature(state?.entries);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const navigate = (event: MouseEvent) => {
      const link = (event.target as Element).closest?.('a[href]');
      if (link && !window.confirm(t('workingPlan.leaveConfirm'))) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', prevent);
    document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', prevent); document.removeEventListener('click', navigate, true); };
  }, [dirty, t]);
  return { state, saving, error, dirty, baselineChanged, change, flush, save, accept, reload, refreshInputs };
}
