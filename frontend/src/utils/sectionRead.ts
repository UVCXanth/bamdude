import type { Permission } from '../api/client';

/**
 * The read each Workshop section's route asks (App.tsx's `PermissionRoute`), by the path's first
 * segment; `null` outside the Workshop. The dispatch note is the stock's, the order's and the
 * customer's document at once (WS-13 E13 O25), so any of the three opens it.
 */
export function sectionReadOf(to: string): Permission[] | null {
  const path = to.split(/[?#]/)[0];
  if (/^\/stock\/dispatch-notes(\/|$)/.test(path)) return ['stock:read', 'orders:read', 'customers:read'];
  const section = path.split('/')[1];
  if (section === 'projects') return ['orders:read'];
  if (section === 'products') return ['products:read'];
  if (section === 'customers') return ['customers:read'];
  if (section === 'stock') return ['stock:read'];
  return null;
}
