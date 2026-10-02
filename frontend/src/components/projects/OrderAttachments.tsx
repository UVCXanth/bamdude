import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, Eye, Loader2, Trash2, Upload } from 'lucide-react';
import { api } from '../../api/client';
import type { Order, ProjectAttachment } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useBlobPreview } from '../../hooks/useBlobPreview';
// The app-wide byte formatter, rather than the third hand-rolled `MB / KB / B`
// ladder — the File Manager and the library both read sizes through this one.
import { formatFileSize } from '../../utils/file';
import { formatDateTime } from '../../utils/date';
import { Button } from '../Button';
import { ConfirmModal } from '../ConfirmModal';
import { Modal } from '../Modal';
import { invalidateOrderViews } from '../../utils/queryInvalidation';

interface OrderAttachmentsProps {
  order: Order;
  canEdit: boolean;
}

/** The pictures a browser shows by itself — the only files «View» is offered for. */
const PICTURE = /\.(png|jpe?g|webp|gif)$/i;

function extension(attachment: ProjectAttachment): string {
  const name = attachment.original_name || attachment.filename;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : '—';
}

/**
 * Files that belong to the order but not to the print — a customer's spec, a
 * signed quote, a photo of the packed parcel (WS-13 E4 G04).
 *
 * ⚠️ **Downloads and pictures go through `fetch`, not a bare `<a href>` / `<img src>`.**
 * The GET route is behind `PROJECTS_READ` and this app authenticates with a bearer
 * token, which a plain link cannot carry: it would 401 and look like a missing file.
 * A picture is the download's own authorised fetch turned into a blob URL, shown in
 * a lightbox — no media route of its own.
 *
 * ⚠️ **A blob URL is memory the page holds until it is let go (R09):** on close, when
 * another picture replaces it, and on unmount. Each read carries its own ticket: an
 * answer that arrives after its viewer was closed or replaced opens nothing, and the
 * URL made of it is let go at once.
 */
