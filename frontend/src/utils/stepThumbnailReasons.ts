/**
 * The closed reasons a thumbnail job or the batch route may answer (spec §6), each with its own sentence in
 * both locales. A code this build does not know — a newer server's — gets the generic sentence, never an
 * instruction to install the STEP component.
 */

export const THUMBNAIL_REASONS = [
  'queue_full',
  'preemption_limit',
  'expired_before_start',
  'job_expired',
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

export function thumbnailReasonKey(code: string | null | undefined): string {
  return (THUMBNAIL_REASONS as readonly string[]).includes(code ?? '')
    ? `fileManager.stepThumbnail.reasons.${code}`
    : 'fileManager.stepThumbnail.reasons.unknown';
}
