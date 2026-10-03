import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { api } from '../../api/client';
import type { ProductPartKind } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../Button';
import { Select } from '../Select';
import { compositionMutationKey, invalidateComposition } from './partMutations';

const FIELD_CLASS =
  'px-2 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';

interface AddPartRowProps {
  productId: number;
  canEdit: boolean;
  /** Where a refusal goes — the «Add part» dialog's error slot; `null` clears it when the
   *  next part is sent. Without it a refusal is a toast. */
  onError?: (message: string | null) => void;
}

/**
 * The form that adds a part: what kind of part, called what, how many. It is the body of
 * the product page's «Add part» dialog (WS-13 E9 D05): a part that lands empties the form
 * and leaves the focus in the name for the next one; a refusal keeps what was typed.
 *
 * ⚠️ **`qty_per_unit` may legitimately be 0.** The field's floor is 0, not 1:
 * an object that is printed alongside the product but is not part of it is
 * exactly what zero means (see `CompositionTable`), and refusing it here would
 * make the state reachable only by editing a row after creating it wrong.
 *
 * The price / url / remarks fields belong to a purchased part alone and are
 * hidden for a printed one — the server accepts them either way, but a printed
 * part with a sourcing URL is a contradiction the UI should not offer.
 */
export function AddPartRow({ productId, canEdit, onError }: AddPartRowProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [kind, setKind] = useState<ProductPartKind>('printed');
  const [name, setName] = useState('');
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState('');
  const [url, setUrl] = useState('');
  const [remarks, setRemarks] = useState('');
  const nameField = useRef<HTMLInputElement>(null);
  // The name takes the focus back after a part lands — once the field is enabled again: it
  // is disabled while the request runs, and a browser does not focus a disabled field.
  const focusName = useRef(false);
  const [landed, setLanded] = useState(0);
  // One part per «Add»: `isPending` disables the button a render late, and a second click
  // before it sent a second request (WS-13 E9 Codex review V02).
  const sending = useRef(false);

  const add = useMutation({
    mutationKey: compositionMutationKey(productId),
    onMutate: () => onError?.(null),
    mutationFn: () => {
      const parsedPrice = Number(price.trim());
      return api.createProductPart(productId, {
        kind,
        name: name.trim(),
        qty_per_unit: qty,
        // An empty box is "not said", which on the wire is null — `0` would be
        // a part that is genuinely free, and `""` is not a number at all.
        unit_price: kind === 'purchased' && price.trim() !== '' && Number.isFinite(parsedPrice) ? parsedPrice : null,
        sourcing_url: kind === 'purchased' ? url.trim() || null : null,
        remarks: kind === 'purchased' ? remarks.trim() || null : null,
      });
    },
    onSuccess: () => {
      invalidateComposition(queryClient, productId);
      setName('');
      setQty(1);
      setPrice('');
      setUrl('');
      setRemarks('');
      focusName.current = true;
      setLanded((n) => n + 1);
    },
    // A name (or alias) another part already owns answers 409 — the server's
    // own sentence, with the form left holding what was typed.
    onError: (e: Error) => (onError ? onError(e.message) : showToast(e.message, 'error')),
    onSettled: () => {
      sending.current = false;
    },
  });

  useEffect(() => {
    if (add.isPending || !focusName.current) return;
    focusName.current = false;
    nameField.current?.focus();
  }, [add.isPending, landed]);

  if (!canEdit) return null;

  return (
    <div data-testid="add-part-row">
      <div className="flex items-end gap-2 flex-wrap">
        <div>
          <label className="block text-xs text-bambu-gray mb-1" htmlFor="add-part-kind">
            {t('products.composition.kind')}
          </label>
          <Select
            size="sm"
            id="add-part-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ProductPartKind)}
            disabled={add.isPending}
          >
            <option value="printed">{t('products.composition.printed')}</option>
            <option value="purchased">{t('products.composition.purchased')}</option>
          </Select>
        </div>

        <div className="min-w-[12rem] flex-1">
          <label className="block text-xs text-bambu-gray mb-1" htmlFor="add-part-name">
            {t('products.composition.name')}
          </label>
          <input
            ref={nameField}
            id="add-part-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={add.isPending}
            className={`${FIELD_CLASS} w-full`}
          />
        </div>

        <div>
          <label className="block text-xs text-bambu-gray mb-1" htmlFor="add-part-qty">
            {t('products.composition.perUnit')}
          </label>
          <input
            id="add-part-qty"
            type="number"
            min={0}
            value={qty}
            onChange={(e) => setQty(Math.max(0, Number(e.target.value) || 0))}
            disabled={add.isPending}
            className={`${FIELD_CLASS} w-20 text-right tabular-nums`}
          />
        </div>

        {kind === 'purchased' && (
          <>
            <div>
              <label className="block text-xs text-bambu-gray mb-1" htmlFor="add-part-price">
                {t('products.composition.unitPrice')}
              </label>
              <input
                id="add-part-price"
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                disabled={add.isPending}
                className={`${FIELD_CLASS} w-24 text-right tabular-nums`}
              />
            </div>
            <div className="min-w-[10rem]">
              <label className="block text-xs text-bambu-gray mb-1" htmlFor="add-part-url">
                {t('products.composition.sourcingUrl')}
              </label>
              <input
                id="add-part-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={add.isPending}
                className={`${FIELD_CLASS} w-full`}
              />
            </div>
            <div className="min-w-[10rem]">
              <label className="block text-xs text-bambu-gray mb-1" htmlFor="add-part-remarks">
                {t('products.composition.remarks')}
              </label>
              <input
                id="add-part-remarks"
                type="text"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                disabled={add.isPending}
                className={`${FIELD_CLASS} w-full`}
              />
            </div>
          </>
        )}

        <Button
          size="sm"
          onClick={() => {
            if (sending.current) return;
            sending.current = true;
            add.mutate();
          }}
          disabled={name.trim() === '' || add.isPending}
        >
          <Plus className="w-4 h-4" />
          {t('products.composition.add')}
        </Button>
      </div>
    </div>
  );
}
