import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { Modal } from '../Modal';
import { Button } from '../Button';

/** «Накладну DN-0042 оформлено» — shown where the issue was made (spec workshop-dispatch-notes, rule 24). */
export function DispatchNoteCreated({ id, code, onClose }: { id: number; code: string; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Modal
      onClose={onClose}
      title={t('stock.dispatchNote.createdTitle', { code })}
      icon={<FileText className="w-5 h-5 text-bambu-green" />}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button
            onClick={() => {
              onClose();
              navigate(`/stock/dispatch-notes/${id}`);
            }}
          >
            {t('stock.dispatchNote.open')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-bambu-gray">{t('stock.dispatchNote.createdBody')}</p>
    </Modal>
  );
}
