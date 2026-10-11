import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { RefreshCw } from 'lucide-react';
import { api } from '../../api/client';
import type { PartImageCandidate, PartImageChoice, PartImagePinReason, PartImageRef, ProductPartKind } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../Button';
import { InstanceThumb, PartThumb } from '../PartThumb';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { candidateImage, candidateKey, sameInstance, type PartImageDraft } from './partImageDraft';

const AMBER = 'text-amber-700 dark:text-amber-400';
const RADIO = 'accent-bambu-green';

/** One literal key per reason: `keysResolve` sees only literals (Global Constraints). */
function pinReasonText(t: TFunction, reason: PartImagePinReason | null): string {
  switch (reason) {
    case 'file_unlinked':
      return t('products.partImage.pinReason.fileUnlinked');
    case 'file_trashed':
      return t('products.partImage.pinReason.fileTrashed');
    case 'object_gone':
      return t('products.partImage.pinReason.objectGone');
    case 'not_this_part':
      return t('products.partImage.pinReason.notThisPart');
    case 'not_rendered':
      return t('products.partImage.pinReason.notRendered');
    default:
      return t('products.partImage.pinReason.unknown');
  }
}

/** By method only (plan E5, D9): the reasons' vocabulary is not mirrored here. */
function methodText(t: TFunction, candidate: PartImageCandidate): string {
  if (candidate.method === 'skipped') return t('products.partImage.method.skipped');
  if (candidate.method === null && candidate.plate_status === 'pending') return t('products.partImage.method.pending');
  return t('products.partImage.method.missing');
}

