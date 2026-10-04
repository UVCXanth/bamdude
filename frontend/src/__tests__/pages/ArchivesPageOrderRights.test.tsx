/**
 * «Add to order» on the archives page follows the server's rule (WS-13 E13 B06):
 * filing a print under an order rewrites the archive AND the order, so it needs
 * `orders:update` and the right to change THAT archive — `update_all` any print,
 * `update_own` only the caller's own, an ownerless print only `update_all`. The bulk
 * action asks it of every selected print.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ArchivesPage } from '../../pages/ArchivesPage';
import type { Permission } from '../../api/client';

const auth = vi.hoisted(() => ({ granted: new Set<string>(), userId: 5 }));

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({
      ...actual.useAuth(),
      hasPermission: (p: Permission) => auth.granted.has(p),
      hasAnyPermission: (...ps: Permission[]) => ps.some((p) => auth.granted.has(p)),
      canModify: (resource: string, action: string, createdById: number | null | undefined) => {
        if (auth.granted.has(`${resource}:${action}_all`)) return true;
        if (auth.granted.has(`${resource}:${action}_own`)) return createdById != null && createdById === auth.userId;
        return false;
      },
    }),
  };
});

const archive = (id: number, name: string, createdById: number | null) => ({
  id,
  filename: `${name}.gcode.3mf`,
  print_name: name,
  printer_id: null,
  status: 'completed',
  created_at: '2026-10-01T09:00:00Z',
  project_id: null,
  project_name: null,
  created_by_id: createdById,
  tags: '',
});

const ARCHIVES = [archive(1, 'Mine', 5), archive(2, 'Theirs', 8), archive(3, 'Nobodys', null)];

function cardOf(id: number): HTMLElement {
  return document.querySelector(`[data-archive-id="${id}"]`) as HTMLElement;
}

/** Opens the card's menu and answers the menu's own box (`ContextMenu` is a fixed div). */
async function menuOf(id: number): Promise<HTMLElement> {
  fireEvent.click(within(cardOf(id)).getByTitle('Right-click for more options'));
  return (await screen.findByRole('button', { name: 'Add to order' })).closest('.fixed') as HTMLElement;
}

async function addToOrderItem(id: number): Promise<HTMLElement> {
  await menuOf(id);
  return screen.getByRole('button', { name: 'Add to order' });
}

describe('ArchivesPage — who may file a print under an order (E13 B06)', () => {
  beforeEach(() => {
    localStorage.clear();
    auth.granted = new Set(['archives:read_all', 'orders:read', 'products:read', 'customers:read', 'stock:read']);
    server.use(
      http.get('/api/v1/archives/', () =>
        HttpResponse.json({ data: ARCHIVES, meta: { current_page: 1, per_page: 50, total: 3, last_page: 1 } }),
      ),
      http.get('/api/v1/printers/', () => HttpResponse.json([])),
      http.get('/api/v1/projects/', () => HttpResponse.json([])),
      http.get('/api/v1/archives/tags', () => HttpResponse.json([])),
    );
  });

  it('files only the caller’s own print with «update own»', async () => {
    auth.granted = new Set([...auth.granted, 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust', 'archives:update_own']);
    render(<ArchivesPage />);
    await waitFor(() => expect(cardOf(3)).not.toBeNull());
    expect(await addToOrderItem(1)).not.toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    const theirs = await addToOrderItem(2);
    expect(theirs).toBeDisabled();
    expect(theirs).toHaveAttribute('title', 'You do not have permission to update archives');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await addToOrderItem(3)).toBeDisabled();
  });

  it('files no print without the right to change orders, and says so', async () => {
    auth.granted = new Set([...auth.granted, 'archives:update_all']);
    render(<ArchivesPage />);
    await waitFor(() => expect(cardOf(1)).not.toBeNull());
    const item = await addToOrderItem(1);
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('title', 'Filing a print under an order needs the right to change orders');
  });

  it('files any print with «update all» and the right to change orders', async () => {
    auth.granted = new Set([...auth.granted, 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust', 'archives:update_all']);
    render(<ArchivesPage />);
    await waitFor(() => expect(cardOf(3)).not.toBeNull());
    expect(await addToOrderItem(3)).not.toBeDisabled();
  });

  // The Workshop's own right (m193, owner's ruling 2026-10-04): the default Operators file
  // external (ownerless) and other people's prints without «update all».
  it('files any print with the Workshop’s «file prints» right, the bulk action too', async () => {
    auth.granted = new Set([...auth.granted, 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust', 'archives:update_own', 'orders:file_prints']);
    render(<ArchivesPage />);
    await waitFor(() => expect(cardOf(3)).not.toBeNull());
    expect(await addToOrderItem(3)).not.toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await addToOrderItem(2)).not.toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(within(await menuOf(3)).getByRole('button', { name: 'Select' }));
    fireEvent.click(cardOf(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Order' })).not.toBeDisabled());
  });

  it('asks the bulk action of every selected print', async () => {
    auth.granted = new Set([...auth.granted, 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust', 'archives:update_own']);
    render(<ArchivesPage />);
    await waitFor(() => expect(cardOf(2)).not.toBeNull());
    fireEvent.click(within(await menuOf(1)).getByRole('button', { name: 'Select' }));
    const bulk = await screen.findByRole('button', { name: 'Order' });
    expect(bulk).not.toBeDisabled();
    fireEvent.click(cardOf(2)); // selection mode: a click on a card toggles it
    await waitFor(() => expect(screen.getByRole('button', { name: 'Order' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Order' })).toHaveAttribute(
      'title',
      'Some of the selected prints are not yours to change',
    );
  });
});

// WS-13 E13 T17 (ARC-01): a print's order is a label — its colour comes with the archive, no
// order list is asked for it — and a link to the order only for whoever may read orders.
describe('ArchivesPage — the order a print belongs to', () => {
  let ordersAsked: number;
  const filed = { ...archive(7, 'Filed', 5), project_id: 4, project_name: 'Kickstarter batch', project_color: '#ff0000' };

  beforeEach(() => {
    localStorage.clear();
    ordersAsked = 0;
    server.use(
      http.get('/api/v1/archives/', () =>
        HttpResponse.json({ data: [filed], meta: { current_page: 1, per_page: 50, total: 1, last_page: 1 } }),
      ),
      http.get('/api/v1/printers/', () => HttpResponse.json([])),
      http.get('/api/v1/projects/', () => {
        ordersAsked += 1;
        return HttpResponse.json([]);
      }),
      http.get('/api/v1/archives/tags', () => HttpResponse.json([])),
    );
  });

  it('an orders reader gets the order as a link in its own colour, and no order list is asked', async () => {
    auth.granted = new Set(['archives:read_all', 'orders:read']);
    render(<ArchivesPage />);
    await waitFor(() => expect(cardOf(7)).not.toBeNull());
    const chip = within(cardOf(7)).getByText('Kickstarter batch');
    expect(chip.closest('a')).toHaveAttribute('href', '/projects/4');
    expect(chip.closest('a')).toHaveStyle({ color: '#ff0000' });
    expect(ordersAsked).toBe(0);
  });

  it('without the orders read the order is a label, not a link', async () => {
    auth.granted = new Set(['archives:read_all']);
    render(<ArchivesPage />);
    await waitFor(() => expect(cardOf(7)).not.toBeNull());
    expect(within(cardOf(7)).getByText('Kickstarter batch').closest('a')).toBeNull();
    expect(ordersAsked).toBe(0);
  });
});
