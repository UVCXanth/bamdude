import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { api } from '../../api/client';
import type { LineMode, Order, ProjectLine, ProjectLineCreate } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useProductStock } from '../../hooks/useProductStock';
import { useProductDetail } from '../../hooks/useProductDetail';
import { useConfigurationKits } from '../../hooks/useConfigurationKits';
import { ProductPicker } from '../pickers/ProductPicker';
import { Button } from '../Button';
import { Select } from '../Select';
import { invalidateOrderViews } from '../../utils/queryInvalidation';

const FIELD_CLASS =
  'w-full px-2 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';

/**
 * The last row of the lines table: pick a product, say how many.
 *
 * ⚠️ **The material is upper-cased on blur, not on submit.** It is matched
 * against the plate's own filament tokens, which the server upper-cases
 * (`plate_materials` in `product_composition.py`) — so `petg` typed here and
 * `PETG` on the plate have to end up the same string. Doing it on blur means
 * the operator SEES the value that will be sent, instead of discovering after
 * the fact that the field they filled in was rewritten.
 *
 * A material no plate of the product carries is deliberately NOT rejected: the
 * server has no such rule either, and the plan block (pass 3) is where "no
 * plate for this part in this material" is surfaced, with the plates in hand
 * to say it properly.
 *
 * ⚠️ **«From stock» is offered only when there IS stock**, and it defaults to
 * `min(kits_available, quantity)` — the operator's usual answer is "take what
 * is on the shelf" (pass 8, Decision 4). The box is editable down to 0 because
 * the other answer, "keep the shelf for something else", is theirs to give.
 */