export function OrderAttachments({ order, canEdit }: OrderAttachmentsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  // ⚠️ WHICH row is busy, not THAT one is. A single flag disabled the download
  // button of every attachment in the list while one of them was being fetched.
  const [downloadingName, setDownloadingName] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ProjectAttachment | null>(null);
  const [progress, setProgress] = useState<{ n: number; of: number } | null>(null);

  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });

  const attachments = order.attachments ?? [];

  const refresh = () => invalidateOrderViews(queryClient, { orderId: order.id });

  const remove = useMutation({
    mutationFn: (filename: string) => api.deleteProjectAttachment(order.id, filename),
    // The row that was asked for is the row that goes quiet — `remove.isPending`
    // alone cannot say which one, and the mutation is shared by every row.
    onMutate: (filename: string) => setDeletingName(filename),
    onSuccess: refresh,
    onError: (e: Error) => showToast(e.message, 'error'),
    onSettled: () => setDeletingName(null),
  });

  /** One file after another; a refused file is named in its own toast and the rest go on. */
  const uploadAll = async (files: File[]) => {
    for (let i = 0; i < files.length; i++) {
      setProgress({ n: i + 1, of: files.length });
      try {
        await api.uploadProjectAttachment(order.id, files[i]);
      } catch (e) {
        showToast(t('orders.attachments.uploadFailed', { name: files[i].name, error: (e as Error).message }), 'error');
      }
    }
    setProgress(null);
    refresh();
  };

  // The session is refreshed as `request<T>()` does it, and a refusal is the server's
  // sentence (final review M10).
  const fetchBlob = (attachment: ProjectAttachment): Promise<Blob> =>
    api.getProjectAttachment(order.id, attachment.filename);

  const download = async (attachment: ProjectAttachment) => {
    setDownloadingName(attachment.filename);
    try {
      const url = window.URL.createObjectURL(await fetchBlob(attachment));
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.original_name || attachment.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (e) {
      showToast((e as Error).message, 'error');
    } finally {
      setDownloadingName(null);
    }
  };

  // The viewer's reads and their blob URLs (R09) — `useBlobPreview`, shared with the
  // product's documents.
  const { preview: shown, open: openPreview, close: closePreview } = useBlobPreview(fetchBlob);
  const preview = shown && { attachment: shown.item, url: shown.url, failed: shown.failed };

  return (
    // No heading of its own — the «Attachments» tab names it (WS-13 E3 F05).
    <section className="space-y-3">
      {canEdit && (
        <div className="flex items-center justify-end gap-4">
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length > 0) void uploadAll(files);
            }}
          />
          <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()} disabled={progress != null}>
            {progress ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {progress
              ? t('orders.attachments.uploading', { n: progress.n, of: progress.of })
              : t('orders.attachments.upload')}
          </Button>
        </div>
      )}

      {attachments.length > 0 ? (
        <ul>
          {attachments.map((attachment) => {
            const name = attachment.original_name || attachment.filename;
            return (
              // ⚠️ The row WRAPS (Codex review V02): on a phone the actions never shrink,
              // so a one-line row squeezed the name to nothing and pushed «delete» out of
              // the panel. The name keeps a readable width; the actions move under it.
              <li
                key={attachment.filename}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-bambu-dark-tertiary py-2.5 text-sm"
              >
                <span className="min-w-[44px] rounded bg-bambu-dark-tertiary px-1.5 py-0.5 text-center text-[11px] font-semibold text-bambu-gray-light">
                  {extension(attachment)}
                </span>
                <div className="min-w-[10rem] flex-1">
                  <p className="font-semibold text-white [overflow-wrap:anywhere]">{name}</p>
                  <p className="text-xs text-bambu-gray">
                    {[
                      formatFileSize(attachment.size),
                      attachment.uploaded_at
                        ? formatDateTime(attachment.uploaded_at, settings?.time_format, settings?.date_format)
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <div className="ml-auto flex flex-shrink-0 flex-wrap items-center justify-end gap-1">
                  {PICTURE.test(name) && (
                    <Button variant="ghost" size="sm" onClick={() => void openPreview(attachment)}>
                      <Eye className="w-4 h-4" />
                      {t('orders.attachments.view')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`attachment-download-${attachment.filename}`}
                    onClick={() => void download(attachment)}
                    disabled={downloadingName === attachment.filename}
                  >
                    <Download className="w-4 h-4" />
                    {t('orders.attachments.download')}
                  </Button>
                  {canEdit && (
                    <button
                      type="button"
                      data-testid={`attachment-delete-${attachment.filename}`}
                      onClick={() => setConfirming(attachment)}
                      disabled={deletingName === attachment.filename}
                      aria-label={t('orders.attachments.deleteNamed', { name })}
                      title={t('orders.attachments.deleteNamed', { name })}
                      className="p-1.5 rounded text-status-error hover:bg-bambu-dark-tertiary transition-colors disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-bambu-gray">{t('orders.attachments.empty')}</p>
      )}

      {confirming && (
        <ConfirmModal
          title={t('orders.attachments.confirmTitle', { name: confirming.original_name || confirming.filename })}
          message={t('orders.attachments.confirmText')}
          confirmText={t('orders.attachments.confirm')}
          variant="danger"
          onConfirm={() => {
            remove.mutate(confirming.filename);
            setConfirming(null);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}

      {preview && (
        <Modal
          variant="lightbox"
          onClose={closePreview}
          ariaLabel={preview.attachment.original_name || preview.attachment.filename}
        >
          {preview.url ? (
            <img
              src={preview.url}
              alt={preview.attachment.original_name || preview.attachment.filename}
              className="max-w-[90vw] max-h-[90vh] object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          ) : preview.failed ? (
            <div className="flex flex-col items-center gap-3 text-sm text-white" onClick={(e) => e.stopPropagation()}>
              <p>{t('orders.attachments.previewFailed')}</p>
              <Button size="sm" variant="secondary" onClick={() => void openPreview(preview.attachment)}>
                {t('orders.attachments.retry')}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-white">{t('common.loading')}</p>
          )}
        </Modal>
      )}
    </section>
  );
}
