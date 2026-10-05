/**
 * Storage locations arrive in the order a person reads names (upstream
 * 54af3146, adapted): "Drybox 2" before "Drybox 10", and the Ukrainian letters
 * Ґ, Є, І, Ї inside the alphabet rather than before А. The server's
 * `ORDER BY name` gives neither — and upstream's Python key would put Ґ/Є/І/Ї
 * first — so the one client call every consumer shares orders the list with
 * the rule every other place-list uses (`utils/locationOrder`).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { api } from '../../api/client';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function location(id: number, name: string) {
  return { id, name, identifier: null, spool_count: 0, created_at: '', updated_at: '' };
}

describe('getLocations', () => {
  it('orders numbers by value and Ukrainian letters within the alphabet', async () => {
    const names = ['Drybox 10', 'Шафа', 'Drybox 2', 'Ірпінь', 'Ангар', 'Drybox 1', 'Їжак', 'Ґанок', 'Єнот', 'Бокс'];
    server.use(
      http.get('/api/v1/inventory/locations', () => HttpResponse.json(names.map((name, i) => location(i + 1, name)))),
    );

    const got = (await api.getLocations()).map((l) => l.name);

    // The Ukrainian collation is stable even on English-locale CI hosts.
    expect(got.filter((n) => /^[A-Za-z]/.test(n))).toEqual(['Drybox 1', 'Drybox 2', 'Drybox 10']);
    expect(got.filter((n) => !/^[A-Za-z]/.test(n))).toEqual([
      'Ангар',
      'Бокс',
      'Ґанок',
      'Єнот',
      'Ірпінь',
      'Їжак',
      'Шафа',
    ]);
  });
});
