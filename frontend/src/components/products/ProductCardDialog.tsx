import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { Product, ProductCreate, ProductListItem, ProductStatus, ProductUpdate } from '../../api/client';
import { Button } from '../Button';
import { Select } from '../Select';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { WorkshopField, WorkshopFormGrid } from '../workshop/WorkshopFormGrid';
import { useToast } from '../../contexts/ToastContext';
import { useProductDetail } from '../../hooks/useProductDetail';
import { invalidateOrderViews, invalidateProductCatalog } from '../../utils/queryInvalidation';

const FIELD_CLASS =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none';

/** The columns' own lengths (WS-13 E10 B02, A03) — the server answers 422 past them. */
const MAX = { name: 255, sku: 64, version: 64, designer: 255, license: 255, sourceUrl: 2048, designId: 64 } as const;

interface ProductCardDialogProps {
  product?: Product | ProductListItem | null;
  onClose: () => void;
}

/** A list row carries none of the descriptive fields — not "empty", absent. */
function isFullProduct(product: Product | ProductListItem | null | undefined): product is Product {
  return !!product && 'description' in product;
}

/**
 * Create / edit a product's card (WS-13 E10 §B, F13): the Workshop dialog frame,
 * the mockup's fields and «More» for the two it does not draw. Pictures are not
 * here (B08) — they are the product page's «Pictures…».
 *
 * ⚠️ **One session, one base (J).** A product opened from a list is read in full
 * first; the first full product — handed over or read — becomes the session's
 * base once. A background refresh of the same product changes neither the base
 * nor what was typed, and the PATCH carries only what differs from that base. A
 * new id is a new session.
 *
 * There is deliberately no `onSaved` callback — the same decision `OrderModal`
 * records: the saved record reaches every list through the invalidations, and a
 * new product opens at once (B06).
 */
export function ProductCardDialog({ product, onClose }: ProductCardDialogProps) {
  const { t } = useTranslation();
  const full = isFullProduct(product) ? product : null;
  const fetchId = product && !full ? product.id : null;
  // ⚠️ Through the shared hook, and `null` rather than an `enabled` flag of its own:
  // TanStack gives a query the LAST observer's options, so an own `useQuery` would
  // take `meta: { refreshToast: true }` off the product page underneath.
  const read = useProductDetail(fetchId);

  // The session: the product id it is for, and its base — taken once, while rendering.
  const [session, setSession] = useState<{ id: number | null; base: Product | null }>({
    id: product?.id ?? null,
    base: full,
  });
  let current = session;
  if ((product?.id ?? null) !== session.id) {
    current = { id: product?.id ?? null, base: full };
    setSession(current);
  } else if (current.base == null && fetchId != null && read.data && read.data.id === current.id) {
    current = { ...current, base: read.data };
    setSession(current);
  }

  if (current.id != null && current.base == null) {
    return (
      <WorkshopDialog
        onClose={onClose}
        title={t('products.modal.editTitle')}
        size="lg"
        footer={
          <>
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="button" disabled>
              {t('products.modal.save')}
            </Button>
          </>
        }
      >
        {read.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-600 dark:text-red-500">
            <span>
              {t('products.modal.loadFailed')} {(read.error as Error)?.message}
            </span>
            <Button variant="secondary" size="sm" onClick={() => void read.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <div role="status" aria-busy className="space-y-3">
            <span className="sr-only">{t('common.loading')}</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 rounded-lg bg-bambu-dark-tertiary/60 animate-pulse" />
            ))}
          </div>
        )}
      </WorkshopDialog>
    );
  }

  return <ProductForm key={current.id ?? 'new'} base={current.base} onClose={onClose} />;
}

