import type { Permission } from '../api/client';

/**
 * What a page outside the Workshop may change of the Workshop's (WS-13 E13 B06) — the
 * UI's copy of the server's gates (B01, B03), which stay the final word. A library
 * file or folder belongs to products and a print to an order: changing either is the
 * Workshop's business, so beside the right on the thing itself it needs the Workshop's
 * own: `products:update` for a product link, `orders:update` for an order.
 */

type HasPermission = (permission: Permission) => boolean;
type CanModify = (
  resource: 'queue' | 'archives' | 'library',
  action: 'update' | 'delete' | 'reprint',
  createdById: number | null | undefined,
) => boolean;

/** Link a library file to products, or unlink it. */
export function canLinkFile(hasPermission: HasPermission, canModify: CanModify, createdById: number | null | undefined) {
  return hasPermission('products:update') && canModify('library', 'update', createdById);
}

/** Link a folder to products, or unlink it — folders carry no owner, so the library side is `update_all`. */
export function canLinkFolder(hasPermission: HasPermission) {
  return hasPermission('products:update') && hasPermission('library:update_all');
}

/**
 * F(print) — file a past print under an order or take it out (WS-13 E13 O21): the Workshop's
 * own `orders:file_prints` files ANY print — a print from the printer's screen has no owner;
 * otherwise `orders:update` with the archive's own right (`update_own` only the caller's own,
 * an ownerless print only `update_all`).
 */
export function canFileArchive(hasPermission: HasPermission, canModify: CanModify, createdById: number | null | undefined) {
  return (
    hasPermission('orders:file_prints') ||
    (hasPermission('orders:update') && canModify('archives', 'update', createdById))
  );
}

/**
 * Fф — file work this request CREATES under an order (WS-13 E13 O21): `orders:file_prints` or
 * `orders:update`. The work is nobody's yet, so no archive right is asked. Every door of new
 * work asks it: the print dialog's order, a reprint, a clone, a plate's «Repeat».
 */
export function canFileFuturePrint(hasPermission: HasPermission) {
  return hasPermission('orders:file_prints') || hasPermission('orders:update');
}

/**
 * Does a copy of work under an order — a reprint, a clone, a plate's «Repeat» — keep the order?
 * Only for whoever may file work under it, and only while it is open; anybody else gets the
 * explicit «without order» before sending (WS-13 E13 R11, O10). Nothing to inherit keeps nothing.
 */
export function keepsOrderOnCopy(projectId: number | null | undefined, hasPermission: HasPermission, open = true) {
  return projectId == null || (open && canFileFuturePrint(hasPermission));
}

/**
 * Would moving these files into a folder with these products change which products
 * any of them belongs to? A move REPLACES a file's products with the folder's — the
 * root has none — so such a move needs `products:update` too (B01).
 */
export function moveChangesProducts(files: { product_ids: number[] }[], folderProductIds: number[]) {
  const target = new Set(folderProductIds);
  return files.some((file) => {
    const own = new Set(file.product_ids);
    return own.size !== target.size || [...own].some((id) => !target.has(id));
  });
}
