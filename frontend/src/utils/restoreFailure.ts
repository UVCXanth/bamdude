/**
 * The sentence a refused restore shows. The previews' quiesce refusal has its own (restart, then restore); any
 * other refusal shows the server's — already in the system language — and a refusal with no text the generic one.
 */

export interface RestoreResult {
  success: boolean;
  message?: string | null;
  code?: string | null;
}

export function restoreFailureText(result: RestoreResult, t: (key: string) => string): string {
  if (result.code === 'preview_quiesce_unproven') return t('backup.previewQuiesceUnproven');
  return result.message || t('backup.failedToRestore');
}
