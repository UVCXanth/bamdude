import { api } from '../../api/client';
import type {
  InstanceImageRef,
  PartImageCandidate,
  PartImageChoice,
  PartImageInstanceKey,
  ProductPart,
} from '../../api/client';

/**
 * What the editor's picture section holds until «Save part» (spec part-thumbnails §12.4; plan E5,
 * D6). A photo's `file` is the one chosen in this dialog, or `null` for «keep the saved photo».
 */
export type PartImageDraft =
  | { source: 'auto' }
  | { source: 'instance'; instance: PartImageInstanceKey }
  | { source: 'photo'; file: File | null };

/** The one picture request a «Save part» sends. */
export type PartImageRequest =
  | { kind: 'auto' }
  | { kind: 'instance'; instance: PartImageInstanceKey }
  | { kind: 'photo'; file: File };

export function sameInstance(a?: PartImageInstanceKey | null, b?: PartImageInstanceKey | null): boolean {
  return (
    a != null &&
    b != null &&
    a.library_file_id === b.library_file_id &&
    a.plate_index === b.plate_index &&
    a.identify_id === b.identify_id
  );
}

/** The draft a dialog opens with: the saved choice; none at all — a non-editor answer — is automatic (D15). */
export function draftFromChoice(choice: PartImageChoice | null | undefined): PartImageDraft {
  if (choice?.source === 'photo') return { source: 'photo', file: null };
  if (choice?.source === 'instance' && choice.instance) return { source: 'instance', instance: { ...choice.instance } };
  return { source: 'auto' };
}

/** «Photo» chosen without a file, on a part with no saved photo: the dialog refuses before sending. */
export function needsPhotoFile(draft: PartImageDraft, choice: PartImageChoice | null | undefined): boolean {
  return draft.source === 'photo' && draft.file === null && choice?.source !== 'photo';
}

/**
 * The picture request «Save part» sends, or `null` when the draft says what is saved. A pin kept as
 * it is — valid or not — is no change: the server explains an invalid one, the operator decides.
 * Automatic is one `PUT {source: "auto"}` from a pin or a photo alike: the writer drops the photo
 * after its commit (spec §10.3).
 */
export function pendingImageRequest(
  draft: PartImageDraft,
  choice: PartImageChoice | null | undefined,
): PartImageRequest | null {
  const saved = choice?.source ?? 'auto';
  switch (draft.source) {
    case 'auto':
      return saved === 'auto' ? null : { kind: 'auto' };
    case 'instance':
      return saved === 'instance' && sameInstance(choice?.instance, draft.instance)
        ? null
        : { kind: 'instance', instance: draft.instance };
    case 'photo':
      return draft.file ? { kind: 'photo', file: draft.file } : null;
  }
}

export function sendImageRequest(partId: number, request: PartImageRequest): Promise<ProductPart> {
  switch (request.kind) {
    case 'auto':
      return api.setPartImage(partId, { source: 'auto' });
    case 'instance':
      return api.setPartImage(partId, { source: 'instance', instance: request.instance });
    case 'photo':
      return api.uploadPartPhoto(partId, request.file);
  }
}

export function candidateKey(candidate: PartImageCandidate): PartImageInstanceKey {
  return {
    library_file_id: candidate.library_file_id,
    plate_index: candidate.plate_index,
    identify_id: candidate.identify_id,
  };
}

/**
 * A candidate as a picture (plan E5, D8–D9): ready exactly when it has a version — the rule the
 * server pins by; «being prepared» only while its plate is queued without a result — a plate that
 * never renders (not sliced, failed, unavailable) shows no picture rather than a promise.
 */
export function candidateImage(candidate: PartImageCandidate): InstanceImageRef {
  const status: InstanceImageRef['status'] =
    candidate.v != null
      ? 'ready'
      : candidate.method === 'skipped'
        ? 'skipped'
        : candidate.method === null && candidate.plate_status === 'pending'
          ? 'pending'
          : 'missing';
  return { ...candidateKey(candidate), status, v: candidate.v };
}
