/**
 * «New customer…» in the order form creates a customer, which the server allows
 * with `projects:create` only — an editor of orders without it is not offered the
 * option (WS-13 E13 G01).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Permission } from '../../../api/client';
import { OrderModal } from '../../../components/projects/OrderModal';

const auth = vi.hoisted(() => ({ granted: new Set<string>() }));

vi.mock('../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({
      ...actual.useAuth(),
      hasPermission: (p: Permission) => auth.granted.has(p),
    }),
  };
});

describe('OrderModal — «New customer…» asks projects:create (G01)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getCustomers').mockResolvedValue([{ id: 2, name: 'ACME', figures: {} }] as never);
  });

  it('is not offered to an editor without the right to create', async () => {
    auth.granted = new Set(['projects:read', 'projects:update']);
    render(<OrderModal onClose={() => {}} />);
    await screen.findByRole('option', { name: /ACME/ });
    expect(screen.queryByRole('option', { name: 'New customer…' })).not.toBeInTheDocument();
  });

  it('is offered with projects:create', async () => {
    auth.granted = new Set(['projects:read', 'projects:create']);
    render(<OrderModal onClose={() => {}} />);
    expect(await screen.findByRole('option', { name: 'New customer…' })).toBeInTheDocument();
  });
});
