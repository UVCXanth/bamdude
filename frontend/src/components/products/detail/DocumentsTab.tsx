import { useRef, useState, type RefObject } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, Eye, Trash2 } from 'lucide-react';
import { api } from '../../../api/client';
import type { AttachmentCategory, Product, ProductAttachment } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { useBlobPreview } from '../../../hooks/useBlobPreview';
import { useFocusWhenRowLeaves } from '../../../hooks/useFocusWhenRowLeaves';
import { Button } from '../../Button';
import { Modal } from '../../Modal';
import { ActionConfirm } from '../../workshop/ActionConfirm';
import { byAttachmentOrder } from '../attachmentOrder';

/**
 * The three document categories, in the mockup's order (G01). `pictures` is deliberately
 * NOT here: it is the gallery, and a picture listed in both places would carry two delete
 * buttons for one file — one of which would silently also be clearing the cover.
 */
const SECTIONS: Exclude<AttachmentCategory, 'pictures'>[] = ['bom_docs', 'assembly', 'other'];

/** What the file picker offers per category — a convenience, never the guard: the server's
 *  per-category allowlist (`CATEGORY_EXTENSIONS`) decides and answers 400 for the rest. */
const ACCEPT: Record<string, string> = {
  bom_docs: '.xls,.xlsx,.pdf,.csv',
  assembly: '.pdf,.md,image/*',
  other: '',
};

/** The pictures a browser shows by itself — the only files «View» is offered for (as `OrderAttachments`). */
const PICTURE = /\.(png|jpe?g|webp|gif)$/i;

const ICON_BUTTON =
  'p-1.5 rounded text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors disabled:opacity-50';

function nameOf(attachment: ProductAttachment): string {
  return attachment.original_name || attachment.filename;
}

function extension(attachment: ProductAttachment): string {
  const name = nameOf(attachment);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : '—';
}

/**
 * The «Documents» tab of the product page (WS-13 E9 G01–G04, R07).
 *
 * It reads `product.attachments` — no request of its own — in the gallery's order
 * (`byAttachmentOrder`); an upload or a delete re-reads `['product', id]`. Each row says
 * its type, name, size and where it came from: «from 3MF» (read out of a file, replaced by
 * the next re-read), «import» (from an export ZIP); a plain upload is unlabelled.
 *
 * ⚠️ **Downloads and pictures go through `api.getProductAttachment`** — the authorised
 * blob fetch order attachments use: the session is refreshed before and after a 401, and
 * a refusal is the server's sentence. A picture's viewer is `useBlobPreview`: «…» while it
 * reads, «Could not show it» and a retry when the read — or the picture itself — failed,
 * and an answer that comes after the viewer was closed, replaced or left with the page
 * opens nothing and is let go.
 *
 * An upload is per section: that section waits, the others do not; a refusal stands in
 * that section in the server's words. A delete asks first (`ActionConfirm`, B11).
 */
