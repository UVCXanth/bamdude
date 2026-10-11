/**
 * The editor's picture draft (spec part-thumbnails §12.4; plan E5, D6): what «Save part» sends for
 * the picture — one request, or none when the draft says what is saved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../api/client';
import type { PartImageCandidate, PartImageChoice } from '../../../api/client';
import {
  candidateImage,
  draftFromChoice,
  needsPhotoFile,
  pendingImageRequest,
  sendImageRequest,
} from '../../../components/products/partImageDraft';

const key = { library_file_id: 9, plate_index: 1, identify_id: 11 };
const auto: PartImageChoice = { source: 'auto', instance: null, pin: null, photo: null };
const pinned: PartImageChoice = { source: 'instance', instance: key, pin: { valid: true, reason: null }, photo: null };
const photo: PartImageChoice = { source: 'photo', instance: null, pin: null, photo: { present: true } };
const file = new File(['x'], 'p.png', { type: 'image/png' });

afterEach(() => vi.restoreAllMocks());

describe('the draft a dialog opens with', () => {
  it('follows the saved choice; no choice at all is automatic (D15)', () => {
    expect(draftFromChoice(undefined)).toEqual({ source: 'auto' });
    expect(draftFromChoice(auto)).toEqual({ source: 'auto' });
    expect(draftFromChoice(pinned)).toEqual({ source: 'instance', instance: key });
    expect(draftFromChoice(photo)).toEqual({ source: 'photo', file: null });
  });

  it('a pin whose key the server did not send opens as automatic', () => {
    expect(draftFromChoice({ ...pinned, instance: null })).toEqual({ source: 'auto' });
  });
});

describe('the one request «Save part» sends', () => {
  it('none when the draft says what is saved — an invalid pin kept as it is included', () => {
    expect(pendingImageRequest({ source: 'auto' }, auto)).toBeNull();
    expect(pendingImageRequest({ source: 'auto' }, undefined)).toBeNull();
    expect(pendingImageRequest({ source: 'instance', instance: { ...key } }, pinned)).toBeNull();
    expect(
      pendingImageRequest({ source: 'instance', instance: key }, { ...pinned, pin: { valid: false, reason: 'object_gone' } }),
    ).toBeNull();
    expect(pendingImageRequest({ source: 'photo', file: null }, photo)).toBeNull();
  });

  it('automatic from a pin or a photo is one PUT — the writer drops the photo itself (D6)', () => {
    expect(pendingImageRequest({ source: 'auto' }, pinned)).toEqual({ kind: 'auto' });
    expect(pendingImageRequest({ source: 'auto' }, photo)).toEqual({ kind: 'auto' });
  });

  it('another object, or a pin where there was none', () => {
    const other = { ...key, identify_id: 12 };
    expect(pendingImageRequest({ source: 'instance', instance: other }, pinned)).toEqual({ kind: 'instance', instance: other });
    expect(pendingImageRequest({ source: 'instance', instance: key }, auto)).toEqual({ kind: 'instance', instance: key });
  });

  it('a chosen file is always sent — a new photo replaces a saved one', () => {
    expect(pendingImageRequest({ source: 'photo', file }, auto)).toEqual({ kind: 'photo', file });
    expect(pendingImageRequest({ source: 'photo', file }, photo)).toEqual({ kind: 'photo', file });
  });

  it('«Photo» without a file needs one only when no photo is saved', () => {
    expect(needsPhotoFile({ source: 'photo', file: null }, auto)).toBe(true);
    expect(needsPhotoFile({ source: 'photo', file: null }, undefined)).toBe(true);
    expect(needsPhotoFile({ source: 'photo', file: null }, photo)).toBe(false);
    expect(needsPhotoFile({ source: 'photo', file }, auto)).toBe(false);
    expect(needsPhotoFile({ source: 'auto' }, auto)).toBe(false);
  });
});

describe('sending it', () => {
  it('each request through its own door', async () => {
    const set = vi.spyOn(api, 'setPartImage').mockResolvedValue({ id: 3 } as never);
    const upload = vi.spyOn(api, 'uploadPartPhoto').mockResolvedValue({ id: 3 } as never);
    await sendImageRequest(3, { kind: 'auto' });
    await sendImageRequest(3, { kind: 'instance', instance: key });
    await sendImageRequest(3, { kind: 'photo', file });
    expect(set.mock.calls).toEqual([
      [3, { source: 'auto' }],
      [3, { source: 'instance', instance: key }],
    ]);
    expect(upload).toHaveBeenCalledWith(3, file);
  });
});

describe('a candidate’s picture (D8, D9)', () => {
  const candidate = (over: Partial<PartImageCandidate>): PartImageCandidate => ({
    library_file_id: 9,
    filename: 'flask.gcode.3mf',
    hidden: false,
    plate_index: 1,
    identify_id: 11,
    method: 'toolpath',
    reason: null,
    plate_status: 'ready',
    v: 'v11',
    pinned: false,
    ...over,
  });

  it('ready only with a version — the rule the server pins by', () => {
    expect(candidateImage(candidate({}))).toEqual({ ...key, status: 'ready', v: 'v11' });
    expect(candidateImage(candidate({ method: 'skipped', reason: 'over_cap', v: null })).status).toBe('skipped');
    expect(candidateImage(candidate({ method: 'missing', reason: 'empty_render', v: null })).status).toBe('missing');
    expect(candidateImage(candidate({ method: null, plate_status: 'pending', v: null })).status).toBe('pending');
    // a plate that never renders (not sliced, failed, unavailable) is no «being prepared»
    expect(candidateImage(candidate({ method: null, plate_status: 'none', v: null })).status).toBe('missing');
    expect(candidateImage(candidate({ method: null, plate_status: 'failed', v: null })).status).toBe('missing');
  });
});