export function AddLineRow({ orderId }: { orderId: number }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [productId, setProductId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [material, setMaterial] = useState('');
  const [color, setColor] = useState('');
  const [note, setNote] = useState('');
  /** `null` is "the operator has not touched the box", which is what makes the
   *  default follow the quantity as it is typed. A typed 0 is not null. */
  const [fromStock, setFromStock] = useState<number | null>(null);
  // spec workshop-product-variants, rule 27: a line is kits of the product, or
  // a set of its parts. `choices` holds only the groups the operator touched —
  // the server gives every other group its standard option.
  const [mode, setMode] = useState<LineMode>('product');
  const [choices, setChoices] = useState<Record<number, number>>({});
  const [partCounts, setPartCounts] = useState<Record<number, number>>({});
  const { data: product } = useProductDetail(productId);
  const groups = product?.variant_groups ?? [];
  const wanted = Object.fromEntries(Object.entries(partCounts).filter(([, qty]) => qty > 0));
  const pickProduct = (id: number | null) => {
    setProductId(id);
    setChoices({});
    setPartCounts({});
  };

  // Only once a product is picked — a disabled query in TanStack v5 is pending
  // and NOT fetching, so nothing is asked for until there is something to ask
  // about. The hook owns the key; see `useProductStock`.
  const { data: stock } = useProductStock(productId);
  // A line with other options reserves ITS kit, not the product's standard one.
  const chosenOptions = Object.values(choices);
  const { data: configKits } = useConfigurationKits(
    productId,
    chosenOptions.length ? { options: chosenOptions } : null,
  );
  const kits = (chosenOptions.length ? configKits?.kits_available : stock?.kits_available) ?? 0;
  // Clamped against BOTH the shelf and the line: reserving more kits than the
  // line will ship is not a reservation, it is stock taken out of circulation.
  // The server clamps too — this is what the operator SEES it will send.
  const reserve = Math.min(fromStock ?? quantity, kits, quantity);

  const add = useMutation({
    mutationFn: (units: number) => {
      const said = {
        material: material.trim().toUpperCase() || null,
        color: color.trim() || null,
        note: note.trim() || null,
      };
      if (mode === 'parts') {
        // A set of parts: quantity 1 and no stock, both fixed by the server.
        const data: ProjectLineCreate = { product_id: productId!, mode: 'parts', part_counts: wanted, ...said };
        return api.addOrderLine(orderId, data);
      }
      return api.addOrderLine(orderId, {
        product_id: productId!,
        quantity,
        // Folded here as well as on blur: blur is what the operator SEES, this
        // is what actually goes on the wire, and the two must not be able to
        // disagree — a submit that never blurred the field (Enter, or a click
        // straight from the picker) would otherwise send the raw casing. The
        // inline-edit path folds it in `changedFields` for the same reason.
        //
        // An empty box is "not said", which on the wire is null — an empty
        // string would be a colour named "" that no plate can ever match.
        material: material.trim().toUpperCase() || null,
        color: color.trim() || null,
        note: note.trim() || null,
        // ⚠️ Sent only when there is something to reserve. The server defaults
        // it to 0, so a `from_stock_units: 0` on every line would be a field
        // nobody typed riding on every request — and the reservation path would
        // run for products that hold no stock at all.
        ...(units > 0 ? { from_stock_units: units } : {}),
        ...(Object.keys(choices).length ? { choices } : {}),
      });
    },
    onSuccess: (saved: Order, units: number) => {
      // ⚠️ The whole set, not the order alone: a new line is new work, so the
      // plan block has a part to plan that it does not know about yet. The
      // product's shelf moved too when kits were reserved.
      // ⚠️ The product keys ride in `ORDER_VIEW_KEYS` since Ruling 29 — the
      // shelf moves with an order's lines, and most of the call sites that move
      // it know no product at all. Invalidating them again here, scoped, would
      // be a second refetch of the same product page for one save.
      invalidateOrderViews(queryClient, { orderId });
      if (units > 0) {
        // What was ACTUALLY reserved can be less than what was asked: the shelf
        // may have emptied between this row rendering and Save. The server
        // answers with the whole order, and the new line is its highest id —
        // the row itself is about to reset, so the number is said in a toast
        // rather than left in a box nobody will look at again.
        const created = saved.lines.reduce<ProjectLine | null>(
          (best, line) => (best && best.id > line.id ? best : line),
          null,
        );
        if (created && created.from_stock_units < units) {
          showToast(t('stock.line.clamped', { n: created.from_stock_units }), 'warning');
        }
      }
      pickProduct(null);
      setMode('product');
      setQuantity(1);
      setMaterial('');
      setColor('');
      setNote('');
      setFromStock(null);
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  return (
    <tr className="border-t border-bambu-dark-tertiary align-top">
      <td className="p-2 min-w-[14rem]">
        <p className="text-xs text-bambu-gray mb-1">{t('orders.lines.add')}</p>
        <ProductPicker value={productId} onChange={pickProduct} disabled={add.isPending} allowCreate />
        {productId != null && (
          <div className="mt-2 space-y-2" role="radiogroup" aria-label={t('orders.lineConfig.mode')}>
            <div className="flex items-center gap-3 text-xs text-bambu-gray">
              {(['product', 'parts'] as const).map((value) => (
                <label key={value} className="inline-flex items-center gap-1">
                  <input
                    type="radio"
                    name="add-line-mode"
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    disabled={add.isPending}
                    className="accent-bambu-green"
                  />
                  {t(value === 'parts' ? 'orders.lineConfig.modeParts' : 'orders.lineConfig.modeProduct')}
                </label>
              ))}
            </div>
            {mode === 'product' &&
              groups.map((group) => (
                <label key={group.id} className="flex items-center gap-2 text-xs text-bambu-gray">
                  <span className="min-w-[5rem]">{group.name}</span>
                  <Select
                    size="sm"
                    aria-label={group.name}
                    value={String(choices[group.id] ?? group.default_option_id ?? '')}
                    onChange={(e) => {
                      const optionId = Number(e.target.value);
                      setChoices((prev) => ({ ...prev, [group.id]: optionId }));
                    }}
                    disabled={add.isPending}
                  >
                    {group.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </label>
              ))}
            {mode === 'parts' &&
              (product?.parts ?? []).map((part) => (
                <label key={part.id} className="flex items-center gap-2 text-xs text-bambu-gray">
                  <input
                    type="number"
                    min={0}
                    value={partCounts[part.id] ?? ''}
                    placeholder="0"
                    aria-label={t('orders.lineConfig.needFor', { name: part.name })}
                    onChange={(e) => {
                      const qty = Math.max(0, Math.floor(Number(e.target.value) || 0));
                      setPartCounts((prev) => ({ ...prev, [part.id]: qty }));
                    }}
                    disabled={add.isPending}
                    className={`${FIELD_CLASS} w-16`}
                  />
                  <span className="text-white">{part.name}</span>
                </label>
              ))}
          </div>
        )}
      </td>
      <td className="p-2">
        <label className="sr-only" htmlFor="add-line-quantity">
          {t('orders.lines.quantity')}
        </label>
        <input
          id="add-line-quantity"
          type="number"
          min={1}
          value={mode === 'parts' ? 1 : quantity}
          onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
          disabled={add.isPending || mode === 'parts'}
          className={`${FIELD_CLASS} w-20`}
        />
        {/* Only when the shelf has something. `> 0`, never a bare `&&` on the
            number itself — `{0 && …}` renders the 0. A parts line has no kits. */}
        {kits > 0 && mode === 'product' && (
          <div className="mt-1">
            <label className="block text-xs text-bambu-gray" htmlFor="add-line-from-stock">
              {t('stock.line.label')}
            </label>
            <input
              id="add-line-from-stock"
              data-testid="add-line-from-stock"
              type="number"
              min={0}
              max={Math.min(kits, quantity)}
              value={reserve}
              onChange={(e) => setFromStock(Math.max(0, Number(e.target.value) || 0))}
              disabled={add.isPending}
              className={`${FIELD_CLASS} w-20`}
            />
            <p className="text-xs text-bambu-gray mt-0.5">{t('stock.line.available', { n: kits })}</p>
          </div>
        )}
      </td>
      <td className="p-2">
        <label className="sr-only" htmlFor="add-line-material">
          {t('orders.lines.material')}
        </label>
        <input
          id="add-line-material"
          type="text"
          value={material}
          onChange={(e) => setMaterial(e.target.value)}
          onBlur={() => setMaterial((m) => m.trim().toUpperCase())}
          disabled={add.isPending}
          className={`${FIELD_CLASS} w-24`}
        />
      </td>
      <td className="p-2">
        <label className="sr-only" htmlFor="add-line-color">
          {t('orders.lines.color')}
        </label>
        <input
          id="add-line-color"
          type="text"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          disabled={add.isPending}
          className={`${FIELD_CLASS} w-24`}
        />
      </td>
      <td className="p-2">
        <label className="sr-only" htmlFor="add-line-note">
          {t('orders.lines.note')}
        </label>
        <input
          id="add-line-note"
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={add.isPending}
          className={FIELD_CLASS}
        />
      </td>
      <td className="p-2" />
      <td className="p-2 text-right">
        <Button
          size="sm"
          onClick={() => add.mutate(mode === 'parts' ? 0 : reserve)}
          disabled={productId == null || add.isPending || (mode === 'parts' && Object.keys(wanted).length === 0)}
        >
          <Plus className="w-4 h-4" />
          {t('orders.lines.addLine')}
        </Button>
      </td>
    </tr>
  );
}