function SavedState({ choice }: { choice: PartImageChoice | null | undefined }) {
  const { t } = useTranslation();
  if (!choice || choice.source === 'auto') {
    return <p className="text-xs text-bambu-gray">{t('products.partImage.saved.auto')}</p>;
  }
  if (choice.source === 'photo') {
    return (
      <div className="space-y-0.5">
        <p className="text-xs text-bambu-gray">{t('products.partImage.saved.photo')}</p>
        {choice.photo && !choice.photo.present && <p className={`text-xs ${AMBER}`}>{t('products.partImage.photoGone')}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-bambu-gray">
        {t('products.partImage.saved.instance', { id: choice.instance?.identify_id ?? '—' })}
      </p>
      {choice.pin && !choice.pin.valid && (
        <p data-testid="part-image-pin-invalid" className={`text-xs ${AMBER}`}>
          {t('products.partImage.pinInvalid', { reason: pinReasonText(t, choice.pin.reason) })}
        </p>
      )}
    </div>
  );
}

/**
 * The chosen file, not yet sent (plan E5, D14): its address is made in an effect and revoked in its
 * cleanup — StrictMode's second run makes a fresh one, and nothing outlives the file or the dialog.
 */
function LocalPreview({ file, alt }: { file: File; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url ? (
    <img data-testid="part-photo-preview" src={url} alt={alt} className="h-16 w-16 rounded bg-bambu-dark object-contain" />
  ) : null;
}

interface PlateGroup {
  key: string;
  label: string;
  candidates: PartImageCandidate[];
}

/** The server's order, grouped by file and plate; a file the reader may not open is named so (spec §11.1). */
function groupByPlate(t: TFunction, candidates: PartImageCandidate[]): PlateGroup[] {
  const groups = new Map<string, PlateGroup>();
  for (const candidate of candidates) {
    const key = `${candidate.library_file_id}:${candidate.plate_index}`;
    let group = groups.get(key);
    if (!group) {
      const file = candidate.hidden ? t('products.detail.files.hiddenFile') : (candidate.filename ?? '');
      const plate =
        candidate.plate_index === 0
          ? t('products.detail.files.wholeFile')
          : t('products.detail.files.plateN', { index: candidate.plate_index });
      group = { key, label: `${file} · ${plate}`, candidates: [] };
      groups.set(key, group);
    }
    group.candidates.push(candidate);
  }
  return [...groups.values()];
}

function platesSummary(candidates: PartImageCandidate[]): { ready: number; pending: number; other: number } {
  const status = new Map<string, PartImageCandidate['plate_status']>();
  for (const c of candidates) status.set(`${c.library_file_id}:${c.plate_index}`, c.plate_status);
  let ready = 0;
  let pending = 0;
  let other = 0;
  for (const value of status.values()) {
    if (value === 'ready') ready += 1;
    else if (value === 'pending') pending += 1;
    else other += 1;
  }
  return { ready, pending, other };
}

export interface PartImageSectionProps {
  productId: number;
  /** The saved part's id — null while it is new. */
  partId: number | null;
  /** The saved picture and choice as the server says them NOW — the dialog's live read model
   *  (plan E5 r2, D15), never its editing base: a finished render shows in an open editor. */
  image?: PartImageRef | null;
  choice?: PartImageChoice | null;
  kind: ProductPartKind;
  /** The name the dialog shows now: the pictures' alt. */
  name: string;
  draft: PartImageDraft;
  onChange: (draft: PartImageDraft) => void;
  disabled: boolean;
  /** The file input's id: the dialog focuses it when «Photo» has no file (plan E5, D6). */
  photoInputId: string;
  /** `products:update` — the re-render door (D10). */
  canRerender: boolean;
}

/**
 * The part editor's «Picture» (spec part-thumbnails §12.4). It holds a DRAFT and sends nothing —
 * «Save part» does (plan E5, D7); the one immediate action is «Re-render», which queues the product's
 * plates and does not touch the part (D10). What is saved — the effective picture, the saved choice
 * and why a pin no longer holds — stands apart from the draft, so a refused save hides nothing.
 *
 * The plate objects are a saved printed part's (D8): they follow its saved name and aliases, and only
 * a ready one can be pinned — the server's own rule. A purchased part has a photo or automatic.
 */
export function PartImageSection({
  productId,
  partId,
  image,
  choice,
  kind,
  name,
  draft,
  onChange,
  disabled,
  photoInputId,
  canRerender,
}: PartImageSectionProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const group = useId();
  const printed = kind === 'printed';

  const candidates = useQuery({
    queryKey: ['part-image-candidates', partId],
    queryFn: () => api.getPartImageCandidates(partId as number),
    enabled: partId != null && printed,
    retry: false,
  });
  const rerender = useMutation({
    mutationFn: () => api.rerenderPartImages(productId, true),
    onSuccess: ({ queued }) => {
      showToast(t('products.partImage.rerenderQueued', { count: queued }));
      queryClient.invalidateQueries({ queryKey: ['part-image-candidates', partId] });
    },
    onError: (error: Error) => showToast(t('products.partImage.rerenderFailed', { message: error.message }), 'error'),
  });

  const list = candidates.data ?? [];
  const chosenFile = draft.source === 'photo' ? draft.file : null;
  const summary = printed && partId != null && list.length > 0 ? platesSummary(list) : null;

  let objects = null;
  if (printed) {
    let body;
    if (partId == null) {
      body = <p className="text-xs text-bambu-gray">{t('products.partImage.newPartObjects')}</p>;
    } else if (candidates.isError) {
      body = (
        <LoadFailedNote role="status" message={t('products.partImage.objectsFailed')} onRetry={() => candidates.refetch()} />
      );
    } else if (!candidates.data) {
      body = <p className="text-xs text-bambu-gray">{t('products.partImage.objectsLoading')}</p>;
    } else if (list.length === 0) {
      body = <p className="text-xs text-bambu-gray">{t('products.partImage.objectsEmpty')}</p>;
    } else {
      body = groupByPlate(t, list).map((plate) => (
        <div key={plate.key} data-testid={`part-image-plate-${plate.key}`} className="space-y-1">
          <p className="text-xs text-bambu-gray wrap-anywhere">{plate.label}</p>
          <ul className="flex flex-wrap gap-2">
            {plate.candidates.map((candidate) => {
              const key = candidateKey(candidate);
              const objectName = t('products.partImage.object', { id: candidate.identify_id });
              const thumb = (
                <InstanceThumb
                  productId={productId}
                  image={candidateImage(candidate)}
                  name={objectName}
                  size="md"
                  zoom={candidate.v ? 'hover' : 'none'}
                />
              );
              return (
                <li key={candidate.identify_id} data-testid={`part-image-candidate-${candidate.identify_id}`}>
                  {candidate.v ? (
                    <label className="flex items-center gap-2 rounded-lg border border-bambu-dark-tertiary p-1.5 text-xs text-bambu-gray-light has-[:checked]:border-bambu-green">
                      <input
                        type="radio"
                        name={group}
                        className={RADIO}
                        checked={draft.source === 'instance' && sameInstance(draft.instance, key)}
                        onChange={() => onChange({ source: 'instance', instance: key })}
                        disabled={disabled}
                        aria-label={`${plate.label} · ${objectName}`}
                      />
                      {thumb}
                      <span>
                        {objectName}
                        {candidate.pinned && <small className="block text-bambu-green">{t('products.partImage.pinned')}</small>}
                      </span>
                    </label>
                  ) : (
                    <div className="flex items-center gap-2 rounded-lg border border-dashed border-bambu-dark-tertiary p-1.5 text-xs text-bambu-gray">
                      {thumb}
                      <span>
                        {objectName}
                        <small className="block">{methodText(t, candidate)}</small>
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ));
    }
    objects = (
      <div className="space-y-1.5">
        <p className="text-sm text-bambu-gray-light">{t('products.partImage.objects')}</p>
        {body}
      </div>
    );
  }

  return (
    <fieldset data-testid="part-image-section" className="mt-4 space-y-3 rounded-xl border border-bambu-dark-tertiary p-3">
      <legend className="px-1 text-sm font-semibold text-white">{t('products.partImage.title')}</legend>

      <div className="flex items-start gap-3">
        <PartThumb partId={partId ?? 0} image={image} name={name} kind={kind} size="md" />
        <div className="min-w-0 space-y-0.5">
          <p className="text-xs text-bambu-gray-light">
            {image ? t('products.partImage.shown') : t('products.partImage.none')}
          </p>
          <SavedState choice={choice} />
        </div>
      </div>

      <div role="radiogroup" aria-label={t('products.partImage.title')} className="space-y-3">
        <label className="flex items-start gap-2 text-sm text-bambu-gray-light">
          <input
            type="radio"
            name={group}
            className={`${RADIO} mt-0.5`}
            checked={draft.source === 'auto'}
            onChange={() => onChange({ source: 'auto' })}
            disabled={disabled}
          />
          <span>
            {t('products.partImage.auto')}
            <small className="block text-xs text-bambu-gray">{t('products.partImage.autoHint')}</small>
          </span>
        </label>

        {objects}

        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-bambu-gray-light">
            <input
              type="radio"
              name={group}
              className={RADIO}
              checked={draft.source === 'photo'}
              onChange={() => onChange({ source: 'photo', file: chosenFile })}
              disabled={disabled}
            />
            {t('products.partImage.photo')}
          </label>
          <div className="flex flex-wrap items-center gap-2 pl-6">
            <input
              id={photoInputId}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label={t('products.partImage.choosePhoto')}
              disabled={disabled}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onChange({ source: 'photo', file });
                e.target.value = ''; // the same file may be chosen again
              }}
              className="max-w-full text-xs text-bambu-gray-light file:mr-2 file:rounded-lg file:border-0 file:bg-bambu-dark-tertiary file:px-3 file:py-1.5 file:text-white"
            />
            {chosenFile && <LocalPreview file={chosenFile} alt={name} />}
            {chosenFile ? (
              <small className="text-xs text-bambu-gray wrap-anywhere">
                {t('products.partImage.photoChosen', { name: chosenFile.name })}
              </small>
            ) : (
              draft.source === 'photo' &&
              choice?.source === 'photo' && (
                <small className="text-xs text-bambu-gray">{t('products.partImage.photoKept')}</small>
              )
            )}
          </div>
        </div>
      </div>

      {summary && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-bambu-dark-tertiary pt-2">
          <small data-testid="part-image-plates" className="text-xs text-bambu-gray">
            {t('products.partImage.plates', summary)}
          </small>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!canRerender || rerender.isPending}
            onClick={() => rerender.mutate()}
          >
            <RefreshCw className="h-4 w-4" />
            {t('products.partImage.rerender')}
          </Button>
        </div>
      )}
    </fieldset>
  );
}
