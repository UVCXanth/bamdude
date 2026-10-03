import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { FileArchive, Loader2, Upload } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { ProductImportResponse } from '../../api/client';
import { invalidateProductCatalog } from '../../utils/queryInvalidation';
import { FolderTreePicker } from '../FolderTreePicker';
import { Button } from '../Button';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { cardNoteText } from './cardNotes';

interface ImportProductDialogProps {
  onClose: () => void;
}

/**
 * Rebuild a product from an export ZIP (WS-13 E10 G01–G03, F19).
 *
 * ⚠️ **The folder is a DESTINATION, not a link.** It is where files nobody
 * already has land; the server never joins it to the product, because "every
 * file in here belongs to this product" is not what an operator said by
 * importing into their Downloads folder. Files the library already holds are
 * matched by content hash and reused, so a second import of the same export
 * adds no duplicates — which is also why the picker is optional: with nothing
 * chosen the server reuses, or makes, a root folder named after the product.
 *
 * ⚠️ **The warnings are the point, not decoration.** An import is somebody
 * else's export and half of what it has to say is what it could NOT take. They
 * arrive as `CardNote` codes, go through `cardNoteText`, and stay in the dialog's
 * result step (G03) — the product opens only by «Open the product», so they are
 * read before anything moves.
 *
 * ⚠️ **A refusal stays in the dialog's slot.** 400 (not an export) and 413 (over
 * the ceiling) are answered by picking a different file, which the operator can
 * only do while the file input is in front of them.
 */
export function ImportProductDialog({ onClose }: ImportProductDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const chooseId = useId();
  const openId = useId();
  const importId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [folderId, setFolderId] = useState<number | null>(null);
  const [result, setResult] = useState<ProductImportResponse | null>(null);

  const { data: folders } = useQuery({ queryKey: ['library-folders'], queryFn: api.getLibraryFolders });

  // ⚠️ Synchronous: one press, one import; nothing closes the dialog under it.
  const sent = useRef(false);
  const run = useMutation({
    mutationFn: (chosen: File) => api.importProduct(chosen, folderId),
    onSuccess: (answer) => {
      invalidateProductCatalog(queryClient);
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      sent.current = false;
      setResult(answer);
    },
    onError: () => {
      sent.current = false;
    },
  });
  const pending = run.isPending;

  // The cursor starts in the first field — the archive chooser; the result's on «Open the product».
  useEffect(() => {
    document.getElementById(result ? openId : chooseId)?.focus();
  }, [result, chooseId, openId]);
  // After a refusal «Import» is live again and takes the focus back: it was disabled under
  // the request, which left the focus nowhere.
  useEffect(() => {
    if (run.isError) document.getElementById(importId)?.focus();
  }, [run.isError, run.error, importId]);

  const close = () => {
    if (sent.current) return;
    onClose();
  };

  if (result) {
    return (
      <WorkshopDialog
        size="md"
        onClose={onClose}
        title={t('products.import.title')}
        subtitle={t('products.import.subtitle')}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.close')}
            </Button>
            <Button
              id={openId}
              onClick={() => {
                onClose();
                navigate(`/products/${result.product.id}`);
              }}
            >
              {t('products.import.open')}
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          <p className="font-medium text-white">{t('products.import.done', { name: result.product.name })}</p>
          {result.warnings.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-amber-700 dark:text-amber-400">
              {result.warnings.map((warning, index) => (
                <li key={index}>{cardNoteText(t, warning)}</li>
              ))}
            </ul>
          ) : (
            <p className="text-bambu-gray">{t('products.import.noWarnings')}</p>
          )}
        </div>
      </WorkshopDialog>
    );
  }

  const refusal = run.isError
    ? run.error instanceof ApiError && run.error.status === 413
      ? // 413's server sentence names a byte count nobody reads; everything else is the
        // server's own words, because it knows what was wrong with the archive.
        t('products.import.tooLarge')
      : (run.error as Error).message
    : undefined;

  return (
    <WorkshopDialog
      size="md"
      onClose={close}
      title={t('products.import.title')}
      subtitle={t('products.import.subtitle')}
      pending={pending}
      error={refusal}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            id={importId}
            type="button"
            onClick={() => {
              if (sent.current || !file) return;
              sent.current = true;
              run.mutate(file);
            }}
            disabled={!file || pending}
          >
            {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {pending ? t('products.import.importing') : t('products.import.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm text-bambu-gray-light">{t('products.import.file')}</span>
          <input
            ref={input}
            data-testid="import-file-input"
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => {
              run.reset();
              setFile(e.target.files?.[0] ?? null);
            }}
          />
          <div className="flex min-w-0 items-center gap-3">
            <Button
              id={chooseId}
              type="button"
              variant="secondary"
              onClick={() => input.current?.click()}
              disabled={pending}
            >
              <FileArchive className="w-4 h-4" />
              {t('products.import.choose')}
            </Button>
            {file && <span className="min-w-0 truncate text-sm text-white">{file.name}</span>}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm text-bambu-gray-light">{t('products.import.folder')}</span>
          <FolderTreePicker
            folders={folders}
            value={folderId}
            onChange={setFolderId}
            rootLabel={t('products.import.newFolder')}
            className="max-h-48 rounded border border-bambu-dark-tertiary p-1"
          />
        </div>

        <p className="text-xs text-bambu-gray">{t('products.import.hint')}</p>
      </div>
    </WorkshopDialog>
  );
}
