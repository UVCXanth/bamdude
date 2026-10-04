import type { Permission } from '../api/client';

/**
 * What a page outside the Workshop may change of the Workshop's (WS-13 E13 B06) — the
 * UI's copy of the server's gates (B01, B03), which stay the final word. A library
 * file or folder belongs to products and a print to an order: changing either is the
 * order desk's business, so beside the right on the thing itself it needs
 * `projects:update`.
 */

type HasPermission = (permission: Permission) => boolean;
type CanModify = (
  resource: 'queue' | 'archives' | 'library',
  action: 'update' | 'delete' | 'reprint',
  createdById: number | null | undefined,
) => boolean;

/** Link a library file to products, or unlink it. */
export function canLinkFile(hasPermission: HasPermission, canModify: CanModify, createdById: number | null | undefined) {
  return hasPermission('projects:update') && canModify('library', 'update', createdById);
}

/** Link a folder to products, or unlink it — folders carry no owner, so the library side is `update_all`. */
export function canLinkFolder(hasPermission: HasPermission) {
  return hasPermission('projects:update') && hasPermission('library:update_all');
}

/** File a print under an order or take it out: `update_own` only the caller's own, an ownerless print only `update_all`. */
export function canFileArchive(hasPermission: HasPermission, canModify: CanModify, createdById: number | null | undefined) {
  return hasPermission('projects:update') && canModify('archives', 'update', createdById);
}

/**
 * Would moving these files into a folder with these products change which products
 * any of them belongs to? A move REPLACES a file's products with the folder's — the
 * root has none — so such a move needs `projects:update` too (B01).
 */
export function moveChangesProducts(files: { product_ids: number[] }[], folderProductIds: number[]) {
  const target = new Set(folderProductIds);
  return files.some((file) => {
    const own = new Set(file.product_ids);
    return own.size !== target.size || [...own].some((id) => !target.has(id));
  });
}
