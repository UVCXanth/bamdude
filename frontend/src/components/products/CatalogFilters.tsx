import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { getColorName } from '../../utils/colors';
import { Select } from '../Select';

/** The URL keys of the catalog's filters, `''` when unset (spec workshop-product-catalog, rule 21). */
export interface CatalogFilterValues {
  material: string;
  color: string;
  model: string;
  status: string;
  /** `'1'` — only products with a free kit. */
  stock: string;
}

/**
 * Material, colour, printer model, status and «in stock» — every one a request
 * parameter; the choices are what the catalog's products actually carry
 * (`GET /products/facets`), so a filter never offers a value with no product.
 */
export function CatalogFilters({
  values,
  onChange,
}: {
  values: CatalogFilterValues;
  onChange: (key: keyof CatalogFilterValues, value: string) => void;
}) {
  const { t } = useTranslation();
  const { data: facets } = useQuery({
    queryKey: ['product-facets'],
    queryFn: () => api.getProductFacets(),
    staleTime: 60_000,
  });

  const choice = (key: 'material' | 'color' | 'model', label: string, any: string, options: string[], name?: (v: string) => string) => (
    <Select
      tone="filter"
      active={values[key] !== ''}
      aria-label={label}
      value={values[key]}
      onChange={(e) => onChange(key, e.target.value)}
      className="min-w-0"
    >
      <option value="">{any}</option>
      {/* A value set by a link but no longer on any product still shows as chosen. */}
      {values[key] && !options.includes(values[key]) && <option value={values[key]}>{name ? name(values[key]) : values[key]}</option>}
      {options.map((value) => (
        <option key={value} value={value}>
          {name ? name(value) : value}
        </option>
      ))}
    </Select>
  );

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {choice('material', t('products.catalog.material'), t('products.catalog.anyMaterial'), facets?.materials ?? [])}
      {choice('color', t('products.catalog.color'), t('products.catalog.anyColor'), facets?.colors ?? [], getColorName)}
      {choice('model', t('products.catalog.model'), t('products.catalog.anyModel'), facets?.models ?? [])}
      <Select
        tone="filter"
        active={values.status !== ''}
        aria-label={t('products.catalog.status')}
        value={values.status}
        onChange={(e) => onChange('status', e.target.value)}
        className="min-w-0"
      >
        <option value="">{t('products.catalog.anyStatus')}</option>
        <option value="draft">{t('products.status.draft')}</option>
        <option value="ready">{t('products.status.ready')}</option>
      </Select>
      <label className="flex items-center gap-2 text-sm text-white cursor-pointer">
        <input
          type="checkbox"
          checked={values.stock === '1'}
          onChange={(e) => onChange('stock', e.target.checked ? '1' : '')}
          className="accent-bambu-green"
        />
        {t('products.catalog.inStock')}
      </label>
    </div>
  );
}
