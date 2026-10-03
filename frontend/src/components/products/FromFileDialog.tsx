import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { api } from '../../api/client';
import { invalidateProductCatalog } from '../../utils/queryInvalidation';
import type { LibraryFileListItem, LibraryFolderTree, Product } from '../../api/client';
import { isPrintable } from '../../lib/fileTags';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../Button';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { cardNotesText } from './cardNotes';

/** How long the search box waits before it becomes a request. */
const DEBOUNCE_MS = 300;
/** One screenful. The dialog pages nothing — it narrows by typing instead. */
const PAGE_SIZE = 20;

interface FromFileDialogProps {
  onClose: () => void;
  onCreated: (created: Product) => void;
}

/**
 * Full path of every folder, so two files of the same name in different places
 * stay tellable apart. `LibraryFileListItem` carries `folder_id` only — there
 * is no `folder_path` on the wire, and the tree is the only thing that knows
 * the ancestry.
 */
function folderPaths(trees: LibraryFolderTree[] | undefined): Map<number, string> {
  const paths = new Map<number, string>();
  const walk = (node: LibraryFolderTree, prefix: string) => {
    const path = `${prefix}/${node.name}`;
    paths.set(node.id, path);
    for (const child of node.children ?? []) walk(child, path);
  };
  for (const root of trees ?? []) walk(root, '');
  return paths;
}

/**
 * The kind of a file by its NAME (WS-13 E10 E02): a sliced `.gcode.3mf` is a 3MF
 * container though its `file_type` is «gcode», and the mockup's box says «3MF».
 */
function fileKind(filename: string): string {
  const name = filename.toLowerCase();
  if (name.endsWith('.3mf')) return '3MF';
  if (name.endsWith('.stl')) return 'STL';
  if (name.endsWith('.step') || name.endsWith('.stp')) return 'STEP';
  if (name.endsWith('.gcode')) return 'GCODE';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : '—';
}

/**
 * Pick one library file and make a product of it (WS-13 E10 E01–E03, F17).
 *
 * ⚠️ **Not `LibraryPickerModal`.** That dialog exists to pick a BATCH of files
 * for the print queue: it filters to what is sliced for one printer model,
 * multi-selects and hands back `SequencedFile[]`. Here exactly one file is
 * picked, from the whole library, and the answer is a `Product`.
 *
 * ⚠️ **`include_root: false`** — the WHOLE library the reader may see. Without it
 * `GET /library/files` answers the root folder's files only, which on a library
 * kept in folders is nothing at all (E10 T0). The search goes to the server too:
 * the library may hold tens of thousands of files, and this dialog needs one.
 *
 * One creation at a time: the pressed row says «…» and the others wait; a refusal
 * stays in the dialog; what the file gave is told after it (A02's notes).
 */
