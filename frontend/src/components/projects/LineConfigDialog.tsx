import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import type { LineConfigurationBody, LineConfigurationImpact, Product, ProductPart, ProjectLine } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useProductDetail } from '../../hooks/useProductDetail';
import { invalidateOrderViews } from '../../utils/queryInvalidation';
import { Button } from '../Button';
import { Modal } from '../Modal';
import { Select } from '../Select';

const FIELD_CLASS =
  'w-20 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm text-right tabular-nums focus:border-bambu-green focus:outline-none';

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function byOrder(a: ProductPart, b: ProductPart): number {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id;
}

/** Every group's standard option. */
function defaultsOf(product: Product | undefined): Record<number, number> {
  const out: Record<number, number> = {};
  for (const group of product?.variant_groups ?? []) {
    if (group.default_option_id != null) out[group.id] = group.default_option_id;
  }
  return out;
}

/** A part's count per unit under the chosen options, before the line's own changes. */
function basePer(part: ProductPart, chosen: Set<number>): number {
  return part.variant_option_id == null || chosen.has(part.variant_option_id) ? part.qty_per_unit : 0;
}

/**
 * The body the server gets: every group's choice, and only the counts that
 * differ from what the chosen options give anyway (a parts line: every wanted
 * count). The server keeps the same rule; saying it here keeps the dirty check
 * and the preview honest.
 */
function bodyOf(
  product: Product | undefined,
  isParts: boolean,
  choices: Record<number, number>,
  counts: Record<number, number>,
): LineConfigurationBody {
  if (isParts) {
    return {
      choices: {},
      part_counts: Object.fromEntries(Object.entries(counts).filter(([, qty]) => qty > 0)),
    };
  }
  const chosen = { ...defaultsOf(product), ...choices };
  const set = new Set(Object.values(chosen));
  const parts = new Map((product?.parts ?? []).map((p) => [p.id, p]));
  const changed: Record<number, number> = {};
  for (const [pid, qty] of Object.entries(counts)) {
    const part = parts.get(Number(pid));
    if (part && qty !== basePer(part, set)) changed[Number(pid)] = qty;
  }
  return { choices: chosen, part_counts: changed };
}

/**
 * Change an order line's configuration (spec workshop-product-variants, rules
 * 11–14, 26): the option of each group, and per part whether it is in the kit
 * and how many per unit — or, for a parts line, how many of each.
 *
 * Every change is previewed by the server's dry run before anything is saved:
 * which parts drop out, what of them is already printed or queued (it becomes
 * surplus), and what the line's reservation becomes. The figures are the
 * server's; this dialog only says them.
 */
