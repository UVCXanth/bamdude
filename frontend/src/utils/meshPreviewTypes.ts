/**
 * Which library files get which thumbnail path — by `file_type`, never by a display name (spec §3).
 * STL/OBJ render at once through the batch route; STEP/STP only in the background, through receipts.
 */

export const LEGACY_THUMBNAIL_TYPES = ['stl', 'obj'] as const;
export const CAD_THUMBNAIL_TYPES = ['step', 'stp'] as const;

const lower = (value: string | null | undefined) => (value ?? '').toLowerCase();

export function isLegacyThumbnailType(fileType: string | null | undefined): boolean {
  return (LEGACY_THUMBNAIL_TYPES as readonly string[]).includes(lower(fileType));
}

export function isCadThumbnailType(fileType: string | null | undefined): boolean {
  return (CAD_THUMBNAIL_TYPES as readonly string[]).includes(lower(fileType));
}

/** An upload by its name — the server decides the type, this only chooses which hint the dialog shows. */
export function isMeshUploadName(name: string): boolean {
  const extension = lower(name.split('.').pop());
  return isLegacyThumbnailType(extension) || isCadThumbnailType(extension);
}
