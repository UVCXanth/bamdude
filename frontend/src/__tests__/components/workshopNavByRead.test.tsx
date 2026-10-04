/**
 * The Workshop's four reads, one at a time (WS-13 E13 O13, T17): the sidebar shows the
 * section with any of them and, inside it, only the entries the caller may read; the badges
 * are asked only by someone who may read one of their domains, and a masked figure shows no
 * badge. The routes keep the doors: a section the caller may not read sends them home.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { Layout } from '../../components/Layout';
import { server } from '../mocks/server';

const SECTIONS = [
  { read: 'orders:read', label: 'Orders' },
  { read: 'products:read', label: 'Products' },
  { read: 'customers:read', label: 'Customers' },
  { read: 'stock:read', label: 'Stock' },
] as const;

let badgeCalls = 0;

function asUser(permissions: string[]) {
  server.use(
    http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
    http.get('/api/v1/auth/me', () =>
      HttpResponse.json({
        id: 7,
        username: 'reader',
        role: 'user',
        is_active: true,
        is_admin: false,
        groups: [{ id: 9, name: 'Readers' }],
        permissions,
        created_at: '2026-01-01T00:00:00Z',
      }),
    ),
  );
}

describe('the Workshop by its four reads', () => {
  beforeEach(() => {
    localStorage.removeItem('sidebarOrder');
    localStorage.setItem('sidebarNavOpen', JSON.stringify({ projects: true }));
    badgeCalls = 0;
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([])),
      http.get('/api/v1/version', () => HttpResponse.json({ version: '0.6.1', build: 'test' })),
      http.get('/api/v1/settings/', () => HttpResponse.json({ check_updates: false, check_printer_firmware: false })),
      http.get('/api/v1/external-links/', () => HttpResponse.json([])),
      http.get('/api/v1/smart-plugs/', () => HttpResponse.json([])),
      http.get('/api/v1/support/debug-logging', () => HttpResponse.json({ enabled: false })),
      http.get('/api/v1/updates/check', () => HttpResponse.json({ update_available: false })),
      http.get('/api/v1/printers/developer-mode-warnings', () => HttpResponse.json([])),
      http.get('/api/v1/projects/nav-badges', () => {
        badgeCalls += 1;
        return HttpResponse.json({ active_orders: 3, draft_products: null, stock_below_min: null });
      }),
    );
  });

  it.each(SECTIONS)('with only $read the section shows its own entry and no other', async ({ read, label }) => {
    asUser([read]);
    render(<Layout />);
    await waitFor(() => expect(screen.getByRole('link', { name: new RegExp(`^${label}`) })).toBeInTheDocument());
    const others = SECTIONS.filter((s) => s.read !== read).map((s) => s.label);
    for (const other of others) {
      expect(screen.queryByRole('link', { name: new RegExp(`^${other}$`) })).not.toBeInTheDocument();
    }
  });

  it('a customers reader asks no badges — none of them is about customers', async () => {
    asUser(['customers:read']);
    render(<Layout />);
    await waitFor(() => expect(screen.getByRole('link', { name: /^Customers/ })).toBeInTheDocument());
    expect(badgeCalls).toBe(0);
  });

  it('an orders reader sees the orders count and no masked badge', async () => {
    asUser(['orders:read', 'products:read']);
    render(<Layout />);
    await waitFor(() => expect(badgeCalls).toBeGreaterThan(0));
    const orders = await screen.findByRole('link', { name: /^Orders/ });
    await waitFor(() => expect(orders).toHaveTextContent('3'));
    expect(screen.getByRole('link', { name: /^Products/ }).textContent?.trim()).toBe('Products');
  });

  it('without any of the four reads there is no Workshop section', async () => {
    asUser(['printers:read']);
    render(<Layout />);
    await waitFor(() => expect(document.querySelector('aside')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /^Orders/ })).not.toBeInTheDocument();
    expect(badgeCalls).toBe(0);
  });
});
