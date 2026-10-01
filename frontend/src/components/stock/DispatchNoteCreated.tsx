import { useEffect, useId } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { Button } from '../Button';
import { WorkshopDialog } from '../workshop/WorkshopDialog';

/**
 * «Накладну оформлено» — shown where an issue was made (spec workshop-dispatch-notes,
 * rule 24; WS-13 E6 E15, the mockup's `docCreated`): the code and, when known, the units
 * it carries; where the note is listed; «Close» and «Open and print».
 *
 * ⚠️ «Open and print» only OPENS the note — printing is the note page's own button,
 * never started without an explicit press. `fromOrder` says where else the note is
 * listed: a manual issue off the stock page has no order card.
 */
export function DispatchNoteCreated({
  id,
  code,
  units,
  fromOrder = true,
  onClose,
}: {
  id: number;
  code: string;
  /** The units the sealed note carries (E6 H03); without them the subtitle is the code alone. */
  units?: number | null;
  fromOrder?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openId = useId();

  // The first focus is the primary action — after the Modal's own focus of its panel,
  // which runs in the child's effect first.
  useEffect(() => {
    document.getElementById(openId)?.focus();
  }, [openId]);

  return (
    <WorkshopDialog
      onClose={onClose}
      title={t('stock.dispatchNote.createdTitle')}
      subtitle={units != null ? t('stock.dispatchNote.createdUnits', { code, count: units }) : code}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button
            id={openId}
            onClick={() => {
              onClose();
              navigate(`/stock/dispatch-notes/${id}`);
            }}
          >
            <FileText className="w-4 h-4" />
            {t('stock.dispatchNote.openPrint')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-white">
        {fromOrder ? t('stock.dispatchNote.createdBody', { code }) : t('stock.dispatchNote.createdBodyStock')}
      </p>
    </WorkshopDialog>
  );
}
