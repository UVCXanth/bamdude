import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type Order } from '../../api/client';
import { invalidateOrderViews } from '../../utils/queryInvalidation';
import { ConfirmModal } from '../ConfirmModal';

const PROFILE_SOURCE = 'https://infinityflow3d.com/pages/free-3d-printer-auto-clearing-cad-and-g-code';

function ProfileHelp() {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 text-xs text-bambu-gray">
      <p className="font-medium text-white">{t('autoEject.profileTitle')}</p>
      <p>{t('autoEject.profileExample')}</p>
      <a href={PROFILE_SOURCE} target="_blank" rel="noopener noreferrer" className="text-bambu-green underline">
        {t('autoEject.profileSource')}
      </a>
      <ul className="list-disc pl-4 space-y-1">
        <li>{t('autoEject.profileHeight')}</li>
        <li>{t('autoEject.profileCamera')}</li>
        <li>{t('autoEject.profileOtherPrinters')}</li>
      </ul>
    </div>
  );
}

export function OrderAutoEject({ order, canEdit }: { order: Order; canEdit: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [confirmationOrder, setConfirmationOrder] = useState<number | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const sending = useRef(false);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateOrder(order.id, { auto_eject_enabled: enabled }),
    onSuccess: () => {
      setConfirmationOrder(null);
      setAcknowledged(false);
      invalidateOrderViews(queryClient);
    },
    onSettled: () => { sending.current = false; },
  });
  const mayEdit = canEdit && order.status === 'active';
  const confirming = confirmationOrder === order.id && mayEdit && !order.auto_eject_enabled;
  const save = (enabled: boolean) => {
    if (!mayEdit || sending.current) return;
    sending.current = true;
    toggle.mutate(enabled);
  };
  const cancel = () => {
    if (sending.current) return;
    setConfirmationOrder(null);
    setAcknowledged(false);
    toggle.reset();
  };
  return (
    <div className="rounded-lg border border-bambu-dark-tertiary p-3 space-y-2">
      <label className="flex items-center gap-2 font-medium text-sm">
        <input type="checkbox" className="accent-bambu-green" checked={!!order.auto_eject_enabled}
          disabled={!mayEdit || toggle.isPending}
          onChange={(event) => {
            if (!event.target.checked) save(false);
            else {
              toggle.reset();
              setAcknowledged(false);
              setConfirmationOrder(order.id);
            }
          }} />
        {t('autoEject.title')}
      </label>
      <p className="text-xs text-bambu-gray">{t('autoEject.help')}</p>
      <details className="text-xs text-bambu-gray">
        <summary className="cursor-pointer text-bambu-green">{t('autoEject.how')}</summary>
        <p className="mt-2">{t('autoEject.requirements')}</p>
        <div className="mt-3"><ProfileHelp /></div>
      </details>
      {toggle.error && !confirming && <p role="alert" className="text-xs text-red-400">{toggle.error.message}</p>}
      {confirming && <ConfirmModal
        title={t('autoEject.confirmTitle')}
        message={t('autoEject.confirmMessage')}
        variant="warning"
        confirmText={t('autoEject.confirmEnable')}
        confirmDisabled={!acknowledged}
        isLoading={toggle.isPending}
        onCancel={cancel}
        onConfirm={() => { if (acknowledged && confirming) save(true); }}
      >
        <ProfileHelp />
        <label className="mt-4 flex items-start gap-2 text-sm text-white">
          <input type="checkbox" className="mt-1 accent-bambu-green" checked={acknowledged}
            disabled={toggle.isPending} onChange={(event) => setAcknowledged(event.target.checked)} />
          {t('autoEject.confirmAcknowledgement')}
        </label>
        {toggle.error && <p role="alert" className="mt-2 text-xs text-red-400">{toggle.error.message}</p>}
      </ConfirmModal>}
    </div>
  );
}
