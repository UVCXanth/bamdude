import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import type { DeliveryMethod } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useDeliveryMethods } from '../../hooks/useDeliveryMethods';
import { Button } from '../Button';
import { Modal } from '../Modal';

const FIELD_CLASS =
  'w-full px-3 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';
const ICON_BUTTON = 'p-1 text-bambu-gray hover:text-white disabled:opacity-30';

/**
 * Edit the delivery reference (spec workshop-customers, rule 20) — opened from
 * a contact row, above the customer form. A method contacts use cannot be
 * deleted (the server answers 409 too); renaming it renames it on every contact.
 */
export function DeliveryMethodsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { data: methods = [] } = useDeliveryMethods();
  const [draft, setDraft] = useState('');
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['delivery-methods'] });
    queryClient.invalidateQueries({ queryKey: ['customers'] });
  };
  const onError = (e: Error) => showToast(e.message, 'error');
  const create = useMutation({
    mutationFn: (name: string) => api.createDeliveryMethod(name),
    onSuccess: () => {
      setDraft('');
      refresh();
    },
    onError,
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => api.renameDeliveryMethod(id, name),
    onSuccess: refresh,
    onError,
  });
  const reorder = useMutation({ mutationFn: (ids: number[]) => api.reorderDeliveryMethods(ids), onSuccess: refresh, onError });
  const remove = useMutation({ mutationFn: (id: number) => api.deleteDeliveryMethod(id), onSuccess: refresh, onError });

  const move = (index: number, by: -1 | 1) => {
    const ids = methods.map((m) => m.id);
    const target = index + by;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.mutate(ids);
  };
  const commitName = (method: DeliveryMethod, value: string) => {
    const name = value.trim();
    if (name && name !== method.name) rename.mutate({ id: method.id, name });
  };

  return (
    <Modal onClose={onClose} title={t('customers.delivery.manageTitle')} size="md">
      <div className="p-4 space-y-3">
        <ul className="space-y-2">
          {methods.map((method, index) => (
            <li key={method.id} className="flex items-center gap-2">
              <input
                defaultValue={method.name}
                aria-label={t('customers.delivery.name')}
                className={FIELD_CLASS}
                onBlur={(e) => commitName(method, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <button
                type="button"
                aria-label={t('customers.delivery.moveUp')}
                disabled={index === 0}
                onClick={() => move(index, -1)}
                className={ICON_BUTTON}
              >
                <ArrowUp className="w-4 h-4" />
              </button>
              <button
                type="button"
                aria-label={t('customers.delivery.moveDown')}
                disabled={index === methods.length - 1}
                onClick={() => move(index, 1)}
                className={ICON_BUTTON}
              >
                <ArrowDown className="w-4 h-4" />
              </button>
              <button
                type="button"
                aria-label={t('common.delete')}
                disabled={method.contacts_count > 0}
                title={
                  method.contacts_count > 0 ? t('customers.delivery.inUse', { count: method.contacts_count }) : undefined
                }
                onClick={() => remove.mutate(method.id)}
                className="p-1 text-bambu-gray hover:text-red-400 disabled:opacity-30"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) create.mutate(draft.trim());
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={t('customers.delivery.new')}
            className={FIELD_CLASS}
          />
          <Button type="submit" disabled={!draft.trim() || create.isPending}>
            <Plus className="w-4 h-4" />
            {t('customers.delivery.add')}
          </Button>
        </form>
      </div>
    </Modal>
  );
}
