import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProductFacets } from '../../api/client';
import { getColorName } from '../../utils/colors';
import { Button } from '../Button';
import { Select } from '../Select';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { catalogStatus, catalogStock, type CatalogStatus, type CatalogStock } from './catalogUrl';

/**
 * The catalog's filters as the page reads them off the URL (spec workshop-product-catalog,
 * rule 21; WS-13 E8 C04). `hidden` is the old `catalog` key turned round: `catalog=0` was
 * always «show the hidden ones too», and it still is.
 */
export interface CatalogFilterValues {
  material: string;
  color: string;
  /** A model name, `none` for «not sliced», `''` for any. */
  model: string;
  status: CatalogStatus;
  stock: CatalogStock;
  hidden: boolean;
  adhoc: boolean;
}

/**
 * The mockup's row of filters (WS-13 E8 C03) — full-size selects, as the mockup draws them:
 * material, colour, printer model with
 * «not sliced», readiness, the four stock modes, «hidden», «one-off» and Reset. Every
 * one is a request parameter the page owns; the choices are what the catalog's
 * products carry (`GET /products/facets`, read by the page), so a filter never offers
 * a value with no product — but a value a link set is kept chosen (C04). When the
 * facets fail, the filters still work with what they have and a note offers a retry
 * (C09). Reset is the page's: drawn only while a condition holds (C05).
 */
export function CatalogFilters({
  values,
  onChange,
  facets,
  facetsFailed,
  onRetryFacets,
  onReset,
}: {
  values: CatalogFilterValues;
  onChange: <K extends keyof CatalogFilterValues>(key: K, value: CatalogFilterValues[K]) => void;
  facets: ProductFacets | undefined;
  facetsFailed: boolean;
  onRetryFacets: () => unknown;
  onReset?: () => void;
}) {
  const { t } = useTranslation();

  const choice = (
    key: 'material' | 'color' | 'model',
    label: string,
    any: string,
    options: string[],
    name: (v: string) => string = (v) => v,
    tail?: ReactNode,
  ) => (
    <Select
      aria-label={label}
      value={values[key]}
      onChange={(e) => onChange(key, e.target.value)}
      className="min-w-0"
    >
      <option value="">{any}</option>
      {options.map((value) => (
        <option key={value} value={value}>
          {name(value)}
        </option>
      ))}
      {/* A value set by a link but on no product (or not read yet) still shows as chosen. */}
      {values[key] && !options.includes(values[key]) && !(key === 'model' && values[key] === 'none') && (
        <option value={values[key]}>{name(values[key])}</option>
      )}
      {tail}
    </Select>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {choice('material', t('products.catalog.material'), t('products.catalog.anyMaterial'), facets?.materials ?? [])}
      {choice('color', t('products.catalog.color'), t('products.catalog.anyColor'), facets?.colors ?? [], getColorName)}
      {choice(
        'model',
        t('products.catalog.model'),
        t('products.catalog.anyModel'),
        facets?.models ?? [],
        (model) => t('products.catalog.slicedFor', { model }),
        <option value="none">{t('products.catalog.unsliced')}</option>,
      )}
      <Select
        aria-label={t('products.catalog.readiness')}
        value={values.status}
        onChange={(e) => onChange('status', catalogStatus(e.target.value))}
        className="min-w-0"
      >
        <option value="">{t('products.catalog.anyReadiness')}</option>
        <option value="ready">{t('products.catalog.readyToPrint')}</option>
        <option value="draft">{t('products.status.draft')}</option>
      </Select>
      <Select
        aria-label={t('products.catalog.stock')}
        value={values.stock}
        onChange={(e) => onChange('stock', catalogStock(e.target.value))}
        className="min-w-0"
      >
        <option value="">{t('products.catalog.anyStock')}</option>
        <option value="finished">{t('products.catalog.stockFinished')}</option>
        <option value="kits">{t('products.catalog.stockKits')}</option>
        <option value="low">{t('products.catalog.stockLow')}</option>
      </Select>
      <label className="inline-flex items-center gap-2 text-sm text-bambu-gray cursor-pointer whitespace-nowrap">
        <input
          type="checkbox"
          checked={values.hidden}
          onChange={(e) => onChange('hidden', e.target.checked)}
          className="accent-bambu-green"
        />
        {t('products.catalog.hidden')}
      </label>
      <label className="inline-flex items-center gap-2 text-sm text-bambu-gray cursor-pointer whitespace-nowrap">
        <input
          type="checkbox"
          checked={values.adhoc}
          onChange={(e) => onChange('adhoc', e.target.checked)}
          className="accent-bambu-green"
        />
        {t('products.catalog.adhoc')}
      </label>
      {onReset && (
        <Button variant="ghost" onClick={onReset}>
          {t('list.empty.reset')}
        </Button>
      )}
      {facetsFailed && (
        <LoadFailedNote role="status" className="basis-full text-xs" message={t('products.catalog.facetsFailed')} onRetry={onRetryFacets} />
      )}
    </div>
  );
}
