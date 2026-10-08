import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { Product, ProductPart, ProductPartCreate, ProductPartKind, ProductPartUpdate } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useInnerEscape } from '../../hooks/useInnerEscape';
import { getCurrencySymbol } from '../../utils/currency';
import { Button } from '../Button';
import { Select } from '../Select';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { WorkshopField, WorkshopFormGrid } from '../workshop/WorkshopFormGrid';
import { compositionMutationKey, invalidateComposition } from './partMutations';
import { useUiPreferences } from '../../hooks/useUiPreferences';

const FIELD_CLASS =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none';

/** The columns' lengths (WS-13 E10 A03): a purchased part's key carries the 10-character
 *  `purchased:` prefix, so its name stops at 502; an alias and the address at 512. */
const NAME_MAX: Record<ProductPartKind, number> = { printed: 512, purchased: 502 };
const ALIAS_MAX = 512;
const URL_MAX = 512;

/** An alias as the server stores it (`product_composition.normalise_alias`). */
function normaliseAlias(raw: string): string {
  return raw.trim().toLowerCase();
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

interface ProductPartDialogProps {
  product: Product;
  /** The part to edit; none for a new one. */
  part?: ProductPart | null;
  onClose: () => void;
}

/**
 * A product's part — new or edited — in one dialog and ONE request (WS-13 E10 C01–C07,
 * F14). Nothing is written before «Save part»: the aliases travel with the part as its
 * whole list, and a new part carries its variant binding (A05), so a refusal — a key
 * another part owns, a busy product — leaves nothing half-saved, and what was typed stays.
 *
 * ⚠️ **One session, one base (J).** The part handed over at the opening is the base the
 * PATCH is measured from; a background refresh of the product changes the variant list
 * (the dictionary) but never what was typed. A bound option the product lost is named so
 * and blocks the save until another is chosen.
 *
 * The kind is chosen at creation only (K2): the server has no `kind` on a PATCH.
 * «Not counted» belongs to a printed part with nothing per unit (K4); a count typed on a
 * marked part takes the mark off in the same request.
 */
export function ProductPartDialog({ product, part, onClose }: ProductPartDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { data: settings } = useUiPreferences();

  const groups = product.variant_groups ?? [];
  const optionLabel = new Map(groups.flatMap((g) => g.options.map((o) => [o.id, `${g.name}: ${o.name}`] as const)));

  // The session's base — the part as it was at the opening — and the name of its option then.
  const [base] = useState<ProductPart | null>(part ?? null);
  const [baseOptionLabel] = useState(() =>
    base?.variant_option_id != null ? optionLabel.get(base.variant_option_id) : undefined,
  );
  const isEdit = base != null;
  const ownKey = base?.kind === 'printed' ? base.name_key : null;
  const baseAliases = base ? base.aliases.filter((alias) => alias !== base.name_key) : [];

  const ids = {
    kind: useId(),
    name: useId(),
    qty: useId(),
    extra: useId(),
    variant: useId(),
    aliases: useId(),
    aliasNote: useId(),
    ignore: useId(),
    price: useId(),
    url: useId(),
    remarks: useId(),
  };
  // The cursor starts in the name (C01). The Modal focuses its panel in its own (child)
  // effect; this one runs after it.
  const nameId = ids.name;
  useEffect(() => {
    document.getElementById(nameId)?.focus();
  }, [nameId]);

  const [kind, setKind] = useState<ProductPartKind>(base?.kind ?? 'printed');
  const [name, setName] = useState(base?.name ?? '');
  const [qty, setQty] = useState(String(base?.qty_per_unit ?? 1));
  const [extra, setExtra] = useState(String(base?.extra_percent ?? 0));
  const [ignored, setIgnored] = useState(base?.ignored ?? false);
  const [variant, setVariant] = useState(base?.variant_option_id != null ? String(base.variant_option_id) : '');
  const [price, setPrice] = useState(base?.unit_price != null ? String(base.unit_price) : '');
  const [url, setUrl] = useState(base?.sourcing_url ?? '');
  const [remarks, setRemarks] = useState(base?.remarks ?? '');
  const [aliases, setAliases] = useState<string[]>(baseAliases);
  const [aliasDraft, setAliasDraft] = useState('');
  const [aliasNote, setAliasNote] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  // Escape in the alias field empties it and stops there; on an empty field it is the
  // dialog's again — the next Escape closes it (C06).
  const aliasField = useRef<HTMLInputElement>(null);
  useInnerEscape(aliasField, aliasDraft !== '' || aliasNote !== null, () => {
    setAliasDraft('');
    setAliasNote(null);
  });

  const printed = kind === 'printed';
  const qtyNumber = qty.trim() === '' ? Number.NaN : Number(qty);
  const extraNumber = extra.trim() === '' ? Number.NaN : Number(extra);
  const extraValid = Number.isFinite(extraNumber) && extraNumber >= 0 && extraNumber <= 1000;
  const qtyValid = Number.isInteger(qtyNumber) && qtyNumber >= 0;
  // «Not counted» only at zero (C04): a count > 0 takes the mark off.
  const canIgnore = printed && qtyValid && qtyNumber === 0;
  const ignoredNow = canIgnore && ignored;
  const variantGone = variant !== '' && !optionLabel.has(Number(variant));

  /** The alias field's text as tokens — a pasted comma list is a token per name (a comma is
   *  the field's separator); `false` (with the note) when one of them is already in the list. */
  function takeDraft(raw: string): string[] | false {
    const keys = raw.split(',').map(normaliseAlias).filter((key) => key !== '');
    const fresh = keys.filter((key, index) => keys.indexOf(key) === index);
    if (fresh.some((key) => key === ownKey || aliases.includes(key))) {
      setAliasNote(t('products.partDialog.aliasDuplicate'));
      return false;
    }
    const next = [...aliases, ...fresh];
    setAliases(next);
    setAliasDraft('');
    setAliasNote(null);
    return next;
  }

  const mutation = useMutation({
    mutationKey: compositionMutationKey(product.id),
    mutationFn: (body: ProductPartCreate | ProductPartUpdate) =>
      base
        ? api.updateProductPart(product.id, base.id, body as ProductPartUpdate)
        : api.createProductPart(product.id, body as ProductPartCreate),
    onSuccess: () => {
      invalidateComposition(queryClient, product.id);
      showToast(t('products.partDialog.saved'));
      onClose();
    },
  });

  // ⚠️ Synchronous: a press and an Escape in the same frame see `isPending` still false —
  // the ref makes «one press, one request» and «no closing under a request» hold; a
  // refusal re-arms it.
  const sent = useRef(false);
  const formId = useId();
  const submitId = `${formId}-submit`;
  // After a refusal the fields are live again: the focus goes back to the button that sent it.
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

  function refuse(message: string, fieldId: string) {
    setLocalError(message);
    document.getElementById(fieldId)?.focus();
  }

  function submit() {
    if (sent.current || pending || variantGone) return;
    setLocalError(null);
    if (name.trim() === '') return refuse(t('products.partDialog.nameRequired'), ids.name);
    if (!qtyValid) return refuse(t('products.partDialog.qtyInvalid'), ids.qty);
    if (printed && !extraValid) return refuse(t('products.partDialog.extraInvalid'), ids.extra);
    let unitPrice: number | null = null;
    if (!printed && price.trim() !== '') {
      unitPrice = Number(price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) return refuse(t('products.partDialog.priceInvalid'), ids.price);
    }
    // Text left in the alias field becomes a token, not lost (C06); a duplicate stops here.
    let tokens = aliases;
    if (printed && aliasDraft.trim() !== '') {
      const taken = takeDraft(aliasDraft);
      if (taken === false) {
        document.getElementById(ids.aliases)?.focus();
        return;
      }
      tokens = taken;
    }
    const variantId = variant ? Number(variant) : null;

    if (!base) {
      sent.current = true;
      mutation.mutate(
        printed
          ? {
              kind,
              name: name.trim(),
              qty_per_unit: qtyNumber,
              ...(extraNumber > 0 ? { extra_percent: extraNumber } : {}),
              ignored: ignoredNow,
              aliases: tokens,
              variant_option_id: variantId,
            }
          : {
              kind,
              name: name.trim(),
              qty_per_unit: qtyNumber,
              variant_option_id: variantId,
              unit_price: unitPrice,
              sourcing_url: url.trim() || null,
              remarks: remarks.trim() || null,
            },
      );
      return;
    }

    // An edit sends what differs from the session's base (C07); the aliases only if the list moved.
    const data: ProductPartUpdate = {};
    if (name.trim() !== base.name) data.name = name.trim();
    if (qtyNumber !== base.qty_per_unit) data.qty_per_unit = qtyNumber;
    if (variantId !== base.variant_option_id) data.variant_option_id = variantId;
    if (printed) {
      if (extraNumber !== (base.extra_percent ?? 0)) data.extra_percent = extraNumber;
      if (ignoredNow !== base.ignored) data.ignored = ignoredNow;
      if (!sameList(tokens, baseAliases)) data.aliases = tokens;
    } else {
      if (unitPrice !== base.unit_price) data.unit_price = unitPrice;
      if ((url.trim() || null) !== base.sourcing_url) data.sourcing_url = url.trim() || null;
      if ((remarks.trim() || null) !== base.remarks) data.remarks = remarks.trim() || null;
    }
    if (Object.keys(data).length === 0) {
      onClose();
      return;
    }
    sent.current = true;
    mutation.mutate(data);
  }

  const error = localError ?? (mutation.isError ? (mutation.error as Error).message : undefined);
  const kindLabel = (k: ProductPartKind) => t(k === 'printed' ? 'products.partDialog.printed' : 'products.partDialog.purchased');
  const currency = getCurrencySymbol(settings?.currency || 'USD');

  return (
    <WorkshopDialog
      onClose={close}
      title={isEdit ? t('products.partDialog.editTitle') : t('products.partDialog.createTitle')}
      subtitle={`${product.code} · ${product.name}`}
      size="lg"
      pending={pending}
      error={error}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button id={submitId} type="submit" form={formId} disabled={pending || variantGone}>
            {pending && <Loader2 className="w-4 h-4 animate-spin" />}
            {pending ? t('products.partDialog.saving') : t('products.partDialog.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <WorkshopFormGrid>
          <WorkshopField
            label={t('products.partDialog.kind')}
            htmlFor={ids.kind}
            hint={isEdit ? t('products.partDialog.kindFixed') : undefined}
          >
            {isEdit ? (
              <input
                id={ids.kind}
                type="text"
                readOnly
                value={kindLabel(kind)}
                aria-describedby={`${ids.kind}-hint`}
                // Read-only: no field ground, so it does not look like a box to type into.
                className="w-full cursor-default rounded-lg border border-transparent bg-transparent px-0 py-2 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
              />
            ) : (
              <Select
                id={ids.kind}
                value={kind}
                onChange={(e) => setKind(e.target.value as ProductPartKind)}
                disabled={pending}
                className="w-full"
              >
                <option value="printed">{kindLabel('printed')}</option>
                <option value="purchased">{kindLabel('purchased')}</option>
              </Select>
            )}
          </WorkshopField>

          <WorkshopField label={t('products.partDialog.name')} htmlFor={ids.name}>
            <input
              id={ids.name}
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setLocalError(null);
              }}
              maxLength={NAME_MAX[kind]}
              className={FIELD_CLASS}
              disabled={pending}
            />
          </WorkshopField>

          <WorkshopField
            label={t('products.partDialog.perUnit')}
            htmlFor={ids.qty}
            hint={t('products.partDialog.perUnitHint')}
          >
            <input
              id={ids.qty}
              type="number"
              min={0}
              step={1}
              value={qty}
              onChange={(e) => {
                setQty(e.target.value);
                setLocalError(null);
              }}
              aria-describedby={`${ids.qty}-hint`}
              className={`${FIELD_CLASS} tabular-nums`}
              disabled={pending}
            />
          </WorkshopField>

          {printed && (
            <WorkshopField label={t('products.partDialog.extraPercent')} htmlFor={ids.extra}
              hint={t('products.partDialog.extraHint')}>
              <input id={ids.extra} type="number" min={0} max={1000} step="any" value={extra}
                onChange={(e) => { setExtra(e.target.value); setLocalError(null); }}
                aria-describedby={`${ids.extra}-hint`} className={`${FIELD_CLASS} tabular-nums`} disabled={pending} />
            </WorkshopField>
          )}

          <WorkshopField
            label={t('products.partDialog.variant')}
            htmlFor={ids.variant}
            hint={variantGone ? t('products.partDialog.variantGoneHint') : t('products.partDialog.variantHint')}
          >
            <Select
              id={ids.variant}
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
              disabled={pending}
              aria-describedby={`${ids.variant}-hint`}
              aria-invalid={variantGone || undefined}
              className="w-full"
            >
              <option value="">{t('products.partDialog.variantAlways')}</option>
              {groups.map((g) =>
                g.options.map((o) => (
                  <option key={o.id} value={String(o.id)}>
                    {optionLabel.get(o.id)}
                  </option>
                )),
              )}
              {variantGone && (
                <option value={variant}>
                  {t('products.partDialog.variantGone', {
                    name:
                      base?.variant_option_id === Number(variant) && baseOptionLabel
                        ? baseOptionLabel
                        : `#${variant}`,
                  })}
                </option>
              )}
            </Select>
          </WorkshopField>

          {printed ? (
            <>
              <WorkshopField
                label={t('products.partDialog.aliases')}
                htmlFor={ids.aliases}
                hint={t('products.partDialog.aliasesHint')}
                full
              >
                <ul data-testid="part-alias-tokens" className="flex flex-wrap gap-1.5">
                  {ownKey && (
                    <li className="inline-flex items-center gap-1 rounded bg-bambu-dark-tertiary px-2 py-0.5 text-xs text-bambu-gray-light">
                      <span className="font-mono">{ownKey}</span>
                      <span className="sr-only"> — {t('products.partDialog.ownKey')}</span>
                    </li>
                  )}
                  {aliases.map((alias) => (
                    <li
                      key={alias}
                      className="inline-flex items-center gap-1 rounded bg-bambu-dark-tertiary px-2 py-0.5 text-xs text-bambu-gray-light"
                    >
                      <span className="font-mono">{alias}</span>
                      <button
                        type="button"
                        onClick={() => setAliases(aliases.filter((a) => a !== alias))}
                        disabled={pending}
                        aria-label={t('products.partDialog.aliasRemove', { name: alias })}
                        className="rounded text-bambu-gray hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
                <input
                  ref={aliasField}
                  id={ids.aliases}
                  type="text"
                  value={aliasDraft}
                  maxLength={ALIAS_MAX}
                  placeholder={t('products.partDialog.aliasPlaceholder')}
                  onChange={(e) => {
                    setAliasDraft(e.target.value);
                    setAliasNote(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      // A token, never the form's submit (C06).
                      e.preventDefault();
                      takeDraft(aliasDraft);
                    }
                  }}
                  aria-describedby={`${ids.aliases}-hint${aliasNote ? ` ${ids.aliasNote}` : ''}`}
                  aria-invalid={aliasNote !== null || undefined}
                  className={FIELD_CLASS}
                  disabled={pending}
                />
                {aliasNote && (
                  <p id={ids.aliasNote} role="status" className="text-xs text-amber-700 dark:text-amber-400">
                    {aliasNote}
                  </p>
                )}
              </WorkshopField>

              <div className="col-span-full flex min-w-0 flex-col gap-1">
                <label htmlFor={ids.ignore} className="inline-flex items-center gap-2 text-sm text-bambu-gray-light">
                  <input
                    id={ids.ignore}
                    type="checkbox"
                    checked={ignoredNow}
                    onChange={(e) => setIgnored(e.target.checked)}
                    disabled={pending || !canIgnore}
                    aria-describedby={`${ids.ignore}-hint`}
                    className="accent-bambu-green"
                  />
                  {t('products.partDialog.ignore')}
                </label>
                <p id={`${ids.ignore}-hint`} className="text-xs leading-[18px] text-bambu-gray">
                  {canIgnore ? t('products.partDialog.ignoreHint') : t('products.partDialog.ignoreNeedsZero')}
                </p>
              </div>
            </>
          ) : (
            <>
              <WorkshopField label={t('products.partDialog.unitPrice', { currency })} htmlFor={ids.price}>
                <input
                  id={ids.price}
                  type="number"
                  min={0}
                  step="0.01"
                  value={price}
                  onChange={(e) => {
                    setPrice(e.target.value);
                    setLocalError(null);
                  }}
                  className={`${FIELD_CLASS} tabular-nums`}
                  disabled={pending}
                />
              </WorkshopField>
              <WorkshopField label={t('products.partDialog.sourcingUrl')} htmlFor={ids.url}>
                <input
                  id={ids.url}
                  type="url"
                  value={url}
                  maxLength={URL_MAX}
                  onChange={(e) => setUrl(e.target.value)}
                  className={FIELD_CLASS}
                  disabled={pending}
                />
              </WorkshopField>
              <WorkshopField label={t('products.partDialog.remarks')} htmlFor={ids.remarks} full>
                <input
                  id={ids.remarks}
                  type="text"
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  className={FIELD_CLASS}
                  disabled={pending}
                />
              </WorkshopField>
            </>
          )}
        </WorkshopFormGrid>
      </form>
    </WorkshopDialog>
  );
}