function ProductForm({ base, onClose }: { base: Product | null; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const isEdit = base != null;

  const ids = {
    name: useId(),
    sku: useId(),
    version: useId(),
    category: useId(),
    status: useId(),
    description: useId(),
    designer: useId(),
    license: useId(),
    sourceUrl: useId(),
    more: useId(),
    designId: useId(),
    notes: useId(),
  };
  // The cursor starts in the name (B01). The Modal focuses its panel in its own
  // (child) effect; this one runs after it.
  const nameId = ids.name;
  useEffect(() => {
    document.getElementById(nameId)?.focus();
  }, [nameId]);

  const initial = {
    name: base?.name ?? '',
    description: base?.description ?? '',
    designer: base?.designer ?? '',
    license: base?.license ?? '',
    sourceUrl: base?.source_url ?? '',
    designId: base?.design_id ?? '',
    notes: base?.notes ?? '',
    sku: base?.sku ?? '',
    version: base?.version ?? '',
    categoryId: base?.category ? String(base.category.id) : '',
    status: (base?.status ?? 'draft') as ProductStatus,
  };
  // The server refuses «ready» without parts and a plate (409); the option says so
  // before anybody tries — and a new product has neither (B04).
  const canBeReady = isEdit && base.parts_count > 0 && base.plates_count > 0;

  const categoriesQuery = useQuery({
    queryKey: ['product-categories'],
    queryFn: () => api.getProductCategories(),
    staleTime: 60_000,
  });
  const categories = categoriesQuery.data ?? [];

  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [designer, setDesigner] = useState(initial.designer);
  const [license, setLicense] = useState(initial.license);
  const [sourceUrl, setSourceUrl] = useState(initial.sourceUrl);
  const [designId, setDesignId] = useState(initial.designId);
  const [notes, setNotes] = useState(initial.notes);
  const [sku, setSku] = useState(initial.sku);
  const [version, setVersion] = useState(initial.version);
  // The chosen category with the name it was chosen under: a directory refresh that
  // drops it must still be able to name it (J).
  const [category, setCategory] = useState<{ id: string; name: string }>({
    id: initial.categoryId,
    name: base?.category?.name ?? '',
  });
  const categoryId = category.id;
  const [status, setStatus] = useState<ProductStatus>(initial.status);
  // «More» opens by itself when it holds something (B03); folding it keeps the values.
  const [moreOpen, setMoreOpen] = useState(initial.designId !== '' || initial.notes !== '');
  const [localError, setLocalError] = useState<string | null>(null);

  // The chosen category is shown by its own name while the directory loads, and as
  // «(no longer exists)» once a loaded directory lacks it — never as the first option.
  const chosenListed = categoryId === '' || categories.some((c) => String(c.id) === categoryId);
  const categoryGone = categoriesQuery.isSuccess && !chosenListed;
  const chosenName = category.name || `#${categoryId}`;

  /** The fields that differ from the session's base; a blank one goes as none (B05). */
  function changedFields(): ProductUpdate {
    const data: ProductUpdate = {};
    const text = (value: string, was: string, key: keyof ProductUpdate) => {
      if (value.trim() !== was) (data as Record<string, unknown>)[key] = value.trim() || null;
    };
    if (name.trim() !== initial.name) data.name = name.trim();
    text(description, initial.description, 'description');
    text(designer, initial.designer, 'designer');
    text(license, initial.license, 'license');
    text(sourceUrl, initial.sourceUrl, 'source_url');
    text(designId, initial.designId, 'design_id');
    text(notes, initial.notes, 'notes');
    text(sku, initial.sku, 'sku');
    text(version, initial.version, 'version');
    if (categoryId !== initial.categoryId) data.category_id = categoryId ? Number(categoryId) : null;
    if (status !== initial.status) data.status = status;
    return data;
  }

  function created(): ProductCreate {
    return {
      name: name.trim(),
      description: description.trim() || null,
      designer: designer.trim() || null,
      license: license.trim() || null,
      source_url: sourceUrl.trim() || null,
      design_id: designId.trim() || null,
      notes: notes.trim() || null,
      // The catalog fields go only when given; a new product has no plates, so
      // «ready» cannot be chosen — the status goes only if it ever were.
      ...(sku.trim() ? { sku: sku.trim() } : {}),
      ...(version.trim() ? { version: version.trim() } : {}),
      ...(categoryId ? { category_id: Number(categoryId) } : {}),
      ...(status === 'ready' ? { status } : {}),
    };
  }

  const mutation = useMutation({
    mutationFn: (data: ProductUpdate | ProductCreate) =>
      base ? api.updateProduct(base.id, data as ProductUpdate) : api.createProduct(data as ProductCreate),
    onSuccess: (saved) => {
      // ⚠️ Order views too: `ProjectLineResponse.product_name` is denormalised, so a
      // rename reaches an order card only through its own keys (Ruling 29).
      invalidateOrderViews(queryClient);
      // A new product is a draft, and a category change moves the directory's counts.
      invalidateProductCatalog(queryClient);
      onClose();
      if (base) {
        showToast(t('products.toast.updated'));
        return;
      }
      showToast(t('products.toast.created'));
      // The new product opens at once (B06, the mockup's `product-save`).
      navigate(`/products/${saved.id}`);
    },
  });

  // ⚠️ Synchronous (B07): a press and an Escape in the same tick see `isPending`
  // still false — the ref makes «one press, one request» and «no closing under a
  // request» hold; a refusal re-arms it.
  const sent = useRef(false);
  const formId = useId();
  const submitId = `${formId}-submit`;
  // After a refusal the fields are live again: the focus goes back to the button
  // that sent it, never to BODY (J).
  useEffect(() => {
    if (mutation.isError) {
      sent.current = false;
      document.getElementById(submitId)?.focus();
    }
  }, [mutation.isError, mutation.error, submitId]);

  function close() {
    if (sent.current) return;
    onClose();
  }

  const pending = mutation.isPending;

  function submit() {
    if (sent.current || pending || categoryGone) return;
    if (name.trim() === '') {
      setLocalError(t('products.modal.nameRequired'));
      document.getElementById(nameId)?.focus();
      return;
    }
    setLocalError(null);
    if (base) {
      const data = changedFields();
      if (Object.keys(data).length === 0) {
        onClose();
        return;
      }
      sent.current = true;
      mutation.mutate(data);
      return;
    }
    sent.current = true;
    mutation.mutate(created());
  }

  const error = localError ?? (mutation.isError ? (mutation.error as Error).message : undefined);
  const subtitle = isEdit ? (base.sku ? `${base.code} · ${base.sku}` : base.code) : t('products.modal.createSubtitle');

  const textInput = (
    id: string,
    value: string,
    setValue: (v: string) => void,
    maxLength: number,
    extra: { type?: 'text' | 'url'; placeholder?: string } = {},
  ) => (
    <input
      id={id}
      type={extra.type ?? 'text'}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      maxLength={maxLength}
      placeholder={extra.placeholder}
      className={FIELD_CLASS}
      disabled={pending}
    />
  );

  return (
    <WorkshopDialog
      onClose={close}
      title={isEdit ? t('products.modal.editTitle') : t('products.modal.createTitle')}
      subtitle={subtitle}
      size="lg"
      pending={pending}
      error={error}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button id={submitId} type="submit" form={formId} disabled={pending || categoryGone}>
            {pending && <Loader2 className="w-4 h-4 animate-spin" />}
            {pending
              ? isEdit
                ? t('products.modal.saving')
                : t('products.modal.creating')
              : isEdit
                ? t('products.modal.save')
                : t('products.modal.create')}
          </Button>
        </>
      }
    >
      {/* `noValidate`: every check this form has is said in the dialog's slot (B05);
          a browser bubble would stop an empty name before it, and would refuse the
          mockup's own `makerworld.com/…` source — the side panel opens a link
          without a scheme (`sourceHref`). */}
      <form
        id={formId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <WorkshopFormGrid>
          <WorkshopField label={t('products.modal.name')} htmlFor={ids.name} full>
            <input
              id={ids.name}
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setLocalError(null);
              }}
              maxLength={MAX.name}
              aria-invalid={localError != null || undefined}
              className={FIELD_CLASS}
              disabled={pending}
            />
          </WorkshopField>

          <WorkshopField label={t('products.modal.sku')} htmlFor={ids.sku}>
            {textInput(ids.sku, sku, setSku, MAX.sku, { placeholder: t('products.modal.skuPlaceholder') })}
          </WorkshopField>
          <WorkshopField label={t('products.modal.version')} htmlFor={ids.version}>
            {textInput(ids.version, version, setVersion, MAX.version, {
              placeholder: t('products.modal.versionPlaceholder'),
            })}
          </WorkshopField>

          <WorkshopField
            label={t('products.modal.category')}
            htmlFor={ids.category}
            hint={categoryGone ? t('products.modal.categoryGoneHint') : undefined}
          >
            <Select
              id={ids.category}
              value={categoryId}
              onChange={(e) =>
                setCategory({
                  id: e.target.value,
                  name: categories.find((c) => String(c.id) === e.target.value)?.name ?? '',
                })
              }
              disabled={pending}
              aria-describedby={categoryGone ? `${ids.category}-hint` : undefined}
              aria-invalid={categoryGone || undefined}
              className="w-full"
            >
              <option value="">{t('products.modal.noCategory')}</option>
              {categories.map((category) => (
                <option key={category.id} value={String(category.id)}>
                  {category.name}
                </option>
              ))}
              {!chosenListed && (
                <option value={categoryId}>
                  {categoryGone ? t('products.modal.categoryGone', { name: chosenName }) : chosenName}
                </option>
              )}
            </Select>
          </WorkshopField>

          <WorkshopField
            label={t('products.modal.readiness')}
            htmlFor={ids.status}
            hint={!canBeReady ? t('products.modal.readyNeedsParts') : undefined}
          >
            <Select
              id={ids.status}
              value={status}
              onChange={(e) => setStatus(e.target.value as ProductStatus)}
              disabled={pending}
              aria-describedby={!canBeReady ? `${ids.status}-hint` : undefined}
              className="w-full"
            >
              <option value="draft">{t('products.status.draft')}</option>
              {/* Kept selectable when it is already the value — a product marked
                  ready that lost its plates is shown as it is. */}
              <option value="ready" disabled={!canBeReady && initial.status !== 'ready'}>
                {t('products.status.ready')}
              </option>
            </Select>
          </WorkshopField>

          <WorkshopField label={t('products.modal.description')} htmlFor={ids.description} full>
            <textarea
              id={ids.description}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={FIELD_CLASS}
              disabled={pending}
            />
          </WorkshopField>

          <WorkshopField label={t('products.modal.designer')} htmlFor={ids.designer}>
            {textInput(ids.designer, designer, setDesigner, MAX.designer)}
          </WorkshopField>
          <WorkshopField label={t('products.modal.license')} htmlFor={ids.license}>
            {textInput(ids.license, license, setLicense, MAX.license)}
          </WorkshopField>

          <WorkshopField label={t('products.modal.sourceUrl')} htmlFor={ids.sourceUrl} full>
            {textInput(ids.sourceUrl, sourceUrl, setSourceUrl, MAX.sourceUrl, {
              type: 'url',
              placeholder: t('products.modal.sourcePlaceholder'),
            })}
          </WorkshopField>

          {/* «More» (B03, K12): the two fields the mockup does not draw. */}
          <div className="col-span-full">
            <button
              type="button"
              onClick={() => setMoreOpen((open) => !open)}
              aria-expanded={moreOpen}
              aria-controls={ids.more}
              className="inline-flex items-center gap-1 rounded text-sm text-bambu-gray-light hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
            >
              {moreOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              {t('products.modal.more')}
            </button>
          </div>
          {/* `contents`: the two fields sit on the form's own grid; `hidden` wins over
              it (Tailwind's preflight makes `[hidden]` `display: none !important`). */}
          <div id={ids.more} hidden={!moreOpen} className="contents">
            <WorkshopField label={t('products.modal.designId')} htmlFor={ids.designId}>
              {textInput(ids.designId, designId, setDesignId, MAX.designId)}
            </WorkshopField>
            <div aria-hidden className="max-[761px]:hidden" />
            <WorkshopField label={t('products.modal.notes')} htmlFor={ids.notes} full>
              <textarea
                id={ids.notes}
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className={FIELD_CLASS}
                disabled={pending}
              />
            </WorkshopField>
          </div>
        </WorkshopFormGrid>
      </form>
    </WorkshopDialog>
  );
}
