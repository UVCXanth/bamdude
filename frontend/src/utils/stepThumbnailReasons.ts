/**
 * The closed reasons a thumbnail job or the batch route may answer (spec §6), each with its own sentence in
 * both locales. A code this build does not know — a newer server's — gets the generic sentence, never an
 * instruction to install the STEP component.
 */

import { ApiError } from '../api/client';

export const THUMBNAIL_REASONS = [
  'queue_full',
  'preemption_limit',
  'expired_before_start',
  'job_expired',
  'backup_in_progress',
  'authority_missing',
  'use_thumbnail_jobs',
  'cad_unavailable',
  'timeout',
  'resource_limit',
  'render_failed',
  'superseded',
  'source_unverified',
  'file_missing',
  'too_small',
  'unavailable',
  'busy',
  'canceled',
  'cancel_too_late',
  'protocol_error',
  'not_step',
] as const;

export type ThumbnailReason = (typeof THUMBNAIL_REASONS)[number];

/** A refusal's closed code: the server's own, a missing right for a bare 403, else the service unavailable. */
export function stepRefusalCode(error: unknown): string {
  if (error instanceof ApiError && error.code) return error.code;
  if (error instanceof ApiError && error.status === 403) return 'authority_missing';
  return 'unavailable';
}

/** Refusals grouped by reason, in the order each reason first came: one sentence per reason, never per file. */
export function countByReason(codes: ReadonlyArray<string | null | undefined>): Array<[string | null, number]> {
  const counts = new Map<string | null, number>();
  for (const code of codes) counts.set(code ?? null, (counts.get(code ?? null) ?? 0) + 1);
  return [...counts];
}

export function thumbnailReasonKey(code: string | null | undefined): string {
  return (THUMBNAIL_REASONS as readonly string[]).includes(code ?? '')
    ? `fileManager.stepThumbnail.reasons.${code}`
    : 'fileManager.stepThumbnail.reasons.unknown';
}