export function FromFileDialog({ onClose, onCreated }: FromFileDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  // The cursor starts in the search, the dialog's first field.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // ⚠️ No `placeholderData`: a new search shows its own reading state, never the
  // previous answer as though it were this one's (J).
  const files = useQuery({
    queryKey: ['library-files', 'pick', q],
    queryFn: () =>
      api.getLibraryFilesPaged({ ...(q ? { q } : {}), include_root: false, page: 1, per_page: PAGE_SIZE }),
  });
  const { data: folders } = useQuery({ queryKey: ['library-folders'], queryFn: api.getLibraryFolders });
  const paths = useMemo(() => folderPaths(folders), [folders]);

  // ⚠️ Synchronous: one press, one creation; nothing closes the dialog under it.
  const sent = useRef(false);
  const [creating, setCreating] = useState<number | null>(null);
  // The row whose button sent the last request: its button takes the focus back after a refusal.
  const pressed = useRef<number | null>(null);
  const uid = useId();
  const buttonId = (fileId: number) => `${uid}-create-${fileId}`;
  const create = useMutation({
    mutationFn: (fileId: number) => api.createProductFromFile(fileId),
    onSuccess: ({ product, notes }) => {
      invalidateProductCatalog(queryClient);
      // What the file gave, in the reader's language — or, with nothing to tell, the
      // mockup's sentence that a product was CREATED out of the picked file.
      showToast(notes.length > 0 ? cardNotesText(t, notes) : t('products.toast.createdFromFile'));
      onCreated(product);
    },
    onError: () => {
      sent.current = false;
      setCreating(null);
    },
  });
  const busy = creating !== null || create.isPending;
  // After a refusal the buttons are live again: the focus goes back to the one that sent it
  // (it was disabled under the request, which left the focus nowhere).
  useEffect(() => {
    if (create.isError && pressed.current != null) document.getElementById(buttonId(pressed.current))?.focus();
    // `buttonId` is derived from `uid`, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [create.isError, create.error]);

  const close = () => {
    if (sent.current) return;
    onClose();
  };

  const createFrom = (file: LibraryFileListItem) => {
    if (sent.current) return;
    sent.current = true;
    pressed.current = file.id;
    setCreating(file.id);
    create.mutate(file.id);
  };

  const items = files.data?.items ?? [];
  let list;
  if (!files.data && files.isError) {
    list = <LoadFailedNote message={t('products.fromFile.loadFailed')} onRetry={() => files.refetch()} />;
  } else if (!files.data) {
    list = (
      <div role="status" aria-busy className="space-y-2">
        <span className="sr-only">{t('common.loading')}</span>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 rounded-lg bg-bambu-dark-tertiary/60 animate-pulse" />
        ))}
      </div>
    );
  } else if (items.length === 0) {
    list = <p className="py-6 text-center text-sm text-bambu-gray">{t('products.fromFile.empty')}</p>;
  } else {
    list = (
      <ul className="space-y-2">
        {items.map((file) => {
          const folder = file.folder_id === null ? null : (paths.get(file.folder_id) ?? null);
          const model = file.sliced_for_model;
          // «Not sliced» by content (the `gcode` tag), not by the provenance tag `sliced`,
          // which a hand-uploaded `.gcode.3mf` does not carry.
          const sliced = model != null || isPrintable(file);
          const pressed = creating === file.id;
          return (
            <li
              key={file.id}
              data-testid="from-file-row"
              className="flex items-center gap-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-2"
            >
              <span className="flex h-10 w-12 shrink-0 items-center justify-center rounded bg-bambu-dark-tertiary text-[11px] font-semibold text-bambu-gray-light">
                {fileKind(file.filename)}
              </span>
              <span className="min-w-0 flex-1">
                <b className="block truncate text-sm font-medium text-white">{file.filename}</b>
                <small className="block truncate text-xs text-bambu-gray">
                  {sliced ? (
                    [folder, model].filter(Boolean).join(' · ')
                  ) : (
                    <>
                      {folder && `${folder} · `}
                      <span className="text-amber-700 dark:text-amber-400">{t('products.fromFile.notSliced')}</span>
                    </>
                  )}
                </small>
              </span>
              <Button id={buttonId(file.id)} size="sm" onClick={() => createFrom(file)} disabled={busy}>
                {t('products.fromFile.create')}
                {pressed && '…'}
              </Button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <WorkshopDialog
      size="lg"
      onClose={close}
      title={t('products.fromFile.title')}
      subtitle={t('products.fromFile.subtitle')}
      pending={busy}
      error={create.isError ? (create.error as Error).message : undefined}
      footer={
        <Button variant="secondary" onClick={close} disabled={busy}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray" />
          <input
            ref={searchRef}
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t('products.fromFile.search')}
            aria-label={t('products.fromFile.search')}
            className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark py-2 pl-9 pr-3 text-sm text-white placeholder:text-bambu-gray focus:border-bambu-green focus:outline-none"
          />
        </div>
        {files.data && files.isError && <RefreshFailedNote onRetry={() => void files.refetch()} />}
        {list}
        {/* One screenful of the whole library: say so when there is more, so a file not shown
            is not taken for a file not there (final review M7). */}
        {files.data && files.data.meta.total > items.length && (
          <p className="text-xs text-bambu-gray">
            {t('products.fromFile.partial', { shown: items.length, total: files.data.meta.total })}
          </p>
        )}
      </div>
    </WorkshopDialog>
  );
}
