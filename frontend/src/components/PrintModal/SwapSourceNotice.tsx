import { useTranslation } from 'react-i18next';
import { HelpCircle } from 'lucide-react';
import { Button } from '../Button';

/**
 * The source's swap declaration is unknown (swap-source-lifecycle spec r4 §9).
 *
 * Neutral: it does not say the file is old, only that nothing declares whether it carries its own
 * plate-swap sequence, so BamDude runs none of its swap macros for it. While our swap macros are
 * requested for this job the dialog cannot send it, and the one way on is an explicit opt-out for
 * THIS job — never a change to the saved swap settings, which stay as they are.
 */
export function SwapSourceNotice({
  requested,
  optedOut,
  onOptOut,
  onUndo,
}: {
  /** Our swap macros are on for a selected swap-mode printer. */
  requested: boolean;
  /** The operator chose to print this job without them. */
  optedOut: boolean;
  onOptOut: () => void;
  onUndo: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-4 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-3 text-xs" role="note">
      <div className="flex items-start gap-2">
        <HelpCircle className="w-4 h-4 shrink-0 text-bambu-gray mt-0.5" />
        <div className="space-y-1.5">
          <p className="text-sm text-white">{t('printModal.swapSourceUnknownTitle')}</p>
          <p className="text-bambu-gray">{t('printModal.swapSourceUnknownDesc')}</p>
          {optedOut ? (
            <>
              <p className="text-bambu-gray">{t('printModal.swapSourceOptedOut')}</p>
              <p className="text-bambu-gray">{t('printModal.swapSourcePlateRules')}</p>
              <Button type="button" variant="secondary" size="sm" onClick={onUndo}>
                {t('printModal.swapSourceUndo')}
              </Button>
            </>
          ) : (
            requested && (
              <>
                <p className="text-amber-400">{t('printModal.swapSourceUnknownBlocked')}</p>
                <p className="text-bambu-gray">{t('printModal.swapSourcePlateRules')}</p>
                <Button type="button" variant="secondary" size="sm" onClick={onOptOut}>
                  {t('printModal.swapSourceOptOut')}
                </Button>
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}