export function LineConfigDialog({
  orderId,
  line,
  onClose,
}: {
  orderId: number;
  line: ProjectLine;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const { data: product } = useProductDetail(line.product_id);
  const isParts = line.mode === 'parts';

  const initialChoices = useMemo(
    () => Object.fromEntries((line.configuration?.choices ?? []).map((c) => [c.group_id, c.option_id])),
    [line],
  );
  const initialCounts = useMemo(
    () => Object.fromEntries((line.configuration?.changed_parts ?? []).map((p) => [p.part_id, p.qty])),
    [line],
  );
  const [choices, setChoices] = useState<Record<number, number>>(initialChoices);
  const [counts, setCounts] = useState<Record<number, number>>(initialCounts);

  const body = bodyOf(product, isParts, choices, counts);
  const bodyKey = JSON.stringify(body);
  const initialKey = JSON.stringify(bodyOf(product, isParts, initialChoices, initialCounts));
  const dirty = product != null && bodyKey !== initialKey;
  const debouncedKey = useDebouncedValue(bodyKey, 300);

  const preview = useQuery<LineConfigurationImpact>({
    queryKey: ['line-config-preview', orderId, line.id, debouncedKey],
    queryFn: () => api.previewLineConfiguration(orderId, line.id, JSON.parse(debouncedKey) as LineConfigurationBody),
    enabled: product != null && debouncedKey !== initialKey,
    retry: false,
    staleTime: 30_000,
  });

  const save = useMutation({
    mutationFn: () => api.setLineConfiguration(orderId, line.id, body),
    onSuccess: () => {
      invalidateOrderViews(queryClient, { orderId });
      onClose();
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  const chosenSet = new Set(Object.values({ ...defaultsOf(product), ...choices }));
  const parts = [...(product?.parts ?? [])].sort(byOrder);

  /** A count back at what the options give is no longer a change. */
  const setCount = (part: ProductPart, qty: number | null) =>
    setCounts((prev) => {
      const next = { ...prev };
      if (qty == null || (!isParts && qty === basePer(part, chosenSet))) delete next[part.id];
      else next[part.id] = qty;
      return next;
    });

  const reset = () => {
    setChoices(defaultsOf(product));
    setCounts({});
  };

  const impactText = (impact: LineConfigurationImpact): string => {
    const printed = impact.dropping.reduce((sum, d) => sum + d.printed, 0);
    const queued = impact.dropping.reduce((sum, d) => sum + d.queued, 0);
    const bits: string[] = [];
    if (printed > 0 || queued > 0) bits.push(t('orders.lineConfig.impactSurplus', { printed, queued }));
    if (impact.reserved_before > 0 || impact.reserved_after > 0) {
      bits.push(t('orders.lineConfig.impactReserve', { before: impact.reserved_before, after: impact.reserved_after }));
    }
    // Ready units move to the new configuration's position — as many as it has free.
    if (impact.finished_before > 0 || impact.finished_after > 0) {
      bits.push(t('orders.lineConfig.impactReady', { before: impact.finished_before, after: impact.finished_after }));
    }
    return bits.length ? bits.join(' · ') : t('orders.lineConfig.impactNone');
  };

  const previewing = dirty && (debouncedKey !== bodyKey || preview.isFetching);

  return (
    <Modal
      onClose={onClose}
      title={t('orders.lineConfig.title', { product: line.product_name })}
      size="lg"
      closeDisabled={save.isPending}
      footer={
        <div className="flex items-center justify-between gap-2 w-full">
          <div>
            {!isParts && (product?.variant_groups?.length ?? 0) + parts.length > 0 && (
              <Button variant="ghost" size="sm" onClick={reset} disabled={save.isPending}>
                {t('orders.lineConfig.reset')}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
              {t('common.cancel')}
            </Button>
            {/* Not while the impact is still being asked: a quick Save would skip
                the warning the dry run exists to give (spec rules 14, 26). */}
            <Button
              onClick={() => (dirty ? save.mutate() : onClose())}
              disabled={product == null || save.isPending || previewing}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      }
    >
      {product == null ? (
        <div className="flex justify-center p-6">
          <Loader2 className="w-5 h-5 animate-spin text-bambu-gray" />
        </div>
      ) : (
        <div className="p-4 space-y-4">
          {!isParts && product.variant_groups.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm text-bambu-gray">{t('orders.lineConfig.options')}</h3>
              {product.variant_groups.map((group) => (
                <label key={group.id} className="flex items-center gap-3 text-sm text-white">
                  <span className="min-w-[8rem]">{group.name}</span>
                  <Select
                    size="sm"
                    aria-label={group.name}
                    value={String(choices[group.id] ?? group.default_option_id ?? '')}
                    onChange={(e) => {
                      const optionId = Number(e.target.value);
                      setChoices((prev) => ({ ...prev, [group.id]: optionId }));
                    }}
                  >
                    {group.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </label>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <h3 className="text-sm text-bambu-gray">{t('orders.lineConfig.parts')}</h3>
            <table className="w-full text-sm">
              <tbody>
                {parts.map((part) => {
                  const base = isParts ? 0 : basePer(part, chosenSet);
                  const shown = counts[part.id] ?? base;
                  return (
                    <tr key={part.id} className="text-white">
                      {!isParts && (
                        <td className="py-1 pr-2 w-6">
                          <input
                            type="checkbox"
                            checked={shown > 0}
                            aria-label={t('orders.lineConfig.inKitFor', { name: part.name })}
                            onChange={() =>
                              setCount(part, shown > 0 ? 0 : base > 0 ? base : Math.max(1, part.qty_per_unit))
                            }
                            className="accent-bambu-green"
                          />
                        </td>
                      )}
                      <td className="py-1 pr-3">{part.name}</td>
                      <td className="py-1 text-right">
                        <input
                          type="number"
                          min={0}
                          value={counts[part.id] != null ? String(counts[part.id]) : ''}
                          placeholder={String(base)}
                          aria-label={t(isParts ? 'orders.lineConfig.needFor' : 'orders.lineConfig.perUnitFor', {
                            name: part.name,
                          })}
                          onChange={(e) => {
                            const raw = e.target.value.trim();
                            const qty = Number(raw);
                            if (raw === '') setCount(part, null);
                            else if (Number.isInteger(qty) && qty >= 0) setCount(part, qty);
                          }}
                          className={FIELD_CLASS}
                        />
                        <span className="ml-2 text-xs text-bambu-gray">
                          {t(isParts ? 'orders.lineConfig.needed' : 'orders.lineConfig.perUnit')}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {dirty &&
            (preview.isError && !previewing ? (
              <p className="text-sm text-red-400" data-testid="line-config-impact">
                {preview.error.message}
              </p>
            ) : (
              <p className="text-sm text-amber-400" data-testid="line-config-impact">
                {previewing || !preview.data ? t('orders.lineConfig.checking') : impactText(preview.data)}
              </p>
            ))}
        </div>
      )}
    </Modal>
  );
}
