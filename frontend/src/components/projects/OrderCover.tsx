import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon, Loader2, Trash2, Upload } from 'lucide-react';
import { api } from '../../api/client';
import type { Order } from '../../api/client';
import { Button } from '../Button';
import { ActionConfirm } from '../workshop/ActionConfirm';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { invalidateOrderViews } from '../../utils/queryInvalidation';

/**
 * The order's cover as a 48 px picture at the head of the header (WS-13 E3 C05):
 * for an editor a button that opens the cover dialog, for a reader the picture
 * alone, named. No cover → nothing; an editor reaches the dialog from the menu.
 *
 * ⚠️ **The URL is bare — the response header is the single freshness rule.**
 * Replacing a cover keeps the same URL; the endpoint answers
 * `Cache-Control: private, no-cache`, so the browser revalidates, and a `?v=`
 * counter here could only disagree with it. The media token is stamped by the
 * app-wide sync, as on every other picture.
 */
export function OrderCoverThumb({ order, canEdit, onOpen }: { order: Order; canEdit: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  if (!order.cover_image_filename) return null;
  const src = api.getProjectCoverImageUrl(order.id);
  if (!canEdit) {
    return (
      <img
        data-testid="order-cover-image"
        src={src}
        alt={t('orders.header.coverAlt', { name: order.name })}
        className="h-12 w-12 shrink-0 rounded-lg object-cover"
      />
    );
  }
  return (
    <button
      type="button"
      aria-label={t('orders.header.changeCover')}
      onClick={onOpen}
      className="shrink-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
    >
      <img data-testid="order-cover-image" src={src} alt="" className="h-12 w-12 rounded-lg object-cover" />
    </button>
  );
}

/**
 * Upload or remove the cover (WS-13 E3 C05) — the same two writes the header's
 * cover column used to carry, with the refusal and the wait in the dialog rather
 * than behind it. Removing deletes the picture for good, so it asks first, naming
 * the order and what stays (WS-13 E13 E01).
 */
export function OrderCoverDialog({ order, onClose }: { order: Order; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const refresh = () => invalidateOrderViews(queryClient, { orderId: order.id });

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadProjectCoverImage(order.id, file),
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });

  const busy = upload.isPending;

  return (
    <WorkshopDialog
      onClose={onClose}
      title={t('orders.cover.title')}
      subtitle={order.name}
      size="sm"
      pending={busy}
      error={error}
      footer={
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="flex aspect-[3/2] w-full items-center justify-center overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark">
          {order.cover_image_filename ? (
            <img data-testid="order-cover-preview" src={api.getProjectCoverImageUrl(order.id)} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex flex-col items-center gap-2 text-sm text-bambu-gray">
              <ImageIcon className="h-6 w-6" />
              {t('orders.cover.empty')}
            </span>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          className="hidden"
          data-testid="order-cover-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
            e.target.value = '';
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
            {upload.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {t('orders.cover.upload')}
          </Button>
          {order.cover_image_filename && (
            <Button variant="secondary" size="sm" onClick={() => setAsking(true)} disabled={busy}>
              <Trash2 className="w-4 h-4" />
              {t('orders.cover.remove')}
            </Button>
          )}
        </div>
      </div>
      {asking && (
        <ActionConfirm
          title={t('orders.cover.removeTitle', { name: order.name })}
          body={<p className="text-sm text-bambu-gray">{t('orders.cover.removeBody')}</p>}
          primaryLabel={t('orders.cover.removeConfirm')}
          danger
          send={async () => {
            setError(null);
            await api.deleteProjectCoverImage(order.id);
            refresh();
          }}
          onClose={() => setAsking(false)}
        />
      )}
    </WorkshopDialog>
  );
}
