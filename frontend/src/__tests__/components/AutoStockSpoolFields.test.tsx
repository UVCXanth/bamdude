import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { AutoStockSpoolFields } from '../../components/AutoStockSpoolFields';

const permissions = vi.hoisted(() => ({ write: true }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ hasPermission: (p: string) => p === 'inventory:read' || permissions.write }) }));

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={queryClient}><AutoStockSpoolFields value={{ enabled: false, group: null }} onChange={vi.fn()} /></QueryClientProvider>);
}

describe('Automatic stock fields — fallback and permissions', () => {
  beforeEach(() => { permissions.write = true; });

  it('shows a load failure rather than inventing a stock group', async () => {
    server.use(http.get('/api/v1/inventory/spools/auto-stock-groups', () => new HttpResponse(null, { status: 500 })));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load inventory groups');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('keeps printer-only editors from enabling or changing a group', async () => {
    permissions.write = false;
    server.use(http.get('/api/v1/inventory/spools/auto-stock-groups', () => HttpResponse.json([])));
    mount();
    expect(await screen.findByLabelText('Assign a full stock spool on loading')).toBeDisabled();
    expect(screen.getByLabelText('Inventory filament group')).toBeDisabled();
    expect(screen.getByText('Inventory update permission is required to change automatic assignment.')).toBeVisible();
  });
});