export function DocumentsTab({
  product,
  headingRef,
}: {
  product: Pick<Product, 'id' | 'attachments'>;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('products:update');
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  // Per section: two sections may upload at once, and each waits for its own (E9 final review).
  const [uploading, setUploading] = useState<ReadonlySet<AttachmentCategory>>(() => new Set());
  const [refusals, setRefusals] = useState<Partial<Record<AttachmentCategory, string>>>({});
  const [downloading, setDownloading] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ attachment: ProductAttachment; row: Element | null } | null>(null);
  const keepFocusWhenRowLeaves = useFocusWhenRowLeaves(headingRef);
  const productId = product.id;
  const viewer = useBlobPreview((attachment: ProductAttachment) => api.getProductAttachment(productId, attachment.filename));

  const attachments = product.attachments ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['product', productId] });

  const upload = useMutation({
    mutationFn: ({ file, category }: { file: File; category: AttachmentCategory }) =>
      api.uploadProductAttachment(productId, file, category),
    onMutate: ({ category }) => {
      setUploading((prev) => new Set(prev).add(category));
      setRefusals((prev) => ({ ...prev, [category]: undefined }));
    },
    onSuccess: refresh,
    onError: (e: Error, { category }) => setRefusals((prev) => ({ ...prev, [category]: e.message })),
    onSettled: (_data, _error, { category }) =>
      setUploading((prev) => {
        const next = new Set(prev);
        next.delete(category);
        return next;
      }),
  });

  const download = async (attachment: ProductAttachment) => {
    setDownloading(attachment.filename);
    try {
      const url = window.URL.createObjectURL(await api.getProductAttachment(productId, attachment.filename));
      const link = document.createElement('a');
      link.href = url;
      link.download = nameOf(attachment);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (e) {
      showToast((e as Error).message, 'error');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="space-y-4">
      {SECTIONS.map((category) => (
        <Section
          key={category}
          category={category}
          entries={attachments.filter((a) => a.category === category).sort(byAttachmentOrder)}
          canEdit={canEdit}
          uploading={uploading.has(category)}
          refusal={refusals[category]}
          downloading={downloading}
          onUpload={(file) => upload.mutate({ file, category })}
          onDownload={(attachment) => void download(attachment)}
          onView={(attachment) => void viewer.open(attachment)}
          onDelete={(attachment, row) => setDeleting({ attachment, row })}
        />
      ))}

      {deleting && (
        <ActionConfirm
          title={t('products.detail.docs.deleteTitle')}
          body={
            <div className="space-y-2">
              <p>{t('products.detail.docs.deleteBody', { name: nameOf(deleting.attachment) })}</p>
              <p className="text-bambu-gray">{t('products.detail.docs.deleteEffect')}</p>
            </div>
          }
          primaryLabel={t('common.delete')}
          danger
          send={async () => {
            // The row — and the button the focus goes back to — leaves with the re-read,
            // which this awaits: the row is gone before the confirmation closes.
            keepFocusWhenRowLeaves(deleting.row);
            await api.deleteProductAttachment(productId, deleting.attachment.filename);
            await refresh();
          }}
          onClose={() => setDeleting(null)}
        />
      )}

      {viewer.preview && (
        <Modal variant="lightbox" onClose={viewer.close} ariaLabel={nameOf(viewer.preview.item)}>
          {viewer.preview.url ? (
            <img
              key={viewer.preview.url}
              src={viewer.preview.url}
              alt={nameOf(viewer.preview.item)}
              className="max-w-[90vw] max-h-[90vh] object-contain"
              onClick={(e) => e.stopPropagation()}
              onError={viewer.fail}
            />
          ) : viewer.preview.failed ? (
            <div className="flex flex-col items-center gap-3 text-sm text-white" onClick={(e) => e.stopPropagation()}>
              <p>{t('products.detail.docs.previewFailed')}</p>
              <Button size="sm" variant="secondary" onClick={() => void viewer.open(viewer.preview!.item)}>
                {t('common.retry')}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-white">…</p>
          )}
        </Modal>
      )}
    </div>
  );
}

/** One category — rendered even when empty, saying what it takes. */
function Section({
  category,
  entries,
  canEdit,
  uploading,
  refusal,
  downloading,
  onUpload,
  onDownload,
  onView,
  onDelete,
}: {
  category: Exclude<AttachmentCategory, 'pictures'>;
  entries: ProductAttachment[];
  canEdit: boolean;
  uploading: boolean;
  refusal: string | undefined;
  downloading: string | null;
  onUpload: (file: File) => void;
  onDownload: (attachment: ProductAttachment) => void;
  onView: (attachment: ProductAttachment) => void;
  onDelete: (attachment: ProductAttachment, row: Element | null) => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  return (
    <section className="space-y-2 rounded-xl border border-bambu-dark-tertiary px-4 py-3.5" data-testid={`attachment-section-${category}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-white">{t(`products.detail.docs.sections.${category}`)}</h3>
        {canEdit && (
          <>
            <input
              ref={input}
              data-testid={`attachment-input-${category}`}
              type="file"
              accept={ACCEPT[category] || undefined}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUpload(file);
                e.target.value = '';
              }}
            />
            <Button size="sm" variant="secondary" disabled={uploading} onClick={() => input.current?.click()}>
              {uploading ? t('products.detail.docs.uploading') : t('products.detail.docs.upload')}
            </Button>
          </>
        )}
      </div>
      {refusal && (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
          {refusal}
        </p>
      )}
      {entries.length === 0 ? (
        <small className="text-xs text-bambu-gray">
          {t('products.detail.docs.empty', { hint: t(`products.detail.docs.hints.${category}`) })}
        </small>
      ) : (
        <ul className="space-y-2">
          {entries.map((attachment) => {
            const name = nameOf(attachment);
            const size = t('products.detail.docs.kb', { n: Math.max(1, Math.round(attachment.size / 1024)) });
            // Equality, never a fallback branch: an unknown source renders unlabelled, not mislabelled.
            const source =
              attachment.source === '3mf'
                ? t('products.detail.docs.from3mf')
                : attachment.source === 'import'
                  ? t('products.detail.docs.imported')
                  : null;
            return (
              <li key={attachment.filename} className="flex items-center gap-3 rounded-lg bg-bambu-dark px-3 py-2">
                <span className="w-12 shrink-0 rounded bg-bambu-dark-tertiary px-1 py-1 text-center text-[10px] font-semibold text-bambu-gray-light">
                  {extension(attachment)}
                </span>
                <div className="min-w-0 flex-1">
                  <b className="block text-sm font-semibold text-white wrap-anywhere">{name}</b>
                  <small className="text-xs text-bambu-gray">{source ? `${size} · ${source}` : size}</small>
                </div>
                {PICTURE.test(name) && (
                  <button type="button" className={ICON_BUTTON} aria-label={t('products.detail.docs.view', { name })} onClick={() => onView(attachment)}>
                    <Eye className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  className={ICON_BUTTON}
                  aria-label={t('products.detail.docs.download', { name })}
                  disabled={downloading === attachment.filename}
                  onClick={() => onDownload(attachment)}
                >
                  <Download className="h-4 w-4" />
                </button>
                {canEdit && (
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    aria-label={t('products.detail.docs.delete', { name })}
                    onClick={(e) => onDelete(attachment, e.currentTarget.closest('li'))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
