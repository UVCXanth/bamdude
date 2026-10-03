import { useTranslation } from 'react-i18next';
import type { StockLookup } from '../../api/client';
import { useProductDetail } from '../../hooks/useProductDetail';
import { ProductPicker } from '../pickers/ProductPicker';
import { Select } from '../Select';
import { lineConfigLabel } from '../projects/lineConfigLabel';

/**
 * A product and one option per variant group — how a movement opened from the
 * page header names its position (spec workshop-finished-goods, rule 26).
 *
 * `choices` holds only the groups the operator touched; the others stay on
 * their standard, which is what the server assumes for a group it is not told
 * about, so the two agree on the position without the client restating them.
 */
export function StockProductChoice({
  productId,
  onProduct,
  choices,
  onChoices,
  disabled,
  productLocked = false,
}: {
  productId: number | null;
  onProduct: (id: number | null) => void;
  choices: Record<number, number>;
  onChoices: (next: Record<number, number>) => void;
  disabled?: boolean;
  /** The dialog was opened for one product (the product page, WS-13 E9 F01–F02): it is
   *  named, not picked — only its configuration is chosen. Named as text: a locked
   *  picker still read the whole catalog and showed it greyed out, the product perhaps
   *  scrolled out of its box (E9 final review). */
  productLocked?: boolean;
}) {
  const { t } = useTranslation();
  const { data: product } = useProductDetail(productId);
  const groups = productId != null ? (product?.variant_groups ?? []) : [];

  return (
    <div className="space-y-2">
      <div>
        <p className="block text-sm text-bambu-gray mb-1">{t('stock.move.product')}</p>
        {productLocked ? (
          <p data-testid="stock-locked-product" className="text-sm text-white">
            {product ? `${product.code} · ${product.name}` : '…'}
          </p>
        ) : (
          <ProductPicker
            value={productId}
            onChange={(id) => {
              onProduct(id);
              onChoices({});
            }}
            disabled={disabled}
          />
        )}
      </div>
      {groups.map((group) => (
        <label key={group.id} className="flex items-center gap-2 text-sm text-bambu-gray">
          <span className="min-w-[6rem]">{group.name}</span>
          <Select
            className="flex-1"
            aria-label={group.name}
            value={String(choices[group.id] ?? group.default_option_id ?? '')}
            onChange={(e) => {
              const next = { ...choices };
              if (e.target.value === '') delete next[group.id];
              else next[group.id] = Number(e.target.value);
              onChoices(next);
            }}
            disabled={disabled}
          >
            {/* A group without a standard: «No choice» is what the server is told by
                saying nothing, so it is what the field shows until an option is picked
                (WS-13 E9 Codex review V01 — the first option showed while none was sent). */}
            {group.default_option_id == null && <option value="">{t('stock.move.noChoice')}</option>}
            {group.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </label>
      ))}
    </div>
  );
}

/** What the server answered for the picked configuration: its position, or that it has none yet. */
export function StockLookupNote({ lookup, creates }: { lookup: StockLookup | undefined; creates: boolean }) {
  const { t } = useTranslation();
  if (!lookup) return null;
  const caption = lineConfigLabel(lookup.configuration, 'product', t);
  return (
    <div className="rounded-lg bg-bambu-dark px-3 py-2 text-sm" data-testid="stock-lookup">
      {caption && <p className="text-bambu-gray">{caption}</p>}
      {lookup.item ? (
        <p className="text-white">
          {t('stock.move.position', {
            code: lookup.item.code,
            onHand: lookup.item.on_hand,
            available: lookup.item.available,
          })}
        </p>
      ) : (
        <p className={creates ? 'text-white' : 'text-status-warning'}>
          {t(creates ? 'stock.move.willCreate' : 'stock.move.noPosition')}
        </p>
      )}
    </div>
  );
}

/** The fixed position a dialog was opened from — product, configuration, code and figures. */
export function StockPositionHeader({
  item,
}: {
  item: { code: string; product: { name: string }; configuration: StockLookup['configuration']; on_hand: number; reserved: number; available: number };
}) {
  const { t } = useTranslation();
  const caption = lineConfigLabel(item.configuration, 'product', t);
  return (
    <div className="rounded-lg bg-bambu-dark px-3 py-2 text-sm">
      <p className="text-white">
        {item.product.name} <span className="text-bambu-gray">{item.code}</span>
      </p>
      {caption && <p className="text-bambu-gray">{caption}</p>}
      <p className="text-bambu-gray">
        {t('stock.move.figures', { onHand: item.on_hand, reserved: item.reserved, available: item.available })}
      </p>
    </div>
  );
}
