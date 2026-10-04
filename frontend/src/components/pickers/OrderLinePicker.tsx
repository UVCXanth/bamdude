import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrderDetail } from '../../hooks/useOrderDetail';
import { lineConfigLabel } from '../projects/lineConfigLabel';
import { Select } from '../Select';
import { LoadFailedNote } from '../workshop/LoadFailedNote';

interface OrderLinePickerProps {
  orderId: number | null;
  value: number | null;
  onChange: (id: number | null) => void;
  disabled?: boolean;
  /** Lets a caller label the control with its own `<label htmlFor>` — see
   *  `OrderChoice`. */
  id?: string;
}

/**
 * Which line of the order (WS-13 E13 D02) — «product × quantity · configuration»,
 * with «No line» an explicit choice (`project_line_id: null`), never what an error
 * leaves behind.
 *
 * - Disabled until an order is chosen: a line only means something in its order.
 * - The first read says so and keeps the field shut; a failed read says so with a
 *   retry — neither means «this order has no lines», and the bound line stays.
 * - A successful answer without lines offers «No line» alone.
 * - The bound line is let go only when a SUCCESSFUL answer for the CURRENT order no
 *   longer has it. A late answer about another order cannot do it: each order is
 *   its own query key, and a background refetch that fails keeps the last answer.
 */
export function OrderLinePicker({ orderId, value, onChange, disabled, id }: OrderLinePickerProps) {
  const { t } = useTranslation();

  // Through the shared hook, never a second `useQuery` on the same key: the
  // LAST observer to mount owns a query's options, so a picker that declared
  // its own would have taken `meta: { refreshToast: true }` off the order page
  // behind it for as long as the dialog was open. See `useOrderDetail`.
  const detail = useOrderDetail(orderId);
  const order = orderId != null && detail.data?.id === orderId ? detail.data : undefined;
  const lines = order?.lines;
  const reading = orderId != null && detail.isPending;
  const failed = orderId != null && detail.isError && lines == null;

  const gone = lines != null && value != null && !lines.some((line) => line.id === value);
  useEffect(() => {
    if (gone && detail.isSuccess) onChange(null);
  }, [gone, detail.isSuccess, onChange]);

  const label = (line: NonNullable<typeof lines>[number]) => {
    const config = lineConfigLabel(line.configuration, line.mode, t);
    return `${line.product_name} × ${line.quantity}${config ? ` · ${config}` : ''}`;
  };

  return (
    <div className="space-y-1">
      <Select
        className="w-full"
        id={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        disabled={disabled || orderId == null || reading}
      >
        <option value="">{orderId == null ? t('pickers.chooseOrderFirst') : t('pickers.noLine')}</option>
        {/* The bound line while its order is read, or when it could not be. */}
        {value != null && lines == null && orderId != null && (
          <option value={String(value)}>{reading ? t('pickers.linesLoading') : t('pickers.lineUnread')}</option>
        )}
        {(lines ?? []).map((line) => (
          <option key={line.id} value={line.id}>
            {label(line)}
          </option>
        ))}
      </Select>
      {failed && <LoadFailedNote message={t('pickers.linesFailed')} onRetry={() => detail.refetch()} />}
    </div>
  );
}
