import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { LineConfiguration, StockLookup } from '../../api/client';
import { useProductDetail } from '../../hooks/useProductDetail';
import { ProductPicker } from '../pickers/ProductPicker';
import { Select } from '../Select';
import { lineConfigLabel } from '../projects/lineConfigLabel';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { WorkshopField } from '../workshop/WorkshopFormGrid';

/**
 * A product and one option per variant group — how a movement opened from the
 * page header names its position (spec workshop-finished-goods, rule 26). Its
 * fields are cells of the dialog's `WorkshopFormGrid` (WS-13 E12 G02): the product
 * across both columns, a select per group beside each other.
 *
 * `choices` holds only the groups the operator touched; the others stay on
 * their standard, which is what the server assumes for a group it is not told
 * about, so the two agree on the position without the client restating them.
 * A group without a standard starts at «No choice» — a configuration of its own
 * (R11), sent as no id at all.
 *
 * Until the product's groups are read nothing is assumed about them (G08): the
 * dialog's lookup waits for `groupsReady`; a failed read says so with a retry.
 */
export function StockProductChoice({
  productId,
  onProduct,
  choices,
  onChoices,
  disabled,
  productLocked = false,
  productInputId,
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
  /** The product search field's id — the dialog puts the cursor there (G07). */
  productInputId?: string;
}) {
  const { t } = useTranslation();
  const ownId = useId();
  const inputId = productInputId ?? `${ownId}-product`;
  const product = useProductDetail(productId);
  const groups = productId != null ? (product.data?.variant_groups ?? []) : [];

  return (
    <>
      {productLocked ? (
        <div className="col-span-full flex min-w-0 flex-col gap-1">
          <p className="text-sm text-bambu-gray-light">{t('stock.move.product')}</p>
          <p data-testid="stock-locked-product" className="text-sm text-white">
            {product.data ? `${product.data.code} · ${product.data.name}` : '…'}
          </p>
        </div>
      ) : (
        <WorkshopField label={t('stock.move.product')} htmlFor={inputId} full>
          <ProductPicker
            inputId={inputId}
            value={productId}
            onChange={(id) => {
              onProduct(id);
              onChoices({});
            }}
            disabled={disabled}
          />
        </WorkshopField>
      )}
      {productId != null && !product.data && !product.isError && (
        <p role="status" className="col-span-full text-sm text-bambu-gray">
          {t('stock.move.groupsReading')}
        </p>
      )}
      {productId != null && product.isError && (
        <div className="col-span-full">
          {product.data ? (
            <RefreshFailedNote onRetry={() => product.refetch()} />
          ) : (
            <LoadFailedNote message={t('stock.move.groupsFailed')} onRetry={() => product.refetch()} />
          )}
        </div>
      )}
      {groups.map((group) => {
        const id = `${inputId}-group-${group.id}`;
        return (
          <WorkshopField key={group.id} label={group.name} htmlFor={id}>
            <Select
              id={id}
              className="w-full"
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
          </WorkshopField>
        );
      })}
    </>
  );
}

/**
 * What the server answered for the picked configuration: its position, that it has none
 * yet — or, while the answer is not this configuration's own, that it is being read (G08).
 */
export function StockLookupNote({
  lookup,
  creates,
  reading = false,
  noPositionId,
}: {
  lookup: StockLookup | undefined;
  creates: boolean;
  /** The answer on screen is not the current one (another configuration on its way). */
  reading?: boolean;
  /** The «no position» line's id — the primary names it as its reason (G02). */
  noPositionId?: string;
}) {
  const { t } = useTranslation();
  if (reading) {
    return (
      <p role="status" className="col-span-full rounded-lg bg-bambu-dark px-3 py-2 text-sm text-bambu-gray" data-testid="stock-lookup">
        {t('stock.move.reading')}
      </p>
    );
  }
  if (!lookup) return null;
  const caption = lineConfigLabel(lookup.configuration, 'product', t);
  return (
    <div className="col-span-full rounded-lg bg-bambu-dark px-3 py-2 text-sm" data-testid="stock-lookup">
      {caption && <p className="text-bambu-gray">{caption}</p>}
      {lookup.item ? (
        <p className="text-white">
          {t('stock.move.position', {
            code: lookup.item.code,
            onHand: lookup.item.on_hand,
            reserved: lookup.item.reserved,
            available: lookup.item.available,
          })}
        </p>
      ) : (
        <p id={noPositionId} className={creates ? 'text-white' : 'text-status-warning'}>
          {t(creates ? 'stock.move.willCreate' : 'stock.move.noPosition')}
        </p>
      )}
    </div>
  );
}

interface PositionFigures {
  on_hand: number;
  reserved: number;
  available: number;
}

/**
 * The fixed position a dialog was opened from — the product, the configuration and the
 * code are the row's own; the figures are a current read's only (G08): `null` while there
 * is none («…»). Without `figures` the row's are shown (callers that read nothing more).
 */
export function StockPositionHeader({
  item,
  figures,
}: {
  item: { code: string; product: { name: string }; configuration: LineConfiguration } & Partial<PositionFigures>;
  figures?: PositionFigures | null;
}) {
  const { t } = useTranslation();
  const caption = lineConfigLabel(item.configuration, 'product', t);
  const shown: PositionFigures | null =
    figures === undefined
      ? { on_hand: item.on_hand ?? 0, reserved: item.reserved ?? 0, available: item.available ?? 0 }
      : figures;
  return (
    <div data-testid="stock-position-header" className="rounded-lg bg-bambu-dark px-3 py-2 text-sm">
      <p className="text-white">
        {item.product.name} <span className="text-bambu-gray">{item.code}</span>
      </p>
      {caption && <p className="text-bambu-gray">{caption}</p>}
      <p className="text-bambu-gray">
        {shown
          ? t('stock.move.figures', { onHand: shown.on_hand, reserved: shown.reserved, available: shown.available })
          : '…'}
      </p>
    </div>
  );
}
